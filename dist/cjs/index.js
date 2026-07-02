'use strict';

var stellarSdk = require('@stellar/stellar-sdk');
var utils = require('./utils.js');

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

exports.ErrorCode = void 0;
(function (ErrorCode) {
    ErrorCode[ErrorCode["NotAuthorized"] = 1] = "NotAuthorized";
    ErrorCode[ErrorCode["StreamNotFound"] = 2] = "StreamNotFound";
    ErrorCode[ErrorCode["StreamCancelled"] = 3] = "StreamCancelled";
    ErrorCode[ErrorCode["StreamNotStarted"] = 4] = "StreamNotStarted";
    ErrorCode[ErrorCode["StreamEnded"] = 5] = "StreamEnded";
    ErrorCode[ErrorCode["NothingToWithdraw"] = 6] = "NothingToWithdraw";
    ErrorCode[ErrorCode["InsufficientDeposit"] = 7] = "InsufficientDeposit";
    ErrorCode[ErrorCode["InvalidTimeRange"] = 8] = "InvalidTimeRange";
    ErrorCode[ErrorCode["AlreadyPaused"] = 9] = "AlreadyPaused";
    ErrorCode[ErrorCode["NotPaused"] = 10] = "NotPaused";
    ErrorCode[ErrorCode["ClawbackDisabled"] = 11] = "ClawbackDisabled";
    ErrorCode[ErrorCode["ArithmeticOverflow"] = 12] = "ArithmeticOverflow";
})(exports.ErrorCode || (exports.ErrorCode = {}));
const MESSAGES = {
    [exports.ErrorCode.NotAuthorized]: 'Caller is not the sender or recipient of this stream.',
    [exports.ErrorCode.StreamNotFound]: 'Stream not found.',
    [exports.ErrorCode.StreamCancelled]: 'This stream has been cancelled.',
    [exports.ErrorCode.StreamNotStarted]: 'Stream has not started yet.',
    [exports.ErrorCode.StreamEnded]: 'Stream has passed its end time.',
    [exports.ErrorCode.NothingToWithdraw]: 'Nothing to withdraw — balance is zero.',
    [exports.ErrorCode.InsufficientDeposit]: 'Deposit is too small for the requested stream duration.',
    [exports.ErrorCode.InvalidTimeRange]: 'end_time must be greater than start_time.',
    [exports.ErrorCode.AlreadyPaused]: 'Stream is already paused.',
    [exports.ErrorCode.NotPaused]: 'Stream is not currently paused.',
    [exports.ErrorCode.ClawbackDisabled]: 'Clawback was not enabled when this stream was created.',
    [exports.ErrorCode.ArithmeticOverflow]: 'Integer overflow in stream calculation.',
};
class ConduitError extends Error {
    code;
    constructor(code, detail) {
        super(detail ?? MESSAGES[code] ?? `ConduitError(${code})`);
        this.name = 'ConduitError';
        this.code = code;
    }
    static fromContractError(raw) {
        // Contract errors surface as { code: number } in soroban-sdk responses
        if (raw && typeof raw === 'object' && 'code' in raw) {
            const code = Number(raw.code);
            if (code in exports.ErrorCode) {
                return new ConduitError(code);
            }
        }
        return new ConduitError(exports.ErrorCode.StreamNotFound, String(raw));
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
        const depositStroops = utils.toStroops(depositAmount);
        const rateStroops = ratePerSecond
            ? BigInt(ratePerSecond)
            : utils.calculateRate(depositAmount, durationSeconds);
        const start = startTime ?? Math.floor(Date.now() / 1000);
        const end = durationSeconds ? start + durationSeconds : 0;
        const senderAddr = this.config.keypair.publicKey();
        const factoryId = this.config.factoryAddress ?? '';
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
            throw new Error(`Simulation failed: ${sim.error}`);
        }
        // create_stream returns the new stream ID (u64)
        const streamId = scValToU64(stellarSdk.xdr.ScVal.fromXDR(sim.result.retval.toXDR()));
        const assembled = stellarSdk.SorobanRpc.assembleTransaction(tx, sim).build();
        assembled.sign(this.config.keypair);
        const txHash = await this._sendAndPoll(server, assembled);
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
            throw new Error(`Simulation failed: ${sim.error}`);
        }
        const amount = scValToI128(stellarSdk.xdr.ScVal.fromXDR(sim.result.retval.toXDR()));
        const assembled = stellarSdk.SorobanRpc.assembleTransaction(tx, sim).build();
        assembled.sign(this.config.keypair);
        await this._sendAndPoll(server, assembled);
        return amount;
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
        const { subscribeToStream } = await Promise.resolve().then(function () { return require('./chunks/events-D5VREIWr.js'); });
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
            throw new ConduitError(exports.ErrorCode.StreamNotFound, `Stream ${id} not found`);
        return addr;
    }
    async _simulateTx(tx) {
        const server = this._server();
        const result = await server.simulateTransaction(tx);
        if (stellarSdk.SorobanRpc.Api.isSimulationError(result)) {
            throw new Error(`Simulation error: ${result.error}`);
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
            throw new Error(`Simulation failed: ${sim.error}`);
        }
        const assembled = stellarSdk.SorobanRpc.assembleTransaction(tx, sim).build();
        assembled.sign(keypair);
        return this._sendAndPoll(server, assembled);
    }
    async _sendAndPoll(server, tx) {
        const sent = await server.sendTransaction(tx);
        if (sent.status === 'ERROR') {
            throw new Error(`Transaction rejected: ${JSON.stringify(sent.errorResult)}`);
        }
        const hash = sent.hash;
        for (let i = 0; i < 30; i++) {
            await sleep(1000);
            const s = await server.getTransaction(hash);
            if (s.status === stellarSdk.SorobanRpc.Api.GetTransactionStatus.SUCCESS)
                return hash;
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

exports.calculateRate = utils.calculateRate;
exports.fromStroops = utils.fromStroops;
exports.streamProgress = utils.streamProgress;
exports.toStroops = utils.toStroops;
exports.withdrawableLocal = utils.withdrawableLocal;
exports.ConduitClient = ConduitClient;
exports.ConduitError = ConduitError;
//# sourceMappingURL=index.js.map
