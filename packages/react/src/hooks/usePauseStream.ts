import { useCallback } from 'react';
import { useStream, type UseStreamResult } from './useStream.js';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';

export type PauseStreamFn = () => Promise<string>;

export interface UsePauseStreamResult extends UseStreamMutationState {
  mutate: PauseStreamFn;
  pause: PauseStreamFn;
  /** True only while the pause transaction is in flight; lets UIs show "Pausing Stream...". */
  isPausing: boolean;
  reset: () => void;
}

export function usePauseStream(streamId: StreamMutationId): UsePauseStreamResult {
  const { stream, setStream } = useStream(streamId) as UseStreamResult;
  const mutation = useStreamMutation(streamId, (client, id) => client.streams.pause(id));

  const pause = useCallback<PauseStreamFn>(async () => {
    const previous = stream;
    if (stream) {
      setStream((current) => current ? { ...current, paused: true, pausedAt: Math.floor(Date.now() / 1000), cancelled: false } : current);
    }

    try {
      return await mutation.mutate();
    } catch (error) {
      if (previous) setStream(previous);
      throw error;
    }
  }, [mutation, setStream, stream]);

  return { ...mutation, mutate: pause, pause, isPausing: mutation.isPending };
}