import { useState, useEffect, useCallback, useRef } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface GovernorConfig {
  feeBps: number;
  minDuration: number;
  maxDuration: number;
  maxRate: string;
  feeRecipient: string;
  factoryAddress: string;
}

export interface UseGovernorConfigResult {
  config: GovernorConfig | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * #767 — Hook wrapping GovernorModule.getConfig(). Since protocol config
 * rarely changes, this defaults to a longer polling interval (60s) than
 * useStream.
 */
export function useGovernorConfig(pollIntervalMs = 60_000): UseGovernorConfigResult {
  const { client, isReady } = useStreamFiClient();
  const [config, setConfig] = useState<GovernorConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const fetchConfig = useCallback(() => {
    const requestId = ++requestIdRef.current;

    if (!isReady || !client?.governor) {
      setConfig(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    client.governor
      .getConfig()
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setConfig(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [client, isReady]);

  useEffect(() => {
    fetchConfig();
    if (pollIntervalMs <= 0) return;
    const interval = setInterval(fetchConfig, pollIntervalMs);
    return () => clearInterval(interval);
  }, [fetchConfig, pollIntervalMs]);

  return { config, loading, error, refetch: fetchConfig };
}
