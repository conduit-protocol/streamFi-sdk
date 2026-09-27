import { useState, useEffect, useCallback, useRef } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface GovernorProposal {
  id: string;
  description: string;
  targetConfig: Record<string, unknown>;
  status: 'active' | 'passed' | 'failed' | 'pending';
  proposer: string;
  startTime: number;
  endTime: number;
  votesFor: bigint;
  votesAgainst: bigint;
}

export interface UseGovernorProposalsResult {
  proposals: GovernorProposal[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * #836 — Hook wrapping GovernorModule.getProposals().
 * Provides React bindings to query active governor proposals for
 * protocol governance inspection.
 */
export function useGovernorProposals(pollIntervalMs = 30_000): UseGovernorProposalsResult {
  const { client, isReady } = useStreamFiClient();
  const [proposals, setProposals] = useState<GovernorProposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const fetchProposals = useCallback(() => {
    const requestId = ++requestIdRef.current;

    if (!isReady || !client?.governor) {
      setProposals([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    client.governor
      .getProposals()
      .then((data) => {
        if (requestIdRef.current !== requestId) return;
        setProposals(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [client, isReady]);

  useEffect(() => {
    fetchProposals();
    if (pollIntervalMs <= 0) return;
    const interval = setInterval(fetchProposals, pollIntervalMs);
    return () => clearInterval(interval);
  }, [fetchProposals, pollIntervalMs]);

  return { proposals, loading, error, refetch: fetchProposals };
}
