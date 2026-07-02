"use strict";
/**
 * StreamsModule — all DripStream + DripFactory operations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamsModule = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const utils_js_1 = require("./utils.js");
const soroban_js_1 = require("./soroban.js");
const factory_js_1 = require("./factory.js");
const errors_js_1 = require("./errors.js");
const ZERO_ADDR = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
class StreamsModule {
    config;
    rpcUrl;
    passphrase;
    callerAddr;
    _factory;
    constructor(config) {
        this.config = config;
        this.rpcUrl = config.rpcUrl ?? soroban_js_1.DEFAULT_RPC[config.network];
        this.passphrase = soroban_js_1.NETWORK_PASSPHRASE[config.network];
        this.callerAddr = config.keypair?.publicKey() ?? ZERO_ADDR;
        this._factory = new factory_js_1.FactoryModule(config);
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
        const depositStroops = (0, utils_js_1.toStroops)(depositAmount);
        const rateStroops = ratePerSecond
            ? BigInt(ratePerSecond)
            : (0, utils_js_1.calculateRate)(depositAmount, durationSeconds);
        const start = startTime ?? Math.floor(Date.now() / 1000);
        const end = durationSeconds ? start + durationSeconds : 0;
        const senderAddr = this.config.keypair.publicKey();
        const factoryId = this.config.factoryAddress ?? '';
        const args = [
            new stellar_sdk_1.Address(senderAddr).toScVal(),
            new stellar_sdk_1.Address(recipient).toScVal(),
            new stellar_sdk_1.Address(token).toScVal(),
            (0, stellar_sdk_1.nativeToScVal)(depositStroops, { type: 'i128' }),
            (0, stellar_sdk_1.nativeToScVal)(rateStroops, { type: 'i128' }),
            (0, stellar_sdk_1.nativeToScVal)(start, { type: 'u64' }),
            (0, stellar_sdk_1.nativeToScVal)(end, { type: 'u64' }),
            (0, soroban_js_1.boolToScVal)(clawbackEnabled),
        ];
        const tx = await (0, soroban_js_1.buildContractCallTx)(this.rpcUrl, this.passphrase, senderAddr, factoryId, 'create_stream', args);
        const server = this._server();
        const sim = await server.simulateTransaction(tx);
        if (stellar_sdk_1.SorobanRpc.Api.isSimulationError(sim)) {
            throw new Error(`Simulation failed: ${sim.error}`);
        }
        // create_stream returns the new stream ID (u64)
        const streamId = (0, soroban_js_1.scValToU64)(stellar_sdk_1.xdr.ScVal.fromXDR(sim.result.retval.toXDR()));
        const assembled = stellar_sdk_1.SorobanRpc.assembleTransaction(tx, sim).build();
        assembled.sign(this.config.keypair);
        const txHash = await this._sendAndPoll(server, assembled);
        const streamAddress = await this._factory.streamAddress(streamId) ?? '';
        return { streamId, streamAddress, txHash };
    }
    /** Fetch full stream state from the deployed DripStream contract. */
    async get(streamId) {
        const id = BigInt(streamId);
        const addr = await this._resolveAddr(id);
        const tx = await (0, soroban_js_1.buildContractCallTx)(this.rpcUrl, this.passphrase, this.callerAddr, addr, 'info', []);
        const val = await this._simulateTx(tx);
        return parseStreamInfo(id, addr, val);
    }
    /** Get withdrawable balance — read-only, no transaction. */
    async withdrawable(streamId) {
        const id = BigInt(streamId);
        const addr = await this._resolveAddr(id);
        const tx = await (0, soroban_js_1.buildContractCallTx)(this.rpcUrl, this.passphrase, this.callerAddr, addr, 'withdrawable', []);
        const val = await this._simulateTx(tx);
        return (0, soroban_js_1.scValToI128)(val);
    }
    /** Withdraw tokens as the recipient. Defaults to full available balance. */
    async withdraw(streamId, amount) {
        if (!this.config.keypair)
            throw new Error('keypair required');
        const id = BigInt(streamId);
        const qty = amount ?? await this.withdrawable(id);
        return this._invoke(await this._resolveAddr(id), 'withdraw', [
            (0, stellar_sdk_1.nativeToScVal)(qty, { type: 'i128' }),
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
            (0, stellar_sdk_1.nativeToScVal)(amount, { type: 'i128' }),
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
        const tx = await (0, soroban_js_1.buildContractCallTx)(this.rpcUrl, this.passphrase, caller, addr, 'clawback', []);
        const server = this._server();
        const sim = await server.simulateTransaction(tx);
        if (stellar_sdk_1.SorobanRpc.Api.isSimulationError(sim)) {
            throw new Error(`Simulation failed: ${sim.error}`);
        }
        const amount = (0, soroban_js_1.scValToI128)(stellar_sdk_1.xdr.ScVal.fromXDR(sim.result.retval.toXDR()));
        const assembled = stellar_sdk_1.SorobanRpc.assembleTransaction(tx, sim).build();
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
        const { subscribeToStream } = await import('./events.js');
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
        return new stellar_sdk_1.SorobanRpc.Server(this.rpcUrl, { allowHttp: this.rpcUrl.startsWith('http://') });
    }
    async _resolveAddr(id) {
        const addr = await this._factory.streamAddress(id);
        if (!addr)
            throw new errors_js_1.ConduitError(errors_js_1.ErrorCode.StreamNotFound, `Stream ${id} not found`);
        return addr;
    }
    async _simulateTx(tx) {
        const server = this._server();
        const result = await server.simulateTransaction(tx);
        if (stellar_sdk_1.SorobanRpc.Api.isSimulationError(result)) {
            throw new Error(`Simulation error: ${result.error}`);
        }
        if (!result.result)
            throw new Error('Simulation returned no result');
        return stellar_sdk_1.xdr.ScVal.fromXDR(result.result.retval.toXDR());
    }
    /** Simulate → assemble → sign → submit → poll. Returns txHash. */
    async _invoke(contractId, method, args) {
        const keypair = this.config.keypair;
        const tx = await (0, soroban_js_1.buildContractCallTx)(this.rpcUrl, this.passphrase, keypair.publicKey(), contractId, method, args);
        const server = this._server();
        const sim = await server.simulateTransaction(tx);
        if (stellar_sdk_1.SorobanRpc.Api.isSimulationError(sim)) {
            throw new Error(`Simulation failed: ${sim.error}`);
        }
        const assembled = stellar_sdk_1.SorobanRpc.assembleTransaction(tx, sim).build();
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
            if (s.status === stellar_sdk_1.SorobanRpc.Api.GetTransactionStatus.SUCCESS)
                return hash;
            if (s.status === stellar_sdk_1.SorobanRpc.Api.GetTransactionStatus.FAILED) {
                throw new Error(`Transaction failed: ${hash}`);
            }
        }
        throw new Error(`Transaction timed out: ${hash}`);
    }
}
exports.StreamsModule = StreamsModule;
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
        sender: m['sender'] ? stellar_sdk_1.Address.fromScVal(m['sender']).toString() : '',
        recipient: m['recipient'] ? stellar_sdk_1.Address.fromScVal(m['recipient']).toString() : '',
        token: m['token'] ? stellar_sdk_1.Address.fromScVal(m['token']).toString() : '',
        ratePerSecond: m['rate_per_second'] ? (0, soroban_js_1.scValToI128)(m['rate_per_second']) : 0n,
        startTime: m['start_time'] ? Number((0, soroban_js_1.scValToU64)(m['start_time'])) : 0,
        endTime: m['end_time'] ? Number((0, soroban_js_1.scValToU64)(m['end_time'])) : 0,
        withdrawn: m['withdrawn'] ? (0, soroban_js_1.scValToI128)(m['withdrawn']) : 0n,
        paused: m['paused']?.b() ?? false,
        pausedAt: m['paused_at'] ? Number((0, soroban_js_1.scValToU64)(m['paused_at'])) : 0,
        cancelled: m['cancelled']?.b() ?? false,
        clawbackEnabled: m['clawback_enabled']?.b() ?? false,
    };
}
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
