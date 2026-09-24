/**
 * Real batch-transaction construction for {@link ConduitBatcher}.
 *
 * ## Why a batch is several transactions, not one
 *
 * Soroban permits exactly **one `InvokeHostFunction` operation per
 * transaction**. There is no way to pack N contract calls into a single
 * envelope, which is why the previous placeholder XDR was never replaced with
 * a real one — the shape it promised (`xdr: string` for N operations) is not
 * expressible on this network.
 *
 * So a batch builds **one genuine transaction per operation**. That matches how
 * the rest of the SDK already batches: `StreamsModule.batchWithdraw` issues one
 * transaction per withdrawal.
 *
 * ## What "submittable" means here
 *
 * A Soroban invocation is only submittable once it has been simulated, so the
 * network can attach its footprint and authorisation entries. Two levels:
 *
 * - **Offline** (`sequence` supplied, no `rpcUrl`): a well-formed, decodable
 *   transaction envelope. Not yet submittable — it still needs preparing.
 * - **Prepared** (`rpcUrl` supplied): simulated and assembled via RPC, so the
 *   footprint and auth are attached and the XDR can go straight to the network.
 *
 * `prepared` on the result says which one you got, so a caller is never left
 * guessing whether the XDR is ready.
 */

import {
  Account,
  Address,
  Contract,
  SorobanRpc,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE, createRpcServer } from './soroban.js';
import { RateLimitError } from './errors.js';
import type { Network } from './types/index.js';

export const DEFAULT_BATCH_TIMEOUT_SECONDS = 30;

/**
 * Everything needed to turn a validated operation list into real transactions.
 *
 * Supply `sequence` to build offline, or `rpcUrl` to fetch the sequence and
 * produce prepared, submittable XDR. Supplying neither is an error — that is
 * exactly the gap the placeholder XDR used to paper over.
 */
export interface BatchTransactionContext {
  /** Soroban contract the batched operations are invoked against. */
  contractId: string;
  /** Source account (G-address) that will sign and pay for the transactions. */
  sourceAccount: string;
  /** Named network. Ignored when `networkPassphrase` is given. */
  network?: Network;
  /** Explicit passphrase, for networks not covered by {@link Network}. */
  networkPassphrase?: string;
  /**
   * Current sequence number of `sourceAccount`. Required for offline building.
   * Each operation in the batch consumes one sequence number, in order.
   */
  sequence?: string;
  /** Soroban RPC endpoint. When set, transactions are simulated and prepared. */
  rpcUrl?: string;
  /** Per-transaction fee in stroops. Defaults to `BASE_FEE`. */
  fee?: string;
  /** Transaction timeout in seconds. Defaults to 30. */
  timeoutSeconds?: number;
}

/** One built transaction, with the operation it came from. */
export interface BuiltBatchTransaction {
  /** Index of the source operation in the input array. */
  index: number;
  method: string;
  xdr: string;
  /** True when simulated and assembled, so the XDR is ready to submit. */
  prepared: boolean;
}

export class BatchBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchBuildError';
  }
}

/** Resolve the passphrase from an explicit value or a named network. */
export function resolvePassphrase(context: BatchTransactionContext): string {
  if (context.networkPassphrase && context.networkPassphrase.trim().length > 0) {
    return context.networkPassphrase;
  }
  if (context.network) {
    const passphrase = NETWORK_PASSPHRASE[context.network];
    if (passphrase) return passphrase;
    throw new BatchBuildError(`Unknown network "${context.network}"`);
  }
  throw new BatchBuildError(
    'BatchTransactionContext requires either networkPassphrase or network',
  );
}

/**
 * Validate the context up front, so a caller gets a named problem instead of a
 * transaction that fails at submission.
 */
