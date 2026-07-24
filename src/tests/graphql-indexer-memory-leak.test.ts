import { describe, it, expect } from 'vitest';
import { GraphQLIndexer } from '../indexer.js';

describe('GraphQLIndexer Memory Leak & Boundary Check Regression Tests', () => {
  it('throws boundary error when endpoint is empty or null', () => {
    expect(() => new GraphQLIndexer('')).toThrow('GraphQLIndexer endpoint must be a non-empty string');
    expect(() => new GraphQLIndexer(null as any)).toThrow('GraphQLIndexer endpoint must be a non-empty string');
  });

  it('throws boundary error when query options are null or missing query string', async () => {
    const indexer = new GraphQLIndexer('https://indexer.streamfi.io/graphql');

    await expect(indexer.query(null as any)).rejects.toThrow('GraphQLQueryOptions cannot be null or undefined');
    await expect(indexer.query({ query: '' })).rejects.toThrow('GraphQL query string cannot be null or empty');

    indexer.cleanup();
  });

  it('subscribes and properly cleans up active subscriptions on unsubscribe()', async () => {
    const indexer = new GraphQLIndexer('https://indexer.streamfi.io/graphql');
    let receivedDataCount = 0;

    const sub = indexer.subscribe({
      query: 'subscription { streamUpdated { id } }',
      onData: () => {
        receivedDataCount++;
      },
    });

    expect(indexer.getSubscriptionCount()).toBe(1);

    // Unsubscribe and verify active subscription set count decreases to 0
    sub.unsubscribe();
    expect(indexer.getSubscriptionCount()).toBe(0);

    indexer.cleanup();
  });

  it('cleans up all active subscriptions on indexer.cleanup() without memory leak', () => {
    const indexer = new GraphQLIndexer('https://indexer.streamfi.io/graphql');

    const sub1 = indexer.subscribe({ query: 'subscription { sub1 }', onData: () => {} });
    const sub2 = indexer.subscribe({ query: 'subscription { sub2 }', onData: () => {} });
    const sub3 = indexer.subscribe({ query: 'subscription { sub3 }', onData: () => {} });

    expect(indexer.getSubscriptionCount()).toBe(3);

    // Cleanup indexer instance
    indexer.cleanup();
    expect(indexer.getSubscriptionCount()).toBe(0);

    // Subsequent actions throw destroyed error
    expect(() => indexer.subscribe({ query: 'sub', onData: () => {} })).toThrow('GraphQLIndexer has been destroyed');
  });
});
