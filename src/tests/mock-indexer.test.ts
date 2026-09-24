import { describe, it, expect } from 'vitest';
import { MockGraphQLIndexer, createMockIndexer } from '../mock-indexer.js';

describe('MockGraphQLIndexer', () => {
  it('returns preset query responses', async () => {
    const indexer = new MockGraphQLIndexer({
      queries: {
        'query GetStreams { streams { id } }': { streams: [{ id: '1' }] },
      },
    });

    const result = await indexer.query({ query: 'query GetStreams { streams { id } }' });
    expect(result).toEqual({ streams: [{ id: '1' }] });
  });

  it('returns undefined for unknown queries in non-strict mode', async () => {
    const indexer = new MockGraphQLIndexer();
    const result = await indexer.query({ query: 'query Unknown { unknown }' });
    expect(result).toBeUndefined();
  });

  it('throws for unknown queries in strict mode', async () => {
    const indexer = new MockGraphQLIndexer({ strict: true });
    await expect(indexer.query({ query: 'query Unknown { unknown }' })).rejects.toThrow(
      'MockGraphQLIndexer: no preset response',
    );
  });

  it('emits subscription events in order', async () => {
    const indexer = new MockGraphQLIndexer({
      subscriptions: {
        'subscription OnStream { onStream { id } }': [{ id: '1' }, { id: '2' }],
      },
    });

    const events: unknown[] = [];
    const sub = indexer.subscribe({
      query: 'subscription OnStream { onStream { id } }',
      onData: (data) => events.push(data),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([{ id: '1' }, { id: '2' }]);
    sub.unsubscribe();
  });

  it('stops emitting after unsubscribe', async () => {
    const indexer = new MockGraphQLIndexer({
      subscriptions: {
        'sub': [{ id: '1' }, { id: '2' }],
      },
    });

    const events: unknown[] = [];
    const sub = indexer.subscribe({
      query: 'sub',
      onData: (data) => events.push(data),
    });

    sub.unsubscribe();
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([]);
  });

  it('createMockIndexer is a convenience factory', () => {
    const indexer = createMockIndexer({ queries: { 'q': 'data' } });
    expect(indexer).toBeInstanceOf(MockGraphQLIndexer);
  });

  it('throws when destroyed', async () => {
    const indexer = new MockGraphQLIndexer();
    indexer.cleanup();
    await expect(indexer.query({ query: 'q' })).rejects.toThrow('destroyed');
  });
});
