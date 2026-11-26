import { describe, it, expect, vi } from 'vitest';
import {
  GraphQLIndexer,
  replayEventsFrom,
  REPLAY_EVENTS_FROM_QUERY,
  type ReplayEventsFromOptions,
} from '../indexer.js';

interface TestEvent {
  id: string;
  ledger: number;
  txHash: string;
}

function event(ledger: number, id = `evt-${ledger}`): TestEvent {
  return { id, ledger, txHash: `hash-${ledger}` };
}

function page(items: unknown[], pageInfo: Record<string, unknown> = {}) {
  return { streamEvents: { items, pageInfo } };
}

describe('GraphQLIndexer.replayEventsFrom', () => {
  it('requests events from the supplied ledger offset and returns them in order', async () => {
    const indexer = new GraphQLIndexer('http://indexer');
    const query = vi.spyOn(indexer, 'query').mockResolvedValue(
      page([event(10), event(12)]),
    );

    const result = await indexer.replayEventsFrom<TestEvent>(10, { toLedger: 20, persist: false });

    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      query: REPLAY_EVENTS_FROM_QUERY,
      variables: expect.objectContaining({ fromLedger: 10, toLedger: 20, limit: 100 }),
      persist: false,
    }));
    expect(result).toHaveLength(2);
    expect(result[0]!.ledger).toBe(10);
    expect(result.lastLedger).toBe(12);
    expect(result.dispatched).toBe(2);
    expect(result.events).toBe(result);
  });

  it('derives the offset from lastProcessedLedger (exclusive by default)', async () => {
    const indexer = new GraphQLIndexer('http://indexer');
    const query = vi.spyOn(indexer, 'query').mockResolvedValue(page([]));

    await indexer.replayEventsFrom({ lastProcessedLedger: 99 });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({ fromLedger: 100 }),
    }));

    await indexer.replayEventsFrom({ lastProcessedLedger: 99, inclusive: true });
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({
      variables: expect.objectContaining({ fromLedger: 99 }),
    }));
  });

  it('applies ledgerOffset as a ledger-sequence window', async () => {
    const indexer = new GraphQLIndexer('http://indexer');
    const query = vi.spyOn(indexer, 'query').mockResolvedValue(page([]));

    await indexer.replayEventsFrom(500, { ledgerOffset: 25 });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      variables: expect.objectContaining({ fromLedger: 500, toLedger: 525 }),
    }));
  });

  it('pages through cursors, deduplicates ids and stops at toLedger', async () => {
    const indexer = new GraphQLIndexer('http://indexer');
    const query = vi.spyOn(indexer, 'query')
      .mockResolvedValueOnce(page([event(1)], { hasNextPage: true, endCursor: 'c1' }))
      .mockResolvedValueOnce(page([event(1), event(2)], { hasNextPage: true, endCursor: 'c2' }))
      .mockResolvedValueOnce(page([event(30), event(31)]));

    const onEvent = vi.fn();
    const result = await indexer.replayEventsFrom<TestEvent>(1, {
      toLedger: 20,
      pageSize: 1,
      onEvent,
    });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenNthCalledWith(2, expect.objectContaining({
      variables: expect.objectContaining({ cursor: 'c1' }),
    }));
    expect(result.map((e) => e.ledger)).toEqual([1, 2]);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(result.lastLedger).toBe(2);
    expect(result.pagesFetched).toBe(3);
  });

  it('works as a standalone function with an endpoint', async () => {
    const indexer = new GraphQLIndexer('http://indexer');
    const query = vi.spyOn(GraphQLIndexer.prototype, 'query').mockResolvedValue(page([event(7)]));
    try {
      const result = await replayEventsFrom(indexer, 7);
      expect(result.dispatched).toBe(1);
      expect(query).toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });

  it('rejects invalid ledger bounds and page limits', async () => {
    const indexer = new GraphQLIndexer('http://indexer');
    vi.spyOn(indexer, 'query').mockResolvedValue(page([]));

    const options: ReplayEventsFromOptions = {};
    await expect(indexer.replayEventsFrom(0)).rejects.toThrow(/fromLedger/);
    await expect(indexer.replayEventsFrom(10, { toLedger: 5 })).rejects.toThrow(/toLedger/);
    await expect(indexer.replayEventsFrom(10, { pageSize: 0, ...options })).rejects.toThrow(/pageSize/);
    await expect(indexer.replayEventsFrom(10, { maxPages: 0 })).rejects.toThrow(/maxPages/);
    await expect(indexer.replayEventsFrom(10, { ledgerOffset: -1 })).rejects.toThrow(/ledgerOffset/);
  });

  it('enforces maxPages', async () => {
    const indexer = new GraphQLIndexer('http://indexer');
    let pageNumber = 0;
    vi.spyOn(indexer, 'query').mockImplementation(async () =>
      page([event(1)], { hasNextPage: true, endCursor: `cursor-${++pageNumber}` }),
    );

    await expect(indexer.replayEventsFrom(1, { maxPages: 2 })).rejects.toThrow(/maxPages/);
  });
});