export function validateContext(context: BatchTransactionContext): string[] {
  const errors: string[] = [];

  if (!context || typeof context !== 'object') {
    return ['Batch transaction context is required to build XDR'];
  }
  if (!context.contractId || !StrKey.isValidContract(context.contractId)) {
    errors.push(
      `contractId must be a valid Soroban contract ID (C-address), got "${context.contractId}"`,
    );
  }
  if (!context.sourceAccount || !StrKey.isValidEd25519PublicKey(context.sourceAccount)) {
    errors.push(
      `sourceAccount must be a valid Stellar public key (G-address), got "${context.sourceAccount}"`,
    );
  }
  if (!context.network && !context.networkPassphrase) {
    errors.push('Either network or networkPassphrase must be provided');
  }
  if (context.network && !NETWORK_PASSPHRASE[context.network]) {
    errors.push(`Unknown network "${context.network}"`);
  }
  if (context.sequence === undefined && !context.rpcUrl) {
    errors.push(
      'Either sequence (to build offline) or rpcUrl (to fetch it and prepare) must be provided',
    );
  }
  if (context.sequence !== undefined && !/^\d+$/.test(String(context.sequence))) {
    errors.push(`sequence must be a non-negative integer string, got "${context.sequence}"`);
  }

  return errors;
}

/**
 * ScVal type names accepted by {@link paramToScVal} (and per-field `types` on
 * batch operations) to force a specific encoding instead of the default
 * inference.
 */
export type ScValType =
  | 'u32' | 'i32' | 'u64' | 'i64' | 'u128' | 'i128' | 'u256' | 'i256'
  | 'string' | 'symbol' | 'address' | 'bool' | 'bytes';

/**
 * Convert a single parameter to an ScVal.
 *
 * - Already-encoded `xdr.ScVal` values pass through untouched — their type is
 *   already explicit, so re-encoding would destroy it.
 * - An explicit `type` hint wins over every heuristic (see
 *   {@link BatchOperation.types} for per-field hints in the params map).
 * - Strings that are valid Stellar addresses become `Address` values rather
 *   than string values — passing a G- or C-address as a plain string is a
 *   common way to build a transaction the contract then rejects.
 * - Everything else falls back to the SDK's natural encoding: positive
 *   integers become `u64` and negatives `i64`. This is what the contract
 *   expects for the u64-heavy ABI fields such as `create_stream`'s
 *   `start_time`/`end_time` and stream IDs; previously every integer `number`
 *   was forced to `i64` and every `bigint` to `i128`, producing the wrong
 *   ScVal type and a contract-side type error (see #497).
 */
export function paramToScVal(value: unknown, type?: ScValType): xdr.ScVal {
  // Values with no ScVal representation (symbols, functions, undefined) map to
  // void rather than throwing — validation has already accepted the payload, so
  // a stray non-serialisable field must not take the whole batch down.
  if (
    value === undefined ||
    typeof value === 'symbol' ||
    typeof value === 'function'
  ) {
    return xdr.ScVal.scvVoid();
  }
  if (value === null) {
    return xdr.ScVal.scvVoid();
  }
  if (value instanceof xdr.ScVal) {
    return value;
  }

  // An explicit type hint means the caller knows the contract ABI — trust it
  // over any heuristic below (e.g. `{ streamId: 'u64' }`, `{ amount: 'i128' }`).
  if (type !== undefined) {
    return nativeToScVal(value, { type });
  }

  if (typeof value === 'string' && (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))) {
    return new Address(value).toScVal();
  }

  return nativeToScVal(value);
}

/**
 * Build the argument list for one operation.
 *
 * `args` wins when present, so a caller who knows the contract ABI controls the
 * positional arguments exactly. Otherwise `params` is passed as a single map
 * argument, keyed by field name, with `types` supplying per-field ScVal type
 * information when the default inference would pick the wrong type (e.g. a
 * u64 stream ID, which untyped would encode as a string after bigint
 * serialisation, or an i128 amount).
 */
