import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphQLIndexer } from '../indexer.js';

describe('GraphQLIndexer APQ', () => {
  const endpoint = 'https://indexer.example/graphql';
  let indexer: GraphQLIndexer;

  beforeEach(() => {
    indexer = new GraphQLIndexer(endpoint);
  });

  afterEach(() => {
    indexer.cleanup();
  });

  it('sends a persisted query hash on the first request when persist is enabled', async () => {
    const fetchFn = vi.fn();
    fetchFn.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { streamCount: 5 } }),
    });

    // Expose the private executeGraphQLRequest by calling query and stubbing fetch globally.
    globalThis.fetch = fetchFn as unknown as typeof fetch;
    const result = await indexer.query({ query: 'query { streamCount }' });

    expect(result).toEqual({ streamCount: 5 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);
    expect(body.query).toBeNull();
    expect(body.extensions).toMatchObject({
      persistedQuery: { version: 1, sha256Hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });

  it('falls back to the full query when the server reports PERSISTED_QUERY_NOT_FOUND', async () => {
    const fetchFn = vi.fn();
    fetchFn.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        errors: [{ message: 'PERSISTED_QUERY_NOT_FOUND' }],
      }),
    });
    fetchFn.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { streamCount: 3 } }),
    });

    globalThis.fetch = fetchFn as unknown as typeof fetch;
    const result = await indexer.query({ query: 'query { streamCount }' });

    expect(result).toEqual({ streamCount: 3 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const fallbackBody = JSON.parse(fetchFn.mock.calls[1]![1].body);
    expect(fallbackBody.query).toBe('query { streamCount }');
    expect(fallbackBody.extensions).toBeDefined();
  });

  it('skips APQ when persist is false', async () => {
    const fetchFn = vi.fn();
    fetchFn.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { streamCount: 1 } }),
    });

    globalThis.fetch = fetchFn as unknown as typeof fetch;
    await indexer.query({ query: 'query { streamCount }', persist: false });

    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);
    expect(body.query).toBe('query { streamCount }');
    expect(body.extensions).toBeUndefined();
  });

  it('emits one metric for a successful logical query', async () => {
    const onQueryMetric = vi.fn();
    const instrumented = new GraphQLIndexer({ endpoint, onQueryMetric });
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { streamCount: 1 } }),
    });
    globalThis.fetch = fetchFn as unknown as typeof fetch;

    await instrumented.query({ query: 'query StreamCount { streamCount }' });

    expect(onQueryMetric).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'StreamCount',
      success: true,
      durationMs: expect.any(Number),
    }));
    expect(onQueryMetric).toHaveBeenCalledTimes(1);
    instrumented.cleanup();
  });

  it('emits a failed metric when GraphQL returns errors', async () => {
    const onQueryMetric = vi.fn();
    const instrumented = new GraphQLIndexer({ endpoint, onQueryMetric });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: 'query failed' }] }),
    }) as unknown as typeof fetch;

    await expect(instrumented.query({ query: 'query Broken { streamCount }' })).rejects.toThrow('query failed');
    expect(onQueryMetric).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'Broken',
      success: false,
      error: expect.any(Error),
    }));
    instrumented.cleanup();
  });
});

describe('GraphQLIndexer — streamsBySender/streamsByRecipient', () => {
  const endpoint = 'https://indexer.example/graphql';
  let indexer: GraphQLIndexer;

  beforeEach(() => {
    indexer = new GraphQLIndexer(endpoint);
  });

  afterEach(() => {
    indexer.cleanup();
  });

  it('streamsBySender builds and executes a query with sender address', async () => {
    const fetchFn = vi.fn();
    const mockSenderAddress = 'GXYZ...';
    const mockStreams = [
      { id: '1', sender: mockSenderAddress, recipient: 'GA...', ratePerSecond: '100' },
      { id: '2', sender: mockSenderAddress, recipient: 'GB...', ratePerSecond: '200' },
    ];

    fetchFn.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          streamsBySender: {
            items: mockStreams,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    });

    globalThis.fetch = fetchFn as unknown as typeof fetch;
    const result = await indexer.streamsBySender<any>(mockSenderAddress);

    expect(result).toEqual({
      streamsBySender: {
        items: mockStreams,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);
    expect(body.variables).toEqual({ sender: mockSenderAddress });
  });

  it('streamsByRecipient builds and executes a query with recipient address', async () => {
    const fetchFn = vi.fn();
    const mockRecipientAddress = 'GABC...';
    const mockStreams = [
      { id: '1', sender: 'GXYZ...', recipient: mockRecipientAddress, ratePerSecond: '100' },
      { id: '2', sender: 'GQRS...', recipient: mockRecipientAddress, ratePerSecond: '200' },
    ];

    fetchFn.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          streamsByRecipient: {
            items: mockStreams,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    });

    globalThis.fetch = fetchFn as unknown as typeof fetch;
    const result = await indexer.streamsByRecipient<any>(mockRecipientAddress);

    expect(result).toEqual({
      streamsByRecipient: {
        items: mockStreams,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);
    expect(body.variables).toEqual({ recipient: mockRecipientAddress });
  });

  it('streamsBySender respects query options like timeoutMs', async () => {
    const fetchFn = vi.fn();
    fetchFn.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { streamsBySender: { items: [], pageInfo: { hasNextPage: false } } },
      }),
    });

    globalThis.fetch = fetchFn as unknown as typeof fetch;
    await indexer.streamsBySender('GXYZ...', { timeoutMs: 5000 });

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('streamsByRecipient respects query options like headers', async () => {
    const fetchFn = vi.fn();
    fetchFn.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { streamsByRecipient: { items: [], pageInfo: { hasNextPage: false } } },
      }),
    });

    globalThis.fetch = fetchFn as unknown as typeof fetch;
    await indexer.streamsByRecipient('GABC...', { headers: { 'X-Custom': 'value' } });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const callHeaders = fetchFn.mock.calls[0]![1].headers;
    expect(callHeaders['X-Custom']).toBe('value');
  });
});
