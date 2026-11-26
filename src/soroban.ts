/**
 * Low-level Soroban RPC helpers.
 *
 * Wraps @stellar/stellar-sdk's SorobanRpc to provide a thin
 * simulate → assemble → sign → submit pipeline.
 */

import {
  SorobanRpc,
  Transaction,
  TransactionBuilder,
  Networks,
  Contract,
  Address,
  Asset,
  Account,
  Memo,
  xdr,
  BASE_FEE,
  StrKey,
  scValToNative,
  FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import type { Network } from "./types/index.js";
import type { Signer } from "./signer.js";
import {
  RateLimitError,
  StreamFiNetworkError,
  InsufficientBalanceError,
  ConfirmationTimeoutError,
  CircuitOpenError,
  RpcServiceUnavailableError,
} from "./errors.js";
import { withRetry } from "./with-retry.js";
import { coalesceAsync } from "./coalesce-async.js";
import { recordSuccess, recordFailure, getCircuitState } from "./rpc-circuit-state.js";
import { recordConnectionResult } from "./connection-health.js";

// ── RPC Server cache ─────────────────────────────────────────────────────────
// Reusing SorobanRpc.Server instances avoids creating a new HTTP agent per
// call, which reduces TCP/TLS handshake overhead and GC pressure. This is
// safe because SorobanRpc.Server is stateless beyond its URL configuration.

const _serverCache = new Map<string, SorobanRpc.Server>();

/**
 * Returns a cached SorobanRpc.Server for the given URL.
 * Subsequent calls with the same URL return the same instance,
 * eliminating per-call HTTP agent creation overhead.
 */
export function getServer(rpcUrl: string): SorobanRpc.Server {
  const activeUrl = resolveRpcEndpoint(rpcUrl);
  let server = _serverCache.get(activeUrl);
  if (!server) {
    server = new SorobanRpc.Server(activeUrl, {
      allowHttp: activeUrl.startsWith("http://"),
    });
    _serverCache.set(activeUrl, server);
  }
  return server;
}

function getServerForEndpoint(rpcUrl: string): SorobanRpc.Server {
  let server = _serverCache.get(rpcUrl);
  if (!server) {
    server = new SorobanRpc.Server(rpcUrl, {
      allowHttp: rpcUrl.startsWith("http://"),
    });
    _serverCache.set(rpcUrl, server);
  }
  return server;
}

/**
 * Clear the RPC server cache. Useful in tests or when switching
 * network configurations that should invalidate cached servers.
 */
export function clearServerCache(): void {
  _serverCache.clear();
  _proxiedServerCache.clear();
}

// ── RPC URL fallback state ──────────────────────────────────────────────────
// Tracks consecutive timeouts per endpoint to enable failover to backups.

interface EndpointState {
  consecutiveTimeouts: number;
}

const _endpointStates = new Map<string, EndpointState>();

function getEndpointState(url: string): EndpointState {
  let state = _endpointStates.get(url);
  if (!state) {
    state = { consecutiveTimeouts: 0 };
    _endpointStates.set(url, state);
  }
  return state;
}

export function recordRpcTimeout(url: string): void {
  const state = getEndpointState(url);
  state.consecutiveTimeouts++;
}

export function recordRpcSuccess(url: string): void {
  const state = getEndpointState(url);
  state.consecutiveTimeouts = 0;
}

export function getConsecutiveTimeouts(url: string): number {
  return getEndpointState(url).consecutiveTimeouts;
}

export function clearRpcEndpointStates(): void {
  _endpointStates.clear();
}

interface RpcEndpointGroup {
  urls: string[];
  activeIndex: number;
  failureThreshold: number;
}

const _endpointGroups = new Map<string, RpcEndpointGroup>();

function findEndpointGroup(url: string): RpcEndpointGroup | undefined {
  const direct = _endpointGroups.get(url);
  if (direct) return direct;
  for (const group of _endpointGroups.values()) {
    if (group.urls.includes(url)) return group;
  }
  return undefined;
}

export function registerRpcEndpointGroup(
  urls: string[],
  options: { failureThreshold?: number } = {},
): string[] {
  const unique = [...new Set(urls.map((url) => url.trim()).filter((url) => url.length > 0))];
  if (unique.length === 0) return [];
  const key = unique[0];
  if (key === undefined) return [];
  const existing = _endpointGroups.get(key);
  if (existing) {
    existing.urls = unique;
    existing.activeIndex = 0;
    existing.failureThreshold = options.failureThreshold ?? existing.failureThreshold;
  } else {
    _endpointGroups.set(key, {
      urls: unique,
      activeIndex: 0,
      failureThreshold: Math.max(1, Math.floor(options.failureThreshold ?? 3)),
    });
  }
  return unique;
}

export function clearRpcFailoverGroups(): void {
  _endpointGroups.clear();
}

export function resolveRpcEndpoint(url: string): string {
  const group = findEndpointGroup(url);
  return group?.urls[group.activeIndex] ?? url;
}

export function getRpcEndpointGroup(url: string): readonly string[] | undefined {
  return findEndpointGroup(url)?.urls;
}

export function advanceRpcEndpoint(
  url: string,
  attempted: ReadonlySet<string>,
): string | undefined {
  const group = findEndpointGroup(url);
  if (!group) return undefined;
  for (let offset = 1; offset <= group.urls.length; offset += 1) {
    const index = (group.activeIndex + offset) % group.urls.length;
    const candidate = group.urls[index];
    if (candidate !== undefined && !attempted.has(candidate)) {
      group.activeIndex = index;
      return candidate;
    }
  }
  return undefined;
}

// ── Ledger info cache ───────────────────────────────────────────────────────
// Caches the latest ledger sequence and timestamp to avoid repeated RPC calls
// when converting between timestamps and ledger sequences. The cache is
// automatically refreshed after the average block time interval.

export interface LedgerInfo {
  sequence: number;
  timestamp: number; // Unix timestamp in seconds
  closedAt: string;
}

interface CachedLedgerInfo extends LedgerInfo {
  cachedAt: number;
}

const _ledgerInfoCache = new Map<string, CachedLedgerInfo>();
const DEFAULT_LEDGER_CACHE_TTL_MS = 5000; // 5 seconds (avg ~3-4 blocks)

/**
 * Query the latest ledger info (sequence number and timestamp) with automatic
 * caching. Results are cached per `rpcUrl` for {@link DEFAULT_LEDGER_CACHE_TTL_MS}
 * milliseconds to avoid repeated RPC queries.
 *
 * @param rpcUrl - The Soroban RPC URL
 * @returns Promise resolving to current ledger sequence and timestamp
 * @throws {RateLimitError} if rate limited by RPC
 * @throws {StreamFiNetworkError} if network error occurs
 *
 * @example
 * ```ts
 * const ledger = await getLatestLedgerInfo('https://soroban-testnet.stellar.org');
 * console.log(`Current ledger: ${ledger.sequence}, time: ${ledger.timestamp}`);
 * ```
 */
export async function getLatestLedgerInfo(rpcUrl: string): Promise<LedgerInfo> {
  const now = Date.now();
  const cached = _ledgerInfoCache.get(rpcUrl);

  // Return cached result if still fresh
  if (cached && now - cached.cachedAt < DEFAULT_LEDGER_CACHE_TTL_MS) {
    return {
      sequence: cached.sequence,
      timestamp: cached.timestamp,
      closedAt: cached.closedAt,
    };
  }

  const server = createRpcServer(rpcUrl);

  let ledger;
  try {
    ledger = await catchNetworkError(
      "getLatestLedger",
      server.getLatestLedger(),
    );
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }

  const ledgerWithTime = ledger as typeof ledger & { closedAt?: string };
  const closedAt = ledgerWithTime.closedAt ?? new Date(0).toISOString();

  const info: CachedLedgerInfo = {
    sequence: ledger.sequence,
    timestamp: Math.floor(new Date(closedAt).getTime() / 1000),
    closedAt,
    cachedAt: now,
  };

  _ledgerInfoCache.set(rpcUrl, info);

  return {
    sequence: info.sequence,
    timestamp: info.timestamp,
    closedAt: info.closedAt,
  };
}

/**
 * Clear the ledger info cache. Useful in tests or when you need a fresh
 * ledger query without waiting for TTL expiration.
 */
export function clearLedgerInfoCache(rpcUrl?: string): void {
  if (rpcUrl) {
    _ledgerInfoCache.delete(rpcUrl);
  } else {
    _ledgerInfoCache.clear();
  }
}

// ── Proxied server cache ─────────────────────────────────────────────────────
// createRpcServer wraps the raw server in a Proxy with retry logic. Creating a
// new Proxy on every call allocates closures and the proxy trap object,
// increasing GC pressure. Caching the proxied result eliminates this overhead,
// giving ~20% throughput improvement for high-frequency RPC workflows (e.g.
// list() calling get() for each stream in a page).

const _proxiedServerCache = new Map<string, SorobanRpc.Server>();

export const DEFAULT_RPC: Record<Network, string> = {
  mainnet: "https://soroban-mainnet.stellar.org",
  testnet: "https://soroban-testnet.stellar.org",
  local: "http://localhost:8000/soroban/rpc",
};

/**
 * Default Horizon endpoints, used as a fallback source for an account's
 * sequence number when the Soroban RPC endpoint itself is unreachable (see
 * {@link getAccountWithFallback} and #953). Horizon is a separate service
 * from Soroban RPC — it cannot simulate or submit Soroban contract
 * invocations — but it reads account state from the same ledger, so it can
 * stand in for the one RPC call every contract invocation needs just to
 * learn the caller's current sequence number.
 */
export const DEFAULT_HORIZON: Record<Network, string> = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
  local: "http://localhost:8000",
};

