import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { ConduitClient } from '../client.js';
import type {
  StreamOperation,
  BatchWithdrawItem,
  BatchWithdrawResult,
  FeeEstimate,
  StreamInfo,
  BatchStreamCreationPayload,
  BatchCreateStreamResult,
} from '../types/index.js';
import type { StreamEvent, StreamHistoryEntry } from '../events.js';
import type { WalletAdapter } from '../adapters/types.js';
import { streamedTotalLocal, withdrawableLocal } from '../utils.js';
import { calculateVestedPercentage } from '../streams.js';
import { useConduitClient } from './context.js';
import { streamStatus, withdrawableLocal } from '../utils.js';

export interface HookOptions {
  client?: ConduitClient;
}

// ── 1. useTransferRecipient ──────────────────────────────────────────────────

export interface UseTransferRecipientResult {
  transferRecipient: (newRecipient: string, overrideStreamId?: bigint | string) => Promise<string>;
  isPending: boolean;
  error: Error | null;
  txHash: string | null;
}

export function useTransferRecipient(
  streamId?: bigint | string,
  options?: HookOptions,
): UseTransferRecipientResult {
  const client = useConduitClient(options?.client);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const transferRecipient = useCallback(
    async (newRecipient: string, overrideStreamId?: bigint | string): Promise<string> => {
      const targetId = overrideStreamId ?? streamId;
      if (targetId == null) {
        throw new Error('streamId is required for transferRecipient');
      }
      setIsPending(true);
      setError(null);
      setTxHash(null);
      try {
        const hash = await client.streams.transferRecipient(targetId, newRecipient);
        setTxHash(hash);
        setIsPending(false);
        return hash;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setIsPending(false);
        throw e;
      }
    },
    [client, streamId],
  );

  return { transferRecipient, isPending, error, txHash };
}

// ── 2. useFeeEstimate ────────────────────────────────────────────────────────

export interface UseFeeEstimateOptions extends HookOptions {
  enabled?: boolean;
}

export interface UseFeeEstimateResult {
  estimate: FeeEstimate | number | null;
  isLoading: boolean;
  error: Error | null;
}

