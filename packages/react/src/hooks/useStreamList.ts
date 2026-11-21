import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListStreamsParams, StreamInfo } from '@conduit-protocol/sdk';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface UseStreamListResult {
  streams: StreamInfo[];
  isLoading: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
}

export function useStreamList(params: ListStreamsParams): UseStreamListResult {
  const { client, isReady } = useStreamFiClient();
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    setStreams([]);
    setCursor(undefined);
    setHasMore(false);
    if (!isReady || !client) return;
    setIsLoading(true);
    setError(null);
    client.streams.list(params).then((page) => {
      if (requestId.current !== id) return;
      setStreams(page.streams);
      setCursor(page.nextCursor);
      setHasMore(page.hasNextPage);
      setIsLoading(false);
    }).catch((err: unknown) => {
      if (requestId.current !== id) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      setIsLoading(false);
    });
  }, [client, isReady, params]);

  const loadMore = useCallback(() => {
    if (!client || !isReady || !hasMore || !cursor || isLoading) return;
    const id = ++requestId.current;
    setIsLoading(true);
    client.streams.list({ ...params, cursor }).then((page) => {
      if (requestId.current !== id) return;
      setStreams((current) => [...current, ...page.streams]);
      setCursor(page.nextCursor);
      setHasMore(page.hasNextPage);
      setIsLoading(false);
    }).catch((err: unknown) => {
      if (requestId.current !== id) return;
      setError(err instanceof Error ? err : new Error(String(err)));
      setIsLoading(false);
    });
  }, [client, cursor, hasMore, isLoading, isReady, params]);

  return { streams, isLoading, error, hasMore, loadMore };
}
