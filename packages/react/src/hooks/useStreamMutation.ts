import { useCallback, useState } from 'react';
import type { ConduitClient } from '@conduit-protocol/sdk';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export type StreamMutationId = bigint | string | null | undefined;

export interface UseStreamMutationState {
  isPending: boolean;
  error: Error | null;
  txHash: string | null;
}

export interface UseStreamMutationResult<TArgs extends unknown[]> extends UseStreamMutationState {
  mutate: (...args: TArgs) => Promise<string>;
  reset: () => void;
}

export function useStreamMutation<TArgs extends unknown[]>(
  streamId: StreamMutationId,
  action: (client: ConduitClient, streamId: bigint | string, ...args: TArgs) => Promise<string>,
): UseStreamMutationResult<TArgs> {
  const { client, isReady } = useStreamFiClient();
  const [state, setState] = useState<UseStreamMutationState>({
    isPending: false,
    error: null,
    txHash: null,
  });

  const reset = useCallback(() => {
    setState({ isPending: false, error: null, txHash: null });
  }, []);

  const mutate = useCallback(
    async (...args: TArgs): Promise<string> => {
      if (!isReady || !client) {
        const err = new Error('ConduitClient is not connected. Wrap your component with <StreamFiProvider>.');
        setState({ isPending: false, error: err, txHash: null });
        throw err;
      }

      if (streamId == null || streamId === '') {
        const err = new Error('streamId is required for this stream operation.');
        setState({ isPending: false, error: err, txHash: null });
        throw err;
      }

      setState({ isPending: true, error: null, txHash: null });

      try {
        const txHash = await action(client, streamId, ...args);
        setState({ isPending: false, error: null, txHash });
        return txHash;
      } catch (err: unknown) {
        const typed = err instanceof Error ? err : new Error(String(err));
        setState({ isPending: false, error: typed, txHash: null });
        throw typed;
      }
    },
    [action, client, isReady, streamId],
  );

  return { ...state, mutate, reset };
}