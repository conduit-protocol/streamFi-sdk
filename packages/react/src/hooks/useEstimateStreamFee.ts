import { useState, useEffect, useCallback, useRef } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';
import type { StreamOperation, FeeEstimate } from '@conduit-protocol/sdk';

export interface UseEstimateStreamFeeResult {
  estimate: FeeEstimate | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useEstimateStreamFee(
  operation: StreamOperation | null | undefined,
): UseEstimateStreamFeeResult {
  const { client, isReady } = useStreamFiClient();
  const [estimate, setEstimate] = useState<FeeEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const fetch = useCallback(() => {
    const requestId = ++requestIdRef.current;

    if (!isReady || !client || !operation) {
      setEstimate(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    client.streams
      .estimateFee(operation)
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setEstimate(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [client, isReady, operation]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { estimate, loading, error, refetch: fetch };
}
