/**
 * Low-level Soroban RPC helpers.
 *
 * Wraps @stellar/stellar-sdk's SorobanRpc to provide a thin
 * simulate → assemble → sign → submit pipeline.
 */

import {
  SorobanRpc,
  TransactionBuilder,
  Networks,
  Contract,
  xdr,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import type { Network } from './types/index.js';
import type { Signer } from './signer.js';

export const DEFAULT_RPC: Record<Network, string> = {
  mainnet: 'https://soroban-mainnet.stellar.org',
  testnet: 'https://soroban-testnet.stellar.org',
  local:   'http://localhost:8000/soroban/rpc',
};

export const NETWORK_PASSPHRASE: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  local:   Networks.STANDALONE,
};

/**
 * Build a contract-call transaction for simulate or submit.
 *
 * Fetches the caller's account from the RPC to get the current sequence
 * number, then wraps the call in a TransactionBuilder.
 */
export async function buildContractCallTx(
  rpcUrl:      string,
  passphrase:  string,
  caller:      string,
  contractId:  string,
  method:      string,
  args:        xdr.ScVal[],
): Promise<ReturnType<TransactionBuilder['build']>> {
  const server  = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  const account = await server.getAccount(caller);
  const contract = new Contract(contractId);

  return new TransactionBuilder(account, {
    fee:            BASE_FEE,
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
export async function invokeContract(
  rpcUrl:     string,
  passphrase: string,
  signer:     Signer,
  tx:         ReturnType<TransactionBuilder['build']>,
): Promise<string> {
  const server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });

  // Simulate
  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  // Assemble (adds soroban auth + footprint)
  const assembled = SorobanRpc.assembleTransaction(tx, simResult).build();

  // Sign
  await signer.sign(assembled);

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
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return hash;
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Transaction failed: ${hash}`);
    }
  }
  throw new Error(`Transaction timed out: ${hash}`);
}

/**
 * Simulate a read-only call and return the result XDR.
 */
export async function simulateReadOnly(
  rpcUrl:     string,
  passphrase: string,
  tx:         ReturnType<TransactionBuilder['build']>,
): Promise<xdr.ScVal> {
  const server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  const result = await server.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(result)) {
    throw new Error(`Simulation error: ${result.error}`);
  }
  if (!result.result) {
    throw new Error('Simulation returned no result');
  }
  return xdr.ScVal.fromXDR(result.result.retval.toXDR());
}

/**
 * Query a token contract's `decimals()` — part of the standard Stellar
 * Asset / SEP-41 token interface every `CreateStreamParams.token` must
 * implement. Callers must not assume 7 decimals (the native XLM/Stellar
 * Asset Contract default) for arbitrary token addresses.
 */
export async function getTokenDecimals(
  rpcUrl:     string,
  passphrase: string,
  callerAddr: string,
  tokenId:    string,
): Promise<number> {
  const tx  = await buildContractCallTx(rpcUrl, passphrase, callerAddr, tokenId, 'decimals', []);
  const val = await simulateReadOnly(rpcUrl, passphrase, tx);
  return val.u32();
}

/** Convert an ScVal i128 to bigint */
export function scValToI128(val: xdr.ScVal): bigint {
  const i128 = val.i128();
  const hi   = BigInt(i128.hi().toString());
  const lo   = BigInt(i128.lo().toString());
  // hi is signed high 64 bits, lo is unsigned low 64 bits
  return (hi << 64n) | lo;
}

/** Convert an ScVal u64 to bigint */
export function scValToU64(val: xdr.ScVal): bigint {
  return BigInt(val.u64().toString());
}

/** Encode a u64 value as ScVal */
export function u64ToScVal(val: bigint | number): xdr.ScVal {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(val.toString()));
}

/** Encode a boolean as ScVal */
export function boolToScVal(val: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(val);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