export function operationToScVals(operation: {
  params?: Record<string, unknown> | undefined;
  types?: Record<string, ScValType> | undefined;
  args?: unknown[] | undefined;
}): xdr.ScVal[] {
  if (Array.isArray(operation.args)) {
    return operation.args.map(arg => paramToScVal(arg));
  }

  const params = operation.params ?? {};
  const entries = Object.entries(params);
  if (entries.length === 0) return [];

  return [
    xdr.ScVal.scvMap(
      entries
        // Soroban map keys must be sorted for the value to be canonical.
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) =>
          new xdr.ScMapEntry({
            key: nativeToScVal(key, { type: 'symbol' }),
            val: paramToScVal(value, operation.types?.[key]),
          }),
        ),
    ),
  ];
}

interface BuildableOperation {
  method: string;
  params?: Record<string, unknown> | undefined;
  /** Per-field ScVal type hints for `params` map entries (see #497). */
  types?: Record<string, ScValType> | undefined;
  args?: unknown[] | undefined;
}

/**
 * Build one unsigned transaction per operation, offline.
 *
 * Requires `context.sequence`. Sequence numbers are consumed in order, so the
 * transactions are submitted in the same order they appear here.
 */
export function buildBatchTransactionsSync(
  operations: BuildableOperation[],
  context: BatchTransactionContext,
): BuiltBatchTransaction[] {
  const errors = validateContext(context);
  if (errors.length > 0) throw new BatchBuildError(errors.join('; '));
  if (context.sequence === undefined) {
    throw new BatchBuildError('sequence is required to build batch transactions offline');
  }

  const passphrase = resolvePassphrase(context);
  const contract = new Contract(context.contractId);
  const fee = context.fee ?? BASE_FEE;
  const timeout = context.timeoutSeconds ?? DEFAULT_BATCH_TIMEOUT_SECONDS;

  return operations.map((operation, index) => {
    if (!operation?.method || typeof operation.method !== 'string') {
      throw new BatchBuildError(`Operation at index ${index} is missing a method name`);
    }

    // One sequence number per transaction, since each is submitted separately.
    const sequence = (BigInt(context.sequence as string) + BigInt(index)).toString();
    const account = new Account(context.sourceAccount, sequence);

    const tx = new TransactionBuilder(account, { fee, networkPassphrase: passphrase })
      .addOperation(contract.call(operation.method, ...operationToScVals(operation)))
      .setTimeout(timeout)
      .build();

    return { index, method: operation.method, xdr: tx.toXDR(), prepared: false };
  });
}

/**
 * Build one transaction per operation and prepare each via RPC simulation, so
 * the returned XDR carries its footprint and auth and is ready to submit.
 *
 * Falls back to offline building when no `rpcUrl` is configured. Either
 * `sequence` or `rpcUrl` is required — `sequence` builds offline, `rpcUrl`
 * fetches the sequence and prepares the transactions. Supplying neither fails
 * validation.
 */
