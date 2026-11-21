import { useCallback } from 'react';
import type { StreamInfo } from '@conduit-protocol/sdk';
import { useStream, type UseStreamResult } from './useStream.js';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';

export interface ResumeStreamResult {
  txHash: string;
  stream: StreamInfo | null;
}

export type ResumeStreamFn = () => Promise<ResumeStreamResult>;

export interface UseResumeStreamResult extends UseStreamMutationState {
  mutate: ResumeStreamFn;
  resume: ResumeStreamFn;
  reset: () => void;
}

/**
 * Rejects resume when the loaded snapshot shows the stream cannot be resumed,
 * so no transaction is submitted. Only a known state is checked: an unloaded
 * or partial snapshot is passed through and the contract decides.
 */
function assertResumable(stream: StreamInfo | null): void {
  if (stream && (stream.cancelled || stream.paused === false)) {
    throw new Error('Stream is not paused and cannot be resumed.');
  }
}

export function useResumeStream(streamId: StreamMutationId): UseResumeStreamResult {
  const { stream, setStream } = useStream(streamId) as UseStreamResult;
  const mutation = useStreamMutation(streamId, async (client, id) => {
    const txHash = await client.streams.resume(id);
    const nextStream = typeof client.streams?.get === 'function'
      ? await client.streams.get(id).catch(() => null)
      : null;
    return { txHash, stream: nextStream };
  });

  const resume = useCallback<ResumeStreamFn>(async () => {
    assertResumable(stream);
    const previous = stream;
    if (stream) {
      setStream((current) => current ? { ...current, paused: false, pausedAt: 0 } : current);
    }

    try {
      return await mutation.mutate();
    } catch (error) {
      if (previous) setStream(previous);
      throw error;
    }
  }, [mutation, setStream, stream]);

  return { ...mutation, mutate: resume, resume };
}