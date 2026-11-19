import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketRelayer } from '../relayer/WebSocketRelayer.js';
import { describeContractError, humanizeContractRevert } from '../relayer/ErrorMapper.js';
import { FactoryErrorCode, StreamErrorCode } from '../errors.js';

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

describe('WebSocketRelayer reconnect backoff — full jitter (#1055)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function delayFor(relayer: WebSocketRelayer, attempt: number): number {
    return (relayer as unknown as { reconnectDelayFor(n: number): number }).reconnectDelayFor(attempt);
  }

  it('spreads the delay across the whole [0, cap) window', () => {
    const relayer = new WebSocketRelayer('ws://relay', { reconnectDelayMs: 1000, maxReconnectDelayMs: 30_000 });

    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(delayFor(relayer, 1)).toBe(0);

    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(delayFor(relayer, 1)).toBe(500);
    expect(delayFor(relayer, 3)).toBe(2000);

    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(delayFor(relayer, 2)).toBe(1998);
  });

  it('never exceeds maxReconnectDelayMs', () => {
    const relayer = new WebSocketRelayer('ws://relay', { reconnectDelayMs: 1000, maxReconnectDelayMs: 5000 });
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(delayFor(relayer, 10)).toBeLessThan(5000);
  });
});

describe('WebSocketRelayer inbound message dedupe (#1056)', () => {
  let mockWs: any;
  let getOnmessage: () => Function | null;

  beforeEach(() => {
    const created = createMockWs();
    mockWs = created.mock;
    getOnmessage = created.onmessage;
    (global as any).WebSocket = vi.fn(function () { return mockWs; }) as any;
  });

  afterEach(() => {
    delete (global as any).WebSocket;
  });

  function emit(type: string, id?: string) {
    getOnmessage()?.({ data: JSON.stringify({ type, payload: {}, ...(id === undefined ? {} : { id }) }) });
  }

  it('dispatches a re-delivered message id only once', async () => {
    const relayer = new WebSocketRelayer('ws://relay');
    const handler = vi.fn();
    relayer.on('stream_update', handler);
    await relayer.connect();

    emit('stream_update', 'm-1');
    emit('stream_update', 'm-1');
    emit('stream_update', 'm-2');

    expect(handler).toHaveBeenCalledTimes(2);
    relayer.destroy();
  });

  it('never deduplicates messages without an id', async () => {
    const relayer = new WebSocketRelayer('ws://relay');
    const handler = vi.fn();
    relayer.on('tick', handler);
    await relayer.connect();

    emit('tick');
    emit('tick');

    expect(handler).toHaveBeenCalledTimes(2);
    relayer.destroy();
  });

  it('evicts the oldest id once the window is full', async () => {
    const relayer = new WebSocketRelayer('ws://relay', { dedupeWindowSize: 2 });
    const handler = vi.fn();
    relayer.on('evt', handler);
    await relayer.connect();

    emit('evt', 'a');
    emit('evt', 'b');
    emit('evt', 'c'); // evicts 'a'
    emit('evt', 'a'); // no longer remembered, dispatched again
    emit('evt', 'c'); // still remembered, dropped

    expect(handler).toHaveBeenCalledTimes(4);
    relayer.destroy();
  });

  it('can be disabled with dedupeWindowSize: 0', async () => {
    const relayer = new WebSocketRelayer('ws://relay', { dedupeWindowSize: 0 });
    const handler = vi.fn();
    relayer.on('evt', handler);
    await relayer.connect();

    emit('evt', 'same');
    emit('evt', 'same');

    expect(handler).toHaveBeenCalledTimes(2);
    relayer.destroy();
  });
});

describe('WebSocketRelayer.on unsubscribe (#1058)', () => {
  let mockWs: any;
  let getOnmessage: () => Function | null;

  beforeEach(() => {
    const created = createMockWs();
    mockWs = created.mock;
    getOnmessage = created.onmessage;
    (global as any).WebSocket = vi.fn(function () { return mockWs; }) as any;
  });

  afterEach(() => {
    delete (global as any).WebSocket;
  });

  it('returns a cleanup callback that stops further deliveries', async () => {
    const relayer = new WebSocketRelayer('ws://relay');
    const handler = vi.fn();
    const unsubscribe = relayer.on('evt', handler);
    await relayer.connect();

    getOnmessage()?.({ data: JSON.stringify({ type: 'evt', payload: {} }) });
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    getOnmessage()?.({ data: JSON.stringify({ type: 'evt', payload: {} }) });
    expect(handler).toHaveBeenCalledTimes(1);

    // Calling it twice is harmless.
    expect(() => unsubscribe()).not.toThrow();
    relayer.destroy();
  });
});

describe('contract revert code mapping (#1057)', () => {
  it('maps a code to its variant name and descriptive message', () => {
    expect(describeContractError('stream', StreamErrorCode.StreamEnded)).toEqual({
      contract: 'stream',
      code: StreamErrorCode.StreamEnded,
      name: 'StreamEnded',
      message: 'Stream has passed its end time.',
    });
  });

  it('scopes codes to their contract', () => {
    expect(describeContractError('stream', 1)?.name).toBe('NotAuthorized');
    expect(describeContractError('factory', FactoryErrorCode.NotInitialized)?.name).toBe('NotInitialized');
  });

  it('returns undefined for an unknown code', () => {
    expect(describeContractError('governor', 99)).toBeUndefined();
  });

  it('rewrites a raw revert string into a readable one', () => {
    expect(humanizeContractRevert('stream', 'HostError: Error(Contract, #5)')).toBe(
      'StreamEnded: Stream has passed its end time.',
    );
  });

  it('leaves strings without a known contract code unchanged', () => {
    expect(humanizeContractRevert('stream', 'network timeout')).toBe('network timeout');
    expect(humanizeContractRevert('governor', 'Error(Contract, #99)')).toBe('Error(Contract, #99)');
  });
});
