import { useState, useEffect, useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';
import type { StreamInfo } from '@conduit-protocol/sdk';

export interface UseStreamResult {
  stream: StreamInfo | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  setStream: Dispatch<SetStateAction<StreamInfo | null>>;
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

    if (!isReady || !client || streamId == null || typeof client.streams?.get !== 'function') {
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

  return { stream, loading, error, refetch: fetch, setStream };
}
