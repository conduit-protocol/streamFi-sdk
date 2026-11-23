import { useState, useCallback } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';
import type { CreateStreamParams, CreateStreamResult, FeeEstimate } from '@conduit-protocol/sdk';

export interface UseCreateStreamState {
  loading: boolean;
  error: Error | null;
  result: CreateStreamResult | null;
  /**
   * The Soroban simulation's fee estimate for the most recent `createStream`
   * call (#931), so a confirmation dialog can show the cost before the
   * transaction confirms. `null` until the dry-run simulation completes, or
   * if estimation itself failed — estimation is advisory and never blocks
   * the actual creation below.
   */
  simulationResult: FeeEstimate | null;
  /** Convenience accessor for `simulationResult.totalFee` (#931). */
  estimatedFee: bigint | null;
}

export type CreateStreamFn = (params: CreateStreamParams) => Promise<CreateStreamResult>;

export interface UseCreateStreamResult extends UseCreateStreamState {
  createStream: CreateStreamFn;
  reset: () => void;
}

const INITIAL_STATE: UseCreateStreamState = {
  loading: false,
  error: null,
  result: null,
  simulationResult: null,
  estimatedFee: null,
};

export function useCreateStream(): UseCreateStreamResult {
  const { client, isReady } = useStreamFiClient();
  const [state, setState] = useState<UseCreateStreamState>(INITIAL_STATE);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const createStream = useCallback(
    async (params: CreateStreamParams): Promise<CreateStreamResult> => {
      if (!isReady || !client) {
        const err = new Error('ConduitClient is not connected. Wrap your component with <StreamFiProvider>.');
        setState({ ...INITIAL_STATE, error: err });
        throw err;
      }

      setState((prev) => ({ ...prev, loading: true, error: null, result: null }));

      // Dry-run simulation (#931): best-effort only. A failed or unavailable
      // estimate must never block the real creation below — it's purely for
      // a confirmation dialog to read while the transaction is in flight.
      if (typeof client.estimateFee === 'function') {
        try {
          const simulationResult = await client.estimateFee({ type: 'create', params });
          setState((prev) => ({ ...prev, simulationResult, estimatedFee: simulationResult.totalFee }));
        } catch {
          // Advisory only — swallow and proceed to the real create() below.
        }
      }

      try {
        const result = await client.streams.create(params);
        setState((prev) => ({ ...prev, loading: false, error: null, result }));
        return result;
      } catch (err: unknown) {
        const typed = err instanceof Error ? err : new Error(String(err));
        setState((prev) => ({ ...prev, loading: false, error: typed, result: null }));
        throw typed;
      }
    },
    [client, isReady],
  );

  return { ...state, createStream, reset };
}