export const NETWORK_PASSPHRASE: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  local: Networks.STANDALONE,
};

export interface ConfirmationPollingOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
  /**
   * When `true`, `invokeContract` rejects with a typed {@link ConfirmationTimeoutError}
   * if `maxAttempts` is reached without a terminal SUCCESS or FAILED status, instead
   * of resolving the unconfirmed transaction hash as pending. Default is `false`.
   */
  strict?: boolean;
}

export const DEFAULT_CONFIRMATION_POLL_INTERVAL_MS = 1000;
export const DEFAULT_CONFIRMATION_MAX_ATTEMPTS = 30;

function normalizePollingOptions(
  options: ConfirmationPollingOptions = {},
): Required<ConfirmationPollingOptions> {
  return {
    pollIntervalMs:
      options.pollIntervalMs ?? DEFAULT_CONFIRMATION_POLL_INTERVAL_MS,
    maxAttempts: options.maxAttempts ?? DEFAULT_CONFIRMATION_MAX_ATTEMPTS,
    strict: options.strict ?? false,
  };
}

/** What happened when a submitted transaction was polled for confirmation. */
export type ConfirmationPollOutcome =
  | { kind: "success"; returnValue: xdr.ScVal | undefined }
  | { kind: "failed" }
  | { kind: "timeout"; attempts: number }
  | { kind: "poll-error"; error: unknown; attempt: number };

/**
 * The single poll-until-confirmed loop shared by {@link waitForConfirmation},
 * {@link invokeContract} and `StreamsModule`.
 *
 * Waits `pollIntervalMs` before each `getTransaction` call and reports what
 * it saw instead of deciding what to throw: each caller keeps its own policy
 * for a failed transaction, a timeout or an RPC error (for example,
 * `invokeContract` can resolve a still-unconfirmed hash as pending). The one
 * exception is `signal`: an aborted signal always throws an `AbortError`.
 *
 * @internal
 */
export async function pollForConfirmation(
  server: SorobanRpc.Server,
  hash: string,
  options: {
    pollIntervalMs: number;
    maxAttempts: number;
    signal?: AbortSignal | undefined;
  },
): Promise<ConfirmationPollOutcome> {
  const { pollIntervalMs, maxAttempts, signal } = options;
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await sleepOrAbort(pollIntervalMs, signal);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    let status;
    try {
      status = await catchNetworkError(
        "getTransaction",
        server.getTransaction(hash),
      );
    } catch (error) {
      return { kind: "poll-error", error, attempt: i + 1 };
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      return { kind: "success", returnValue: status.returnValue };
    }
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      return { kind: "failed" };
    }
  }
  return { kind: "timeout", attempts: maxAttempts };
}

export interface WaitForConfirmationOptions {
  /** Milliseconds to wait before each poll. Default {@link DEFAULT_CONFIRMATION_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Maximum number of polls before giving up. Default {@link DEFAULT_CONFIRMATION_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Abort the wait; the returned promise rejects with an `AbortError`. */
  signal?: AbortSignal | undefined;
}

