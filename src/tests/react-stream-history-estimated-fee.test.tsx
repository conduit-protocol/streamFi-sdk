/**
 * Tests for useStreamHistory (SWR-like background revalidation) and
 * useEstimatedFee (debounced fee estimates) in src/react/hooks.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { Keypair } from '@stellar/stellar-sdk';
import {
  ConduitClient,
  ConduitProvider,
  useStreamHistory,
  useEstimatedFee,
} from '../index.js';
import type { StreamHistoryEntry, StreamHistoryPage } from '../events.js';
import type { StreamOperation } from '../types/index.js';

function createClient(): ConduitClient {
  return new ConduitClient({
    network: 'testnet',
    factoryAddress: 'CFACTORYPLACEHOLDER',
    keypair: Keypair.random(),
  });
}

function entry(kind: string, id: string): StreamHistoryEntry {
  return {
    id,
    ledger: 1,
    timestamp: '2026-01-01T00:00:00Z',
    txHash: `tx-${id}`,
    kind,
  } as unknown as StreamHistoryEntry;
}

function page(entries: StreamHistoryEntry[]): StreamHistoryPage {
  return { entries, nextCursor: undefined };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useStreamHistory', () => {
  let client: ConduitClient;

  beforeEach(() => {
    client = createClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches and groups deposits, withdrawals and cancellations', async () => {
    const spy = vi.spyOn(client.streams, 'getHistory').mockResolvedValue(
      page([
        entry('created', 'a'),
        entry('top_up', 'b'),
        entry('withdraw', 'c'),
        entry('cancel', 'd'),
        entry('pause', 'e'),
      ]),
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ConduitProvider client={client}>{children}</ConduitProvider>
    );
    const { result } = renderHook(
      () => useStreamHistory(1n, { refreshIntervalMs: 0, revalidateOnFocus: false }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.entries).toHaveLength(4));
    expect(result.current.deposits.map((e) => e.id)).toEqual(['a', 'b']);
    expect(result.current.withdrawals.map((e) => e.id)).toEqual(['c']);
    expect(result.current.cancellations.map((e) => e.id)).toEqual(['d']);
    expect(result.current.isLoading).toBe(false);
    expect(spy).toHaveBeenCalledWith(1n, { limit: 50 });
  });

  it('keeps stale data on screen while revalidating in the background (SWR)', async () => {
    const stalePage = page([entry('created', 'old'), entry('withdraw', 'old-w')]);
    const fresh = deferred<StreamHistoryPage>();
    const spy = vi
      .spyOn(client.streams, 'getHistory')
      .mockResolvedValueOnce(stalePage)
      .mockImplementationOnce(() => fresh.promise);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ConduitProvider client={client}>{children}</ConduitProvider>
    );
    const { result } = renderHook(
      () => useStreamHistory('stream-1', { refreshIntervalMs: 0, revalidateOnFocus: false }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.entries).toHaveLength(2));

    act(() => {
      void result.current.refresh();
    });
    expect(result.current.isValidating).toBe(true);
    expect(result.current.entries.map((e) => e.id)).toEqual(['old', 'old-w']);

    const newPage = page([entry('cancel', 'new')]);
    await act(async () => {
      fresh.resolve(newPage);
      await fresh.promise;
    });
    await waitFor(() => expect(result.current.entries.map((e) => e.id)).toEqual(['new']));
    expect(result.current.isValidating).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('can limit entries to selected categories', async () => {
    vi.spyOn(client.streams, 'getHistory').mockResolvedValue(
      page([entry('created', 'a'), entry('withdraw', 'b'), entry('cancel', 'c')]),
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ConduitProvider client={client}>{children}</ConduitProvider>
    );
    const { result } = renderHook(
      () =>
        useStreamHistory(1n, {
          types: ['withdrawal'],
          refreshIntervalMs: 0,
          revalidateOnFocus: false,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries[0]?.id).toBe('b');
  });

  it('does nothing when disabled', () => {
    const spy = vi.spyOn(client.streams, 'getHistory');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ConduitProvider client={client}>{children}</ConduitProvider>
    );
    renderHook(() => useStreamHistory(1n, { enabled: false, revalidateOnFocus: false }), {
      wrapper,
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('useEstimatedFee', () => {
  let client: ConduitClient;

  beforeEach(() => {
    client = createClient();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('debounces rapid operation changes and estimates only the latest input', async () => {
    const fee = { totalFee: 500n, resourceFee: 400n, baseFee: 100n, instructions: 2n };
    const spy = vi.spyOn(client.streams, 'estimateFee').mockResolvedValue(fee);
    const op1: StreamOperation = { type: 'withdraw', streamId: 1n, amount: 10n };
    const op2: StreamOperation = { type: 'withdraw', streamId: 1n, amount: 20n };
    const op3: StreamOperation = { type: 'cancel', streamId: 1n };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ConduitProvider client={client}>{children}</ConduitProvider>
    );
    const { result, rerender } = renderHook(
      ({ op }: { op: StreamOperation }) => useEstimatedFee(op, { debounceMs: 300 }),
      { wrapper, initialProps: { op: op1 } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(spy).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(op1);
    expect(result.current.estimate).toEqual(fee);

    rerender({ op: op2 });
    rerender({ op: op3 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(op3);
  });

  it('does not estimate when disabled', async () => {
    const spy = vi.spyOn(client.streams, 'estimateFee');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <ConduitProvider client={client}>{children}</ConduitProvider>
    );
    renderHook(() => useEstimatedFee('create', { enabled: false, debounceMs: 300 }), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
