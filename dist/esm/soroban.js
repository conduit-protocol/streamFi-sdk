"use strict";
/**
 * Low-level Soroban RPC helpers.
 *
 * Wraps @stellar/stellar-sdk's SorobanRpc to provide a thin
 * simulate → assemble → sign → submit pipeline.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NETWORK_PASSPHRASE = exports.DEFAULT_RPC = void 0;
exports.buildContractCallTx = buildContractCallTx;
exports.invokeContract = invokeContract;
exports.simulateReadOnly = simulateReadOnly;
exports.scValToI128 = scValToI128;
exports.scValToU64 = scValToU64;
exports.u64ToScVal = u64ToScVal;
exports.boolToScVal = boolToScVal;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
exports.DEFAULT_RPC = {
    mainnet: 'https://soroban-mainnet.stellar.org',
    testnet: 'https://soroban-testnet.stellar.org',
    local: 'http://localhost:8000/soroban/rpc',
};
exports.NETWORK_PASSPHRASE = {
    mainnet: stellar_sdk_1.Networks.PUBLIC,
    testnet: stellar_sdk_1.Networks.TESTNET,
    local: stellar_sdk_1.Networks.STANDALONE,
};
/**
 * Build a contract-call transaction for simulate or submit.
 *
 * Fetches the caller's account from the RPC to get the current sequence
 * number, then wraps the call in a TransactionBuilder.
 */
async function buildContractCallTx(rpcUrl, passphrase, caller, contractId, method, args) {
    const server = new stellar_sdk_1.SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    const account = await server.getAccount(caller);
    const contract = new stellar_sdk_1.Contract(contractId);
    return new stellar_sdk_1.TransactionBuilder(account, {
        fee: stellar_sdk_1.BASE_FEE,
        networkPassphrase: passphrase,
    })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();
}
/**
 * Simulate a transaction, then assemble + sign + submit.
 * Returns the transaction hash on success.
 */
async function invokeContract(rpcUrl, passphrase, keypair, tx) {
    const server = new stellar_sdk_1.SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    // Simulate
    const simResult = await server.simulateTransaction(tx);
    if (stellar_sdk_1.SorobanRpc.Api.isSimulationError(simResult)) {
        throw new Error(`Simulation failed: ${simResult.error}`);
    }
    // Assemble (adds soroban auth + footprint)
    const assembled = stellar_sdk_1.SorobanRpc.assembleTransaction(tx, simResult).build();
    // Sign
    assembled.sign(keypair);
    // Submit
    const sent = await server.sendTransaction(assembled);
    if (sent.status === 'ERROR') {
        throw new Error(`Transaction rejected: ${JSON.stringify(sent.errorResult)}`);
    }
    // Poll for confirmation
    const hash = sent.hash;
    for (let i = 0; i < 30; i++) {
        await sleep(1000);
        const status = await server.getTransaction(hash);
        if (status.status === stellar_sdk_1.SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
            return hash;
        }
        if (status.status === stellar_sdk_1.SorobanRpc.Api.GetTransactionStatus.FAILED) {
            throw new Error(`Transaction failed: ${hash}`);
        }
    }
    throw new Error(`Transaction timed out: ${hash}`);
}
/**
 * Simulate a read-only call and return the result XDR.
 */
async function simulateReadOnly(rpcUrl, passphrase, tx) {
    const server = new stellar_sdk_1.SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    const result = await server.simulateTransaction(tx);
    if (stellar_sdk_1.SorobanRpc.Api.isSimulationError(result)) {
        throw new Error(`Simulation error: ${result.error}`);
    }
    if (!result.result) {
        throw new Error('Simulation returned no result');
    }
    return stellar_sdk_1.xdr.ScVal.fromXDR(result.result.retval.toXDR());
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
/** Encode a u64 value as ScVal */
function u64ToScVal(val) {
    return stellar_sdk_1.xdr.ScVal.scvU64(stellar_sdk_1.xdr.Uint64.fromString(val.toString()));
}
/** Encode a boolean as ScVal */
function boolToScVal(val) {
    return stellar_sdk_1.xdr.ScVal.scvBool(val);
}
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