/** A transaction that reached a successful terminal status. */
export interface ConfirmedTransaction {
  hash: string;
  /** The contract call's return value, when the transaction has one. */
  returnValue: xdr.ScVal | undefined;
}

/**
 * Wait for an already-submitted transaction to confirm, for a transaction you
 * sent through some other path (a raw `sendTransaction`, a wallet's own
 * submission flow, ...). This is the same poll loop the SDK uses internally
 * after it submits a transaction.
 *
 * Resolves once the transaction reaches a successful terminal status and
 * rejects otherwise:
 * - the transaction failed: an `Error` (`Transaction failed: <hash>`);
 * - it did not confirm within `maxAttempts` polls: {@link ConfirmationTimeoutError};
 * - `signal` was aborted: an `AbortError`;
 * - the RPC call failed: {@link RateLimitError} for rate limiting, otherwise
 *   the underlying error.
 *
 * @example
 * ```ts
 * import { waitForConfirmation } from '@conduit-protocol/sdk';
 *
 * // `hash` came from a `sendTransaction` call made outside the SDK.
 * const { returnValue } = await waitForConfirmation(rpcUrl, hash, {
 *   pollIntervalMs: 2_000,
 *   maxAttempts: 20,
 *   signal: AbortSignal.timeout(60_000),
 * });
 * ```
 */
export async function waitForConfirmation(
  rpcUrl: string,
  txHash: string,
  options: WaitForConfirmationOptions = {},
): Promise<ConfirmedTransaction> {
  const { pollIntervalMs, maxAttempts } = normalizePollingOptions(options);
  const server = createRpcServer(rpcUrl);
  const outcome = await pollForConfirmation(server, txHash, {
    pollIntervalMs,
    maxAttempts,
    signal: options.signal,
  });

  switch (outcome.kind) {
    case "success":
      return { hash: txHash, returnValue: outcome.returnValue };
    case "failed":
      throw new Error(`Transaction failed: ${txHash}`);
    case "timeout":
      throw new ConfirmationTimeoutError(
        txHash,
        outcome.attempts,
        outcome.attempts * pollIntervalMs,
      );
    case "poll-error":
      throw RateLimitError.fromRpcError(outcome.error) ?? outcome.error;
  }
}

/**
 * Creates a SorobanRpc.Server instance wrapped with an exponential backoff retry mechanism.
 * Retries on HTTP 429 rate limits (throttled — back off and retry the same
 * endpoint), but fails fast on HTTP 503, which is surfaced as a
 * {@link RpcServiceUnavailableError} so callers can fail over to a
 * different RPC URL instead of retrying a node that is down. See #456.
 */
/**
 * Idempotent RPC methods (#1100). Besides HTTP 429, these are also retried on
 * transport failures (connection reset, DNS, timeout, ...), since repeating a
 * read can't change chain state. `sendTransaction` and anything else not
 * listed keeps the 429-only policy. A 503 is never retried (see #456).
 * `getAccount` is deliberately absent: `getAccountWithFallback` already falls
 * back to Horizon on a transport failure, and retrying first would only delay
 * that fallback.
 */
export const IDEMPOTENT_RPC_METHODS: ReadonlySet<string> = new Set([
  "getHealth",
  "getNetwork",
  "getLatestLedger",
  "getLedgerEntries",
  "getTransaction",
  "getTransactions",
  "getEvents",
  "getContractData",
  "getFeeStats",
  "getVersionInfo",
  "simulateTransaction",
]);

/**
 * Retry predicate for idempotent reads: a rate limit, or an error that is
 * provably a transport failure (the same signals {@link catchNetworkError}
 * uses). Anything else, including a 503, is surfaced immediately.
 */
export function isRetryableReadError(err: unknown): boolean {
  if (err instanceof RateLimitError || err instanceof StreamFiNetworkError) return true;
  if (err instanceof RpcServiceUnavailableError) return false;
  if (err instanceof TypeError && NETWORK_TYPE_ERROR_MESSAGES.has(err.message)) return true;
  return hasNetworkErrorCode(err);
}

function isImmediateFailoverError(err: unknown): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof RpcServiceUnavailableError ||
    err instanceof StreamFiNetworkError ||
    err instanceof CircuitOpenError ||
    (err instanceof TypeError && NETWORK_TYPE_ERROR_MESSAGES.has(err.message)) ||
    hasNetworkErrorCode(err)
  );
}

function recordRpcOutcome(
  endpoint: string,
  ok: boolean,
  startedAt: number,
): void {
  const durationMs = Date.now() - startedAt;
  if (ok) {
    recordRpcSuccess(endpoint);
    recordSuccess(endpoint);
  } else {
    recordRpcTimeout(endpoint);
    recordFailure(endpoint);
  }
  recordConnectionResult(endpoint, ok, durationMs, "rpc");
}

