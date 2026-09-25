import { useState, useEffect, useCallback, useMemo } from 'react';
import type { ConduitClient } from '../client.js';
import type {
  StreamOperation,
  BatchWithdrawItem,
  BatchWithdrawResult,
} from '../types/index.js';
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
  estimate: number | null;
  isLoading: boolean;
  error: Error | null;
}

export function useFeeEstimate(
  operation?: StreamOperation | null,
  options?: UseFeeEstimateOptions,
): UseFeeEstimateResult {
  const client = useConduitClient(options?.client);
  const enabled = options?.enabled ?? true;
  const [estimate, setEstimate] = useState<number | null>(null);
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
