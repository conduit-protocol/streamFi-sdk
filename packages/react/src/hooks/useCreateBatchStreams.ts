import { useState, useCallback } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';
import { toStroops, type StreamConfig, type BatchCreateStreamResult } from '@conduit-protocol/sdk';

export interface UseCreateBatchStreamsState {
  loading: boolean;
  error: Error | null;
  results: BatchCreateStreamResult[];
}

export type OnBatchProgress = (completed: number, total: number) => void;

export type CreateBatchStreamsFn = (
  configs: StreamConfig[],
  onProgress?: OnBatchProgress,
) => Promise<BatchCreateStreamResult[]>;

export type EstimateTotalBatchCostFn = (configs: StreamConfig[]) => bigint;

export interface UseCreateBatchStreamsResult extends UseCreateBatchStreamsState {
  createBatchStreams: CreateBatchStreamsFn;
  /** Total deposit across all configs, in stroops. Pure: does not touch the network or hook state. */
  estimateTotalBatchCost: EstimateTotalBatchCostFn;
  reset: () => void;
}

/**
 * Sums the deposit of every config in a batch, in stroops, so a UI can show
 * the treasury balance needed before submitting.
 *
 * @example
 * estimateTotalBatchCost([{ depositAmount: '10' }, { depositAmount: '2.5' }]) // 125_000_000n
 */
export const estimateTotalBatchCost: EstimateTotalBatchCostFn = (configs) =>
  configs.reduce((total, config) => total + toStroops(config.depositAmount), 0n);

export function useCreateBatchStreams(): UseCreateBatchStreamsResult {
  const { client, isReady } = useStreamFiClient();
  const [state, setState] = useState<UseCreateBatchStreamsState>({
    loading: false,
    error: null,
    results: [],
  });

  const reset = useCallback(() => {
    setState({ loading: false, error: null, results: [] });
  }, []);

  const createBatchStreams = useCallback(
    async (configs: StreamConfig[], onProgress?: OnBatchProgress): Promise<BatchCreateStreamResult[]> => {
      if (!isReady || !client) {
        const err = new Error('ConduitClient is not connected. Wrap your component with <StreamFiProvider>.');
        setState({ loading: false, error: err, results: [] });
        throw err;
      }

      const total = configs.length;
      if (total === 0) {
        setState({ loading: false, error: null, results: [] });
        return [];
      }

      setState({ loading: true, error: null, results: [] });

      try {
        const results: BatchCreateStreamResult[] = [];
        const chunkSize = 10;
        for (let index = 0; index < configs.length; index += chunkSize) {
          const chunk = configs.slice(index, index + chunkSize);
          const chunkResults = await client.streams.createBatchStreams(chunk);
          results.push(...chunkResults);
          onProgress?.(Math.min(index + chunk.length, total), total);
        }

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

  return { ...state, createBatchStreams, estimateTotalBatchCost, reset };
}
