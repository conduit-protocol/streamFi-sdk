import { useQuery, useMutation } from "@apollo/client";
import {
  GET_DASHBOARD_STATS,
  GET_RECENT_STREAMS,
  GET_TOKENS,
  CREATE_STREAM,
  WITHDRAW_STREAM,
  PAUSE_STREAM,
  RESUME_STREAM,
  CANCEL_STREAM,
} from "../lib/graphql-operations";

interface DashboardStats {
  activeStreams: number;
  totalVolume: string;
  pendingStreams: number;
}

interface Stream {
  id: string;
  streamId: string;
  recipient: string;
  ratePerSecond: string;
  status: string;
  createdAt: string;
}

interface DashboardStatsData {
  dashboardStats: DashboardStats;
}

interface RecentStreamsData {
  streams: Stream[];
}

interface TokenData {
  tokens: {
    id: string;
    symbol: string;
    name: string;
    logoUrl?: string;
  }[];
}

/**
 * Fetches dashboard stats with automatic cache updates after mutations.
 * Uses `refetchQueries` on every mutation to invalidate stale cache entries
 * and pull fresh on-chain state from the server.
 *
 * `errorPolicy: 'all'` ensures that network errors (including RPC / indexer
 * timeouts) are surfaced in the returned `error` field rather than swallowed,
 * so `loading` is always cleared — fixes the infinite-spinner bug (#158).
 */
export function useDashboardStats(walletAddress: string) {
  return useQuery<DashboardStatsData>(GET_DASHBOARD_STATS, {
    variables: { walletAddress },
    // Poll periodically to catch external state changes
    pollInterval: 30_000,
    // Surface errors (including timeouts) instead of leaving loading=true forever
    errorPolicy: 'all',
  });
}

/**
 * Fetches recent streams with automatic refetch after mutations.
 *
 * `errorPolicy: 'all'` ensures that network errors (including RPC / indexer
 * timeouts) are surfaced in the returned `error` field rather than swallowed,
 * so `loading` is always cleared — fixes the infinite-spinner bug (#158).
 */
export function useRecentStreams(walletAddress: string, limit = 20) {
  return useQuery<RecentStreamsData>(GET_RECENT_STREAMS, {
    variables: { walletAddress, limit },
    pollInterval: 30_000,
    // Surface errors (including timeouts) instead of leaving loading=true forever
    errorPolicy: 'all',
  });
}

/**
 * Fetches the list of supported tokens for the Token Selector.
 *
 * Polls periodically to catch newly listed tokens, and is included in
 * `refetchQueries` for every mutation so the token list always reflects
 * the latest on-chain state — fixes the stale-token-list bug.
 *
 * `errorPolicy: 'all'` surfaces network errors instead of leaving
 * loading stuck at true (#158).
 */
export function useTokens() {
  return useQuery<TokenData>(GET_TOKENS, {
    pollInterval: 30_000,
    errorPolicy: 'all',
  });
}

/**
 * All mutation hooks use `refetchQueries` to invalidate and re-fetch
 * both the stats and streams queries, ensuring the Dashboard always
 * reflects the latest on-chain state after any action.
 */
export function useWithdrawStream(walletAddress: string) {
  const [mutate, result] = useMutation(WITHDRAW_STREAM, {
    refetchQueries: [
      { query: GET_DASHBOARD_STATS, variables: { walletAddress } },
      { query: GET_RECENT_STREAMS, variables: { walletAddress, limit: 20 } },
      GET_TOKENS,
    ],
    awaitRefetchQueries: true,
    // Surface errors (including timeouts) instead of leaving loading=true forever
    errorPolicy: 'all',
  });
  return { withdraw: mutate, ...result };
}

export function usePauseStream(walletAddress: string) {
  const [mutate, result] = useMutation(PAUSE_STREAM, {
    refetchQueries: [
      { query: GET_DASHBOARD_STATS, variables: { walletAddress } },
      { query: GET_RECENT_STREAMS, variables: { walletAddress, limit: 20 } },
      GET_TOKENS,
    ],
    awaitRefetchQueries: true,
    // Surface errors (including timeouts) instead of leaving loading=true forever
    errorPolicy: 'all',
  });
  return { pause: mutate, ...result };
}

export function useResumeStream(walletAddress: string) {
  const [mutate, result] = useMutation(RESUME_STREAM, {
    refetchQueries: [
      { query: GET_DASHBOARD_STATS, variables: { walletAddress } },
      { query: GET_RECENT_STREAMS, variables: { walletAddress, limit: 20 } },
      GET_TOKENS,
    ],
    awaitRefetchQueries: true,
    // Surface errors (including timeouts) instead of leaving loading=true forever
    errorPolicy: 'all',
  });
  return { resume: mutate, ...result };
}

export function useCancelStream(walletAddress: string) {
  const [mutate, result] = useMutation(CANCEL_STREAM, {
    refetchQueries: [
      { query: GET_DASHBOARD_STATS, variables: { walletAddress } },
      { query: GET_RECENT_STREAMS, variables: { walletAddress, limit: 20 } },
      GET_TOKENS,
    ],
    awaitRefetchQueries: true,
    // Surface errors (including timeouts) instead of leaving loading=true forever
    errorPolicy: 'all',
  });
  return { cancel: mutate, ...result };
}

/**
 * Creates a new stream and immediately invalidates both the streams list
 * and dashboard stats so the Transaction History reflects the new entry
 * without requiring a manual refresh.
 */
export function useCreateStream(walletAddress: string) {
  const [mutate, result] = useMutation(CREATE_STREAM, {
    refetchQueries: [
      { query: GET_DASHBOARD_STATS, variables: { walletAddress } },
      { query: GET_RECENT_STREAMS, variables: { walletAddress, limit: 20 } },
      GET_TOKENS,
    ],
    awaitRefetchQueries: true,
    // Surface errors (including timeouts) instead of leaving loading=true forever
    errorPolicy: 'all',
  });
  return { createStream: mutate, ...result };
}
