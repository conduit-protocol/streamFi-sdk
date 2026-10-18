import { useState, useEffect, useCallback, useRef } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';
import type { StreamInfo } from '@conduit-protocol/sdk';

export interface UseStreamResult {
  stream: StreamInfo | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  /**
   * Withdraw from the stream. `stream.withdrawn` is bumped optimistically as
   * soon as the call starts (to `amount`, or to everything accrued so far),
   * rolled back if the transaction fails, and reconciled with the ledger
   * once it confirms. Resolves with the transaction hash.
   */
  withdraw: (amount?: bigint | string) => Promise<string>;
  /** Cancel the stream, marking it `cancelled` optimistically. Same rollback semantics as `withdraw`. */
  cancel: () => Promise<string>;
  /** True while an optimistic update is awaiting ledger confirmation. */
  isOptimistic: boolean;
}

function accruedNow(stream: StreamInfo): bigint {
  const now = Math.floor(Date.now() / 1000);
  const until = stream.paused && stream.pausedAt ? stream.pausedAt : now;
  const capped = stream.endTime > 0 ? Math.min(until, stream.endTime) : until;
  return stream.ratePerSecond * BigInt(Math.max(0, capped - stream.startTime));
}

export function useStream(streamId: bigint | string | null | undefined): UseStreamResult {
  const { client, isReady } = useStreamFiClient();
  const [stream, setStream] = useState<StreamInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Guards against out-of-order responses: if streamId changes again (or the
  // component unmounts) before an in-flight get() resolves, its callback
  // must not clobber state with a now-stale result.
  const requestIdRef = useRef(0);

  const fetch = useCallback(() => {
    const requestId = ++requestIdRef.current;

    if (!isReady || !client || streamId == null) {
      setStream(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    client.streams
      .get(streamId)
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setStream(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [client, isReady, streamId]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const [isOptimistic, setIsOptimistic] = useState(false);
  const streamRef = useRef(stream);
  streamRef.current = stream;

  const runOptimistic = useCallback(
    async (patch: (current: StreamInfo) => StreamInfo, send: () => Promise<string>): Promise<string> => {
      if (!isReady || !client || streamId == null) throw new Error('StreamFi client is not ready.');
      const previous = streamRef.current;
      if (previous) {
        setStream(patch(previous));
        setIsOptimistic(true);
      }
      try {
        const hash = await send();
        fetch(); // reconcile with confirmed on-chain state
        return hash;
      } catch (err) {
        if (previous) setStream(previous);
        throw err;
      } finally {
        setIsOptimistic(false);
      }
    },
    [client, isReady, streamId, fetch],
  );

  const withdraw = useCallback(
    (amount?: bigint | string) =>
      runOptimistic(
        (current) => {
          const accrued = accruedNow(current);
          const requested = amount === undefined ? accrued - current.withdrawn : BigInt(amount);
          const next = current.withdrawn + (requested > 0n ? requested : 0n);
          return { ...current, withdrawn: next > accrued ? accrued : next };
        },
        () => client!.streams.withdraw(String(streamId), amount === undefined ? undefined : BigInt(amount)),
      ),
    [client, streamId, runOptimistic],
  );

  const cancel = useCallback(
    () =>
      runOptimistic(
        (current) => ({ ...current, cancelled: true, paused: false }),
        () => client!.streams.cancel(String(streamId)),
      ),
    [client, streamId, runOptimistic],
  );

  return { stream, loading, error, refetch: fetch, withdraw, cancel, isOptimistic };
}
