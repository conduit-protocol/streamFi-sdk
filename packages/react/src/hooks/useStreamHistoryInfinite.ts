import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { StreamHistoryEntry, StreamHistoryPage } from '@conduit-protocol/sdk';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface UseStreamHistoryInfiniteOptions {
  /** Start by walking forward from the oldest ledger, or backward from the newest. */
  direction?: 'forward' | 'backward';
  /** Optional ledger to start from when direction is `forward`. */
  startLedger?: number;
  /** Filter events by type: 'Deposit' (created or top_up), 'Withdraw', or 'Cancel'. */
  filterEventTypes?: StreamHistoryEventTypeFilter[];
}

export interface UseStreamHistoryInfiniteResult {
  /** All loaded entries across pages, oldest first. */
  entries: StreamHistoryEntry[];
  /** True while the first page loads. */
  isLoading: boolean;
  isFetchingNextPage: boolean;
  /** True when another page can be requested with {@link fetchNextPage}. */
  hasNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
  error: Error | null;
  /** Re-fetch every loaded page from the start. */
  refetch: () => Promise<unknown>;
}

/** Event categories accepted by `filterEventTypes`. */
export type StreamHistoryEventTypeFilter = 'Deposit' | 'Withdraw' | 'Cancel';

/** Maps each filter category to the SDK history `kind`s it covers. */
function mapEventTypeToKinds(eventType: StreamHistoryEventTypeFilter): StreamHistoryEntry['kind'][] {
  switch (eventType) {
    case 'Deposit':
      return ['created', 'top_up'];
    case 'Withdraw':
      return ['withdraw'];
    case 'Cancel':
      return ['cancel'];
  }
}

/**
 * #863 — Infinite-scroll activity history (withdrawals, top-ups, pauses, …)
 * for a stream, backed by TanStack Query's `useInfiniteQuery`.
 *
 * Requires `@tanstack/react-query` v5 and a `<QueryClientProvider>` above the
 * component, in addition to `<StreamFiProvider>`. Pages are cursor-based
 * (`StreamsModule.getHistory`), so call `fetchNextPage` from an
 * intersection observer or a "Load more" button.
 *
 * @param streamId - Stream to load; the query is disabled while `undefined`.
 * @param pageSize - Events per request, 1–200. Default 50.
 * @param options.direction - Walk forward from oldest ledger or backward from newest. Default 'backward'.
 * @param options.startLedger - Optional ledger to start from when direction is 'forward'.
 * @param options.filterEventTypes - Optional filter by event type(s): 'Deposit' (created or top_up), 'Withdraw', or 'Cancel'.
 *
 * @example
 * ```typescript
 * // Load all events
 * const { entries, fetchNextPage, hasNextPage } = useStreamHistoryInfinite(streamId);
 *
 * // Load only withdrawals
 * const withdrawals = useStreamHistoryInfinite(streamId, 50, {
 *   filterEventTypes: ['Withdraw'],
 * });
 *
 * // Load deposits and withdrawals, exclude cancels
 * const activity = useStreamHistoryInfinite(streamId, 50, {
 *   filterEventTypes: ['Deposit', 'Withdraw'],
 * });
 * ```
 */
export function useStreamHistoryInfinite(
  streamId: string | bigint | undefined,
  pageSize = 50,
  options: UseStreamHistoryInfiniteOptions = {},
): UseStreamHistoryInfiniteResult {
  const { client, isReady, network } = useStreamFiClient();
  const id = streamId === undefined ? undefined : String(streamId);
  const { direction = 'backward', startLedger, filterEventTypes } = options;

  const filterKey = filterEventTypes?.join(',') ?? '';
  const query = useInfiniteQuery<
    StreamHistoryPage,
    Error,
    { pages: StreamHistoryPage[]; pageParams: (string | number | undefined)[] },
    readonly unknown[],
    string | number | undefined
  >({
    queryKey: ['streamfi', 'streamHistory', network, id, pageSize, direction, startLedger, filterKey],
    queryFn: ({ pageParam }) => {
      const params: { limit: number; cursor?: string; startLedger?: number } = { limit: pageSize };
      if (pageParam !== undefined) {
        if (typeof pageParam === 'number') {
          params.startLedger = pageParam;
        } else {
          params.cursor = pageParam;
        }
      } else if (direction === 'forward' && startLedger !== undefined) {
        params.startLedger = startLedger;
      }
      return client!.streams.getHistory(id!, params);
    },
    initialPageParam: direction === 'forward' ? (startLedger ?? undefined) : undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: isReady && !!client && id !== undefined,
  });

  const allowedKinds = useMemo(
    () => {
      if (!filterEventTypes || filterEventTypes.length === 0) return null;
      const kinds = new Set<StreamHistoryEntry['kind']>();
      for (const eventType of filterEventTypes) {
        for (const kind of mapEventTypeToKinds(eventType)) {
          kinds.add(kind);
        }
      }
      return kinds;
    },
    [filterEventTypes],
  );

  const entries = useMemo(
    () => {
      const allEntries = query.data?.pages.flatMap((page) => page.entries) ?? [];
      if (!allowedKinds) return allEntries;
      return allEntries.filter((entry) => allowedKinds.has(entry.kind));
    },
    [query.data, allowedKinds],
  );

  return {
    entries,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    error: query.error,
    refetch: query.refetch,
  };
}