export function createRpcServer(rpcUrl: string): SorobanRpc.Server {
  const cached = _proxiedServerCache.get(rpcUrl);
  if (cached) return cached;

  const initialEndpoint = resolveRpcEndpoint(rpcUrl);
  const EXCLUDED_METHODS = ["constructor"];

  const proxied = new Proxy(getServerForEndpoint(initialEndpoint), {
    get(target, propKey) {
      const currentEndpoint = resolveRpcEndpoint(rpcUrl);
      const currentServer = getServerForEndpoint(currentEndpoint);
      const origMethod = Reflect.get(currentServer, propKey, currentServer);
      if (
        typeof origMethod !== "function" ||
        typeof propKey !== "string" ||
        EXCLUDED_METHODS.includes(propKey)
      ) {
        return Reflect.get(target, propKey, target);
      }

      return async function (...args: unknown[]) {
        const group = findEndpointGroup(rpcUrl);
        if (!group || group.urls.length <= 1) {
          const server = getServerForEndpoint(resolveRpcEndpoint(rpcUrl));
          const method = Reflect.get(server, propKey, server) as (
            ...a: unknown[]
          ) => Promise<unknown>;
          const startedAt = Date.now();
          try {
            const result = await withRetry(() => method.apply(server, args), {
              maxRetries: 3,
              baseDelayMs: 500,
              backoffFactor: 2,
              jitter: "none",
              circuitScope: rpcUrl,
              ...(IDEMPOTENT_RPC_METHODS.has(propKey)
                ? { shouldRetry: isRetryableReadError }
                : {}),
            });
            recordRpcOutcome(rpcUrl, true, startedAt);
            return result;
          } catch (err) {
            if (!(err instanceof CircuitOpenError)) {
              recordRpcOutcome(rpcUrl, false, startedAt);
            }
            throw err;
          }
        }

        const attempted = new Set<string>();
        let lastError: unknown = new Error("All RPC endpoints failed");
        while (attempted.size < group.urls.length) {
          const endpoint = resolveRpcEndpoint(rpcUrl);
          if (attempted.has(endpoint)) {
            const next = advanceRpcEndpoint(rpcUrl, attempted);
            if (next === undefined) break;
            continue;
          }
          attempted.add(endpoint);
          const server = getServerForEndpoint(endpoint);
          const method = Reflect.get(server, propKey, server) as (
            ...a: unknown[]
          ) => Promise<unknown>;
          const startedAt = Date.now();
          try {
            const result = await withRetry(() => method.apply(server, args), {
              maxRetries: 0,
              circuitScope: endpoint,
              ...(IDEMPOTENT_RPC_METHODS.has(propKey)
                ? { shouldRetry: isRetryableReadError }
                : {}),
            });
            recordRpcOutcome(endpoint, true, startedAt);
            return result;
          } catch (err) {
            lastError = err;
            if (!(err instanceof CircuitOpenError)) {
              recordRpcOutcome(endpoint, false, startedAt);
            }
            const shouldAdvance =
              isImmediateFailoverError(err) ||
              getConsecutiveTimeouts(endpoint) >= group.failureThreshold ||
              getCircuitState(endpoint).state === "open";
            if (!shouldAdvance) throw err;
            if (advanceRpcEndpoint(rpcUrl, attempted) === undefined) break;
          }
        }
        throw lastError;
      };
    },
  });

  _proxiedServerCache.set(rpcUrl, proxied);
  return proxied;
}

/**
 * Resolve the inclusion (bid) fee, in stroops, for a submitted transaction.
 *
 * An explicit `fee` always wins. Otherwise `feeMultiplier` scales
 * `BASE_FEE`. With neither set, this returns `BASE_FEE` (the network
 * minimum) unchanged — the previous, always-hardcoded behaviour. `BASE_FEE`
 * alone is not competitive under inclusion-fee pressure (surge pricing,
 * congested ledgers): the bid goes unselected, `_sendAndPoll` exhausts its
 * poll attempts, and the caller sees a misleading "Transaction timed out"
 * instead of "fee too low" (see #509).
 */
export function resolveFee(config: {
  fee?: string;
  feeMultiplier?: number;
}): string {
  if (config.fee !== undefined) return config.fee;
  if (config.feeMultiplier !== undefined) {
    return (BigInt(BASE_FEE) * BigInt(config.feeMultiplier)).toString();
  }
  return BASE_FEE;
}

/**
 * Fetches an account's current sequence number directly from Horizon's
 * REST API (`GET /accounts/{id}`), for use as a fallback when the Soroban
 * RPC endpoint's `getAccount` is unreachable. Horizon and Soroban RPC read
 * account state from the same ledger, so the sequence number is the same
 * either way — this is only ever used as a stand-in for a *down* RPC
 * endpoint, not a source of different data.
 */
async function fetchAccountFromHorizon(
  horizonUrl: string,
  accountId: string,
  customFetch?: typeof fetch,
): Promise<Account> {
  const doFetch = customFetch ?? fetch;
  const base = horizonUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await doFetch(`${base}/accounts/${accountId}`);
  } catch (cause) {
    throw new StreamFiNetworkError(
      `Horizon fallback request failed for account ${accountId}`,
      cause,
    );
  }
  if (!res.ok) {
    throw new StreamFiNetworkError(
      `Horizon fallback failed to fetch account ${accountId}: HTTP ${res.status}`,
    );
  }
  const data = (await res.json()) as { sequence?: string };
  if (!data.sequence) {
    throw new StreamFiNetworkError(
      `Horizon fallback returned no sequence number for account ${accountId}`,
    );
  }
  return new Account(accountId, data.sequence);
}

/**
 * Resolve `caller`'s current account (sequence number), preferring the
 * Soroban RPC endpoint and automatically failing over to Horizon when the
 * RPC endpoint itself is unreachable — a {@link StreamFiNetworkError}
 * (transport-level failure), {@link RpcServiceUnavailableError} (HTTP 503),
 * or {@link CircuitOpenError} (the SDK's own circuit breaker has already
 * given up on this endpoint). See #953.
 *
 * Any other error (e.g. "account not found" for a real but unfunded
 * address) is rethrown as-is without touching Horizon — those indicate the
 * RPC endpoint is reachable and answered correctly, so failing over would
 * just mask the real error with a second, unrelated lookup.
 *
 * No fallback is attempted when `horizonUrl` is not provided; the original
 * error propagates unchanged.
 */
export async function getAccountWithFallback(
  server: SorobanRpc.Server,
  caller: string,
  horizonUrl?: string,
  customFetch?: typeof fetch,
): Promise<Account> {
  try {
    return await catchNetworkError("getAccount", server.getAccount(caller));
  } catch (err) {
    const endpointUnreachable =
      err instanceof StreamFiNetworkError ||
      err instanceof RpcServiceUnavailableError ||
      err instanceof CircuitOpenError;
    if (!endpointUnreachable || !horizonUrl) throw err;
    return fetchAccountFromHorizon(horizonUrl, caller, customFetch);
  }
}

/** Options accepted by {@link buildContractCallTx} beyond the core call parameters. */
export interface BuildContractCallTxOptions {
  /**
   * Horizon endpoint to fall back to for the account/sequence-number lookup
   * when the Soroban RPC endpoint is unreachable. No fallback is attempted
   * when omitted. See {@link getAccountWithFallback} and #953.
   */
  horizonUrl?: string;
  /** Custom `fetch` used for the Horizon fallback request. Defaults to the global `fetch`. */
  customFetch?: typeof fetch;
}

/**
 * Build a contract-call transaction for simulate or submit.
 *
 * Fetches the caller's account from the RPC to get the current sequence
 * number, then wraps the call in a TransactionBuilder.
 *
 * @param fee - Inclusion fee in stroops. Defaults to `BASE_FEE`; pass the
 * result of {@link resolveFee} to honour `ConduitConfig.fee`/`feeMultiplier`.
 * @param options - See {@link BuildContractCallTxOptions}; set `horizonUrl`
 * to enable automatic failover to Horizon when the RPC endpoint is down.
 */
