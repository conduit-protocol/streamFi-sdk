import { useEffect, useRef } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';
import type { StreamEventHandlers, Subscription } from '@conduit-protocol/sdk';

/**
 * Hook to subscribe to stream-specific events with automatic lifecycle management.
 *
 * Automatically subscribes to the stream on mount and unsubscribes on unmount or
 * when streamId/callbacks change. Handles all cleanup internally.
 *
 * @param streamId - The stream ID to subscribe to (bigint or string)
 * @param callbacks - Event handler callbacks (see StreamEventHandlers)
 *
 * @example
 * ```tsx
 * useStreamEvents(streamId, {
 *   onWithdraw: (e) => console.log('Withdrawn:', e.amount),
 *   onPause: (e) => console.log('Stream paused at:', e.pausedAt),
 *   onError: (err) => console.error(err),
 * });
 * ```
 */
export function useStreamEvents(
  streamId: bigint | string | null | undefined,
  callbacks: StreamEventHandlers,
): void {
  const { client, isReady } = useStreamFiClient();
  const subscriptionRef = useRef<Subscription | null>(null);

  useEffect(() => {
    // Unsubscribe from previous subscription if it exists
    if (subscriptionRef.current) {
      subscriptionRef.current.unsubscribe();
      subscriptionRef.current = null;
    }

    // Only subscribe if we have a ready client, valid streamId, and at least one callback
    if (!isReady || !client || streamId == null || typeof client.streams?.subscribe !== 'function') {
      return;
    }

    // Check if there's at least one callback defined
    const hasCallbacks =
      callbacks.onWithdraw ||
      callbacks.onCancel ||
      callbacks.onPause ||
      callbacks.onResume ||
      callbacks.onTopUp ||
      callbacks.onClawback ||
      callbacks.onCreated ||
      callbacks.onForceCancel ||
      callbacks.onRecipientTransfer ||
      callbacks.onOperatorSet ||
      callbacks.onOperatorRevoke ||
      callbacks.onError ||
      callbacks.onGap;

    if (!hasCallbacks) {
      return;
    }

    // Subscribe to stream events
    subscriptionRef.current = client.streams.subscribe(streamId, callbacks);

    // Cleanup: unsubscribe on unmount or when dependencies change
    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current.unsubscribe();
        subscriptionRef.current = null;
      }
    };
  }, [client, isReady, streamId, callbacks]);
}