export async function buildBatchTransactions(
  operations: BuildableOperation[],
  context: BatchTransactionContext,
): Promise<BuiltBatchTransaction[]> {
  const errors = validateContext(context);
  if (errors.length > 0) throw new BatchBuildError(errors.join('; '));

  if (!context.rpcUrl) {
    return buildBatchTransactionsSync(operations, context);
  }

  const server = createRpcServer(context.rpcUrl);

  let sequence = context.sequence;
  if (sequence === undefined) {
    try {
      const account = await server.getAccount(context.sourceAccount);
      sequence = account.sequenceNumber();
    } catch (err) {
      throw RateLimitError.fromRpcError(err) ?? err;
    }
  }

  const passphrase = resolvePassphrase(context);
  const contract = new Contract(context.contractId);
  const fee = context.fee ?? BASE_FEE;
  const timeout = context.timeoutSeconds ?? DEFAULT_BATCH_TIMEOUT_SECONDS;

  // Build all transactions offline first (sequence numbers are deterministic),
  // then simulate them all in parallel. Soroban simulations are independent
  // read operations — they do not mutate state and do not depend on each
  // other's outcome — so there is no correctness reason to run them serially.
  const txs = operations.map((operation, index) => {
    if (!operation?.method || typeof operation.method !== 'string') {
      throw new BatchBuildError(`Operation at index ${index} is missing a method name`);
    }
    const txSequence = (BigInt(sequence) + BigInt(index)).toString();
    const account = new Account(context.sourceAccount, txSequence);
    const tx = new TransactionBuilder(account, { fee, networkPassphrase: passphrase })
      .addOperation(contract.call(operation.method, ...operationToScVals(operation)))
      .setTimeout(timeout)
      .build();
    return { operation, index, tx };
  });

  const simulationResults = await Promise.all(
    txs.map(async ({ tx, index, operation }) => {
      let simulation;
      try {
        simulation = await server.simulateTransaction(tx);
      } catch (err) {
        throw RateLimitError.fromRpcError(err) ?? err;
      }
      if (SorobanRpc.Api.isSimulationError(simulation)) {
        throw new BatchBuildError(
          `Simulation failed for operation ${index} (${operation.method}): ${simulation.error}`,
        );
      }
      return { index, operation, tx, simulation };
    }),
  );

  return simulationResults.map(({ index, operation, tx, simulation }) => {
    const assembled = SorobanRpc.assembleTransaction(tx, simulation).build();
    return { index, method: operation.method, xdr: assembled.toXDR(), prepared: true };
  });
}

// ── Sequential batch submission ───────────────────────────────────────────────

/**
 * Outcome for one transaction in a submitted batch.
 *
 * `status` mirrors the Soroban terminal states plus two SDK-side sentinels:
 * - `'SUCCESS'`  — confirmed on-chain; `txHash` is set.
 * - `'FAILED'`   — submitted but the network rejected it; `error` is set.
 * - `'SKIPPED'`  — not submitted because an earlier transaction in the batch
 *   failed (its sequence number would be invalid anyway).
 * - `'ERROR'`    — a local or RPC error prevented submission; `error` is set.
 */
export type BatchTxStatus = 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'ERROR';

export interface BatchTxOutcome {
  /** Position of this transaction in the original array. */
  index: number;
  method: string;
  status: BatchTxStatus;
  /** Transaction hash, present when status is 'SUCCESS'. */
  txHash?: string;
  /** Human-readable reason, present when status is 'FAILED', 'SKIPPED', or 'ERROR'. */
  error?: string;
  /** True when this outcome was produced by a dry-run (no on-chain submission). */
  dryRun?: boolean;
}

/** Overall result returned by {@link submitBatch}. */
export interface BatchSubmitResult {
  /**
   * True only when every transaction in the batch was confirmed on-chain.
   * False as soon as any transaction is FAILED, SKIPPED, or ERROR.
   */
  allSucceeded: boolean;
  /**
   * Index of the first transaction that did not succeed, or -1 when all
   * succeeded. Every transaction after this index will be SKIPPED.
   */
  firstFailureIndex: number;
  outcomes: BatchTxOutcome[];
}

/**
 * Typed error thrown when a batch submission has a mid-batch failure.
 * Carries the index of the first failing transaction and the indices of
 * all transactions that were skipped as a result.
 */
export class BatchPartiallySubmittedError extends Error {
  readonly firstFailureIndex: number;
  readonly skippedIndices: number[];
  readonly result: BatchSubmitResult;

  constructor(result: BatchSubmitResult) {
    super(
      `Batch submission failed at transaction ${result.firstFailureIndex}. ` +
      `${result.outcomes.filter(o => o.status === 'SKIPPED').length} transaction(s) skipped.`,
    );
    this.name = 'BatchPartiallySubmittedError';
    this.firstFailureIndex = result.firstFailureIndex;
    this.skippedIndices = result.outcomes
      .filter(o => o.status === 'SKIPPED')
      .map(o => o.index);
    this.result = result;
  }
}

