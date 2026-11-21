import { useState, useEffect, useCallback, useRef } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface UseStreamedTotalResult {
  total: bigint | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useStreamedTotal(
  streamId: bigint | string | null | undefined,
): UseStreamedTotalResult {
  const { client, isReady } = useStreamFiClient();
  const [total, setTotal] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const fetch = useCallback(() => {
    const requestId = ++requestIdRef.current;

    if (!isReady || !client || streamId == null) {
      setTotal(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    client.streams
      .streamedTotal(streamId)
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setTotal(data);
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

  return { total, loading, error, refetch: fetch };
}
