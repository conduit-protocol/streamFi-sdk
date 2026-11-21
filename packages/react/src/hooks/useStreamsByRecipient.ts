import { useCallback, useEffect, useRef, useState } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface UseStreamsByRecipientResult {
  streamIds: bigint[];
  isLoading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  refetch: () => void;
}

/**
 * #766 — Hook for listing stream IDs where `address` is the recipient,
 * with built-in pagination state.
 */
export function useStreamsByRecipient(
  address: string | null,
  options: { limit?: number } = {},
): UseStreamsByRecipientResult {
  const { client, isReady } = useStreamFiClient();
  const [streamIds, setStreamIds] = useState<bigint[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const limit = options.limit ?? 20;
  const requestId = useRef(0);

  const fetchPage = useCallback(
    (pageOffset: number, append: boolean) => {
      if (!isReady || !client?.factory || !address) {
        setStreamIds([]);
        setIsLoading(false);
        return;
      }

      const id = ++requestId.current;
      setIsLoading(true);
      setError(null);

      client.factory
        .streamsByRecipient(address, pageOffset, limit)
        .then((ids) => {
          if (requestId.current !== id) return;
          setStreamIds((prev) => (append ? [...prev, ...ids] : ids));
          setHasMore(ids.length === limit);
          setIsLoading(false);
        })
        .catch((err: unknown) => {
          if (requestId.current !== id) return;
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        });
    },
    [client, isReady, address, limit],
  );

  useEffect(() => {
    setOffset(0);
    fetchPage(0, false);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (isLoading || !hasMore) return;
    const nextOffset = offset + limit;
    setOffset(nextOffset);
    fetchPage(nextOffset, true);
  }, [isLoading, hasMore, offset, limit, fetchPage]);

  const refetch = useCallback(() => {
    setOffset(0);
    fetchPage(0, false);
  }, [fetchPage]);

  return { streamIds, isLoading, error, hasMore, loadMore, refetch };
}
