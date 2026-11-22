import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLIndexer } from '../indexer.js';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(public readonly url: string, public readonly protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
  }

  /** Simulate an unexpected network drop. */
  drop(): void {
    this.onclose?.();
  }
}

const originalWebSocket = (globalThis as unknown as { WebSocket?: unknown }).WebSocket;

describe('GraphQLIndexer reconnect backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalWebSocket === undefined) {
      delete (globalThis as unknown as { WebSocket?: unknown }).WebSocket;
    } else {
      (globalThis as unknown as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    }
  });

  it('doubles the delay on each reconnect attempt (capped at 30s)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // zero jitter for exact timing
    const indexer = new GraphQLIndexer('https://indexer.example/graphql');
    const sub = indexer.subscribe({
      query: 'subscription { stream { id } }',
      onData: () => {},
      onError: () => {},
      reconnectDelayMs: 1000,
      maxReconnectAttempts: 4,
    });

    // Attempt 1: base 1000 * 2^0 = 1000ms.
    FakeWebSocket.instances[0]!.drop();
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Attempt 2: 1000 * 2^1 = 2000ms.
    FakeWebSocket.instances[1]!.drop();
    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // Attempt 3: 1000 * 2^2 = 4000ms.
    FakeWebSocket.instances[2]!.drop();
    vi.advanceTimersByTime(3999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(4);

    sub.unsubscribe();
  });

  it('adds randomized jitter on top of the exponential delay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 15% of the capped delay
    const indexer = new GraphQLIndexer('https://indexer.example/graphql');
    const sub = indexer.subscribe({
      query: 'subscription { stream { id } }',
      onData: () => {},
      onError: () => {},
      reconnectDelayMs: 1000,
      maxReconnectAttempts: 2,
    });

    // 1000ms base + 0.5 * 0.3 * 1000 = 1150ms.
    FakeWebSocket.instances[0]!.drop();
    vi.advanceTimersByTime(1149);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    sub.unsubscribe();
  });
});
