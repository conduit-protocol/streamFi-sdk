import { useState, useEffect, useCallback, useRef } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface UseProtocolFeeBpsResult {
  feeBps: number | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useProtocolFeeBps(): UseProtocolFeeBpsResult {
  const { client, isReady } = useStreamFiClient();
  const [feeBps, setFeeBps] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const fetch = useCallback(() => {
    const requestId = ++requestIdRef.current;

    if (!isReady || !client) {
      setFeeBps(null);
      setLoading(false);
      setError(null);
      return;
    }

    if (!client.factory) {
      setFeeBps(null);
      setLoading(false);
      setError(new Error('factoryAddress is not configured on the ConduitClient.'));
      return;
    }

    setLoading(true);
    setError(null);

    client.factory
      .protocolFeeBps()
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setFeeBps(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [client, isReady]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { feeBps, loading, error, refetch: fetch };
}
