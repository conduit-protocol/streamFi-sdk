/**
 * Tests for #1089 (HTTP polling fallback once WebSocket reconnects are
 * exhausted) and #1090 (`status` filter on `streamsByRecipient`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphQLIndexer } from '../indexer.js';

const endpoint = 'https://indexer.streamfi.io/graphql';

function createMockWs() {
  return {
    readyState: 0,
    send: vi.fn(),
    close: vi.fn(),
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    onclose: null as (() => void) | null,
  };
}

describe('GraphQLIndexer.subscribe() — polling fallback (#1089)', () => {
  let sockets: Array<ReturnType<typeof createMockWs>>;
  let indexer: GraphQLIndexer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    sockets = [];
    (globalThis as any).WebSocket = vi.fn(function () {
      const socket = createMockWs();
      sockets.push(socket);
      return socket;
    });
    indexer = new GraphQLIndexer(endpoint);
  });

  afterEach(() => {
    indexer.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as any).WebSocket;
  });

  function exhaustReconnects(): void {
    sockets[0]!.onclose!();
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    sockets[1]!.onclose!();
  }

  it('polls over HTTP once reconnects are exhausted and keeps the subscription alive', async () => {
    const query = vi.spyOn(indexer, 'query').mockResolvedValue({ x: 1 });
    const onData = vi.fn();
    const onError = vi.fn();
    indexer.subscribe({
      query: 'subscription Live { x }',
      variables: { id: '1' },
      onData,
      onError,
      maxReconnectAttempts: 1,
      reconnectDelayMs: 10,
      pollingIntervalMs: 100,
    });

    exhaustReconnects();
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/exhausted; falling back to HTTP polling/) }),
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'query Live { x }', variables: { id: '1' } }),
    );
    expect(onData).toHaveBeenCalledWith({ x: 1 });
    expect(indexer.getSubscriptionCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('uses an explicit pollingQuery when given', async () => {
    const query = vi.spyOn(indexer, 'query').mockResolvedValue({});
    indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      maxReconnectAttempts: 1,
      reconnectDelayMs: 10,
      pollingQuery: 'query Snapshot { x }',
    });

    exhaustReconnects();
    await vi.advanceTimersByTimeAsync(0);

    expect(query).toHaveBeenCalledWith(expect.objectContaining({ query: 'query Snapshot { x }' }));
  });

  it('keeps polling after a failed poll and reports the error', async () => {
    const query = vi
      .spyOn(indexer, 'query')
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue({ x: 2 });
    const onData = vi.fn();
    const onError = vi.fn();
    indexer.subscribe({
      query: 'subscription { x }',
      onData,
      onError,
      maxReconnectAttempts: 1,
      reconnectDelayMs: 10,
      pollingIntervalMs: 100,
    });

    exhaustReconnects();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: '503' }));

    await vi.advanceTimersByTimeAsync(100);
    expect(query).toHaveBeenCalledTimes(2);
    expect(onData).toHaveBeenCalledWith({ x: 2 });
  });

  it('stops polling on unsubscribe', async () => {
    const query = vi.spyOn(indexer, 'query').mockResolvedValue({});
    const sub = indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      maxReconnectAttempts: 1,
      reconnectDelayMs: 10,
      pollingIntervalMs: 100,
    });

    exhaustReconnects();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
    await vi.advanceTimersByTimeAsync(1000);
    expect(query).toHaveBeenCalledTimes(1);
    expect(indexer.getSubscriptionCount()).toBe(0);
  });

  it('rejects an out-of-range pollingIntervalMs', () => {
    expect(() =>
      indexer.subscribe({ query: 'subscription { x }', onData: () => {}, pollingIntervalMs: 5 }),
    ).toThrow(/pollingIntervalMs/);
  });
});

describe('GraphQLIndexer.streamsByRecipient() — status filter (#1090)', () => {
  let indexer: GraphQLIndexer;

  beforeEach(() => {
    indexer = new GraphQLIndexer(endpoint);
  });

  afterEach(() => {
    indexer.cleanup();
    vi.restoreAllMocks();
  });

  it.each(['active', 'completed'] as const)('passes status=%s to the indexer', async (status) => {
    const query = vi.spyOn(indexer, 'query').mockResolvedValue({});
    await indexer.streamsByRecipient('GRECIPIENT', { status });

    const call = query.mock.calls[0]![0];
    expect(call.variables).toEqual({ recipient: 'GRECIPIENT', status });
    expect(call.query).toContain('$status: String');
    expect(call.query).toContain('status: $status');
  });

  it('sends no status argument for the default "all"', async () => {
    const query = vi.spyOn(indexer, 'query').mockResolvedValue({});
    await indexer.streamsByRecipient('GRECIPIENT', { status: 'all' });
    await indexer.streamsByRecipient('GRECIPIENT');

    for (const [call] of query.mock.calls) {
      expect(call.variables).toEqual({ recipient: 'GRECIPIENT' });
      expect(call.query).not.toContain('$status');
    }
  });

  it('keeps other query options such as timeoutMs', async () => {
    const query = vi.spyOn(indexer, 'query').mockResolvedValue({});
    await indexer.streamsByRecipient('GRECIPIENT', { status: 'active', timeoutMs: 5000 });

    expect(query.mock.calls[0]![0]).toEqual(expect.objectContaining({ timeoutMs: 5000 }));
    expect(query.mock.calls[0]![0]).not.toHaveProperty('status');
  });

  it('rejects an unknown status', async () => {
    await expect(
      indexer.streamsByRecipient('GRECIPIENT', { status: 'paused' as never }),
    ).rejects.toThrow(/status must be one of/);
  });
});
