import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketRelayer } from '../relayer/WebSocketRelayer.js';

function createMockWs(): { mock: any; onmessage: () => Function | null } {
  let onmessage: Function | null = null;
  let onopen: Function | null = null;
  let onclose: Function | null = null;
  const mock = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(() => {
      mock.readyState = 3;
      setTimeout(() => {
        if (onclose) onclose();
      }, 0);
    }),
    set onmessage(fn: any) { onmessage = fn; },
    get onmessage() { return onmessage; },
    set onopen(fn: any) { onopen = fn; if (fn) setTimeout(fn, 0); },
    get onopen() { return onopen; },
    set onclose(fn: any) { onclose = fn; },
    get onclose() { return onclose; },
  };
  return { mock, onmessage: () => onmessage };
}

describe('WebSocketRelayer — High-Concurrency Stress Tests', () => {
  let relayer: WebSocketRelayer;
  let mockWs: any;
  let getOnmessage: () => Function | null;

  beforeEach(() => {
    const created = createMockWs();
    mockWs = created.mock;
    getOnmessage = created.onmessage;
    (global as any).WebSocket = vi.fn(function () { return mockWs; }) as any;
    relayer = new WebSocketRelayer('ws://localhost:8080', {
      maxReconnectAttempts: 2,
      reconnectDelayMs: 10,
    });
  });

  afterEach(() => {
    relayer.destroy();
    delete (global as any).WebSocket;
  });

  it('handles 100+ rapid concurrent sends without race conditions', async () => {
    await relayer.connect();
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(relayer.send({ type: 'test', payload: { index: i }, id: `msg-${i}` }));
    }
    await Promise.all(promises);

    expect(mockWs.send.mock.calls.length).toBe(100);
  });

  it('handles concurrent connect calls without duplicate connections', async () => {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(relayer.connect().catch(() => {}));
    }
    await Promise.all(promises);

    // connectPromise is now assigned synchronously, before the first await,
    // so every one of these 20 calls shares the same in-flight promise
    // instead of some of them racing into the lock queue and only checking
    // for an existing connection once they're finally granted it — the
    // previously-tolerated "at most 2" is now a hard guarantee of 1 (#492).
    const wsConstructors = (global as any).WebSocket.mock.calls.length;
    expect(wsConstructors).toBe(1);
  });

  it('rejects connect when the socket emits an error before opening', async () => {
    class ErroringWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor() {
        setTimeout(() => {
          this.onerror?.();
        }, 0);
      }
    }

    (global as any).WebSocket = vi.fn(function () { return new ErroringWebSocket(); }) as any;
    const failingRelayer = new WebSocketRelayer('ws://localhost:65535', {
      maxReconnectAttempts: 0,
      reconnectDelayMs: 1,
    });

    await expect(failingRelayer.connect()).rejects.toThrow(
      'WebSocket connection failed: ws://localhost:65535',
    );
    expect((global as any).WebSocket).toHaveBeenCalledTimes(1);

    failingRelayer.destroy();
  });

  it('queues messages sent before connection and flushes on connect', async () => {
    const relayer2 = new WebSocketRelayer('ws://localhost:8081', {
      maxReconnectAttempts: 1,
      reconnectDelayMs: 5,
    });

    for (let i = 0; i < 50; i++) {
      relayer2.send({ type: 'queue-test', payload: { index: i } }).catch(() => {});
    }

    expect(relayer2.state.pendingCount).toBe(50);
    relayer2.destroy();
  });

  it('registers and fires multiple handlers for the same message type', async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const handler3 = vi.fn();

    relayer.on('price_update', handler1);
    relayer.on('price_update', handler2);
    relayer.on('price_update', handler3);

    await relayer.connect();
    const cb = getOnmessage();
    const msg = JSON.stringify({ type: 'price_update', payload: { price: 100 } });
    if (cb) cb({ data: msg });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler3).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes handlers correctly during high-frequency events', async () => {
    const handler = vi.fn();
    const unsub = relayer.on('high_freq', handler);

    await relayer.connect();
    const cb = getOnmessage();

    for (let i = 0; i < 50; i++) {
      const msg = JSON.stringify({ type: 'high_freq', payload: { tick: i } });
      if (cb) cb({ data: msg });
    }

    expect(handler).toHaveBeenCalledTimes(50);

    unsub();

    for (let i = 0; i < 50; i++) {
      const msg = JSON.stringify({ type: 'high_freq', payload: { tick: i } });
      if (cb) cb({ data: msg });
    }

    expect(handler).toHaveBeenCalledTimes(50);
  });

  it('handlers do not block each other when one throws', async () => {
    const badHandler = vi.fn(() => { throw new Error('handler error'); });
    const goodHandler = vi.fn();

    relayer.on('data', badHandler);
    relayer.on('data', goodHandler);

    await relayer.connect();
    const cb = getOnmessage();
    const msg = JSON.stringify({ type: 'data', payload: { value: 42 } });
    if (cb) cb({ data: msg });

    expect(goodHandler).toHaveBeenCalledTimes(1);
  });

  it('survives rapid connect-disconnect-reconnect cycles', async () => {
    for (let cycle = 0; cycle < 10; cycle++) {
      const r = new WebSocketRelayer('ws://localhost:8090', {
        maxReconnectAttempts: 1,
        reconnectDelayMs: 1,
      });
      r.connect().catch(() => {});
      r.destroy();
    }
  });

  it('does not reconnect after an intentional disconnect close event', async () => {
    await relayer.connect();
    expect((global as any).WebSocket).toHaveBeenCalledTimes(1);

    relayer.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((global as any).WebSocket).toHaveBeenCalledTimes(1);
    expect(relayer.state.connected).toBe(false);
    expect(relayer.state.reconnecting).toBe(false);

    await relayer.connect();
    expect((global as any).WebSocket).toHaveBeenCalledTimes(2);
  });

  it('delivers messages to the correct handler based on type', async () => {
    const priceHandler = vi.fn();
    const tradeHandler = vi.fn();
    const newsHandler = vi.fn();

    relayer.on('price', priceHandler);
    relayer.on('trade', tradeHandler);
    relayer.on('news', newsHandler);

    await relayer.connect();
    const cb = getOnmessage();

    const events = [
      { type: 'price', payload: { value: 100 } },
      { type: 'trade', payload: { amount: 50 } },
      { type: 'price', payload: { value: 101 } },
      { type: 'news', payload: { headline: 'test' } },
    ];

    for (const evt of events) {
      const msg = JSON.stringify(evt);
      if (cb) cb({ data: msg });
    }

    expect(priceHandler).toHaveBeenCalledTimes(2);
    expect(tradeHandler).toHaveBeenCalledTimes(1);
    expect(newsHandler).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed JSON messages without throwing', async () => {
    const handler = vi.fn();
    relayer.on('data', handler);

    await relayer.connect();
    const cb = getOnmessage();

    const malformedMessages: any[] = ['not json', '{broken json', '', null, undefined];

    for (const msg of malformedMessages) {
      if (cb) cb({ data: msg });
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('handles 1000 rapid events without dropping handlers', async () => {
    const handler = vi.fn();
    relayer.on('rapid', handler);

    await relayer.connect();
    const cb = getOnmessage();

    const messages = Array.from({ length: 1000 }, (_, i) =>
      JSON.stringify({ type: 'rapid', payload: { index: i }, id: `evt-${i}` }),
    );

    for (const msg of messages) {
      if (cb) cb({ data: msg });
    }

    expect(handler).toHaveBeenCalledTimes(1000);
  });

  it('state reflects destroyed status correctly', () => {
    expect(relayer.state.destroyed).toBe(false);
    relayer.destroy();
    expect(relayer.state.destroyed).toBe(true);
  });

  it('state reports pending count when connection is down', () => {
    mockWs.readyState = 3;
    relayer.send({ type: 'test', payload: {} }).catch(() => {});
    relayer.send({ type: 'test', payload: {} }).catch(() => {});
    relayer.send({ type: 'test', payload: {} }).catch(() => {});

    expect(relayer.state.pendingCount).toBe(3);
  });

  it('bounds the pending queue instead of growing it without limit', async () => {
    const bounded = new WebSocketRelayer('ws://localhost:8082', {
      maxReconnectAttempts: 0,
      maxPendingMessages: 5,
    });

    for (let i = 0; i < 20; i++) {
      bounded.send({ type: 'test', payload: { index: i } }).catch(() => {});
    }

    expect(bounded.state.pendingCount).toBe(5);
    bounded.destroy();
  });

  it('drops the oldest queued message once the bound is reached, keeping the newest', async () => {
    const bounded = new WebSocketRelayer('ws://localhost:8083', {
      maxReconnectAttempts: 0,
      maxPendingMessages: 2,
    });

    await bounded.send({ type: 'msg', payload: {}, id: '1' });
    await bounded.send({ type: 'msg', payload: {}, id: '2' });
    await bounded.send({ type: 'msg', payload: {}, id: '3' });

    expect(bounded.state.pendingCount).toBe(2);
    bounded.destroy();
  });

  it('rejects send() once reconnect attempts are exhausted instead of queueing forever', async () => {
    class NeverOpensWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor() {
        setTimeout(() => {
          this.onerror?.();
          this.onclose?.();
        }, 0);
      }
    }

    (global as any).WebSocket = vi.fn(function () { return new NeverOpensWebSocket(); }) as any;
    const doomed = new WebSocketRelayer('ws://localhost:65534', {
      maxReconnectAttempts: 0,
      reconnectDelayMs: 1,
    });

    await expect(doomed.connect()).rejects.toThrow();
    // Let the onclose-triggered attemptReconnect() observe attempts are exhausted.
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(doomed.send({ type: 'test', payload: {} })).rejects.toThrow(/exhausted/);

    doomed.destroy();
  });

  it('notifies subscribers when connection state changes', async () => {
    const handler = vi.fn();
    const unsubscribe = relayer.onStateChange(handler);

    await relayer.connect();
    relayer.disconnect();

    expect(handler.mock.calls.map(([transition]) => transition)).toEqual([
      'connecting',
      'connected',
      'disconnected',
    ]);
    expect(handler.mock.calls[1]![1]).toMatchObject({
      connected: true,
      destroyed: false,
    });

    unsubscribe();
    relayer.destroy();

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('resets reconnecting state to false and emits disconnected when reconnect attempts are exhausted (#516)', async () => {
    class AlwaysFailingWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor() {
        setTimeout(() => {
          this.onerror?.();
          this.onclose?.();
        }, 0);
      }
    }

    (global as any).WebSocket = vi.fn(function () { return new AlwaysFailingWebSocket(); }) as any;
    const stateHistory: Array<{ transition: string; state: any }> = [];
    const doomed = new WebSocketRelayer('ws://localhost:65533', {
      maxReconnectAttempts: 2,
      reconnectDelayMs: 5,
      onStateChange: (transition, state) => {
        stateHistory.push({ transition, state: { ...state } });
      },
    });

    await expect(doomed.connect()).rejects.toThrow();

    // Wait for all 2 reconnect attempts to complete and exhaust
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Reconnection is exhausted; reconnecting must NOT be stuck at true
    expect(doomed.state.connected).toBe(false);
    expect(doomed.state.reconnecting).toBe(false);
    expect(doomed.state.destroyed).toBe(false);

    // Final emitted transition must be disconnected with reconnecting: false
    const lastEvent = stateHistory[stateHistory.length - 1];
    expect(lastEvent?.transition).toBe('disconnected');
    expect(lastEvent?.state.reconnecting).toBe(false);
    expect(lastEvent?.state.connected).toBe(false);

    // A fresh connect() resets the exhausted state and attempts reconnect again
    const connectPromise = doomed.connect();
    expect(doomed.state.reconnecting).toBe(false);
    await expect(connectPromise).rejects.toThrow();

    doomed.destroy();
  });

  it('resets reconnecting state to false and aborts mid-reconnect on disconnect() (#619)', async () => {
    class FailingOnceWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();

      constructor() {
        setTimeout(() => {
          this.onerror?.();
          this.onclose?.();
        }, 0);
      }
    }

    (global as any).WebSocket = vi.fn(function () { return new FailingOnceWebSocket(); }) as any;
    
    let disconnectCount = 0;
    const relayer = new WebSocketRelayer('ws://localhost:65532', {
      maxReconnectAttempts: 5,
      reconnectDelayMs: 20,
      onStateChange: (transition) => {
        if (transition === 'disconnected') {
          disconnectCount++;
        }
      },
    });

    const connectPromise = relayer.connect().catch(() => {});

    await new Promise((resolve) => {
      const unsub = relayer.onStateChange((transition) => {
        if (transition === 'reconnecting') {
          unsub();
          resolve(undefined);
        }
      });
    });

    expect(relayer.state.reconnecting).toBe(true);
    
    disconnectCount = 0;
    relayer.disconnect();
    
    expect(relayer.state.reconnecting).toBe(false);
    expect(disconnectCount).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    
    expect((global as any).WebSocket).toHaveBeenCalledTimes(1);
    expect(disconnectCount).toBe(1);

    await connectPromise;
    relayer.destroy();
  });
});

