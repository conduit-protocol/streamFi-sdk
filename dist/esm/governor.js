"use strict";
/**
 * GovernorModule — DripGovernor config reads.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GovernorModule = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const soroban_js_1 = require("./soroban.js");
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
        this.rpcUrl = cfg.rpcUrl ?? soroban_js_1.DEFAULT_RPC[cfg.network];
        this.passphrase = soroban_js_1.NETWORK_PASSPHRASE[cfg.network];
        this.governorId = cfg.governorAddress ?? DEFAULT_GOVERNOR[cfg.network] ?? '';
        this.callerAddr = cfg.keypair?.publicKey() ?? ZERO_ADDR;
    }
    /** Fetch the current protocol config from the DripGovernor contract. */
    async getConfig() {
        const tx = await (0, soroban_js_1.buildContractCallTx)(this.rpcUrl, this.passphrase, this.callerAddr, this.governorId, 'config', []);
        const val = await (0, soroban_js_1.simulateReadOnly)(this.rpcUrl, this.passphrase, tx);
        return parseGovernorConfig(val);
    }
}
exports.GovernorModule = GovernorModule;
function parseGovernorConfig(val) {
    const entries = val.map() ?? [];
    const m = {};
    for (const e of entries) {
        const k = e.key().sym()?.toString('utf8') ?? e.key().str()?.toString('utf8') ?? '';
        m[k] = e.val();
    }
    return {
        feeBps: m['fee_bps']?.u32() ?? 0,
        feeRecipient: m['fee_recipient'] ? stellar_sdk_1.Address.fromScVal(m['fee_recipient']).toString() : '',
        minDurationSeconds: m['min_duration_seconds'] ? Number((0, soroban_js_1.scValToU64)(m['min_duration_seconds'])) : 0,
        maxRatePerSecond: m['max_rate_per_second'] ? (0, soroban_js_1.scValToI128)(m['max_rate_per_second']) : 0n,
    };
}
