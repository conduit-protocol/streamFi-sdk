import { useState, useEffect, useCallback, useRef } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface UseFactoryPauseStatusResult {
  isPaused: boolean | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useFactoryPauseStatus(): UseFactoryPauseStatusResult {
  const { client, isReady } = useStreamFiClient();
  const [isPaused, setIsPaused] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const fetch = useCallback(() => {
    const requestId = ++requestIdRef.current;

    if (!isReady || !client) {
      setIsPaused(null);
      setLoading(false);
      setError(null);
      return;
    }

    if (!client.factory) {
      setIsPaused(null);
      setLoading(false);
      setError(new Error('factoryAddress is not configured on the ConduitClient.'));
      return;
    }

    setLoading(true);
    setError(null);

    client.factory
      .factoryPaused()
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setIsPaused(data);
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

  return { isPaused, loading, error, refetch: fetch };
}