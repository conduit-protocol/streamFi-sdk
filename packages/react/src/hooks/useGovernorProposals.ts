import { useState, useEffect, useCallback, useRef } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export type ProposalStatus = 'active' | 'passed' | 'failed' | 'pending';
export type ProposalSortBy = 'date' | 'votes';
export type ProposalSortDirection = 'asc' | 'desc';

export interface GovernorProposal {
  id: string;
  description: string;
  targetConfig: Record<string, unknown>;
  status: ProposalStatus;
  proposer: string;
  startTime: number;
  endTime: number;
  votesFor: bigint;
  votesAgainst: bigint;
}

export interface UseGovernorProposalsOptions {
  pollIntervalMs?: number;
  statusFilter?: ProposalStatus[];
  sortBy?: ProposalSortBy;
  sortDirection?: ProposalSortDirection;
}

export interface UseGovernorProposalsResult {
  proposals: GovernorProposal[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Sorts an array of proposals by date or votes according to specified direction.
 */
export function sortProposals(
  proposals: GovernorProposal[],
  sortBy?: ProposalSortBy,
  sortDirection: ProposalSortDirection = 'desc',
): GovernorProposal[] {
  if (!sortBy) return proposals;

  return [...proposals].sort((a, b) => {
    let diff = 0;
    if (sortBy === 'votes') {
      const aTotal = (a.votesFor ?? 0n) + (a.votesAgainst ?? 0n);
      const bTotal = (b.votesFor ?? 0n) + (b.votesAgainst ?? 0n);
      if (aTotal !== bTotal) {
        diff = aTotal < bTotal ? -1 : 1;
      } else {
        const aFor = a.votesFor ?? 0n;
        const bFor = b.votesFor ?? 0n;
        diff = aFor < bFor ? -1 : aFor > bFor ? 1 : 0;
      }
    } else if (sortBy === 'date') {
      const aTime = a.startTime ?? 0;
      const bTime = b.startTime ?? 0;
      if (aTime !== bTime) {
        diff = aTime < bTime ? -1 : 1;
      } else {
        const aNum = Number(a.id);
        const bNum = Number(b.id);
        if (!isNaN(aNum) && !isNaN(bNum)) {
          diff = aNum < bNum ? -1 : 1;
        } else {
          diff = a.id.localeCompare(b.id);
        }
      }
    }

    return sortDirection === 'asc' ? diff : -diff;
  });
}

/**
 * #836 — Hook wrapping GovernorModule.getProposals().
 * Provides React bindings to query active governor proposals for
 * protocol governance inspection.
 *
 * #997 — Adds proposal sorting by vote count or creation date (`sortBy`, `sortDirection`).
 *
 * @param pollIntervalMs - Polling interval in milliseconds. Default 30_000.
 * @param statusFilter - Optional array of proposal statuses to filter by.
 */
export function useGovernorProposals(
  options?: UseGovernorProposalsOptions,
): UseGovernorProposalsResult;
export function useGovernorProposals(
  pollIntervalMs?: number,
  statusFilter?: ProposalStatus[],
  options?: { sortBy?: ProposalSortBy; sortDirection?: ProposalSortDirection },
): UseGovernorProposalsResult;
export function useGovernorProposals(
  arg1?: number | UseGovernorProposalsOptions,
  arg2?: ProposalStatus[],
  arg3?: { sortBy?: ProposalSortBy; sortDirection?: ProposalSortDirection },
): UseGovernorProposalsResult {
  const options: UseGovernorProposalsOptions =
    typeof arg1 === 'object' && arg1 !== null
      ? arg1
      : {
          pollIntervalMs: typeof arg1 === 'number' ? arg1 : 30_000,
          statusFilter: arg2,
          sortBy: arg3?.sortBy,
          sortDirection: arg3?.sortDirection,
        };

  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  const statusFilter = options.statusFilter;
  const sortBy = options.sortBy;
  const sortDirection = options.sortDirection ?? 'desc';

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
        const filtered = statusFilter
          ? data.filter((p) => statusFilter.includes(p.status))
          : data;
        const sorted = sortProposals(filtered, sortBy, sortDirection);
        setProposals(sorted);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [client, isReady, statusFilter, sortBy, sortDirection]);

  useEffect(() => {
    fetchProposals();
    if (pollIntervalMs <= 0) return;
    const interval = setInterval(fetchProposals, pollIntervalMs);
    return () => clearInterval(interval);
  }, [fetchProposals, pollIntervalMs]);

  return { proposals, loading, error, refetch: fetchProposals };
}
