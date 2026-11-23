import { useCallback, useRef, useState } from 'react';
import type { StreamInfo } from '@conduit-protocol/sdk';
import { useStreamFiClient } from '../context/useStreamFiClient.js';
import type { StreamMutationId } from './useStreamMutation.js';

/** Optimistic lifecycle status exposed while a clawback settles on-chain. */
export type ClawbackStatus = 'idle' | 'clawed_back' | 'error';

export interface ClawbackMutationOptions<TContext = unknown> {
  /**
   * Runs before the transaction is submitted, after the optimistic flag is
   * set. Return value is passed as `context` to the other callbacks (e.g. a
   * snapshot of cached data to restore in `onError`).
   */
  onMutate?: (streamId: bigint | string) => TContext | Promise<TContext>;
  onSuccess?: (reclaimedAmount: bigint, streamId: bigint | string, context: TContext | undefined) => void;
  /** Runs after the optimistic state has been rolled back. */
  onError?: (error: Error, streamId: bigint | string, context: TContext | undefined) => void;
  onSettled?: (
    reclaimedAmount: bigint | undefined,
    error: Error | null,
    streamId: bigint | string,
    context: TContext | undefined,
  ) => void;
}

export interface UseClawbackStreamMutationResult {
  /** `true` immediately on `mutate()` and stays true if the clawback succeeds; rolled back on failure. */
  isClawedBack: boolean;
  status: ClawbackStatus;
  isPending: boolean;
  error: Error | null;
  reclaimedAmount: bigint | null;
  mutate: () => Promise<bigint>;
  /** Applies the optimistic clawback to a fetched stream (`clawbackEnabled` is spent, so it is cleared). */
  applyOptimistic: (stream: StreamInfo) => StreamInfo & { clawedBack: boolean };
  reset: () => void;
}

/**
 * Clawback mutation with an optimistic "clawed back" state, following TanStack
 * Query mutation conventions (`onMutate` / `onError` rollback / `onSuccess` /
 * `onSettled`). The UI can read `isClawedBack` right away while the
 * transaction settles; a failure rolls it back and surfaces `error`.
 */
export function useClawbackStreamMutation<TContext = unknown>(
  streamId: StreamMutationId,
  options: ClawbackMutationOptions<TContext> = {},
): UseClawbackStreamMutationResult {
  const { client, isReady } = useStreamFiClient();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const inFlightRef = useRef<Promise<bigint> | null>(null);
  const [state, setState] = useState<{
    isClawedBack: boolean;
    isPending: boolean;
    error: Error | null;
    reclaimedAmount: bigint | null;
  }>({ isClawedBack: false, isPending: false, error: null, reclaimedAmount: null });

  const reset = useCallback(() => {
    setState({ isClawedBack: false, isPending: false, error: null, reclaimedAmount: null });
  }, []);

  const mutate = useCallback((): Promise<bigint> => {
    // Collapse double-clicks into the same on-chain transaction.
    if (inFlightRef.current) return inFlightRef.current;

    const run = async (): Promise<bigint> => {
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

      // Optimistic update first, so the UI never waits on the wallet.
      setState({ isClawedBack: true, isPending: true, error: null, reclaimedAmount: null });
      let context: TContext | undefined;
      try {
        context = await optionsRef.current.onMutate?.(streamId);
        const reclaimedAmount = await client.streams.clawback(streamId);
        setState({ isClawedBack: true, isPending: false, error: null, reclaimedAmount });
        optionsRef.current.onSuccess?.(reclaimedAmount, streamId, context);
        optionsRef.current.onSettled?.(reclaimedAmount, null, streamId, context);
        return reclaimedAmount;
      } catch (err: unknown) {
        const typed = err instanceof Error ? err : new Error(String(err));
        // Rollback.
        setState({ isClawedBack: false, isPending: false, error: typed, reclaimedAmount: null });
        optionsRef.current.onError?.(typed, streamId, context);
        optionsRef.current.onSettled?.(undefined, typed, streamId, context);
        throw typed;
      }
    };

    const promise = run().finally(() => { inFlightRef.current = null; });
    inFlightRef.current = promise;
    return promise;
  }, [client, isReady, streamId]);

  const applyOptimistic = useCallback(
    (stream: StreamInfo) => ({
      ...stream,
      clawbackEnabled: state.isClawedBack ? false : stream.clawbackEnabled,
      clawedBack: state.isClawedBack,
    }),
    [state.isClawedBack],
  );

  const status: ClawbackStatus = state.isClawedBack ? 'clawed_back' : state.error ? 'error' : 'idle';

  return { ...state, status, mutate, applyOptimistic, reset };
}

/** Alias matching the `useStreamClawbackMutation` naming used in the issue tracker. */
export const useStreamClawbackMutation = useClawbackStreamMutation;
