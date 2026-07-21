'use strict';

var stellarSdk = require('@stellar/stellar-sdk');
var utils = require('../utils.js');

/**
 * Low-level Soroban RPC helpers.
 *
 * Wraps @stellar/stellar-sdk's SorobanRpc to provide a thin
 * simulate → assemble → sign → submit pipeline.
 */
const DEFAULT_RPC = {
    mainnet: 'https://soroban-mainnet.stellar.org',
    testnet: 'https://soroban-testnet.stellar.org',
    local: 'http://localhost:8000/soroban/rpc',
};
const NETWORK_PASSPHRASE = {
    mainnet: stellarSdk.Networks.PUBLIC,
    testnet: stellarSdk.Networks.TESTNET,
    local: stellarSdk.Networks.STANDALONE,
};
/**
 * Build a contract-call transaction for simulate or submit.
 *
 * Fetches the caller's account from the RPC to get the current sequence
 * number, then wraps the call in a TransactionBuilder.
 */
async function buildContractCallTx(rpcUrl, passphrase, caller, contractId, method, args) {
    const server = new stellarSdk.SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    const account = await server.getAccount(caller);
    const contract = new stellarSdk.Contract(contractId);
    return new stellarSdk.TransactionBuilder(account, {
        fee: stellarSdk.BASE_FEE,
        networkPassphrase: passphrase,
    })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();
}
/**
 * Simulate a read-only call and return the result XDR.
 */
async function simulateReadOnly(rpcUrl, passphrase, tx) {
    const server = new stellarSdk.SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    const result = await server.simulateTransaction(tx);
    if (stellarSdk.SorobanRpc.Api.isSimulationError(result)) {
        throw new Error(`Simulation error: ${result.error}`);
    }
    if (!result.result) {
        throw new Error('Simulation returned no result');
    }
    return stellarSdk.xdr.ScVal.fromXDR(result.result.retval.toXDR());
}
/**
 * Query a token contract's `decimals()` — part of the standard Stellar
 * Asset / SEP-41 token interface every `CreateStreamParams.token` must
 * implement. Callers must not assume 7 decimals (the native XLM/Stellar
 * Asset Contract default) for arbitrary token addresses.
 */
async function getTokenDecimals(rpcUrl, passphrase, callerAddr, tokenId) {
    const tx = await buildContractCallTx(rpcUrl, passphrase, callerAddr, tokenId, 'decimals', []);
    const val = await simulateReadOnly(rpcUrl, passphrase, tx);
    return val.u32();
}
/** Convert an ScVal i128 to bigint */
function scValToI128(val) {
    const i128 = val.i128();
    const hi = BigInt(i128.hi().toString());
    const lo = BigInt(i128.lo().toString());
    // hi is signed high 64 bits, lo is unsigned low 64 bits
    return (hi << 64n) | lo;
}
/** Convert an ScVal u64 to bigint */
function scValToU64(val) {
    return BigInt(val.u64().toString());
}
/** Encode a boolean as ScVal */
function boolToScVal(val) {
    return stellarSdk.xdr.ScVal.scvBool(val);
}

/**
 * FactoryModule — DripFactory read queries.
 */
