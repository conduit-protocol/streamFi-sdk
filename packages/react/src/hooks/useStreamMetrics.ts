import { useState, useEffect, useCallback, useRef } from 'react';
import type { StreamInfo } from '@conduit-protocol/sdk';
import { streamStatus, withdrawableLocal } from '@conduit-protocol/sdk';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

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

export interface UseStreamMetricsOptions {
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

export function useStreamMetrics(options?: UseStreamMetricsOptions): UseStreamMetricsResult {
  const { client, isReady } = useStreamFiClient();
  const enabled = options?.enabled ?? true;
  const refreshIntervalMs = options?.refreshIntervalMs ?? 15000;

  const [metrics, setMetrics] = useState<StreamMetrics | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(enabled && isReady);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const fetchMetrics = useCallback(async () => {
    if (!client || !isReady || !enabled) {
      setMetrics(null);
      setIsLoading(false);
      return;
    }

    const currentReqId = ++requestIdRef.current;
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
          // ignore error, fallback to streams length
        }
      }

      if (requestIdRef.current !== currentReqId) return;

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
      if (requestIdRef.current === currentReqId) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      if (requestIdRef.current === currentReqId) {
        setIsLoading(false);
      }
    }
  }, [client, isReady, enabled]);

  useEffect(() => {
    if (!enabled || !isReady) {
      setMetrics(null);
      setIsLoading(false);
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
  }, [fetchMetrics, enabled, isReady, refreshIntervalMs]);

  return {
    metrics,
    loading: isLoading,
    isLoading,
    error,
    refetch: fetchMetrics,
  };
}
