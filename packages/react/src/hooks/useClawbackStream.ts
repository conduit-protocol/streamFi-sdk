import { useCallback, useState } from 'react';
import type { ConduitClient } from '@conduit-protocol/sdk';
import { useStreamFiClient } from '../context/useStreamFiClient.js';
import type { StreamMutationId } from './useStreamMutation.js';

export type ClawbackStreamFn = () => Promise<bigint>;

export interface UseClawbackStreamResult {
  isPending: boolean;
  error: Error | null;
  reclaimedAmount: bigint | null;
  txHash: string | null;
  clawback: ClawbackStreamFn;
  reset: () => void;
}

/**
 * Hook for clawbacking unstreamed tokens from a stream.
 *
 * Unlike other mutation hooks, clawback returns the reclaimed amount
 * (bigint) instead of a transaction hash, so it uses a custom mutation
 * instead of `useStreamMutation`.
 */
export function useClawbackStream(streamId: StreamMutationId): UseClawbackStreamResult {
  const { client, isReady } = useStreamFiClient();
  const [state, setState] = useState<{
    isPending: boolean;
    error: Error | null;
    reclaimedAmount: bigint | null;
    txHash: string | null;
  }>({ isPending: false, error: null, reclaimedAmount: null, txHash: null });

  const reset = useCallback(() => {
    setState({ isPending: false, error: null, reclaimedAmount: null, txHash: null });
  }, []);

  const clawback = useCallback<ClawbackStreamFn>(async () => {
    if (!isReady || !client) {
      const err = new Error('ConduitClient is not connected. Wrap your component with <StreamFiProvider>.');
      setState((s) => ({ ...s, error: err }));
      throw err;
    }

    if (streamId == null || streamId === '') {
      const err = new Error('streamId is required for clawback.');
      setState((s) => ({ ...s, error: err }));
      throw err;
    }

    setState({ isPending: true, error: null, reclaimedAmount: null, txHash: null });

    try {
      const reclaimedAmount = await client.streams.clawback(streamId);
      setState({ isPending: false, error: null, reclaimedAmount, txHash: null });
      return reclaimedAmount;
    } catch (err: unknown) {
      const typed = err instanceof Error ? err : new Error(String(err));
      setState({ isPending: false, error: typed, reclaimedAmount: null, txHash: null });
      throw typed;
    }
  }, [client, isReady, streamId]);

  return { ...state, clawback, reset };
}
