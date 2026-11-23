import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ConduitClient } from '../client.js';
import type {
  StreamOperation,
  BatchWithdrawItem,
  BatchWithdrawResult,
  FeeEstimate,
  StreamInfo,
} from '../types/index.js';
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

  const opKey = useMemo(() => {
    if (operation == null) return null;
    return typeof operation === 'string'
      ? operation
      : JSON.stringify(operation, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  }, [operation]);

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