const DEFAULT_FACTORY = {
    mainnet: 'CDRIP_FACTORY_MAINNET_PLACEHOLDER',
    testnet: 'CDRIP_FACTORY_TESTNET_PLACEHOLDER',
    local: 'CDRIP_FACTORY_LOCAL_PLACEHOLDER',
};
class FactoryModule {
    config;
    rpcUrl;
    passphrase;
    factoryId;
    callerAddr;
    constructor(config) {
        this.config = config;
        this.rpcUrl = config.rpcUrl ?? DEFAULT_RPC[config.network];
        this.passphrase = NETWORK_PASSPHRASE[config.network];
        this.factoryId = config.factoryAddress ?? DEFAULT_FACTORY[config.network] ?? '';
        // For read-only calls we use the keypair's public key as the fee source;
        // if no keypair, we use the zero address (simulation only — no real account needed).
        this.callerAddr = config.keypair?.publicKey() ?? 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
    }
    /** Total number of streams ever created through this factory. */
    async streamCount() {
        const tx = await buildContractCallTx(this.rpcUrl, this.passphrase, this.callerAddr, this.factoryId, 'stream_count', []);
        const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
        return scValToU64(val);
    }
    /** Resolve a stream ID to its deployed contract address. Returns null if not found. */
    async streamAddress(streamId) {
        const id = BigInt(streamId);
        const tx = await buildContractCallTx(this.rpcUrl, this.passphrase, this.callerAddr, this.factoryId, 'stream_address', [stellarSdk.nativeToScVal(id, { type: 'u64' })]);
        const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
        // Contract returns Option<Address> — void = None
        if (val.switch().name === 'scvVoid')
            return null;
        try {
            return stellarSdk.Address.fromScVal(val).toString();
        }
        catch {
            return null;
        }
    }
    /** List stream IDs where `address` is the sender, paginated. */
    async streamsBySender(address, offset = 0, limit = 20) {
        const tx = await buildContractCallTx(this.rpcUrl, this.passphrase, this.callerAddr, this.factoryId, 'streams_by_sender', [
            new stellarSdk.Address(address).toScVal(),
            stellarSdk.nativeToScVal(offset, { type: 'u32' }),
            stellarSdk.nativeToScVal(limit, { type: 'u32' }),
        ]);
        const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
        return this.parseU64Vec(val);
    }
    /** List stream IDs where `address` is the recipient, paginated. */
    async streamsByRecipient(address, offset = 0, limit = 20) {
        const tx = await buildContractCallTx(this.rpcUrl, this.passphrase, this.callerAddr, this.factoryId, 'streams_by_recipient', [
            new stellarSdk.Address(address).toScVal(),
            stellarSdk.nativeToScVal(offset, { type: 'u32' }),
            stellarSdk.nativeToScVal(limit, { type: 'u32' }),
        ]);
        const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
        return this.parseU64Vec(val);
    }
    /** Current protocol fee in basis points (e.g. 30 = 0.3%). */
    async protocolFeeBps() {
        const tx = await buildContractCallTx(this.rpcUrl, this.passphrase, this.callerAddr, this.factoryId, 'protocol_fee_bps', []);
        const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
        return Number(val.u32());
    }
    parseU64Vec(val) {
        const items = val.vec();
        if (!items)
            return [];
        return items.map(v => scValToU64(v));
    }
}

