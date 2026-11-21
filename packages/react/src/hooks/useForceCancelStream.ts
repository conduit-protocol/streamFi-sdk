import { useCallback } from 'react';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';

export type ForceCancelStreamFn = () => Promise<string>;

export interface UseForceCancelStreamResult extends UseStreamMutationState {
  forceCancel: ForceCancelStreamFn;
  reset: () => void;
}

export function useForceCancelStream(streamId: StreamMutationId): UseForceCancelStreamResult {
  const { mutate, isPending, error, txHash, reset } = useStreamMutation(streamId, (client, id) =>
    client.streams.forceCancel(id),
  );

  const forceCancel = useCallback<ForceCancelStreamFn>(() => mutate(), [mutate]);

  return { forceCancel, isPending, error, txHash, reset };
}
