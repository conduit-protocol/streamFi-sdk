import { useState, useEffect, useCallback, useRef } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface GovernorConfig {
  feeBps: number;
  minDuration?: number;
  maxDuration?: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  maxRate?: string;
  maxRatePerSecond?: bigint;
  feeRecipient?: string;
  factoryAddress?: string;
  votingDelay?: number;
  votingPeriod?: number;
  proposalThreshold?: bigint;
  /** Formatted human-readable string for voting delay in ledgers (e.g. '~24 hours') */
  formattedVotingDelay?: string;
  /** Formatted human-readable string for voting period in ledgers (e.g. '~3 days') */
  formattedVotingPeriod?: string;
  /** Formatted human-readable string for minimum stream duration */
  formattedMinDuration?: string;
  /** Formatted human-readable string for maximum stream duration */
  formattedMaxDuration?: string;
}

export interface UseGovernorConfigResult {
  config: GovernorConfig | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  formattedVotingDelay?: string;
  formattedVotingPeriod?: string;
}

/**
 * Converts a Stellar ledger count into a human-readable duration string.
 * Stellar ledgers close roughly every ~5 seconds (17,280 ledgers ≈ 24 hours).
 *
 * @param ledgers - Number of ledgers
 * @returns Human-readable duration string (e.g. '~24 hours', '~3 days')
 */
export function formatLedgerDuration(ledgers: number): string {
  if (!ledgers || ledgers <= 0) return '~0 hours';
  const totalSeconds = ledgers * 5;
  if (totalSeconds < 60) {
    return `~${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;
  }
  if (totalSeconds < 3600) {
    const minutes = Math.round(totalSeconds / 60);
    return `~${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (totalSeconds <= 86400) {
    const hours = Math.round(totalSeconds / 3600);
    return `~${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round(totalSeconds / 86400);
  return `~${days} day${days === 1 ? '' : 's'}`;
}

/**
 * #767 — Hook wrapping GovernorModule.getConfig(). Since protocol config
 * rarely changes, this defaults to a longer polling interval (60s) than
 * useStream.
 *
 * #996 — Returns formatted human-readable durations for voting delays and
 * voting periods (e.g. '~24 hours', '~3 days') alongside raw ledger counts.
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
      .then((data: any) => {
        if (requestIdRef.current !== requestId) return;
        const enriched: GovernorConfig = {
          ...data,
          minDuration: data.minDuration ?? data.minDurationSeconds,
          maxDuration: data.maxDuration ?? data.maxDurationSeconds,
          maxRate: data.maxRate ?? (data.maxRatePerSecond ? String(data.maxRatePerSecond) : undefined),
          feeRecipient: data.feeRecipient ?? '',
          factoryAddress: data.factoryAddress ?? '',
          formattedVotingDelay:
            data.votingDelay != null ? formatLedgerDuration(data.votingDelay) : undefined,
          formattedVotingPeriod:
            data.votingPeriod != null ? formatLedgerDuration(data.votingPeriod) : undefined,
          formattedMinDuration:
            data.minDurationSeconds != null
              ? formatLedgerDuration(Math.round(data.minDurationSeconds / 5))
              : data.minDuration != null
                ? formatLedgerDuration(data.minDuration)
                : undefined,
          formattedMaxDuration:
            data.maxDurationSeconds != null
              ? formatLedgerDuration(Math.round(data.maxDurationSeconds / 5))
              : data.maxDuration != null
                ? formatLedgerDuration(data.maxDuration)
                : undefined,
        };
        setConfig(enriched);
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

  return {
    config,
    loading,
    error,
    refetch: fetchConfig,
    formattedVotingDelay: config?.formattedVotingDelay,
    formattedVotingPeriod: config?.formattedVotingPeriod,
  };
}