// ── DripStream errors (contracts/stream/src/errors.rs) ────────────────────────
exports.StreamErrorCode = void 0;
(function (StreamErrorCode) {
    StreamErrorCode[StreamErrorCode["NotAuthorized"] = 1] = "NotAuthorized";
    StreamErrorCode[StreamErrorCode["StreamNotFound"] = 2] = "StreamNotFound";
    StreamErrorCode[StreamErrorCode["StreamCancelled"] = 3] = "StreamCancelled";
    StreamErrorCode[StreamErrorCode["StreamNotStarted"] = 4] = "StreamNotStarted";
    StreamErrorCode[StreamErrorCode["StreamEnded"] = 5] = "StreamEnded";
    StreamErrorCode[StreamErrorCode["NothingToWithdraw"] = 6] = "NothingToWithdraw";
    StreamErrorCode[StreamErrorCode["InsufficientDeposit"] = 7] = "InsufficientDeposit";
    StreamErrorCode[StreamErrorCode["InvalidTimeRange"] = 8] = "InvalidTimeRange";
    StreamErrorCode[StreamErrorCode["AlreadyPaused"] = 9] = "AlreadyPaused";
    StreamErrorCode[StreamErrorCode["NotPaused"] = 10] = "NotPaused";
    StreamErrorCode[StreamErrorCode["ClawbackDisabled"] = 11] = "ClawbackDisabled";
    StreamErrorCode[StreamErrorCode["ArithmeticOverflow"] = 12] = "ArithmeticOverflow";
    StreamErrorCode[StreamErrorCode["PauseThresholdNotMet"] = 13] = "PauseThresholdNotMet";
    StreamErrorCode[StreamErrorCode["AlreadyInitialized"] = 14] = "AlreadyInitialized";
    StreamErrorCode[StreamErrorCode["InvalidAmount"] = 15] = "InvalidAmount";
})(exports.StreamErrorCode || (exports.StreamErrorCode = {}));
const STREAM_MESSAGES = {
    [exports.StreamErrorCode.NotAuthorized]: 'Caller is not the sender or recipient of this stream.',
    [exports.StreamErrorCode.StreamNotFound]: 'Stream not found.',
    [exports.StreamErrorCode.StreamCancelled]: 'This stream has been cancelled.',
    [exports.StreamErrorCode.StreamNotStarted]: 'Stream has not started yet.',
    [exports.StreamErrorCode.StreamEnded]: 'Stream has passed its end time.',
    [exports.StreamErrorCode.NothingToWithdraw]: 'Nothing to withdraw — balance is zero.',
    [exports.StreamErrorCode.InsufficientDeposit]: 'Deposit is too small for the requested stream duration.',
    [exports.StreamErrorCode.InvalidTimeRange]: 'end_time must be greater than start_time.',
    [exports.StreamErrorCode.AlreadyPaused]: 'Stream is already paused.',
    [exports.StreamErrorCode.NotPaused]: 'Stream is not currently paused.',
    [exports.StreamErrorCode.ClawbackDisabled]: 'Clawback was not enabled when this stream was created.',
    [exports.StreamErrorCode.ArithmeticOverflow]: 'Integer overflow in stream calculation.',
    [exports.StreamErrorCode.PauseThresholdNotMet]: 'force_cancel called before the 30-day pause threshold elapsed.',
    [exports.StreamErrorCode.AlreadyInitialized]: 'Stream has already been initialized.',
    [exports.StreamErrorCode.InvalidAmount]: 'Amount must be greater than zero.',
};
// ── DripFactory errors (contracts/factory/src/errors.rs) ──────────────────────
exports.FactoryErrorCode = void 0;
(function (FactoryErrorCode) {
    FactoryErrorCode[FactoryErrorCode["NotInitialized"] = 1] = "NotInitialized";
    FactoryErrorCode[FactoryErrorCode["InvalidDeposit"] = 2] = "InvalidDeposit";
    FactoryErrorCode[FactoryErrorCode["InvalidRate"] = 3] = "InvalidRate";
    FactoryErrorCode[FactoryErrorCode["InvalidTimeRange"] = 4] = "InvalidTimeRange";
    FactoryErrorCode[FactoryErrorCode["InsufficientDeposit"] = 5] = "InsufficientDeposit";
    FactoryErrorCode[FactoryErrorCode["BackdatedStream"] = 6] = "BackdatedStream";
    FactoryErrorCode[FactoryErrorCode["AlreadyInitialized"] = 7] = "AlreadyInitialized";
    FactoryErrorCode[FactoryErrorCode["RateExceedsMax"] = 8] = "RateExceedsMax";
    FactoryErrorCode[FactoryErrorCode["DurationTooShort"] = 9] = "DurationTooShort";
    FactoryErrorCode[FactoryErrorCode["ArithmeticOverflow"] = 10] = "ArithmeticOverflow";
})(exports.FactoryErrorCode || (exports.FactoryErrorCode = {}));
const FACTORY_MESSAGES = {
    [exports.FactoryErrorCode.NotInitialized]: 'Factory has not been initialized.',
    [exports.FactoryErrorCode.InvalidDeposit]: 'Deposit must be greater than zero.',
    [exports.FactoryErrorCode.InvalidRate]: 'rate_per_sec must be greater than zero.',
    [exports.FactoryErrorCode.InvalidTimeRange]: 'end_time must be greater than start_time.',
    [exports.FactoryErrorCode.InsufficientDeposit]: "Deposit doesn't cover rate_per_sec for at least one second, or the full declared duration.",
    [exports.FactoryErrorCode.BackdatedStream]: 'start_time cannot be in the past.',
    [exports.FactoryErrorCode.AlreadyInitialized]: 'Factory has already been initialized.',
    [exports.FactoryErrorCode.RateExceedsMax]: "rate_per_sec exceeds the governor's max_rate_per_second.",
    [exports.FactoryErrorCode.DurationTooShort]: "Stream duration is below the governor's min_duration_seconds.",
    [exports.FactoryErrorCode.ArithmeticOverflow]: 'Integer overflow validating deposit against duration.',
};
// ── DripGovernor errors (contracts/governor/src/errors.rs) ────────────────────
exports.GovernorErrorCode = void 0;
(function (GovernorErrorCode) {
    GovernorErrorCode[GovernorErrorCode["NotAuthorized"] = 1] = "NotAuthorized";
    GovernorErrorCode[GovernorErrorCode["InvalidParam"] = 2] = "InvalidParam";
    GovernorErrorCode[GovernorErrorCode["AlreadyInitialized"] = 3] = "AlreadyInitialized";
})(exports.GovernorErrorCode || (exports.GovernorErrorCode = {}));
const GOVERNOR_MESSAGES = {
    [exports.GovernorErrorCode.NotAuthorized]: 'Caller is not the current governor authority.',
    [exports.GovernorErrorCode.InvalidParam]: 'Parameter failed validation (e.g. fee_bps > 10_000, zero duration/rate).',
    [exports.GovernorErrorCode.AlreadyInitialized]: 'Governor has already been initialized.',
};
const MESSAGES_BY_CONTRACT = {
    stream: STREAM_MESSAGES,
    factory: FACTORY_MESSAGES,
    governor: GOVERNOR_MESSAGES,
};
class ConduitError extends Error {
    contract;
    code;
    constructor(contract, code, detail) {
        super(detail ?? MESSAGES_BY_CONTRACT[contract][code] ?? `ConduitError(${contract}, #${code})`);
        this.name = 'ConduitError';
        this.contract = contract;
        this.code = code;
    }
    /** Builds a ConduitError from a raw `{ code: number }`-shaped contract error object. */
    static fromContractError(contract, raw) {
        if (raw && typeof raw === 'object' && 'code' in raw) {
            const code = Number(raw.code);
            if (code in MESSAGES_BY_CONTRACT[contract]) {
                return new ConduitError(contract, code);
            }
        }
        return new ConduitError(contract, -1, String(raw));
    }
    /**
     * Parses a Soroban simulation/transaction failure message (e.g.
     * `"HostError: Error(Contract, #7)"`) into a typed ConduitError scoped to
     * `contract`. Returns a plain Error (not a ConduitError) if no contract
     * error code can be extracted — network failures, timeouts, and non-contract
     * host traps don't carry one.
     */
    static fromSorobanMessage(contract, message) {
        const match = /Error\(Contract,\s*#(\d+)\)/.exec(message);
        if (!match || !match[1])
            return new Error(message);
        const code = Number(match[1]);
        if (!(code in MESSAGES_BY_CONTRACT[contract]))
            return new Error(message);
        return new ConduitError(contract, code, `${MESSAGES_BY_CONTRACT[contract][code]} (${message})`);
    }
}

/**
 * StreamsModule — all DripStream + DripFactory operations.
 */
const ZERO_ADDR$1 = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
class StreamsModule {
    config;
    rpcUrl;
    passphrase;
    callerAddr;
    _factory;
    constructor(config) {
        this.config = config;
        this.rpcUrl = config.rpcUrl ?? DEFAULT_RPC[config.network];
        this.passphrase = NETWORK_PASSPHRASE[config.network];
        this.callerAddr = config.keypair?.publicKey() ?? ZERO_ADDR$1;
        this._factory = new FactoryModule(config);
    }
    /**
     * Deploy a new DripStream via DripFactory.
     *
     * Simulates first to extract the assigned stream ID from the return value,
     * then signs and submits the assembled transaction.
     */
    async create(params) {
        if (!this.config.keypair) {
            throw new Error('keypair is required for mutating operations');
        }
        const { recipient, token, depositAmount, durationSeconds, ratePerSecond, startTime, clawbackEnabled = false, } = params;
        if (!durationSeconds && !ratePerSecond) {
            throw new Error('Either durationSeconds or ratePerSecond must be provided');
        }
        const senderAddr = this.config.keypair.publicKey();
        const factoryId = this.config.factoryAddress ?? '';
        // `token` is an arbitrary contract address (see CreateStreamParams) — it
        // must not be assumed to use the native asset's 7 decimals. Query the
        // token's own decimals() rather than defaulting toStroops/calculateRate
        // to 7, or a non-7-decimal token's deposit/rate would be silently wrong
        // by orders of magnitude.
        const decimals = await getTokenDecimals(this.rpcUrl, this.passphrase, senderAddr, token);
        const depositStroops = utils.toStroops(depositAmount, decimals);
        const rateStroops = ratePerSecond
            ? BigInt(ratePerSecond)
            : utils.calculateRate(depositAmount, durationSeconds, decimals);
        const start = startTime ?? Math.floor(Date.now() / 1000);
        const end = durationSeconds ? start + durationSeconds : 0;
        const args = [
            new stellarSdk.Address(senderAddr).toScVal(),
            new stellarSdk.Address(recipient).toScVal(),
            new stellarSdk.Address(token).toScVal(),
            stellarSdk.nativeToScVal(depositStroops, { type: 'i128' }),
            stellarSdk.nativeToScVal(rateStroops, { type: 'i128' }),
            stellarSdk.nativeToScVal(start, { type: 'u64' }),
            stellarSdk.nativeToScVal(end, { type: 'u64' }),
            boolToScVal(clawbackEnabled),
        ];
        const tx = await buildContractCallTx(this.rpcUrl, this.passphrase, senderAddr, factoryId, 'create_stream', args);
        const server = this._server();
        const sim = await server.simulateTransaction(tx);
        if (stellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
            throw ConduitError.fromSorobanMessage('factory', sim.error);
        }
        const assembled = stellarSdk.SorobanRpc.assembleTransaction(tx, sim).build();
        assembled.sign(this.config.keypair);
        const { hash: txHash, returnValue } = await this._sendAndPoll(server, assembled);
        // create_stream returns the new stream ID (u64). Read it from the
        // confirmed transaction's actual return value, not the pre-submission
        // simulation — if another create_stream lands on the factory between
        // this call's simulate and submit, the real assigned stream_id can
        // differ from what was simulated.
        if (!returnValue) {
            throw new Error(`Transaction ${txHash} succeeded but returned no value`);
        }
        const streamId = scValToU64(returnValue);
        const streamAddress = await this._factory.streamAddress(streamId) ?? '';
        return { streamId, streamAddress, txHash };
    }
    /** Fetch full stream state from the deployed DripStream contract. */
    async get(streamId) {
        const id = BigInt(streamId);
        const addr = await this._resolveAddr(id);
        const tx = await buildContractCallTx(this.rpcUrl, this.passphrase, this.callerAddr, addr, 'info', []);
        const val = await this._simulateTx(tx);
        return parseStreamInfo(id, addr, val);
    }
    /** Get withdrawable balance — read-only, no transaction. */
    async withdrawable(streamId) {
        const id = BigInt(streamId);
        const addr = await this._resolveAddr(id);
        const tx = await buildContractCallTx(this.rpcUrl, this.passphrase, this.callerAddr, addr, 'withdrawable', []);
        const val = await this._simulateTx(tx);
        return scValToI128(val);
    }
    /** Withdraw tokens as the recipient. Defaults to full available balance. */
    async withdraw(streamId, amount) {
        if (!this.config.keypair)
            throw new Error('keypair required');
        const id = BigInt(streamId);
        const qty = amount ?? await this.withdrawable(id);
        return this._invoke(await this._resolveAddr(id), 'withdraw', [
            stellarSdk.nativeToScVal(qty, { type: 'i128' }),
        ]);
    }
    /** Cancel the stream (sender only). Settles all balances atomically. */
    async cancel(streamId) {
        if (!this.config.keypair)
            throw new Error('keypair required');
        return this._invoke(await this._resolveAddr(BigInt(streamId)), 'cancel', []);
    }
    /** Pause the stream (sender only). */
    async pause(streamId) {
        if (!this.config.keypair)
            throw new Error('keypair required');
        return this._invoke(await this._resolveAddr(BigInt(streamId)), 'pause', []);
    }
    /** Resume a paused stream (sender only). Shifts start/end times forward. */
    async resume(streamId) {
        if (!this.config.keypair)
            throw new Error('keypair required');
        return this._invoke(await this._resolveAddr(BigInt(streamId)), 'resume', []);
    }
    /** Deposit additional tokens into the stream (sender only). */
    async topUp(streamId, amount) {
        if (!this.config.keypair)
            throw new Error('keypair required');
        return this._invoke(await this._resolveAddr(BigInt(streamId)), 'top_up', [
            stellarSdk.nativeToScVal(amount, { type: 'i128' }),
        ]);
    }
    /**
     * Clawback unstreamed tokens (sender; only if enabled at creation).
     * Returns the amount reclaimed (simulated before submission).
     */
    async clawback(streamId) {
        if (!this.config.keypair)
            throw new Error('keypair required');
        const addr = await this._resolveAddr(BigInt(streamId));
        const caller = this.config.keypair.publicKey();
        const tx = await buildContractCallTx(this.rpcUrl, this.passphrase, caller, addr, 'clawback', []);
        const server = this._server();
        const sim = await server.simulateTransaction(tx);
        if (stellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
            throw ConduitError.fromSorobanMessage('stream', sim.error);
        }
        const assembled = stellarSdk.SorobanRpc.assembleTransaction(tx, sim).build();
        assembled.sign(this.config.keypair);
        const { hash, returnValue } = await this._sendAndPoll(server, assembled);
        // Read the reclaimed amount from the confirmed transaction, not the
        // pre-submission simulation — see create()'s comment for why these can
        // genuinely differ (balance/withdrawn can shift between simulate and submit).
        if (!returnValue) {
            throw new Error(`Transaction ${hash} succeeded but returned no value`);
        }
        return scValToI128(returnValue);
    }
    /**
     * List streams by sender or recipient.
     * Resolves full StreamInfo for each ID — use sparingly with large sets.
     */
    async list(params) {
        const { sender, recipient, offset = 0, limit = 20 } = params;
        let ids = [];
        if (sender) {
            ids = await this._factory.streamsBySender(sender, offset, limit);
        }
        else if (recipient) {
            ids = await this._factory.streamsByRecipient(recipient, offset, limit);
        }
        return Promise.all(ids.map(id => this.get(id)));
    }
    /** Subscribe to on-chain stream events via polling. Returns an async subscription handle. */
    async subscribeAsync(streamId, handlers) {
        const address = await this._factory.streamAddress(BigInt(streamId));
        if (!address)
            throw new Error(`Stream ${streamId} not found`);
        const { subscribeToStream } = await Promise.resolve().then(function () { return require('./events-BsJYsXca.js'); });
        return subscribeToStream(this.config.rpcUrl, address, handlers);
    }
    /** Synchronous subscribe — resolves address lazily on first poll tick. */
    subscribe(streamId, handlers) {
        let inner = null;
        let stopped = false;
        this.subscribeAsync(streamId, handlers)
            .then(sub => { if (stopped)
            sub.unsubscribe();
        else
            inner = sub; })
            .catch(err => console.warn('[conduit-sdk] subscribe error:', err));
        return { unsubscribe: () => { stopped = true; inner?.unsubscribe(); } };
    }
    // ── Private helpers ──────────────────────────────────────────────────────
    _server() {
        return new stellarSdk.SorobanRpc.Server(this.rpcUrl, { allowHttp: this.rpcUrl.startsWith('http://') });
    }
    async _resolveAddr(id) {
        const addr = await this._factory.streamAddress(id);
        if (!addr)
            throw new ConduitError('stream', exports.StreamErrorCode.StreamNotFound, `Stream ${id} not found`);
        return addr;
    }
    async _simulateTx(tx) {
        const server = this._server();
        const result = await server.simulateTransaction(tx);
        if (stellarSdk.SorobanRpc.Api.isSimulationError(result)) {
            throw ConduitError.fromSorobanMessage('stream', result.error);
        }
        if (!result.result)
            throw new Error('Simulation returned no result');
        return stellarSdk.xdr.ScVal.fromXDR(result.result.retval.toXDR());
    }
    /** Simulate → assemble → sign → submit → poll. Returns txHash. */
    async _invoke(contractId, method, args) {
        const keypair = this.config.keypair;
        const tx = await buildContractCallTx(this.rpcUrl, this.passphrase, keypair.publicKey(), contractId, method, args);
        const server = this._server();
        const sim = await server.simulateTransaction(tx);
        if (stellarSdk.SorobanRpc.Api.isSimulationError(sim)) {
            throw ConduitError.fromSorobanMessage('stream', sim.error);
        }
        const assembled = stellarSdk.SorobanRpc.assembleTransaction(tx, sim).build();
        assembled.sign(keypair);
        const { hash } = await this._sendAndPoll(server, assembled);
        return hash;
    }
    /**
     * Submits `tx` and polls until it lands. Returns the confirmed transaction's
     * hash and, for a SUCCESS status, its actual on-chain `returnValue` — the
     * real executed result, not the pre-submission simulation.
     *
     * Callers that only need the hash (withdraw/cancel/pause/resume/topUp) can
     * ignore `returnValue`; callers whose contract method returns something
     * meaningful (create_stream's stream_id, clawback's reclaimed amount) must
     * use it instead of trusting the simulated retval — the two can genuinely
     * differ (e.g. another create_stream landing between this call's simulate
     * and submit shifts the assigned stream_id).
     */
    async _sendAndPoll(server, tx) {
        const sent = await server.sendTransaction(tx);
        if (sent.status === 'ERROR') {
            throw new Error(`Transaction rejected: ${JSON.stringify(sent.errorResult)}`);
        }
        const hash = sent.hash;
        for (let i = 0; i < 30; i++) {
            await sleep(1000);
            const s = await server.getTransaction(hash);
            if (s.status === stellarSdk.SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                return { hash, returnValue: s.returnValue };
            }
            if (s.status === stellarSdk.SorobanRpc.Api.GetTransactionStatus.FAILED) {
                throw new Error(`Transaction failed: ${hash}`);
            }
        }
        throw new Error(`Transaction timed out: ${hash}`);
    }
}
// ── Parsing ──────────────────────────────────────────────────────────────────
function parseStreamInfo(id, address, val) {
    const entries = val.map() ?? [];
    const m = {};
    for (const e of entries) {
        const k = e.key().sym()?.toString('utf8') ?? e.key().str()?.toString('utf8') ?? '';
        m[k] = e.val();
    }
    return {
        id,
        address,
        sender: m['sender'] ? stellarSdk.Address.fromScVal(m['sender']).toString() : '',
        recipient: m['recipient'] ? stellarSdk.Address.fromScVal(m['recipient']).toString() : '',
        token: m['token'] ? stellarSdk.Address.fromScVal(m['token']).toString() : '',
        ratePerSecond: m['rate_per_second'] ? scValToI128(m['rate_per_second']) : 0n,
        startTime: m['start_time'] ? Number(scValToU64(m['start_time'])) : 0,
        endTime: m['end_time'] ? Number(scValToU64(m['end_time'])) : 0,
        withdrawn: m['withdrawn'] ? scValToI128(m['withdrawn']) : 0n,
        paused: m['paused']?.b() ?? false,
        pausedAt: m['paused_at'] ? Number(scValToU64(m['paused_at'])) : 0,
        cancelled: m['cancelled']?.b() ?? false,
        clawbackEnabled: m['clawback_enabled']?.b() ?? false,
    };
}
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * GovernorModule — DripGovernor config reads.
 */
const DEFAULT_GOVERNOR = {
    mainnet: 'CDRIP_GOVERNOR_MAINNET_PLACEHOLDER',
    testnet: 'CDRIP_GOVERNOR_TESTNET_PLACEHOLDER',
    local: 'CDRIP_GOVERNOR_LOCAL_PLACEHOLDER',
};
const ZERO_ADDR = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
class GovernorModule {
    rpcUrl;
    passphrase;
    governorId;
    callerAddr;
    constructor(cfg) {
        this.rpcUrl = cfg.rpcUrl ?? DEFAULT_RPC[cfg.network];
        this.passphrase = NETWORK_PASSPHRASE[cfg.network];
        this.governorId = cfg.governorAddress ?? DEFAULT_GOVERNOR[cfg.network] ?? '';
        this.callerAddr = cfg.keypair?.publicKey() ?? ZERO_ADDR;
    }
    /** Fetch the current protocol config from the DripGovernor contract. */
    async getConfig() {
        const tx = await buildContractCallTx(this.rpcUrl, this.passphrase, this.callerAddr, this.governorId, 'config', []);
        const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
        return parseGovernorConfig(val);
    }
}
function parseGovernorConfig(val) {
    const entries = val.map() ?? [];
    const m = {};
    for (const e of entries) {
        const k = e.key().sym()?.toString('utf8') ?? e.key().str()?.toString('utf8') ?? '';
        m[k] = e.val();
    }
    return {
        feeBps: m['fee_bps']?.u32() ?? 0,
        feeRecipient: m['fee_recipient'] ? stellarSdk.Address.fromScVal(m['fee_recipient']).toString() : '',
        minDurationSeconds: m['min_duration_seconds'] ? Number(scValToU64(m['min_duration_seconds'])) : 0,
        maxRatePerSecond: m['max_rate_per_second'] ? scValToI128(m['max_rate_per_second']) : 0n,
    };
}

class ConduitClient {
    streams;
    factory;
    governor;
    config;
    constructor(config) {
        this.config = {
            ...config,
            rpcUrl: config.rpcUrl ?? DEFAULT_RPC[config.network],
        };
        this.streams = new StreamsModule(this.config);
        this.factory = new FactoryModule(this.config);
        this.governor = new GovernorModule(this.config);
    }
}

exports.ConduitClient = ConduitClient;
exports.ConduitError = ConduitError;
exports.scValToI128 = scValToI128;
exports.scValToU64 = scValToU64;
//# sourceMappingURL=index-W00-ngCY.js.map
