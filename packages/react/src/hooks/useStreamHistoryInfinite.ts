import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { StreamHistoryEntry, StreamHistoryPage } from '@conduit-protocol/sdk';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

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
 */
export function useStreamHistoryInfinite(
  streamId: string | bigint | undefined,
  pageSize = 50,
): UseStreamHistoryInfiniteResult {
  const { client, isReady, network } = useStreamFiClient();
  const id = streamId === undefined ? undefined : String(streamId);

  const query = useInfiniteQuery<
    StreamHistoryPage,
    Error,
    { pages: StreamHistoryPage[]; pageParams: (string | undefined)[] },
    readonly unknown[],
    string | undefined
  >({
    queryKey: ['streamfi', 'streamHistory', network, id, pageSize],
    queryFn: ({ pageParam }) =>
      client!.streams.getHistory(id!, {
        limit: pageSize,
        ...(pageParam !== undefined && { cursor: pageParam }),
      }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: isReady && !!client && id !== undefined,
  });

  const entries = useMemo(
    () => query.data?.pages.flatMap((page) => page.entries) ?? [],
    [query.data],
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