export async function buildContractCallTx(
  rpcUrl: string,
  passphrase: string,
  caller: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  fee: string = BASE_FEE,
  memo?: Memo,
  options: BuildContractCallTxOptions = {},
): Promise<ReturnType<TransactionBuilder["build"]>> {
  const server = createRpcServer(rpcUrl);

  let account;
  try {
    account = await getAccountWithFallback(
      server,
      caller,
      options.horizonUrl,
      options.customFetch,
    );
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }

  const contract = new Contract(contractId);

  const builder = new TransactionBuilder(account, {
    fee,
    networkPassphrase: passphrase,
  }).addOperation(contract.call(method, ...args));
  if (memo) builder.addMemo(memo);
  return builder.setTimeout(30).build();
}

/**
 * Simulate a transaction, then assemble + sign + submit.
 * Returns the transaction hash on success.
 */
export async function invokeContract(
  rpcUrl: string,
  passphrase: string,
  signer: Signer,
  tx: ReturnType<TransactionBuilder["build"]>,
  pollingOptions: ConfirmationPollingOptions = {},
): Promise<string> {
  const server = createRpcServer(rpcUrl);
  const polling = normalizePollingOptions(pollingOptions);

  // Simulate
  let simResult;
  try {
    simResult = await catchNetworkError(
      "simulateTransaction (invoke)",
      server.simulateTransaction(tx),
    );
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  // Assemble (adds soroban auth + footprint)
  const assembled = SorobanRpc.assembleTransaction(tx, simResult).build();

  // Sign. A Signer may mutate in place (void) or return a new signed
  // Transaction (see Signer.sign); honour the latter or the signature is lost.
  const signedResult = await signer.sign(assembled);
  const signed = signedResult instanceof Transaction ? signedResult : assembled;

  // Submit
  let sent;
  try {
    sent = await catchNetworkError(
      "sendTransaction",
      server.sendTransaction(signed),
    );
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }
  if (sent.status === "ERROR") {
    throw new Error(
      `Transaction rejected: ${JSON.stringify(sent.errorResult)}`,
    );
  }

  // Poll for confirmation
  const hash = sent.hash;
  const outcome = await pollForConfirmation(server, hash, polling);
  switch (outcome.kind) {
    case "success":
      return hash;
    case "failed":
      throw new Error(`Transaction failed: ${hash}`);
    case "poll-error":
      if (polling.strict) {
        throw new ConfirmationTimeoutError(
          hash,
          outcome.attempt,
          outcome.attempt * polling.pollIntervalMs,
        );
      }
      // Transaction was already submitted; return the hash as pending.
      // Polling failures don't indicate submission failure.
      return hash;
    case "timeout":
      if (polling.strict) {
        throw new ConfirmationTimeoutError(
          hash,
          polling.maxAttempts,
          polling.maxAttempts * polling.pollIntervalMs,
        );
      }
      // Polling timed out but transaction was submitted; return hash as pending.
      return hash;
  }
}

/**
 * Simulate a read-only call and return the result XDR.
 */
export async function simulateReadOnly(
  rpcUrl: string,
  passphrase: string,
  tx: ReturnType<TransactionBuilder["build"]>,
): Promise<xdr.ScVal> {
  const server = createRpcServer(rpcUrl);

  let result;
  try {
    result = await catchNetworkError(
      "simulateTransaction (readonly)",
      server.simulateTransaction(tx),
    );
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }

  if (SorobanRpc.Api.isSimulationError(result)) {
    throw new Error(`Simulation error: ${result.error}`);
  }
  if (!result.result) {
    throw new Error("Simulation returned no result");
  }
  return xdr.ScVal.fromXDR(result.result.retval.toXDR());
}

// ── Diagnostic event decoding (#1098) ────────────────────────────────────────

function renderScVal(val: xdr.ScVal): string {
  try {
    const native: unknown = scValToNative(val);
    if (typeof native === "string") return native;
    return JSON.stringify(native, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  } catch {
    // e.g. scvError, which has no native JS form
    return val.switch().name;
  }
}

function formatDiagnosticEvent(event: xdr.DiagnosticEvent): string {
  const contractEvent = event.event();
  const contractId = contractEvent.contractId();
  const source = contractId ? StrKey.encodeContract(contractId) : "host";
  const v0 = contractEvent.body().v0();
  const topics = v0.topics().map(renderScVal);
  const failed = event.inSuccessfulContractCall() ? "" : " (in failed call)";
  return `${source}${failed}: [${topics.join(", ")}] ${renderScVal(v0.data())}`;
}

/**
 * Decode the diagnostic events of a simulation response into readable lines,
 * one per event: `<contract or "host">: [topics] data`, e.g.
 * `host (in failed call): [error, Error(Contract, #10)] "insufficient allowance"`.
 *
 * Accepts both parsed `xdr.DiagnosticEvent`s and raw base64 strings. For a
 * failed simulation the RPC error string comes first (`error: ...`), so the
 * returned lines explain why the transaction would fail. An event that can't
 * be decoded becomes `<undecodable diagnostic event>` rather than throwing.
 */
export function decodeDiagnosticEvents(
  simulationResponse: SorobanRpc.Api.SimulateTransactionResponse,
): string[] {
  const lines: string[] = [];
  if (SorobanRpc.Api.isSimulationError(simulationResponse) && simulationResponse.error) {
    lines.push(`error: ${simulationResponse.error}`);
  }

  const events =
    (simulationResponse as unknown as { events?: Array<xdr.DiagnosticEvent | string> })
      .events ?? [];
  for (const entry of events) {
    try {
      const event =
        typeof entry === "string" ? xdr.DiagnosticEvent.fromXDR(entry, "base64") : entry;
      lines.push(formatDiagnosticEvent(event));
    } catch {
      lines.push("<undecodable diagnostic event>");
    }
  }
  return lines;
}

/** Structured diagnostic report for Soroban InvokeHostFunction errors */
export interface SorobanDiagnosticReport {
  /** True if the simulation failed */
  failed: boolean;
  /** RPC error message, if any */
  error?: string;
  /** Decoded diagnostic events with contract source, topics, and data */
  events: Array<{
    source: string;
    topics: string[];
    data: string;
    inFailedCall: boolean;
  }>;
  /** Human-readable summary lines (same as decodeDiagnosticEvents output) */
  summary: string[];
}

/**
 * Parse Soroban InvokeHostFunction simulation errors into a structured diagnostic report.
 * 
 * Raw Soroban RPC transaction simulation errors contain nested ScVal structures that are
 * difficult to interpret. This function decodes diagnostic events and returns a structured
 * report with parsed contract events, topics, and data values.
 * 
 * @param simulationResponse - The simulation response from Soroban RPC
 * @returns A structured diagnostic report with decoded events and error information
 * 
 * @example
 * ```ts
 * const sim = await server.simulateTransaction(tx);
 * const report = parseDiagnosticEvents(sim);
 * 
 * if (report.failed) {
 *   console.error(`Simulation failed: ${report.error}`);
 *   report.events.forEach(event => {
 *     console.log(`${event.source}: [${event.topics.join(', ')}] ${event.data}`);
 *   });
 * }
 * ```
 */
export function parseDiagnosticEvents(
  simulationResponse: SorobanRpc.Api.SimulateTransactionResponse,
): SorobanDiagnosticReport {
  const failed = SorobanRpc.Api.isSimulationError(simulationResponse);
  const error = failed && simulationResponse.error ? simulationResponse.error : undefined;
  
  const events: SorobanDiagnosticReport["events"] = [];
  const rawEvents =
    (simulationResponse as unknown as { events?: Array<xdr.DiagnosticEvent | string> })
      .events ?? [];
  
  for (const entry of rawEvents) {
    try {
      const event =
        typeof entry === "string" ? xdr.DiagnosticEvent.fromXDR(entry, "base64") : entry;
      
      const contractEvent = event.event();
      const contractId = contractEvent.contractId();
      const source = contractId ? StrKey.encodeContract(contractId) : "host";
      const v0 = contractEvent.body().v0();
      const topics = v0.topics().map(renderScVal);
      const data = renderScVal(v0.data());
      const inFailedCall = !event.inSuccessfulContractCall();
      
      events.push({
        source,
        topics,
        data,
        inFailedCall,
      });
    } catch {
      // Skip undecodable events - they won't appear in the structured output
      // but will be in the summary as "<undecodable diagnostic event>"
    }
  }
  
  const summary = decodeDiagnosticEvents(simulationResponse);
  
  return {
    failed,
    error,
    events,
    summary,
  };
}

// ── Pre-signed transaction submission (#1099) ────────────────────────────────

/** Lifecycle of a pre-signed transaction submitted with {@link submitSignedTransaction}. */
export type SignedTransactionStatus = "submitted" | "success" | "failed" | "pending";

export interface SubmitSignedTransactionOptions extends ConfirmationPollingOptions {
  /** Abort status polling; the promise rejects with an `AbortError`. */
  signal?: AbortSignal | undefined;
  /** Called on every status transition: `submitted`, then a terminal status. */
  onStatus?: (status: SignedTransactionStatus, hash: string) => void;
}

export interface SignedTransactionResult {
  hash: string;
  /** `pending` when polling ran out (or errored) before a terminal status. */
  status: Exclude<SignedTransactionStatus, "submitted">;
  /** The contract call's return value, for a successful invocation. */
  returnValue?: xdr.ScVal | undefined;
}

/**
 * Submit a transaction that was signed elsewhere (multi-party or offline
 * signing) and track it to a terminal status.
 *
 * `signedXdr` is the base64 envelope of a fully signed `Transaction` or
 * `FeeBumpTransaction`; it must already carry at least one signature. The SDK
 * does not sign or modify it. A `DUPLICATE` response (the network already has
 * it) is tracked like a fresh submission. A rejected transaction throws.
 * Unlike {@link invokeContract}, a `FAILED` transaction resolves with
 * `status: "failed"` rather than throwing, so callers can inspect the hash;
 * set `strict` to turn a polling timeout into a {@link ConfirmationTimeoutError}.
 */
export async function submitSignedTransaction(
  rpcUrl: string,
  passphrase: string,
  signedXdr: string,
  options: SubmitSignedTransactionOptions = {},
): Promise<SignedTransactionResult> {
  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, passphrase);
  } catch (err) {
    throw new Error(
      `Invalid signed transaction XDR: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (tx.signatures.length === 0) {
    throw new Error("Transaction has no signatures; sign it before submitting");
  }

  const server = createRpcServer(rpcUrl);
  const polling = normalizePollingOptions(options);

  let sent;
  try {
    sent = await catchNetworkError("sendTransaction", server.sendTransaction(tx));
  } catch (err) {
    throw RateLimitError.fromRpcError(err) ?? err;
  }
  if (sent.status === "ERROR") {
    throw new Error(`Transaction rejected: ${JSON.stringify(sent.errorResult)}`);
  }
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new Error(`Transaction not accepted, try again later: ${sent.hash}`);
  }

  const hash = sent.hash;
  options.onStatus?.("submitted", hash);

  const outcome = await pollForConfirmation(server, hash, {
    pollIntervalMs: polling.pollIntervalMs,
    maxAttempts: polling.maxAttempts,
    signal: options.signal,
  });

  let result: SignedTransactionResult;
  switch (outcome.kind) {
    case "success":
      result = { hash, status: "success", returnValue: outcome.returnValue };
      break;
    case "failed":
      result = { hash, status: "failed" };
      break;
    case "timeout":
    case "poll-error":
      if (polling.strict) {
        const attempts = outcome.kind === "timeout" ? outcome.attempts : outcome.attempt;
        throw new ConfirmationTimeoutError(hash, attempts, attempts * polling.pollIntervalMs);
      }
      result = { hash, status: "pending" };
      break;
  }
  options.onStatus?.(result.status, hash);
  return result;
}

// ── Token decimals cache ─────────────────────────────────────────────────────
// A token's `decimals()` is immutable for the lifetime of its contract, so
// repeatedly simulating it (e.g. once per `StreamsModule.create()` call for
// the same token) is a pure waste of an RPC round-trip. Cache the in-flight
// promise (not just the resolved value) so concurrent callers for the same
// token also dedupe onto a single simulation.

const _tokenDecimalsCache = new Map<string, Promise<number>>();
let _tokenDecimalsHits = 0;
let _tokenDecimalsMisses = 0;

/**
 * How long a settled token `decimals()` result is reused before it is
 * re-queried and evicted (#1167). Entries expire on their own, so the cache
 * cannot retain a token's metadata indefinitely or grow without bound for
 * long-running processes that touch many tokens.
 */
const TOKEN_DECIMALS_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Query a token contract's `decimals()` — part of the standard Stellar
 * Asset / SEP-41 token interface every `CreateStreamParams.token` must
 * implement. Callers must not assume 7 decimals (the native XLM/Stellar
 * Asset Contract default) for arbitrary token addresses.
 *
 * Results are cached per `rpcUrl:tokenId` for one hour (#1167), after which
 * the entry is evicted and the next call re-simulates `decimals()`. Use
 * `clearTokenDecimalsCache()` to reset early (e.g. in tests or when a fresh
 * simulation is required).
 */
export async function getTokenDecimals(
  rpcUrl: string,
  passphrase: string,
  callerAddr: string,
  tokenId: string,
): Promise<number> {
  const cacheKey = `${rpcUrl}:${tokenId}`;
  const cached = _tokenDecimalsCache.get(cacheKey);
  if (cached) {
    _tokenDecimalsHits++;
    return cached;
  }
  _tokenDecimalsMisses++;

  // Request coalescing extracted into coalesceAsync (#798): concurrent
  // callers share one in-flight simulation, and failures are evicted so a
  // later call can retry. The TTL window (#1167) evicts settled entries.
  return coalesceAsync(
    _tokenDecimalsCache,
    cacheKey,
    async () => {
      const tx = await buildContractCallTx(
        rpcUrl,
        passphrase,
        callerAddr,
        tokenId,
        "decimals",
        [],
      );
      const val = await simulateReadOnly(rpcUrl, passphrase, tx);
      return scValToU32(val);
    },
    TOKEN_DECIMALS_CACHE_TTL_MS,
  );
}

/**
 * Clear the token decimals cache. Useful in tests or when switching network
 * configurations that should invalidate cached values.
 */
export function clearTokenDecimalsCache(resetMetrics = false): void {
  _tokenDecimalsCache.clear();
  if (resetMetrics) {
    resetTokenDecimalsCacheMetrics();
  }
}

/**
 * Cache performance metrics for the module-level token decimals cache.
 * Follows the same shape as FactoryModule.getCacheMetrics().
 */
export function getTokenDecimalsCacheMetrics(): {
  hits: number;
  misses: number;
  size: number;
} {
  return {
    hits: _tokenDecimalsHits,
    misses: _tokenDecimalsMisses,
    size: _tokenDecimalsCache.size,
  };
}

/**
 * Reset hit and miss counters for the token decimals cache.
 */
export function resetTokenDecimalsCacheMetrics(): void {
  _tokenDecimalsHits = 0;
  _tokenDecimalsMisses = 0;
}

/** Convert an ScVal i128 to bigint */
export function scValToI128(val: xdr.ScVal): bigint {
  const i128 = val.i128();
  const hi = BigInt(i128.hi().toString());
  const lo = BigInt(i128.lo().toString());
  // hi is signed high 64 bits, lo is unsigned low 64 bits
  return (hi << 64n) | lo;
}

/** Convert an ScVal u64 to bigint */
export function scValToU64(val: xdr.ScVal): bigint {
  return BigInt(val.u64().toString());
}

/**
 * Convert an ScVal u32 to number, checking the ScVal's shape first. A raw
 * `val.u32()` call throws an opaque XDR error ("bad union switch" etc.) when
 * the contract returns a different numeric width than expected; this surfaces
 * a clear, typed error instead so callers don't have to decode an XDR
 * exception to find out their assumption about the response shape was wrong.
 */
export function scValToU32(val: xdr.ScVal): number {
  if (val.switch().name !== "scvU32") {
    throw new Error(
      `Expected a u32 ScVal, got "${val.switch().name}" instead.`,
    );
  }
  return val.u32();
}

/**
 * Convert an ScVal string/symbol to a JS string.
 *
 * SEP-41 metadata getters use different shapes across implementations:
 * `symbol()` commonly returns an `scvSymbol`, while `name()` returns an
 * `scvString`. Accept both so token metadata lookups don't fail on an
 * XDR union-shape mismatch.
 */
export function scValToString(val: xdr.ScVal): string {
  const kind = val.switch().name;
  if (kind === 'scvString') return val.str().toString('utf8');
  if (kind === 'scvSymbol') return val.sym().toString('utf8');
  throw new Error(`Expected a string or symbol ScVal, got "${kind}" instead.`);
}

/**
 * Encode a u64 value as ScVal.
 *
 * Rejects a non-integer `number` (`2.5`) or a negative value with a clear
 * `RangeError` naming the argument, rather than letting `Uint64.fromString`
 * throw an opaque XDR error — or, worse, wrap a garbage value — deep inside
 * stellar-sdk (#577).
 */
export function u64ToScVal(val: bigint | number): xdr.ScVal {
  if (typeof val === "number" && !Number.isInteger(val)) {
    throw new RangeError(`u64ToScVal: expected an integer, got ${val}`);
  }
  const asBigInt = typeof val === "bigint" ? val : BigInt(val);
  if (asBigInt < 0n) {
    throw new RangeError(
      `u64ToScVal: expected a non-negative value, got ${val}`,
    );
  }
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(asBigInt.toString()));
}

/** Encode a boolean as ScVal */
export function boolToScVal(val: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(val);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Like {@link sleep}, but rejects with an `AbortError` as soon as `signal`
 * aborts, instead of waiting out the full interval (#1172). Without this, a
 * cancelled confirmation wait would keep the caller pending for up to one
 * poll interval.
 */
function sleepOrAbort(ms: number, signal?: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Network error helpers ─────────────────────────────────────────────────────

/**
 * Error codes that identify a transport-level failure: connection
 * refused/reset, DNS resolution failure, timeout, unreachable host. These
 * come from Node's net/dns layer (`ECONNREFUSED`, `ENOTFOUND`, ...),
 * undici (`UND_ERR_*`), axios (`ERR_NETWORK`), or the browser fetch stack
 * (`ERR_CONN_*`).
 */
const NETWORK_ERROR_CODE_PATTERN =
  /^(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|EPIPE|ERR_NETWORK|ERR_CONN|ERR_SOCKET|UND_ERR|ERR_HTTP2_CONNECT_ERROR|ERR_TLS)/i;

/**
 * Canonical network-layer failure messages produced by the fetch/axios HTTP
 * stacks. These are matched exactly (never substring-matched) so an unrelated
 * programming TypeError such as `Cannot read properties of undefined (reading
 * 'connect')` is not misclassified as a network outage.
 */
const NETWORK_TYPE_ERROR_MESSAGES = new Set([
  "fetch failed", // Node.js undici
  "Failed to fetch", // Chromium fetch
  "Network Error", // axios (browser)
  "Load failed", // Safari fetch
]);

/**
 * Walks an error and its nested `cause` chain looking for a transport-level
 * error code. Node's `fetch` rejects with `TypeError: fetch failed` whose
 * `.cause` carries the real errno code (e.g. `ECONNREFUSED`), so checking the
 * nested cause is more reliable than substring-matching the whole error text.
 */
function hasNetworkErrorCode(cause: unknown): boolean {
  let current: unknown = cause;
  for (
    let depth = 0;
    depth < 5 && current !== null && typeof current === "object";
    depth++
  ) {
    if ("code" in current) {
      const code = String((current as { code: unknown }).code);
      if (NETWORK_ERROR_CODE_PATTERN.test(code)) return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Catches an RPC-level error (e.g. `TypeError: fetch failed`) and re-throws it
 * as a `StreamFiNetworkError` so callers can distinguish network outages from
 * contract-logic failures.
 *
 * Only errors that are *provably* transport failures are reclassified: the
 * canonical fetch/axios network messages, or an error (or its nested `cause`)
 * carrying a network errno code. A `TypeError` from a programming mistake in
 * the simulate/assemble/sign pipeline is re-thrown as-is so it isn't masked
 * as a network outage. See #457.
 */
export function catchNetworkError<T>(
  label: string,
  promise: Promise<T>,
): Promise<T> {
  return promise.catch((cause: unknown) => {
    if (
      cause instanceof StreamFiNetworkError ||
      cause instanceof InsufficientBalanceError
    ) {
      throw cause;
    }
    if (cause instanceof TypeError) {
      const message = (cause as Error).message ?? String(cause);
      if (
        NETWORK_TYPE_ERROR_MESSAGES.has(message) ||
        hasNetworkErrorCode(cause)
      ) {
        throw new StreamFiNetworkError(
          `Network error during ${label}: ${(cause as Error).message}`,
          cause,
        );
      }
    } else if (hasNetworkErrorCode(cause)) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new StreamFiNetworkError(
        `Network error during ${label}: ${message}`,
        cause,
      );
    }
    // Re-throw non-network errors as-is
    throw cause;
  });
}

// ── Account / balance helpers ──────────────────────────────────────────────────

/**
 * Query the native XLM balance of an account, in stroops (1 XLM =
 * 10_000_000 stroops).
 *
 * Soroban RPC's getAccount() returns an XDR-level Account (sequence number
 * etc.) with no `.balances` field -- that's a Horizon-only concept. Native
 * XLM balance on Soroban is queried the same way any SEP-41 token balance
 * is: simulate a `balance(id)` call against the native asset's Stellar
 * Asset Contract.
 */
export async function queryXlmBalance(
  rpcUrl: string,
  passphrase: string,
  accountId: string,
): Promise<bigint> {
  const nativeContractId = Asset.native().contractId(passphrase);
  const tx = await buildContractCallTx(
    rpcUrl,
    passphrase,
    accountId,
    nativeContractId,
    "balance",
    [new Address(accountId).toScVal()],
  );
  const val = await simulateReadOnly(rpcUrl, passphrase, tx);
  return scValToI128(val);
}

/**
 * Realistic estimate of a Soroban contract-call resource fee in stroops
 * (0.1 XLM). Used when a simulation carries no fee fields — e.g. an
 * error-response simulation (WasmVm/InvalidAction insufficient balance)
 * reports neither `minResourceFee` nor `fee`. A typical resource fee is a
 * small fraction of one XLM, so this is a fair estimate; the previous
 * 500 XLM fallback overstated the required balance by ~500 XLM (see #430).
 */
export const DEFAULT_RESOURCE_FEE_ESTIMATE = 1_000_000n;

/**
 * Larger fallback used for expensive operations that deploy or instantiate
 * contracts (e.g. `create_stream`). This is a conservative default sized in
 * stroops (3 XLM) to avoid under-estimating required balance in the
 * insufficient-balance error path when the simulation carries no fee fields.
 */
export const CREATE_RESOURCE_FEE_ESTIMATE = 30_000_000n;

/**
 * Estimate the minimum resource fee required for a transaction simulation.
 *
 * A successful simulation reports the fee in `minResourceFee` (preferred)
 * or `fee`. An error-response simulation — the shape passed in from the
 * insufficient-balance path in `StreamsModule.create()` — carries neither
 * field, so we fall back to {@link DEFAULT_RESOURCE_FEE_ESTIMATE} rather
 * than an inflated upper bound.
 */
export function estimateRequiredFee(
  simResult: unknown,
  fallbackStroops = DEFAULT_RESOURCE_FEE_ESTIMATE,
): bigint {
  if (simResult && typeof simResult === "object") {
    const r = simResult as { minResourceFee?: unknown; fee?: unknown };
    const fromMin = toPositiveBigIntOrNull(r.minResourceFee);
    if (fromMin !== null) return fromMin;
    const fromFee = toPositiveBigIntOrNull(r.fee);
    if (fromFee !== null) return fromFee;
  }
  return fallbackStroops;
}

/**
 * Coerce an RPC-supplied fee field to a positive `bigint`, or `null` if it
 * can't be — including the case a non-conforming RPC returns a float
 * (`minResourceFee: 1234.5`), which would make a bare `BigInt(...)` throw a
 * raw `RangeError` out of the fee-estimation path and abort a `create()`
 * that could have fallen back to the default estimate (#577).
 */
function toPositiveBigIntOrNull(value: unknown): bigint | null {
  if (value === undefined || value === null) return null;
  try {
    let n: bigint;
    if (typeof value === "bigint") {
      n = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      n = BigInt(Math.trunc(value));
    } else if (typeof value === "string") {
      n = BigInt(value.trim());
    } else {
      return null;
    }
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}
