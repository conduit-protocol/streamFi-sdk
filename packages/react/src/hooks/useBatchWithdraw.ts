import { useState, useCallback } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';
import type { BatchWithdrawItem, BatchWithdrawResult } from '@conduit-protocol/sdk';

export interface UseBatchWithdrawState {
  loading: boolean;
  error: Error | null;
  results: BatchWithdrawResult[];
}

export type BatchWithdrawFn = (withdrawals: BatchWithdrawItem[]) => Promise<BatchWithdrawResult[]>;

export interface UseBatchWithdrawResult extends UseBatchWithdrawState {
  batchWithdraw: BatchWithdrawFn;
  reset: () => void;
}

export function useBatchWithdraw(): UseBatchWithdrawResult {
  const { client, isReady } = useStreamFiClient();
  const [state, setState] = useState<UseBatchWithdrawState>({
    loading: false,
    error: null,
    results: [],
  });

  const reset = useCallback(() => {
    setState({ loading: false, error: null, results: [] });
  }, []);

  const batchWithdraw = useCallback(
    async (withdrawals: BatchWithdrawItem[]): Promise<BatchWithdrawResult[]> => {
      if (!isReady || !client) {
        const err = new Error('ConduitClient is not connected. Wrap your component with <StreamFiProvider>.');
        setState({ loading: false, error: err, results: [] });
        throw err;
      }

      setState({ loading: true, error: null, results: [] });

      try {
        const results = await client.streams.batchWithdraw(withdrawals);
        setState({ loading: false, error: null, results });
        return results;
      } catch (err: unknown) {
        const typed = err instanceof Error ? err : new Error(String(err));
        setState({ loading: false, error: typed, results: [] });
        throw typed;
      }
    },
    [client, isReady],
  );

  return { ...state, batchWithdraw, reset };
}
