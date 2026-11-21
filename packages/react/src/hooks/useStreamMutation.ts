import { useCallback, useState } from 'react';
import type { ConduitClient } from '@conduit-protocol/sdk';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export type StreamMutationId = bigint | string | null | undefined;

export interface UseStreamMutationState {
  isPending: boolean;
  error: Error | null;
  txHash: string | null;
}

export interface UseStreamMutationResult<TArgs extends unknown[], TResult = string> extends UseStreamMutationState {
  mutate: (...args: TArgs) => Promise<TResult>;
  reset: () => void;
}

function extractTxHash<TResult>(result: TResult): string | null {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'txHash' in result && typeof (result as { txHash?: unknown }).txHash === 'string') {
    return (result as { txHash: string }).txHash;
  }
  return null;
}

export function useStreamMutation<TArgs extends unknown[], TResult = string>(
  streamId: StreamMutationId,
  action: (client: ConduitClient, streamId: bigint | string, ...args: TArgs) => Promise<TResult>,
): UseStreamMutationResult<TArgs, TResult> {
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
    async (...args: TArgs): Promise<TResult> => {
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
        const result = await action(client, streamId, ...args);
        setState({ isPending: false, error: null, txHash: extractTxHash(result) });
        return result;
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