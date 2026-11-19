/**
 * Tests for #1091 (`useStream`) and #1092 (`useStreamEvents`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Keypair } from '@stellar/stellar-sdk';
import { ConduitClient, useStream, useStreamEvents } from '../index.js';
import type { StreamInfo, StreamEventHandlers } from '../types/index.js';

const NOW = 1_700_000_000;

function createClient(): ConduitClient {
  return new ConduitClient({
    network: 'testnet',
    factoryAddress: 'CFACTORYPLACEHOLDER',
    keypair: Keypair.random(),
  });
}

function makeStream(overrides: Partial<StreamInfo> = {}): StreamInfo {
  return {
    id: 1n,
    address: 'CSTREAM',
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    token: 'native',
    ratePerSecond: 10n,
    startTime: NOW - 100,
    endTime: NOW + 100,
    withdrawn: 0n,
    paused: false,
    pausedAt: 0,
    cancelled: false,
    clawbackEnabled: false,
    ...overrides,
  };
}

describe('useStream (#1091)', () => {
  let client: ConduitClient;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    client = createClient();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads the stream and derives vested amount and progress', async () => {
    vi.spyOn(client.streams, 'get').mockResolvedValue(makeStream());
    const { result } = renderHook(() => useStream('1', { client }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.stream?.id).toBe(1n);
    expect(result.current.vestedAmount).toBe(1000n);
    expect(result.current.progress).toBeCloseTo(0.5);
    expect(result.current.isLoading).toBe(false);
  });

  it('ticks the vested amount every second without refetching', async () => {
    const get = vi.spyOn(client.streams, 'get').mockResolvedValue(makeStream());
    const { result } = renderHook(() => useStream('1', { client }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(result.current.vestedAmount).toBe(1030n);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('withdraws and then refetches the stream', async () => {
    const get = vi.spyOn(client.streams, 'get').mockResolvedValue(makeStream());
    const withdraw = vi.spyOn(client.streams, 'withdraw').mockResolvedValue('txhash');
    const { result } = renderHook(() => useStream('1', { client }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    let hash = '';
    await act(async () => {
      hash = await result.current.withdraw(50n);
    });

    expect(hash).toBe('txhash');
    expect(withdraw).toHaveBeenCalledWith('1', 50n);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('surfaces fetch errors', async () => {
    vi.spyOn(client.streams, 'get').mockRejectedValue(new Error('rpc down'));
    const { result } = renderHook(() => useStream('1', { client }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.error?.message).toBe('rpc down');
    expect(result.current.stream).toBeNull();
    expect(result.current.vestedAmount).toBeNull();
  });

  it('does nothing without a streamId', () => {
    const get = vi.spyOn(client.streams, 'get');
    const { result } = renderHook(() => useStream(null, { client }));

    expect(get).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.progress).toBe(0);
  });
});

describe('useStreamEvents (#1092)', () => {
  let client: ConduitClient;
  let captured: StreamEventHandlers | null;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = createClient();
    captured = null;
    unsubscribe = vi.fn();
    vi.spyOn(client.streams, 'subscribe').mockImplementation((_id, handlers) => {
      captured = handlers;
      return { unsubscribe };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers typed events to onEvent', () => {
    const onEvent = vi.fn();
    renderHook(() => useStreamEvents('1', onEvent, { client }));

    const withdrawEvent = { amount: 5n } as never;
    const cancelEvent = { refunded: 1n } as never;
    act(() => {
      captured!.onWithdraw!(withdrawEvent);
      captured!.onCancel!(cancelEvent);
    });

    expect(onEvent).toHaveBeenNthCalledWith(1, { kind: 'withdrawn', event: withdrawEvent });
    expect(onEvent).toHaveBeenNthCalledWith(2, { kind: 'cancelled', event: cancelEvent });
  });

  it('uses the latest callback without resubscribing', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useStreamEvents('1', cb, { client }), {
      initialProps: { cb: first },
    });

    rerender({ cb: second });
    act(() => {
      captured!.onPause!({} as never);
    });

    expect(client.streams.subscribe).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ kind: 'paused', event: {} });
  });

  it('reports subscription errors and unsubscribes on unmount', () => {
    const { result, unmount } = renderHook(() => useStreamEvents('1', vi.fn(), { client }));

    act(() => {
      captured!.onError!(new Error('poll failed'));
    });
    expect(result.current.error?.message).toBe('poll failed');

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe without a streamId', () => {
    renderHook(() => useStreamEvents(undefined, vi.fn(), { client }));
    expect(client.streams.subscribe).not.toHaveBeenCalled();
  });
});