export interface BatchSubmitOptions {
  /** Milliseconds to wait between confirmation polls. Default: 1 000 ms. */
  pollIntervalMs?: number;
  /** Maximum number of poll attempts per transaction. Default: 30. */
  maxPollAttempts?: number;
  /**
   * Network passphrase used to reconstruct the Transaction object from XDR
   * before submission. Required unless `sign` returns a raw XDR string that
   * already encodes the passphrase (in which case the SDK extracts it during
   * signing). Defaults to an empty string, which is safe when the assembled
   * XDR was produced by `buildBatchTransactions` (the passphrase is embedded
   * in the transaction's network hash, not the envelope itself).
   *
   * In practice, pass the same passphrase used when building — e.g.
   * `Networks.TESTNET` for testnet.
   */
  networkPassphrase?: string;
  /**
   * Signer callback invoked immediately before each transaction is submitted.
   * Receives the transaction XDR string, must return a signed XDR string.
   * Called serially, once per transaction, in submission order.
   */
  sign?: (xdr: string) => Promise<string> | string;
  /** AbortSignal to cancel an in-progress submission. */
  signal?: AbortSignal;
  /**
   * Optional progress callback invoked each time a transaction reaches a
   * terminal state (SUCCESS, FAILED, SKIPPED, or ERROR).
   */
  onProgress?: (progress: { index: number; method: string; status: BatchTxStatus }) => void;
  /** When true, simulates every transaction and returns would-be outcomes without submitting. */
  dryRun?: boolean;
  /** When true, throws BatchPartiallySubmittedError if any tx fails. Default false. */
  throwOnError?: boolean;
}

const DEFAULT_SUBMIT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_SUBMIT_MAX_POLL_ATTEMPTS = 30;

/**
 * Submit a built batch sequentially, one transaction at a time.
 *
 * Transactions are confirmed before the next one is submitted, because each
 * carries a pre-assigned sequence number. If any transaction is rejected or
 * fails, all remaining transactions are marked SKIPPED — they would fail with
 * `txBAD_SEQ` regardless, since their sequence numbers now have a gap below
 * them.
 *
 * This makes the all-or-nothing nature of a pre-sequenced batch explicit and
 * observable, rather than a silent failure mode.
 *
 * @param transactions  The array returned by {@link buildBatchTransactions} or
 *                      {@link buildBatchTransactionsSync}.  Every entry must
 *                      have `prepared: true` (i.e. simulated and assembled).
 * @param rpcUrl        Soroban RPC endpoint used to submit and poll.
 * @param options       Optional signer, polling tuning, and abort signal.
 */
