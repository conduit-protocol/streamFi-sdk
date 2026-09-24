import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphQLIndexer } from '../indexer.js';
import { ConduitError } from '../errors.js';

describe('GraphQLIndexer.query() — unwrapped return contract (#599)', () => {
  const endpoint = 'https://indexer.example.com/graphql';
  let indexer: GraphQLIndexer;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    indexer = new GraphQLIndexer(endpoint);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    indexer.cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('unwraps body.data directly and supports generic type parameters', async () => {
    interface StreamStats {
      streamCount: number;
      activeStreamIds: string[];
    }

    const payload: StreamStats = {
      streamCount: 42,
      activeStreamIds: ['stream-1', 'stream-2'],
    };

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: payload }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await indexer.query<StreamStats>({
      query: 'query GetStats { streamCount activeStreamIds }',
    });

    // The return contract guarantees body.data is directly returned, NOT { data: ... }
    expect(result).toEqual(payload);
    expect(result.streamCount).toBe(42);
    expect(result.activeStreamIds).toEqual(['stream-1', 'stream-2']);
    expect((result as unknown as Record<string, unknown>).data).toBeUndefined();
  });

  it('returns null when endpoint returns { data: null }', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: null }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await indexer.query({
      query: 'query NonExistent { stream(id: "none") { id } }',
    });

    expect(result).toBeNull();
  });

  it('throws ConduitError when endpoint returns errors in response body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        errors: [{ message: 'Field "unknownField" does not exist on type "Query"' }],
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      indexer.query({ query: 'query Invalid { unknownField }' }),
    ).rejects.toThrow(ConduitError);

    await expect(
      indexer.query({ query: 'query Invalid { unknownField }' }),
    ).rejects.toThrow('Field "unknownField" does not exist on type "Query"');
  });

  it('correctly unwraps data payload during APQ hash miss retry', async () => {
    interface AccountData {
      address: string;
      balance: string;
    }

    const accountData: AccountData = {
      address: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      balance: '5000000',
    };

    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errors: [{ message: 'PERSISTED_QUERY_NOT_FOUND' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: accountData }),
      });

    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await indexer.query<AccountData>({
      query: 'query GetAccount { account { address balance } }',
      persist: true,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual(accountData);
    expect(result.balance).toBe('5000000');
  });
});
