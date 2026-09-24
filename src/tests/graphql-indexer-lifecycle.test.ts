/**
 * GraphQLIndexer.subscribe() has two entirely separate transports — a
 * WebSocket (graphql-transport-ws) path and an SSE/fetch fallback used when
 * no WebSocket constructor is available — and neither had any test coverage
 * beyond construction/cleanup bookkeeping. This file exercises the message
 * lifecycle of both.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphQLIndexer } from '../indexer.js';

const endpoint = 'https://indexer.streamfi.io/graphql';

// ── WebSocket transport ──────────────────────────────────────────────────

function createMockWs() {
  const mock = {
    readyState: 0,
    sent: [] as string[],
    send: vi.fn((data: string) => {
      mock.sent.push(data);
    }),
    close: vi.fn(),
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    onclose: null as (() => void) | null,
  };
  return mock;
}

describe('GraphQLIndexer.subscribe() — WebSocket transport', () => {
  let mockWs: ReturnType<typeof createMockWs>;
  let wsCtor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockWs = createMockWs();
    wsCtor = vi.fn(function (this: unknown) {
      return mockWs;
    });
    (globalThis as any).WebSocket = wsCtor;
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as any).WebSocket;
  });

  it('derives a wss:// URL from an https:// endpoint', () => {
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData: () => {} });

    expect(wsCtor).toHaveBeenCalledWith('wss://indexer.streamfi.io/graphql', 'graphql-transport-ws');
    indexer.cleanup();
  });

  it('derives a ws:// URL from an http:// endpoint', () => {
    const indexer = new GraphQLIndexer('http://localhost:4000/graphql');
    indexer.subscribe({ query: 'subscription { x }', onData: () => {} });

    expect(wsCtor).toHaveBeenCalledWith('ws://localhost:4000/graphql', 'graphql-transport-ws');
    indexer.cleanup();
  });

  it('sends connection_init on open and defers subscribe until connection_ack', () => {
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({
      query: 'subscription { streamUpdated { id } }',
      variables: { streamId: '1' },
      onData: () => {},
    });

    mockWs.readyState = 1;
    mockWs.onopen!();

    // Only connection_init until the server acks.
    expect(mockWs.sent).toHaveLength(1);
    expect(JSON.parse(mockWs.sent[0]!)).toEqual({ type: 'connection_init' });

    mockWs.onmessage!({ data: JSON.stringify({ type: 'connection_ack' }) });

    expect(mockWs.sent).toHaveLength(2);
    const subscribeMsg = JSON.parse(mockWs.sent[1]!);
    expect(subscribeMsg.type).toBe('subscribe');
    expect(subscribeMsg.payload).toEqual({
      query: 'subscription { streamUpdated { id } }',
      variables: { streamId: '1' },
    });

    indexer.cleanup();
  });

  it('delivers "next" and "data" messages to onData', () => {
    const onData = vi.fn();
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData });

    mockWs.onmessage!({ data: JSON.stringify({ type: 'next', payload: { id: '1' } }) });
    mockWs.onmessage!({ data: JSON.stringify({ type: 'data', data: { id: '2' } }) });

    expect(onData).toHaveBeenNthCalledWith(1, { id: '1' });
    expect(onData).toHaveBeenNthCalledWith(2, { id: '2' });

    indexer.cleanup();
  });

  it('routes "error" messages to onError instead of onData', () => {
    const onData = vi.fn();
    const onError = vi.fn();
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData, onError });

    mockWs.onmessage!({ data: JSON.stringify({ type: 'error', payload: 'boom' }) });

    expect(onData).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));

    indexer.cleanup();
  });

  it('ignores malformed JSON messages without throwing', () => {
    const onData = vi.fn();
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData });

    expect(() => mockWs.onmessage!({ data: 'not json' })).not.toThrow();
    expect(onData).not.toHaveBeenCalled();

    indexer.cleanup();
  });

  it('reports a connection error via onError on socket error', () => {
    const onError = vi.fn();
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData: () => {}, onError });

    mockWs.onerror!({});

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(endpoint) }));

    indexer.cleanup();
  });

  it('swallows exceptions thrown by the caller-supplied onError handler', () => {
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      onError: () => {
        throw new Error('handler blew up');
      },
    });

    expect(() => mockWs.onerror!({})).not.toThrow();

    indexer.cleanup();
  });

  it('sends a "complete" message and closes the socket on unsubscribe()', () => {
    const indexer = new GraphQLIndexer(endpoint);
    const sub = indexer.subscribe({ query: 'subscription { x }', onData: () => {} });
    mockWs.readyState = 1;

    sub.unsubscribe();

    const completeMsg = JSON.parse(mockWs.sent[0]!);
    expect(completeMsg.type).toBe('complete');
    expect(mockWs.close).toHaveBeenCalledTimes(1);
    expect(indexer.getSubscriptionCount()).toBe(0);

    // Idempotent — a second call must not send/close again or throw.
    sub.unsubscribe();
    expect(mockWs.close).toHaveBeenCalledTimes(1);
  });

  it('notifies onError and keeps the subscription active on unexpected close', () => {
    const onError = vi.fn();
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      onError,
      maxReconnectAttempts: 5,
      reconnectDelayMs: 1000,
    });
    expect(indexer.getSubscriptionCount()).toBe(1);

    mockWs.onclose!();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(endpoint) }),
    );
    expect(indexer.getSubscriptionCount()).toBe(1);
    indexer.cleanup();
  });

  it('reconnects and resends connection_init plus subscribe after unexpected close', () => {
    vi.useFakeTimers();
    const sockets: Array<ReturnType<typeof createMockWs>> = [];
    wsCtor.mockImplementation(function () {
      const socket = createMockWs();
      sockets.push(socket);
      return socket;
    });

    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({
      query: 'subscription { streamUpdated { id } }',
      variables: { streamId: '1' },
      onData: () => {},
      onError: () => {},
      maxReconnectAttempts: 3,
      reconnectDelayMs: 10,
    });

    expect(sockets).toHaveLength(1);
    sockets[0]!.onclose!();

    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);

    sockets[1]!.readyState = 1;
    sockets[1]!.onopen!();

    expect(sockets[1]!.sent).toHaveLength(1);
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({ type: 'connection_init' });

    sockets[1]!.onmessage!({ data: JSON.stringify({ type: 'connection_ack' }) });

    expect(sockets[1]!.sent).toHaveLength(2);
    expect(JSON.parse(sockets[1]!.sent[1]!)).toMatchObject({
      type: 'subscribe',
      payload: {
        query: 'subscription { streamUpdated { id } }',
        variables: { streamId: '1' },
      },
    });

    indexer.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not reconnect after unsubscribe during the backoff window', () => {
    vi.useFakeTimers();
    const sockets: Array<ReturnType<typeof createMockWs>> = [];
    wsCtor.mockImplementation(function () {
      const socket = createMockWs();
      sockets.push(socket);
      return socket;
    });

    const indexer = new GraphQLIndexer(endpoint);
    const sub = indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      onError: () => {},
      maxReconnectAttempts: 3,
      reconnectDelayMs: 10,
    });

    sockets[0]!.onclose!();
    sub.unsubscribe();
    vi.advanceTimersByTime(1000);

    expect(sockets).toHaveLength(1);
    expect(indexer.getSubscriptionCount()).toBe(0);
    indexer.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not reconnect after cleanup during the backoff window', () => {
    vi.useFakeTimers();
    const sockets: Array<ReturnType<typeof createMockWs>> = [];
    wsCtor.mockImplementation(function () {
      const socket = createMockWs();
      sockets.push(socket);
      return socket;
    });

    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      onError: () => {},
      maxReconnectAttempts: 3,
      reconnectDelayMs: 10,
    });

    sockets[0]!.onclose!();
    indexer.cleanup();
    vi.advanceTimersByTime(1000);

    expect(sockets).toHaveLength(1);
    expect(indexer.getSubscriptionCount()).toBe(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('tears down after reconnect attempts are exhausted', () => {
    vi.useFakeTimers();
    const sockets: Array<ReturnType<typeof createMockWs>> = [];
    wsCtor.mockImplementation(function () {
      const socket = createMockWs();
      sockets.push(socket);
      return socket;
    });

    const onError = vi.fn();
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      onError,
      maxReconnectAttempts: 2,
      reconnectDelayMs: 10,
    });

    sockets[0]!.onclose!();
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);

    sockets[1]!.onclose!();
    vi.advanceTimersByTime(20);
    expect(sockets).toHaveLength(3);

    sockets[2]!.onclose!();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/exhausted/i) }),
    );
    expect(indexer.getSubscriptionCount()).toBe(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('rejects out-of-range reconnect options before opening a socket', () => {
    const indexer = new GraphQLIndexer(endpoint);

    expect(() =>
      indexer.subscribe({
        query: 'subscription { x }',
        onData: () => {},
        maxReconnectAttempts: 33,
      }),
    ).toThrow(/maxReconnectAttempts/);

    expect(() =>
      indexer.subscribe({
        query: 'subscription { x }',
        onData: () => {},
        reconnectDelayMs: -1,
      }),
    ).toThrow(/reconnectDelayMs/);

    expect(wsCtor).not.toHaveBeenCalled();
    indexer.cleanup();
  });

  it('tears down immediately when maxReconnectAttempts is 0', () => {
    const onError = vi.fn();
    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      onError,
      maxReconnectAttempts: 0,
      reconnectDelayMs: 10,
    });

    mockWs.onclose!();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/exhausted/i) }),
    );
    expect(indexer.getSubscriptionCount()).toBe(0);
    expect(wsCtor).toHaveBeenCalledTimes(1);
  });

  it('uses capped exponential backoff with jitter on reconnect (#597)', () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const sockets: Array<ReturnType<typeof createMockWs>> = [];
    wsCtor.mockImplementation(function () {
      const socket = createMockWs();
      sockets.push(socket);
      return socket;
    });

    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      onError: () => {},
      maxReconnectAttempts: 10,
      reconnectDelayMs: 10_000,
    });

    // Attempt 1: base 10_000, jitter +1_500 => 11_500 total
    sockets[0]!.onclose!();
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);  // not yet (jitter adds 1_500)
    vi.advanceTimersByTime(1_500);
    expect(sockets).toHaveLength(2);  // reconnected

    // Attempt 2: base 20_000, jitter +3_000 => 23_000 total
    sockets[1]!.onclose!();
    vi.advanceTimersByTime(20_000);
    expect(sockets).toHaveLength(2);  // not yet
    vi.advanceTimersByTime(3_000);
    expect(sockets).toHaveLength(3);  // reconnected

    // Attempt 3: base 30_000, cap 30_000, jitter +4_500 => 34_500 total
    sockets[2]!.onclose!();
    vi.advanceTimersByTime(30_000);
    expect(sockets).toHaveLength(3);  // not yet
    vi.advanceTimersByTime(4_500);
    expect(sockets).toHaveLength(4);  // reconnected

    // Attempt 4: base 40_000 but capped at 30_000, jitter +4_500 => 34_500 total (not 44_500)
    sockets[3]!.onclose!();
    vi.advanceTimersByTime(34_500);
    expect(sockets).toHaveLength(5);  // reconnected at capped delay
    vi.advanceTimersByTime(10_000);   // would only reach 44_500 if uncapped - no new socket
    expect(sockets).toHaveLength(5);

    indexer.cleanup();
    randomSpy.mockRestore();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });


});

function sseBodyFromLines(lines: string[]): { getReader: () => any } {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (i >= lines.length) return { value: undefined, done: true };
        const chunk = encoder.encode(lines[i] + '\n');
        i += 1;
        return { value: chunk, done: false };
      },
    }),
  };
}

describe('GraphQLIndexer.subscribe() — SSE fallback transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).WebSocket;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses "data:" lines and delivers the payload to onData', async () => {
    const onData = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBodyFromLines([
        'data: {"data":{"streamUpdated":{"id":"1"}}}',
        '',
        'data: [DONE]',
      ]),
    } as unknown as Response);

    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData });

    // Let the async read loop drain.
    await new Promise((r) => setTimeout(r, 10));

    expect(onData).toHaveBeenCalledWith({ streamUpdated: { id: '1' } });
    indexer.cleanup();
  });

  it('ignores lines that are not SSE data lines and malformed JSON payloads', async () => {
    const onData = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: sseBodyFromLines([
        ': heartbeat',
        'data: not-json',
        'data: {"data":{"ok":true}}',
      ]),
    } as unknown as Response);

    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData });

    await new Promise((r) => setTimeout(r, 10));

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith({ ok: true });
    indexer.cleanup();
  });

  it('reports a non-ok HTTP response via onError', async () => {
    const onError = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
    } as unknown as Response);

    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData: () => {}, onError });

    await new Promise((r) => setTimeout(r, 10));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('503') }));
    indexer.cleanup();
  });

  it('does not report an error when the fetch is aborted by unsubscribe()', async () => {
    const onError = vi.fn();
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    const indexer = new GraphQLIndexer(endpoint);
    const sub = indexer.subscribe({ query: 'subscription { x }', onData: () => {}, onError });
    sub.unsubscribe();

    await new Promise((r) => setTimeout(r, 10));

    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a non-abort fetch rejection via onError', async () => {
    const onError = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const indexer = new GraphQLIndexer(endpoint);
    indexer.subscribe({ query: 'subscription { x }', onData: () => {}, onError });

    await new Promise((r) => setTimeout(r, 10));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'network down' }));
    indexer.cleanup();
  });
});
