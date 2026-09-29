import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_ERROR_MESSAGE_TYPE_MAP } from '../relayer/ErrorMapper.js';
import type { ErrorMessageTypeMap } from '../relayer/ErrorMapper.js';
import { ConduitError, type ConduitContract } from '../errors.js';

/**
 * #773 — Export a default ErrorMessageTypeMap for ErrorMapper.
 */

describe('DEFAULT_ERROR_MESSAGE_TYPE_MAP (#773)', () => {
  it('covers the SDK\u2019s own known error message types', () => {
    expect(DEFAULT_ERROR_MESSAGE_TYPE_MAP).toEqual({
      stream_error: 'stream',
      factory_error: 'factory',
      governor_error: 'governor',
    });
  });

  it('maps each entry to a valid ConduitContract', () => {
    const knownContracts: ConduitContract[] = ['stream', 'factory', 'governor'];
    for (const contract of Object.values(DEFAULT_ERROR_MESSAGE_TYPE_MAP)) {
      expect(knownContracts).toContain(contract);
    }
  });
});

describe('ErrorMapper + DEFAULT_ERROR_MESSAGE_TYPE_MAP (#773)', () => {
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

  function buildMapper(options: { errorMessageTypes?: ErrorMessageTypeMap } = {}) {
    const { mock, onmessage } = createMockWs();
    (global as any).WebSocket = vi.fn(function () { return mock; }) as any;
    const onError = vi.fn();
    let mapper: any;
    return { onError, onmessage, dispose: () => mapper?.dispose(), create: async () => {
      const { WebSocketRelayer } = await import('../relayer/WebSocketRelayer.js');
      const { ErrorMapper } = await import('../relayer/ErrorMapper.js');
      const relayer = new WebSocketRelayer('ws://localhost:8080');
      mapper = new ErrorMapper(relayer, onError, options);
      mapper.attach();
      await relayer.connect();
      return relayer;
    } };
  }

  function emit(getOnmessage: () => Function | null, type: string, payload: unknown) {
    const cb = getOnmessage();
    if (cb) cb({ data: JSON.stringify({ type, payload }) });
  }

  it('maps default message types without a custom options map', async () => {
    const m = buildMapper();
    const relayer = await m.create();

    emit(m.onmessage, 'stream_error', { code: 2 });

    expect(m.onError).toHaveBeenCalledTimes(1);
    expect(m.onError.mock.calls[0]![0]).toBeInstanceOf(ConduitError);

    m.dispose();
    relayer.destroy();
    delete (global as any).WebSocket;
  });

  it('lets consumers spread the default and add only their own custom types', async () => {
    const m = buildMapper({
      errorMessageTypes: { ...DEFAULT_ERROR_MESSAGE_TYPE_MAP, custom_error: 'factory' },
    });
    const relayer = await m.create();

    emit(m.onmessage, 'custom_error', { code: 7 });
    emit(m.onmessage, 'factory_error', { code: 3 });

    expect(m.onError).toHaveBeenCalledTimes(2);
    expect(m.onError.mock.calls[0]![0].contract).toBe('factory');
    expect(m.onError.mock.calls[1]![0].contract).toBe('factory');

    m.dispose();
    relayer.destroy();
    delete (global as any).WebSocket;
  });

  it('lets a custom map override a default entry\u2019s contract', async () => {
    const m = buildMapper({
      errorMessageTypes: { ...DEFAULT_ERROR_MESSAGE_TYPE_MAP, stream_error: 'governor' },
    });
    const relayer = await m.create();

    emit(m.onmessage, 'stream_error', { code: 2 });

    expect(m.onError).toHaveBeenCalledTimes(1);
    expect(m.onError.mock.calls[0]![0].contract).toBe('governor');

    m.dispose();
    relayer.destroy();
    delete (global as any).WebSocket;
  });
});
