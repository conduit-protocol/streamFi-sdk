import { useCallback } from 'react';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';

export type CancelStreamFn = () => Promise<string>;

export interface UseCancelStreamResult extends UseStreamMutationState {
  cancel: CancelStreamFn;
  isCancelling: boolean;
  reset: () => void;
}

export function useCancelStream(streamId: StreamMutationId): UseCancelStreamResult {
  const { mutate, isPending, error, txHash, reset } = useStreamMutation(streamId, (client, id) =>
    client.streams.cancel(id),
  );

  const cancel = useCallback<CancelStreamFn>(() => mutate(), [mutate]);

  return { cancel, isCancelling: isPending, isPending, error, txHash, reset };
}