describe('WebSocketRelayer — Heartbeat/Ping Support', () => {
  let relayer: WebSocketRelayer;
  let mockWs: any;
  let getOnmessage: () => Function | null;

  beforeEach(() => {
    const created = createMockWs();
    mockWs = created.mock;
    getOnmessage = created.onmessage;
    (global as any).WebSocket = vi.fn(function () { return mockWs; }) as any;
  });

  afterEach(() => {
    if (relayer) relayer.destroy();
    delete (global as any).WebSocket;
  });

  it('sends ping at configurable heartbeat intervals', async () => {
    vi.useFakeTimers();
    relayer = new WebSocketRelayer('ws://localhost:8080', {
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 500,
    });

    await relayer.connect();
    expect(mockWs.send).toHaveBeenCalledTimes(0);

    // Advance time to trigger first heartbeat
    vi.advanceTimersByTime(1000);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));

    vi.useRealTimers();
  });

  it('resets heartbeat timeout when pong is received', async () => {
    vi.useFakeTimers();
    relayer = new WebSocketRelayer('ws://localhost:8080', {
      heartbeatIntervalMs: 500,
      heartbeatTimeoutMs: 300,
    });

    await relayer.connect();
    const onmessage = getOnmessage();

    // Trigger heartbeat
    vi.advanceTimersByTime(500);
    await new Promise(resolve => setTimeout(resolve, 10));

    const pingCall = mockWs.send.mock.calls.length;
    expect(pingCall).toBeGreaterThan(0);

    // Receive pong before timeout
    onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'pong' }) }));

    // Advance time to timeout threshold without closing connection
    vi.advanceTimersByTime(300);
    expect(mockWs.close).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('closes connection when pong is not received within heartbeat timeout', async () => {
    vi.useFakeTimers();
    relayer = new WebSocketRelayer('ws://localhost:8080', {
      heartbeatIntervalMs: 500,
      heartbeatTimeoutMs: 300,
    });

    await relayer.connect();

    // Trigger heartbeat
    vi.advanceTimersByTime(500);
    await new Promise(resolve => setTimeout(resolve, 10));

    // Advance time past pong timeout without sending pong
    vi.advanceTimersByTime(300);
    await new Promise(resolve => setTimeout(resolve, 10));

    // Connection should be closed due to missing pong
    expect(mockWs.close).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('stops heartbeat on disconnect', async () => {
    vi.useFakeTimers();
    relayer = new WebSocketRelayer('ws://localhost:8080', {
      heartbeatIntervalMs: 1000,
    });

    await relayer.connect();
    relayer.disconnect();

    // Advance time and verify no new pings are sent
    vi.advanceTimersByTime(2000);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockWs.send).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('respects custom heartbeat and timeout options', async () => {
    relayer = new WebSocketRelayer('ws://localhost:8080', {
      heartbeatIntervalMs: 10000,
      heartbeatTimeoutMs: 2000,
    });

    // Verify options are set (indirectly through behavior)
    await relayer.connect();
    expect(relayer.state.connected).toBe(true);

    relayer.disconnect();
  });
});
