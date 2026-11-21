import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphQLIndexer } from '../indexer.js';

describe('GraphQLIndexer Memory Leak & Real Network I/O Tests', () => {
  const endpoint = 'https://indexer.streamfi.io/graphql';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws boundary error when endpoint is empty or null', () => {
    expect(() => new GraphQLIndexer('')).toThrow('GraphQLIndexer endpoint must be a non-empty string');
    expect(() => new GraphQLIndexer(null as any)).toThrow('GraphQLIndexer endpoint must be a non-empty string');
  });

  it('throws boundary error when query options are null or missing query string', async () => {
    const indexer = new GraphQLIndexer(endpoint);

    await expect(indexer.query(null as any)).rejects.toThrow('GraphQLQueryOptions cannot be null or undefined');
    await expect(indexer.query({ query: '' })).rejects.toThrow('GraphQL query string cannot be null or empty');

    indexer.cleanup();
  });

  it('performs a real HTTP POST request in query() and returns response data', async () => {
    const mockResponseData = { data: { streams: [{ id: '1', sender: 'GAAA' }] } };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponseData,
    } as Response);

    const indexer = new GraphQLIndexer(endpoint);
    const queryStr = 'query { streams { id sender } }';
    const variables = { limit: 10 };

    const result = await indexer.query({ query: queryStr, variables });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe(endpoint);
    expect(calledInit).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      signal: expect.any(AbortSignal),
    });
    // Automatic Persisted Queries (#629): the first attempt sends the hash
    // with a null query; the full string is only replayed on a cache miss.
    expect(JSON.parse((calledInit as RequestInit).body as string)).toEqual({
      query: null,
      variables,
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    // query() returns the unwrapped GraphQL `data` payload, not the envelope.
    expect(result).toEqual(mockResponseData.data);

    indexer.cleanup();
  });

  it('handles HTTP error in query() gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response);

    const indexer = new GraphQLIndexer(endpoint);

    await expect(indexer.query({ query: 'query { streams { id } }' })).rejects.toThrow(
      'GraphQL query failed with status 500: Internal Server Error'
    );

    indexer.cleanup();
  });

  it('throws when a GraphQL response contains query-level errors despite HTTP 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: null,
        errors: [
          { message: 'Cannot query field "doesNotExist" on type "Query".' },
          { message: 'Resolver error: boom' },
        ],
      }),
    } as Response);

    const indexer = new GraphQLIndexer(endpoint);

    await expect(indexer.query({ query: 'query { doesNotExist }' })).rejects.toThrow(
      'Cannot query field "doesNotExist" on type "Query".'
    );

    indexer.cleanup();
  });

  it('subscribes and properly cleans up active subscriptions on unsubscribe()', async () => {
    const indexer = new GraphQLIndexer(endpoint);

    const sub = indexer.subscribe({
      query: 'subscription { streamUpdated { id } }',
      onData: () => {},
    });

    expect(indexer.getSubscriptionCount()).toBe(1);

    // Unsubscribe and verify active subscription set count decreases to 0
    sub.unsubscribe();
    expect(indexer.getSubscriptionCount()).toBe(0);

    indexer.cleanup();
  });

  it('cleans up all active subscriptions on indexer.cleanup() without memory leak', () => {
    const indexer = new GraphQLIndexer(endpoint);

    indexer.subscribe({ query: 'subscription { sub1 }', onData: () => {} });
    indexer.subscribe({ query: 'subscription { sub2 }', onData: () => {} });
    indexer.subscribe({ query: 'subscription { sub3 }', onData: () => {} });

    expect(indexer.getSubscriptionCount()).toBe(3);

    // Cleanup indexer instance
    indexer.cleanup();
    expect(indexer.getSubscriptionCount()).toBe(0);

    // Subsequent actions throw destroyed error
    expect(() => indexer.subscribe({ query: 'sub', onData: () => {} })).toThrow('GraphQLIndexer has been destroyed');
  });
});
