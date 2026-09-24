import { useCallback } from 'react';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';

export type PauseStreamFn = () => Promise<string>;

export interface UsePauseStreamResult extends UseStreamMutationState {
  mutate: PauseStreamFn;
  pause: PauseStreamFn;
  reset: () => void;
}

export function usePauseStream(streamId: StreamMutationId): UsePauseStreamResult {
  const mutation = useStreamMutation(streamId, (client, id) => client.streams.pause(id));
  const pause = useCallback<PauseStreamFn>(() => mutation.mutate(), [mutation]);

  return { ...mutation, mutate: pause, pause };
}