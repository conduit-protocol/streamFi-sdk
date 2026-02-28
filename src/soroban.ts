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
  Keypair,
  xdr,
} from '@stellar/stellar-sdk';
import type { Network } from './types/index.js';

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
 * Simulate a transaction, then assemble + sign + submit.
 * Returns the transaction hash on success.
 */
export async function invokeContract(
  rpcUrl:     string,
  passphrase: string,
  keypair:    Keypair,
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