export function useFeeEstimate(
  operation?: StreamOperation | null,
  options?: UseFeeEstimateOptions,
): UseFeeEstimateResult {
  const client = useConduitClient(options?.client);
  const enabled = options?.enabled ?? true;
  const [estimate, setEstimate] = useState<FeeEstimate | number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const opKey = useMemo(() => stableOperationKey(operation), [operation]);

  useEffect(() => {
    if (!enabled || opKey == null || operation == null) {
      setEstimate(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let isMounted = true;
    setIsLoading(true);
    setError(null);

    client.streams
      .estimateFee(operation)
      .then(fee => {
        if (isMounted) {
          setEstimate(fee);
          setIsLoading(false);
        }
      })
      .catch(err => {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [client, enabled, opKey]);

  return { estimate, isLoading, error };
}

// ── 3. useBatchWithdraw ──────────────────────────────────────────────────────

export interface UseBatchWithdrawResult {
  batchWithdraw: (withdrawals: BatchWithdrawItem[]) => Promise<BatchWithdrawResult[]>;
  isPending: boolean;
  error: Error | null;
  results: BatchWithdrawResult[];
}

export function useBatchWithdraw(options?: HookOptions): UseBatchWithdrawResult {
  const client = useConduitClient(options?.client);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [results, setResults] = useState<BatchWithdrawResult[]>([]);

  const batchWithdraw = useCallback(
    async (withdrawals: BatchWithdrawItem[]): Promise<BatchWithdrawResult[]> => {
      setIsPending(true);
      setError(null);
      try {
        const res = await client.streams.batchWithdraw(withdrawals);
        setResults(res);
        setIsPending(false);
        return res;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setIsPending(false);
        throw e;
      }
    },
    [client],
  );

  return { batchWithdraw, isPending, error, results };
}

// ── 4. useStreamBalance ──────────────────────────────────────────────────────

export interface UseStreamBalanceOptions extends HookOptions {
  intervalMs?: number;
  enabled?: boolean;
}

export interface UseStreamBalanceResult {
  withdrawable: bigint | null;
  isLoading: boolean;
  error: Error | null;
}

export function useStreamBalance(
  streamId?: bigint | string | null,
  options?: UseStreamBalanceOptions,
): UseStreamBalanceResult {
  const client = useConduitClient(options?.client);
  const intervalMs = options?.intervalMs ?? 5000;
  const enabled = options?.enabled ?? true;

  const [withdrawable, setWithdrawable] = useState<bigint | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(streamId != null && enabled);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (streamId == null || !enabled) {
      setWithdrawable(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let isMounted = true;
    setIsLoading(true);

    const fetchBalance = async () => {
      try {
        const val = await client.streams.withdrawable(streamId);
        if (isMounted) {
          setWithdrawable(val);
          setError(null);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    fetchBalance();

    const intervalId = setInterval(fetchBalance, intervalMs);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [client, streamId, intervalMs, enabled]);

  return { withdrawable, isLoading, error };
}

// ── 5. useStreamMetrics ──────────────────────────────────────────────────────

export interface StreamMetrics {
  /** Aggregate protocol total value locked (unwithdrawn deposits in stroops) */
  tvl: bigint;
  /** Total count of streams tracked */
  totalStreams: number;
  /** Total count of active streams */
  activeStreams: number;
  /** Total count of paused streams */
  pausedStreams: number;
  /** Total count of completed streams */
  completedStreams: number;
  /** Total count of cancelled streams */
  cancelledStreams: number;
  /** Alias for tvl (total locked liquidity) */
  totalLocked: bigint;
  /** Total amount streamed across all streams */
  totalStreamed: bigint;
  /** Total amount withdrawn across all streams */
  totalWithdrawn: bigint;
}

export interface UseStreamMetricsOptions extends HookOptions {
  /** Polling refresh interval in milliseconds (defaults to 15000ms) */
  refreshIntervalMs?: number;
  /** Whether the polling query is enabled (defaults to true) */
  enabled?: boolean;
}

export interface UseStreamMetricsResult {
  metrics: StreamMetrics | null;
  loading: boolean;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * React hook to retrieve aggregate protocol TVL and stream metrics with automatic polling.
 *
 * Encapsulates polling and aggregation logic across protocol streams,
 * returning loading states, error states, and aggregated metrics.
 */
export function useStreamMetrics(options?: UseStreamMetricsOptions): UseStreamMetricsResult {
  const client = useConduitClient(options?.client);
  const enabled = options?.enabled ?? true;
  const refreshIntervalMs = options?.refreshIntervalMs ?? 15000;

  const [metrics, setMetrics] = useState<StreamMetrics | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<Error | null>(null);

  const fetchMetrics = useCallback(async () => {
    if (!client || !enabled) return;
    try {
      setIsLoading(true);
      setError(null);

      let streams: StreamInfo[] = [];
      let totalCount: bigint | undefined;

      if (client.streams && typeof client.streams.list === 'function') {
        const res = await client.streams.list({});
        streams = res.streams ?? [];
        totalCount = res.totalCount;
      } else if (typeof (client as any).listStreams === 'function') {
        const res = await (client as any).listStreams({});
        streams = res.streams ?? [];
        totalCount = res.totalCount;
      }

      if (totalCount === undefined && client.factory && typeof client.factory.streamCount === 'function') {
        try {
          totalCount = await client.factory.streamCount();
        } catch {
          // fallback to streams length
        }
      }

      const nowSec = Math.floor(Date.now() / 1000);
      let activeStreams = 0;
      let pausedStreams = 0;
      let completedStreams = 0;
      let cancelledStreams = 0;
      let tvl = 0n;
      let totalWithdrawn = 0n;
      let totalStreamed = 0n;

      for (const stream of streams) {
        const status = streamStatus(stream, nowSec);
        if (status === 'active') activeStreams++;
        else if (status === 'paused') pausedStreams++;
        else if (status === 'completed') completedStreams++;
        else if (status === 'cancelled') cancelledStreams++;

        const withdrawn = stream.withdrawn ?? 0n;
        totalWithdrawn += withdrawn;
        totalStreamed += withdrawn + withdrawableLocal(stream, nowSec);

        if (!stream.cancelled) {
          if (stream.endTime && stream.endTime > stream.startTime) {
            const deposit = stream.ratePerSecond * BigInt(stream.endTime - stream.startTime);
            const remaining = deposit > withdrawn ? deposit - withdrawn : 0n;
            tvl += remaining;
          } else {
            const withdrawable = withdrawableLocal(stream, nowSec);
            tvl += withdrawable;
          }
        }
      }

      const count = totalCount !== undefined ? Number(totalCount) : streams.length;

      setMetrics({
        tvl,
        totalStreams: count,
        activeStreams,
        pausedStreams,
        completedStreams,
        cancelledStreams,
        totalLocked: tvl,
        totalStreamed,
        totalWithdrawn,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [client, enabled]);

  useEffect(() => {
    if (!enabled) {
      setMetrics(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let isMounted = true;
    fetchMetrics();

    let intervalId: ReturnType<typeof setInterval> | undefined;
    if (refreshIntervalMs > 0) {
      intervalId = setInterval(() => {
        if (isMounted) {
          fetchMetrics();
        }
      }, refreshIntervalMs);
    }

    return () => {
      isMounted = false;
      if (intervalId) clearInterval(intervalId);
    };
  }, [fetchMetrics, enabled, refreshIntervalMs]);

  return {
    metrics,
    loading: isLoading,
    isLoading,
    error,
    refetch: fetchMetrics,
  };
}
// ── useStream (#1091) ────────────────────────────────────────────────────────

export interface UseStreamOptions extends HookOptions {
  /** How often (ms) the live vested amount ticks. Default 1000. */
  tickMs?: number;
  /** How often (ms) the on-chain stream state is refetched. Default 30_000. */
  refetchMs?: number;
  enabled?: boolean;
}

export interface UseStreamResult {
  stream: StreamInfo | null;
  /** Total streamed so far, recomputed locally every `tickMs`. */
  vestedAmount: bigint | null;
  /** Fraction of the stream's duration vested, in [0, 1]. */
  progress: number;
  /** Withdraw as the recipient (full balance by default), then refetch. */
  withdraw: (amount?: bigint) => Promise<string>;
  refresh: () => Promise<void>;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Live view of one stream: fetches `StreamInfo` (and refetches every
 * `refetchMs`), and recomputes the vested amount locally every `tickMs` so a
 * balance counter ticks up without an RPC call per second.
 */
export function useStream(
  streamId?: bigint | string | null,
  options?: UseStreamOptions,
): UseStreamResult {
  const client = useConduitClient(options?.client);
  const tickMs = options?.tickMs ?? 1000;
  const refetchMs = options?.refetchMs ?? 30_000;
  const enabled = options?.enabled ?? true;
  const active = streamId != null && enabled;

  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [isLoading, setIsLoading] = useState<boolean>(active);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (streamId == null) return;
    try {
      const info = await client.streams.get(streamId);
      if (mounted.current) {
        setStream(info);
        setError(null);
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (mounted.current) setIsLoading(false);
    }
  }, [client, streamId]);

  useEffect(() => {
    if (!active) {
      setStream(null);
      setIsLoading(false);
      setError(null);
      return;
    }
    setIsLoading(true);
    void refresh();
    const refetchId = setInterval(() => void refresh(), refetchMs);
    return () => clearInterval(refetchId);
  }, [active, refresh, refetchMs]);

  useEffect(() => {
    if (!active) return;
    const tickId = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), tickMs);
    return () => clearInterval(tickId);
  }, [active, tickMs]);

  const withdraw = useCallback(
    async (amount?: bigint): Promise<string> => {
      if (streamId == null) throw new Error('streamId is required for withdraw');
      const hash = await client.streams.withdraw(streamId, amount);
      await refresh();
      return hash;
    },
    [client, streamId, refresh],
  );

  const vestedAmount = stream ? streamedTotalLocal(stream, nowSec) : null;
  const progress = stream ? calculateVestedPercentage(stream, nowSec) : 0;

  return { stream, vestedAmount, progress, withdraw, refresh, isLoading, error };
}

// ── useStreamEvents (#1092) ──────────────────────────────────────────────────

export interface UseStreamEventsOptions extends HookOptions {
  enabled?: boolean;
}

export interface UseStreamEventsResult {
  error: Error | null;
}

/**
 * Subscribes to a stream's on-chain events for the component's lifetime and
 * delivers each one to `onEvent` as a typed {@link StreamEvent}. Changing
 * `onEvent` between renders does not resubscribe; changing `streamId` does.
 */
export function useStreamEvents(
  streamId: bigint | string | null | undefined,
  onEvent: (event: StreamEvent) => void,
  options?: UseStreamEventsOptions,
): UseStreamEventsResult {
  const client = useConduitClient(options?.client);
  const enabled = options?.enabled ?? true;
  const [error, setError] = useState<Error | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (streamId == null || !enabled) return;
    setError(null);
    const emit = (event: StreamEvent): void => onEventRef.current(event);
    const subscription = client.streams.subscribe(streamId, {
      onCreated: (event) => emit({ kind: 'created', event }),
      onWithdraw: (event) => emit({ kind: 'withdrawn', event }),
      onTopUp: (event) => emit({ kind: 'topped_up', event }),
      onPause: (event) => emit({ kind: 'paused', event }),
      onResume: (event) => emit({ kind: 'resumed', event }),
      onCancel: (event) => emit({ kind: 'cancelled', event }),
      onClawback: (event) => emit({ kind: 'clawback', event }),
      onForceCancel: (event) => emit({ kind: 'force_cancelled', event }),
      onRecipientTransfer: (event) => emit({ kind: 'recipient_transferred', event }),
      onOperatorSet: (event) => emit({ kind: 'operator_set', event }),
      onOperatorRevoke: (event) => emit({ kind: 'operator_revoked', event }),
      onError: (err) => setError(err),
    });
    return () => subscription.unsubscribe();
  }, [client, streamId, enabled]);

  return { error };
}

// ── 5. useWallet (#1093) ─────────────────────────────────────────────────────

/** localStorage key {@link useWallet} remembers the connected wallet under. */
export const WALLET_STORAGE_KEY = 'streamfi:wallet';

export interface UseWalletOptions extends HookOptions {
  /**
   * Adapters the user can pick from, keyed by a stable id (e.g.
   * `{ freighter: new FreighterWalletAdapter() }`). The id is what gets
   * persisted, so it must stay the same across page loads.
   */
  adapters: Record<string, WalletAdapter>;
  /** Re-attach the last connected wallet on mount. Defaults to `true`. */
  autoReconnect?: boolean;
  /** Override {@link WALLET_STORAGE_KEY}. */
  storageKey?: string;
}

export interface UseWalletResult {
  publicKey: string | null;
  walletId: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  /** True while the remembered wallet is being re-attached after a reload. */
  isReconnecting: boolean;
  error: Error | null;
  connect: (walletId: string) => Promise<string>;
  disconnect: () => Promise<void>;
}

interface WalletStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function walletStorage(): WalletStorage | null {
  try {
    const globalWithWindow = globalThis as typeof globalThis & {
      window?: { localStorage?: WalletStorage };
    };
    return globalWithWindow.window?.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Connects a wallet adapter to the client and remembers the choice in
 * localStorage, so the session is re-hydrated after a page reload instead of
 * being lost. Only the adapter id is stored — never keys or signatures.
 */
export function useWallet(options: UseWalletOptions): UseWalletResult {
  const client = useConduitClient(options.client);
  const storageKey = options.storageKey ?? WALLET_STORAGE_KEY;
  const autoReconnect = options.autoReconnect ?? true;
  const adaptersRef = useRef(options.adapters);
  adaptersRef.current = options.adapters;

  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const connect = useCallback(
    async (id: string): Promise<string> => {
      const adapter = adaptersRef.current[id];
      if (!adapter) {
        const e = new Error(`Unknown wallet "${id}"`);
        setError(e);
        throw e;
      }
      setIsConnecting(true);
      setError(null);
      try {
        const key = adapter.connect ? await adapter.connect() : await adapter.getPublicKey();
        client.setWallet(adapter);
        walletStorage()?.setItem(storageKey, id);
        setPublicKey(key);
        setWalletId(id);
        return key;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        setIsConnecting(false);
      }
    },
    [client, storageKey],
  );

  const disconnect = useCallback(async (): Promise<void> => {
    const adapter = walletId ? adaptersRef.current[walletId] : undefined;
    walletStorage()?.removeItem(storageKey);
    setPublicKey(null);
    setWalletId(null);
    setError(null);
    await adapter?.disconnect?.();
  }, [walletId, storageKey]);

  useEffect(() => {
    if (!autoReconnect) return;
    const storage = walletStorage();
    const savedId = storage?.getItem(storageKey) ?? null;
    if (!savedId) return;
    const adapter = adaptersRef.current[savedId];
    if (!adapter || adapter.isConnected?.() === false) {
      // The remembered wallet is gone or has revoked the session: forget it
      // rather than prompting the user on every load.
      storage?.removeItem(storageKey);
      return;
    }

    let isMounted = true;
    setIsReconnecting(true);
    Promise.resolve(adapter.getPublicKey())
      .then(key => {
        if (!isMounted) return;
        client.setWallet(adapter);
        setPublicKey(key);
        setWalletId(savedId);
      })
      .catch(() => {
        storage?.removeItem(storageKey);
      })
      .finally(() => {
        if (isMounted) setIsReconnecting(false);
      });

    return () => {
      isMounted = false;
    };
  }, [client, storageKey, autoReconnect]);

  return {
    publicKey,
    walletId,
    isConnected: publicKey !== null,
    isConnecting,
    isReconnecting,
    error,
    connect,
    disconnect,
  };
}

// ── 6. useBatchStreams (#1094) ───────────────────────────────────────────────

export type BatchStatus = 'idle' | 'pending' | 'success' | 'partial' | 'error';

export interface BatchProgress {
  status: BatchStatus;
  /** Items in the batch currently (or last) submitted. */
  total: number;
  succeeded: number;
  failed: number;
}

export interface UseBatchStreamsResult {
  createBatch: (configs: BatchStreamCreationPayload[]) => Promise<BatchCreateStreamResult[]>;
  withdrawBatch: (withdrawals: BatchWithdrawItem[]) => Promise<BatchWithdrawResult[]>;
  progress: BatchProgress;
  isPending: boolean;
  error: Error | null;
  createResults: BatchCreateStreamResult[];
  withdrawResults: BatchWithdrawResult[];
  reset: () => void;
}

const IDLE_PROGRESS: BatchProgress = { status: 'idle', total: 0, succeeded: 0, failed: 0 };

function settledProgress(results: Array<{ success: boolean }>): BatchProgress {
  const succeeded = results.filter(r => r.success).length;
  const failed = results.length - succeeded;
  const status: BatchStatus = failed === 0 ? 'success' : succeeded === 0 ? 'error' : 'partial';
  return { status, total: results.length, succeeded, failed };
}

/**
 * Declarative wrapper around `client.streams.createBatchStreams` and
 * `client.streams.batchWithdraw` for payroll-style batch operations. Each
 * item's outcome is reported individually (`partial` when some fail), since
 * the client isolates per-item failures instead of failing the whole batch.
 */
export function useBatchStreams(options?: HookOptions): UseBatchStreamsResult {
  const client = useConduitClient(options?.client);
  const [progress, setProgress] = useState<BatchProgress>(IDLE_PROGRESS);
  const [error, setError] = useState<Error | null>(null);
  const [createResults, setCreateResults] = useState<BatchCreateStreamResult[]>([]);
  const [withdrawResults, setWithdrawResults] = useState<BatchWithdrawResult[]>([]);

  const createBatch = useCallback(
    async (configs: BatchStreamCreationPayload[]): Promise<BatchCreateStreamResult[]> => {
      setProgress({ status: 'pending', total: configs.length, succeeded: 0, failed: 0 });
      setError(null);
      try {
        const results = await client.streams.createBatchStreams(configs);
        setCreateResults(results);
        setProgress(settledProgress(results));
        return results;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setProgress({ status: 'error', total: configs.length, succeeded: 0, failed: configs.length });
        throw e;
      }
    },
    [client],
  );

  const withdrawBatch = useCallback(
    async (withdrawals: BatchWithdrawItem[]): Promise<BatchWithdrawResult[]> => {
      setProgress({ status: 'pending', total: withdrawals.length, succeeded: 0, failed: 0 });
      setError(null);
      try {
        const results = await client.streams.batchWithdraw(withdrawals);
        setWithdrawResults(results);
        setProgress(settledProgress(results));
        return results;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setProgress({
          status: 'error',
          total: withdrawals.length,
          succeeded: 0,
          failed: withdrawals.length,
        });
        throw e;
      }
    },
    [client],
  );

  const reset = useCallback(() => {
    setProgress(IDLE_PROGRESS);
    setError(null);
    setCreateResults([]);
    setWithdrawResults([]);
  }, []);

  return {
    createBatch,
    withdrawBatch,
    progress,
    isPending: progress.status === 'pending',
    error,
    createResults,
    withdrawResults,
    reset,
  };
}

// ── useStreamHistory ─────────────────────────────────────────────────────────

/** Categories of stream activity exposed by {@link useStreamHistory}. */
export type StreamHistoryType = 'deposit' | 'withdrawal' | 'cancellation';

const DEFAULT_STREAM_HISTORY_TYPES: readonly StreamHistoryType[] = [
  'deposit',
  'withdrawal',
  'cancellation',
];

/** Underlying RPC event kinds that make up each history category. */
const HISTORY_KINDS: Record<StreamHistoryType, ReadonlyArray<StreamHistoryEntry['kind']>> = {
  deposit: ['created', 'top_up'],
  withdrawal: ['withdraw'],
  cancellation: ['cancel'],
};

function matchesHistoryType(entry: StreamHistoryEntry, type: StreamHistoryType): boolean {
  return HISTORY_KINDS[type].includes(entry.kind);
}

export interface UseStreamHistoryOptions extends HookOptions {
  enabled?: boolean;
  /**
   * Background revalidation interval in milliseconds. Defaults to 30,000.
   * Set to `0` to disable interval-based revalidation.
   */
  refreshIntervalMs?: number;
  /** Revalidate when the tab regains focus/visibility. Defaults to `true`. */
  revalidateOnFocus?: boolean;
  /** Page size passed to `client.streams.getHistory` (1-200). Default 50. */
  limit?: number;
  /** Categories included in `entries`. Defaults to all three. */
  types?: StreamHistoryType[];
}

export interface UseStreamHistoryResult {
  /** The selected activity, oldest first. Stale data is kept while revalidating. */
  entries: StreamHistoryEntry[];
  deposits: StreamHistoryEntry[];
  withdrawals: StreamHistoryEntry[];
  cancellations: StreamHistoryEntry[];
  /** True only for the initial load, while no data has been shown yet. */
  isLoading: boolean;
  /** True while any (including background) revalidation is in flight. */
  isValidating: boolean;
  error: Error | null;
  /** Revalidate immediately, keeping previously fetched data on screen (SWR-style). */
  refresh: () => Promise<void>;
}

type FocusTarget = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/**
 * Fetches a stream's past deposits (creations + top-ups), withdrawals and
 * cancellations. A successful fetch is served from state on subsequent
 * revalidations — `refresh()`, the interval, and window focus all revalidate
 * in the background instead of clearing the table.
 */
export function useStreamHistory(
  streamId?: bigint | string | null,
  options?: UseStreamHistoryOptions,
): UseStreamHistoryResult {
  const client = useConduitClient(options?.client);
  const enabled = options?.enabled ?? true;
  const refreshIntervalMs = options?.refreshIntervalMs ?? 30_000;
  const revalidateOnFocus = options?.revalidateOnFocus ?? true;
  const limit = options?.limit ?? 50;
  const types = options?.types;
  const typesKey = types && types.length > 0 ? [...types].sort().join(',') : 'all';
  const active = streamId != null && enabled;

  const [allEntries, setAllEntries] = useState<StreamHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(active);
  const [isValidating, setIsValidating] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(true);
  const requestId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current++;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (streamId == null) return;
    const id = ++requestId.current;
    setIsValidating(true);
    try {
      const page = await client.streams.getHistory(streamId, { limit });
      if (mounted.current && id === requestId.current) {
        setAllEntries(page.entries);
        setError(null);
      }
    } catch (err) {
      if (mounted.current && id === requestId.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      if (mounted.current && id === requestId.current) {
        setIsValidating(false);
        setIsLoading(false);
      }
    }
  }, [client, streamId, limit]);

  useEffect(() => {
    if (!active) {
      requestId.current++;
      setAllEntries([]);
      setIsLoading(false);
      setIsValidating(false);
      setError(null);
      return;
    }
    setAllEntries([]);
    setIsLoading(true);
    void refresh();
    if (refreshIntervalMs <= 0) return;
    const intervalId = setInterval(() => void refresh(), refreshIntervalMs);
    return () => clearInterval(intervalId);
  }, [active, refresh, refreshIntervalMs]);

  useEffect(() => {
    if (!active || !revalidateOnFocus) return;
    const global = globalThis as typeof globalThis & {
      window?: FocusTarget;
      document?: FocusTarget & { visibilityState?: string };
    };
    const win = global.window;
    const doc = global.document;
    if (!win && !doc) return;

    const onFocus = (): void => {
      void refresh();
    };
    const onVisibility = (): void => {
      if (doc?.visibilityState === 'visible') onFocus();
    };
    win?.addEventListener('focus', onFocus);
    doc?.addEventListener('visibilitychange', onVisibility);
    return () => {
      win?.removeEventListener('focus', onFocus);
      doc?.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, revalidateOnFocus, refresh]);

  const deposits = useMemo(
    () => allEntries.filter((entry) => matchesHistoryType(entry, 'deposit')),
    [allEntries],
  );
  const withdrawals = useMemo(
    () => allEntries.filter((entry) => matchesHistoryType(entry, 'withdrawal')),
    [allEntries],
  );
  const cancellations = useMemo(
    () => allEntries.filter((entry) => matchesHistoryType(entry, 'cancellation')),
    [allEntries],
  );
  const entries = useMemo(() => {
    const selected = new Set<StreamHistoryType>(
      types && types.length > 0 ? types : DEFAULT_STREAM_HISTORY_TYPES,
    );
    return allEntries.filter((entry) =>
      [...selected].some((type) => matchesHistoryType(entry, type)),
    );
  }, [allEntries, typesKey]);

  return {
    entries,
    deposits,
    withdrawals,
    cancellations,
    isLoading,
    isValidating,
    error,
    refresh,
  };
}

// ── useEstimatedFee ──────────────────────────────────────────────────────────

/** Stable, bigint-safe cache key for a stream operation. */
function stableOperationKey(operation?: StreamOperation | null): string | null {
  if (operation == null) return null;
  return typeof operation === 'string'
    ? operation
    : JSON.stringify(operation, (_, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
}

export interface UseEstimatedFeeOptions extends HookOptions {
  enabled?: boolean;
  /** Delay in milliseconds after the last input change. Defaults to 300. */
  debounceMs?: number;
}

export interface UseEstimatedFeeResult {
  estimate: FeeEstimate | null;
  isLoading: boolean;
  error: Error | null;
  /** Recompute now, bypassing the debounce timer. */
  refresh: () => Promise<void>;
  /** Alias of {@link UseEstimatedFeeResult.refresh}. */
  refetch: () => Promise<void>;
}

/**
 * Estimates the network fee for a form's current operation, debounced so that
 * typing in a form triggers at most one estimate after the user stops changing
 * inputs. Stale responses from superseded requests are discarded.
 */
export function useEstimatedFee(
  operation?: StreamOperation | null,
  options?: UseEstimatedFeeOptions,
): UseEstimatedFeeResult {
  const client = useConduitClient(options?.client);
  const enabled = options?.enabled ?? true;
  const debounceMs = Math.max(0, options?.debounceMs ?? 300);
  const opKey = stableOperationKey(operation);
  const operationRef = useRef(operation);
  operationRef.current = operation;

  const [estimate, setEstimate] = useState<FeeEstimate | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(true);
  const requestId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current++;
    };
  }, []);

  const runEstimate = useCallback(async (): Promise<void> => {
    const currentOperation = operationRef.current;
    if (currentOperation == null) return;
    const id = ++requestId.current;
    setIsLoading(true);
    try {
      const fee = await client.streams.estimateFee(currentOperation);
      if (mounted.current && id === requestId.current) {
        setEstimate(fee);
        setError(null);
      }
    } catch (err) {
      if (mounted.current && id === requestId.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      if (mounted.current && id === requestId.current) {
        setIsLoading(false);
      }
    }
  }, [client]);

  useEffect(() => {
    if (!enabled || opKey == null) {
      requestId.current++;
      setEstimate(null);
      setIsLoading(false);
      setError(null);
      return;
    }
    setIsLoading(true);
    const timer = setTimeout(() => void runEstimate(), debounceMs);
    return () => clearTimeout(timer);
  }, [enabled, opKey, debounceMs, runEstimate]);

  return { estimate, isLoading, error, refresh: runEstimate, refetch: runEstimate };
}

// ── useClaimableBalance (#1160) ───────────────────────────────────────────────

export interface UseClaimableBalanceOptions {
  /**
   * How often (ms) the hook syncs the base withdrawable amount from the
   * stream's on-chain state. Defaults to 10_000. Set to 0 to disable
   * interval-based syncing.
   */
  syncIntervalMs?: number;
}

export interface UseClaimableBalanceResult {
  /**
   * The smoothly interpolated claimable balance in stroops, updated every
   * animation frame. `null` while the stream is undefined or not yet synced.
   */
  balance: bigint | null;
}

/**
 * Returns a continuously ticking claimable balance for `stream`, updated
 * every animation frame via `requestAnimationFrame` so the counter increments
 * smoothly in real time without an RPC call per frame.
 *
 * The base withdrawable amount is computed locally from `stream` using
 * `withdrawableLocal`, then extrapolated forward by `stream.ratePerSecond`
 * for each sub-second tick. When the stream is paused or cancelled the
 * balance is frozen at its last computed value.
 *
 * @example
 * ```tsx
 * function BalanceDisplay({ stream }: { stream: StreamInfo }) {
 *   const { balance } = useClaimableBalance(stream);
 *   return <span>{balance?.toString() ?? '…'}</span>;
 * }
 * ```
 */
export function useClaimableBalance(
  stream: StreamInfo | undefined,
  options?: UseClaimableBalanceOptions,
): UseClaimableBalanceResult {
  const syncIntervalMs = options?.syncIntervalMs ?? 10_000;
  const [balance, setBalance] = useState<bigint | null>(null);

  // Stable ref so the rAF callback always reads the latest stream without
  // being recreated (which would cancel and restart the animation loop).
  const streamRef = useRef<StreamInfo | undefined>(stream);
  streamRef.current = stream;

  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!stream) {
      setBalance(null);
      return;
    }

    // Seed the base amount once synchronously so the first render shows a
    // value instead of null.
    const computeBalance = (s: StreamInfo): bigint => {
      if (s.cancelled || s.paused) {
        return withdrawableLocal(s);
      }
      const nowSec = Date.now() / 1000;
      return withdrawableLocal(s, nowSec);
    };

    setBalance(computeBalance(stream));

    // rAF loop — extrapolates balance every frame using sub-second precision.
    const tick = (): void => {
      const s = streamRef.current;
      if (!s) return;
      setBalance(computeBalance(s));
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  // Re-run only when the stream identity changes (new id or goes undefined).
  // The rAF loop always reads the latest value via streamRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream?.id]);

  // Optionally re-seed from local state on an interval so the base value
  // stays accurate if the caller doesn't pass a live-updated StreamInfo.
  useEffect(() => {
    if (!stream || syncIntervalMs <= 0) return;

    const id = setInterval(() => {
      const s = streamRef.current;
      if (!s) return;
      setBalance(withdrawableLocal(s));
    }, syncIntervalMs);

    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream?.id, syncIntervalMs]);

  return { balance };
}
