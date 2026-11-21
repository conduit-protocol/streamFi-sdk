/**
 * Tests for #910 — `GraphQLIndexer.subscribe()` heartbeat ping/pong keepalive.
 *
 * Reconnection + exponential backoff already existed; this issue was about the
 * missing heartbeat. These tests verify the client (a) sends a `ping` on the
 * heartbeat interval, (b) answers a server-initiated `ping` with `pong`,
 * (c) treats a missing `pong` as a dead (half-open) connection and
 * force-reconnects, and (d) stops the heartbeat on unsubscribe.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphQLIndexer } from '../indexer.js';

const endpoint = 'https://indexer.streamfi.io/graphql';

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

function openSocketHandshake(mockWs: ReturnType<typeof createMockWs>): void {
  mockWs.readyState = 1;
  mockWs.onopen!();
  mockWs.onmessage!({ data: JSON.stringify({ type: 'connection_ack' }) });
}

describe('GraphQLIndexer.subscribe() — heartbeat (#910)', () => {
  let mockWs: ReturnType<typeof createMockWs>;
  let wsCtor: ReturnType<typeof vi.fn>;
  let indexer: GraphQLIndexer;

  beforeEach(() => {
    mockWs = createMockWs();
    wsCtor = vi.fn(function (this: unknown) {
      return mockWs;
    });
    (globalThis as any).WebSocket = wsCtor;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
    indexer = new GraphQLIndexer(endpoint);
  });

  afterEach(() => {
    indexer.cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as any).WebSocket;
  });

  it('sends a ping on the heartbeat interval and force-reconnects when no pong arrives', () => {
    indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 50,
      reconnectDelayMs: 0,
      maxReconnectAttempts: 5,
    });
    openSocketHandshake(mockWs);

    // First heartbeat tick: the client sends a ping.
    vi.advanceTimersByTime(100);
    const ping = mockWs.sent.find((s) => JSON.parse(s).type === 'ping');
    expect(ping).toBeDefined();

    // No pong within heartbeatTimeoutMs -> the dead socket is closed and a
    // reconnect is scheduled.
    vi.advanceTimersByTime(50);
    expect(mockWs.close).toHaveBeenCalled();

    // reconnectDelayMs=0 -> the reconnect timer fires immediately.
    vi.advanceTimersByTime(1);
    expect(wsCtor).toHaveBeenCalledTimes(2);
  });

  it('answers a server-initiated ping with a pong', () => {
    indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      heartbeatIntervalMs: 0, // disable client-initiated ping for this test
    });
    openSocketHandshake(mockWs);

    mockWs.sent.length = 0;
    mockWs.onmessage!({ data: JSON.stringify({ type: 'ping' }) });

    const pong = mockWs.sent.find((s) => JSON.parse(s).type === 'pong');
    expect(pong).toBeDefined();
  });

  it('keeps the connection alive when a pong is received (no reconnect)', () => {
    indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 50,
      reconnectDelayMs: 0,
      maxReconnectAttempts: 5,
    });
    openSocketHandshake(mockWs);

    vi.advanceTimersByTime(100);
    // The client sent a ping; respond with a pong.
    mockWs.onmessage!({ data: JSON.stringify({ type: 'pong' }) });

    // Advance past the heartbeat timeout — the pong already cleared awaitingPong,
    // so no timeout and no reconnect should occur.
    vi.advanceTimersByTime(50);
    expect(mockWs.close).not.toHaveBeenCalled();
    expect(wsCtor).toHaveBeenCalledTimes(1);
  });

  it('stops the heartbeat when unsubscribed', () => {
    const sub = indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 50,
    });
    openSocketHandshake(mockWs);
    mockWs.sent.length = 0;

    sub.unsubscribe();

    // Even after a full heartbeat interval elapses, no ping should be sent.
    vi.advanceTimersByTime(200);
    expect(mockWs.sent.find((s) => JSON.parse(s).type === 'ping')).toBeUndefined();
  });

  it('does not send pings when heartbeatIntervalMs is 0 (disabled)', () => {
    indexer.subscribe({
      query: 'subscription { x }',
      onData: () => {},
      heartbeatIntervalMs: 0,
    });
    openSocketHandshake(mockWs);
    mockWs.sent.length = 0;

    vi.advanceTimersByTime(500);
    expect(mockWs.sent.find((s) => JSON.parse(s).type === 'ping')).toBeUndefined();
  });
});

describe('GraphQLIndexer.subscribe() — heartbeat on the default config', () => {
  it('enables the heartbeat by default (30s interval, 5s timeout)', () => {
    const mockWs = createMockWs();
    const wsCtor = vi.fn(function (this: unknown) {
      return mockWs;
    });
    (globalThis as any).WebSocket = wsCtor;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
    const idx = new GraphQLIndexer(endpoint);
    idx.subscribe({ query: 'subscription { x }', onData: () => {} });
    try {
      mockWs.readyState = 1;
      mockWs.onopen!();
      mockWs.sent.length = 0;
      // Default interval is 30s; advance 30s and expect a ping.
      vi.advanceTimersByTime(30_000);
      expect(mockWs.sent.find((s) => JSON.parse(s).type === 'ping')).toBeDefined();
    } finally {
      idx.cleanup();
      vi.useRealTimers();
      vi.restoreAllMocks();
      delete (globalThis as any).WebSocket;
    }
  });
});
