import { useCallback } from 'react';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';

export type ResumeStreamFn = () => Promise<string>;

export interface UseResumeStreamResult extends UseStreamMutationState {
  mutate: ResumeStreamFn;
  resume: ResumeStreamFn;
  reset: () => void;
}

export function useResumeStream(streamId: StreamMutationId): UseResumeStreamResult {
  const mutation = useStreamMutation(streamId, (client, id) => client.streams.resume(id));
  const resume = useCallback<ResumeStreamFn>(() => mutation.mutate(), [mutation]);

  return { ...mutation, mutate: resume, resume };
}