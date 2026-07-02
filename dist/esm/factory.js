"use strict";
/**
 * FactoryModule — DripFactory read queries.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FactoryModule = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const soroban_js_1 = require("./soroban.js");
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
        this.rpcUrl = config.rpcUrl ?? soroban_js_1.DEFAULT_RPC[config.network];
        this.passphrase = soroban_js_1.NETWORK_PASSPHRASE[config.network];
        this.factoryId = config.factoryAddress ?? DEFAULT_FACTORY[config.network] ?? '';
        // For read-only calls we use the keypair's public key as the fee source;
        // if no keypair, we use the zero address (simulation only — no real account needed).
        this.callerAddr = config.keypair?.publicKey() ?? 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
    }
    /** Total number of streams ever created through this factory. */
    async streamCount() {
        const tx = await (0, soroban_js_1.buildContractCallTx)(this.rpcUrl, this.passphrase, this.callerAddr, this.factoryId, 'stream_count', []);
        const val = await (0, soroban_js_1.simulateReadOnly)(this.rpcUrl, this.passphrase, tx);
        return (0, soroban_js_1.scValToU64)(val);
    }
    /** Resolve a stream ID to its deployed contract address. Returns null if not found. */
    async streamAddress(streamId) {
        const id = BigInt(streamId);
        const tx = await (0, soroban_js_1.buildContractCallTx)(this.rpcUrl, this.passphrase, this.callerAddr, this.factoryId, 'stream_address', [(0, stellar_sdk_1.nativeToScVal)(id, { type: 'u64' })]);
        const val = await (0, soroban_js_1.simulateReadOnly)(this.rpcUrl, this.passphrase, tx);
        // Contract returns Option<Address> — void = None
        if (val.switch().name === 'scvVoid')
            return null;
        try {
            return stellar_sdk_1.Address.fromScVal(val).toString();
        }
        catch {
            return null;
        }
    }
    /** List stream IDs where `address` is the sender, paginated. */
    async streamsBySender(address, offset = 0, limit = 20) {
        const tx = await (0, soroban_js_1.buildContractCallTx)(this.rpcUrl, this.passphrase, this.callerAddr, this.factoryId, 'streams_by_sender', [
            new stellar_sdk_1.Address(address).toScVal(),
            (0, stellar_sdk_1.nativeToScVal)(offset, { type: 'u32' }),
            (0, stellar_sdk_1.nativeToScVal)(limit, { type: 'u32' }),
        ]);
        const val = await (0, soroban_js_1.simulateReadOnly)(this.rpcUrl, this.passphrase, tx);
        return this.parseU64Vec(val);
    }
    /** List stream IDs where `address` is the recipient, paginated. */
    async streamsByRecipient(address, offset = 0, limit = 20) {
        const tx = await (0, soroban_js_1.buildContractCallTx)(this.rpcUrl, this.passphrase, this.callerAddr, this.factoryId, 'streams_by_recipient', [
            new stellar_sdk_1.Address(address).toScVal(),
            (0, stellar_sdk_1.nativeToScVal)(offset, { type: 'u32' }),
            (0, stellar_sdk_1.nativeToScVal)(limit, { type: 'u32' }),
        ]);
        const val = await (0, soroban_js_1.simulateReadOnly)(this.rpcUrl, this.passphrase, tx);
        return this.parseU64Vec(val);
    }
    /** Current protocol fee in basis points (e.g. 30 = 0.3%). */
    async protocolFeeBps() {
        const tx = await (0, soroban_js_1.buildContractCallTx)(this.rpcUrl, this.passphrase, this.callerAddr, this.factoryId, 'protocol_fee_bps', []);
        const val = await (0, soroban_js_1.simulateReadOnly)(this.rpcUrl, this.passphrase, tx);
        return Number(val.u32());
    }
    parseU64Vec(val) {
        const items = val.vec();
        if (!items)
            return [];
        return items.map(v => (0, soroban_js_1.scValToU64)(v));
    }
}
exports.FactoryModule = FactoryModule;
