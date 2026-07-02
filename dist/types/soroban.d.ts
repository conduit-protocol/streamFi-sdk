/**
 * Low-level Soroban RPC helpers.
 *
 * Wraps @stellar/stellar-sdk's SorobanRpc to provide a thin
 * simulate → assemble → sign → submit pipeline.
 */
import { TransactionBuilder, Keypair, xdr } from '@stellar/stellar-sdk';
import type { Network } from './types/index.js';
export declare const DEFAULT_RPC: Record<Network, string>;
export declare const NETWORK_PASSPHRASE: Record<Network, string>;
/**
 * Build a contract-call transaction for simulate or submit.
 *
 * Fetches the caller's account from the RPC to get the current sequence
 * number, then wraps the call in a TransactionBuilder.
 */
export declare function buildContractCallTx(rpcUrl: string, passphrase: string, caller: string, contractId: string, method: string, args: xdr.ScVal[]): Promise<ReturnType<TransactionBuilder['build']>>;
/**
 * Simulate a transaction, then assemble + sign + submit.
 * Returns the transaction hash on success.
 */
export declare function invokeContract(rpcUrl: string, passphrase: string, keypair: Keypair, tx: ReturnType<TransactionBuilder['build']>): Promise<string>;
/**
 * Simulate a read-only call and return the result XDR.
 */
export declare function simulateReadOnly(rpcUrl: string, passphrase: string, tx: ReturnType<TransactionBuilder['build']>): Promise<xdr.ScVal>;
/** Convert an ScVal i128 to bigint */
export declare function scValToI128(val: xdr.ScVal): bigint;
/** Convert an ScVal u64 to bigint */
export declare function scValToU64(val: xdr.ScVal): bigint;
/** Encode a u64 value as ScVal */
export declare function u64ToScVal(val: bigint | number): xdr.ScVal;
/** Encode a boolean as ScVal */
export declare function boolToScVal(val: boolean): xdr.ScVal;
