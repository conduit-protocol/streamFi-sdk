import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { ConduitClient } from '../client.js';
import type {
  StreamOperation,
  BatchWithdrawItem,
  BatchWithdrawResult,
  FeeEstimate,
  StreamInfo,
} from '../types/index.js';
import type { StreamEvent } from '../events.js';
import { streamedTotalLocal } from '../utils.js';
import { calculateVestedPercentage } from '../streams.js';
import { useConduitClient } from './context.js';

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