export async function submitBatch(
  transactions: BuiltBatchTransaction[],
  rpcUrl: string,
  options: BatchSubmitOptions = {},
): Promise<BatchSubmitResult> {
  if (!rpcUrl || typeof rpcUrl !== 'string') {
    throw new BatchBuildError('submitBatch requires a valid rpcUrl');
  }
  if (!Array.isArray(transactions)) {
    throw new BatchBuildError('submitBatch requires an array of BuiltBatchTransaction');
  }

  const pollIntervalMs  = options.pollIntervalMs  ?? DEFAULT_SUBMIT_POLL_INTERVAL_MS;
  const maxPollAttempts = options.maxPollAttempts ?? DEFAULT_SUBMIT_MAX_POLL_ATTEMPTS;
  const server = createRpcServer(rpcUrl);

  const outcomes: BatchTxOutcome[] = [];
  let firstFailureIndex = -1;

  function pushOutcome(outcome: BatchTxOutcome) {
    outcomes.push(outcome);
    if (options.onProgress) {
      try {
        options.onProgress({ index: outcome.index, method: outcome.method, status: outcome.status });
      } catch (handlerErr) {
        console.warn('[submitBatch] onProgress handler error:', handlerErr);
      }
    }
  }

  for (const built of transactions) {
    // Once a failure is recorded, mark all subsequent txs as SKIPPED.
    // Their pre-assigned sequence numbers have a gap below them and would
    // fail with txBAD_SEQ even if submitted.
    if (firstFailureIndex !== -1) {
      pushOutcome({
        index:  built.index,
        method: built.method,
        status: 'SKIPPED',
        error:  `Skipped because transaction ${firstFailureIndex} failed`,
      });
      continue;
    }

    if (options.signal?.aborted) {
      pushOutcome({
        index:  built.index,
        method: built.method,
        status: 'SKIPPED',
        error:  'Aborted',
      });
      firstFailureIndex = built.index;
      continue;
    }


    // Dry-run: skip signing, submission, and polling. Return a synthetic
    // SUCCESS outcome for each transaction so pre-flight UIs can show
    // what would be submitted without touching the network (#608).
    if (options.dryRun) {
      outcomes.push({
        index:  built.index,
        method: built.method,
        status: 'SUCCESS',
        txHash: `dry-run:${built.index}`,
        dryRun: true,
      });
      continue;
    }
    // Optionally re-sign the XDR (e.g. hardware wallet, async key service).
    let xdrToSubmit = built.xdr;
    if (options.sign) {
      try {
        xdrToSubmit = await options.sign(built.xdr);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushOutcome({ index: built.index, method: built.method, status: 'ERROR', error: `Sign failed: ${msg}` });
        firstFailureIndex = built.index;
        continue;
      }
    }

    // Submit.
    let sent: SorobanRpc.Api.SendTransactionResponse;
    try {
      const tx = new Transaction(xdrToSubmit, options.networkPassphrase ?? '');
      sent = await server.sendTransaction(tx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushOutcome({ index: built.index, method: built.method, status: 'ERROR', error: `Submit failed: ${msg}` });
      firstFailureIndex = built.index;
      continue;
    }

    if (sent.status === 'ERROR') {
      const msg = sent.errorResult ? JSON.stringify(sent.errorResult) : 'Transaction rejected by network';
      pushOutcome({ index: built.index, method: built.method, status: 'FAILED', error: msg });
      firstFailureIndex = built.index;
      continue;
    }

    // Poll for confirmation.
    const hash = sent.hash;
    let confirmed = false;

    for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, pollIntervalMs));

      if (options.signal?.aborted) {
        pushOutcome({ index: built.index, method: built.method, status: 'ERROR', error: 'Aborted during polling' });
        firstFailureIndex = built.index;
        confirmed = true; // Break the poll loop; outer loop will SKIP the rest.
        break;
      }

      let status: SorobanRpc.Api.GetTransactionResponse;
      try {
        status = await server.getTransaction(hash);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushOutcome({ index: built.index, method: built.method, status: 'ERROR', error: `Poll failed: ${msg}` });
        firstFailureIndex = built.index;
        confirmed = true;
        break;
      }

      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        pushOutcome({ index: built.index, method: built.method, status: 'SUCCESS', txHash: hash });
        confirmed = true;
        break;
      }

      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        pushOutcome({ index: built.index, method: built.method, status: 'FAILED', error: `Transaction failed on-chain: ${hash}` });
        firstFailureIndex = built.index;
        confirmed = true;
        break;
      }
      // status === NOT_FOUND: still pending, keep polling
    }

    if (!confirmed) {
      // Exhausted poll attempts without a terminal status.
      pushOutcome({ index: built.index, method: built.method, status: 'ERROR', error: `Transaction timed out after ${maxPollAttempts} poll attempts: ${hash}` });
      firstFailureIndex = built.index;
    }
  }

  const result = {
    allSucceeded:      firstFailureIndex === -1,
    firstFailureIndex,
    outcomes,
  };

  if (options.throwOnError && !result.allSucceeded) {
    throw new BatchPartiallySubmittedError(result);
  }

  return result;
}
