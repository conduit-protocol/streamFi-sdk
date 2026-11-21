import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketRelayer } from '../relayer/WebSocketRelayer.js';
import { ErrorMapper } from '../relayer/ErrorMapper.js';
import { ConduitError } from '../errors.js';

function createMockWs(): { mock: any; onmessage: () => Function | null } {
  let onmessage: Function | null = null;
  let onopen: Function | null = null;
  const mock = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    set onmessage(fn: any) { onmessage = fn; },
    get onmessage() { return onmessage; },
    set onopen(fn: any) { onopen = fn; if (fn) setTimeout(fn, 0); },
    get onopen() { return onopen; },
  };
  return { mock, onmessage: () => onmessage };
}

describe('ErrorMapper — listener cleanup (#81)', () => {
  let relayer: WebSocketRelayer;
  let mockWs: any;
  let getOnmessage: () => Function | null;

  beforeEach(() => {
    const created = createMockWs();
    mockWs = created.mock;
    getOnmessage = created.onmessage;
    (global as any).WebSocket = vi.fn(function () { return mockWs; }) as any;
    relayer = new WebSocketRelayer('ws://localhost:8080');
  });

  afterEach(() => {
    relayer.destroy();
    delete (global as any).WebSocket;
  });

  function emit(type: string, payload: unknown) {
    const cb = getOnmessage();
    if (cb) cb({ data: JSON.stringify({ type, payload }) });
  }

  it('removes its relayer listeners on dispose instead of leaking them', async () => {
    const onError = vi.fn();
    const mapper = new ErrorMapper(relayer, onError);
    mapper.attach();
    await relayer.connect();

    emit('stream_error', { code: 2 });
    expect(onError).toHaveBeenCalledTimes(1);

    mapper.dispose();
    emit('stream_error', { code: 2 });

    // No new call, and the relayer itself has no handlers left registered.
    expect(onError).toHaveBeenCalledTimes(1);
    expect((relayer as any).handlers.size).toBe(0);
  });

  it('does not invoke the callback for messages that arrive after dispose (state mutated post-resolve)', async () => {
    const onError = vi.fn();
    const mapper = new ErrorMapper(relayer, onError);
    mapper.attach();
    await relayer.connect();

    // Simulates the async-resolves-after-teardown race from the bug report:
    // dispose happens first, the stale message arrives a tick later.
    mapper.dispose();
    await Promise.resolve();
    emit('factory_error', { code: 5 });

    expect(onError).not.toHaveBeenCalled();
  });

  it('re-attaching does not double-register listeners (no accumulation across attach calls)', async () => {
    const onError = vi.fn();
    const mapper = new ErrorMapper(relayer, onError);

    mapper.attach();
    mapper.attach();
    mapper.attach();
    await relayer.connect();

    emit('governor_error', { code: 1 });

    // If listeners had accumulated, this would fire 3 times instead of 1.
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not allow attach to revive a disposed mapper', () => {
    const onError = vi.fn();
    const mapper = new ErrorMapper(relayer, onError);

    mapper.attach();
    mapper.dispose();

    expect(() => mapper.attach()).toThrow(
      /ErrorMapper has been disposed and cannot be re-attached/,
    );
    expect((relayer as any).handlers.size).toBe(0);
  });

  it('ignores null/malformed payloads instead of throwing or forwarding them', async () => {
    const onError = vi.fn();
    const mapper = new ErrorMapper(relayer, onError);
    mapper.attach();
    await relayer.connect();

    emit('stream_error', null);
    emit('stream_error', undefined);

    expect(onError).not.toHaveBeenCalled();
  });

  it('maps a raw payload to a typed ConduitError scoped to the right contract', async () => {
    const onError = vi.fn();
    const mapper = new ErrorMapper(relayer, onError);
    mapper.attach();
    await relayer.connect();

    emit('stream_error', { code: 6 });

    expect(onError).toHaveBeenCalledTimes(1);
    const call = onError.mock.calls[0];
    expect(call).toBeDefined();
    const err = call![0];
    expect(err).toBeInstanceOf(ConduitError);
    expect(err.contract).toBe('stream');
    expect(err.code).toBe(6);
  });

  it('allows callers to register custom error message types', async () => {
    const onError = vi.fn();
    const mapper = new ErrorMapper(relayer, onError, {
      errorMessageTypes: {
        proxy_error: 'factory',
      },
    });
    mapper.attach();
    await relayer.connect();

    emit('proxy_error', { code: 5 });

    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]![0];
    expect(err).toBeInstanceOf(ConduitError);
    expect(err.contract).toBe('factory');
    expect(err.code).toBe(5);
  });
});
