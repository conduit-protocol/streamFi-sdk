import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetTransaction } = vi.hoisted(() => ({
  mockGetTransaction: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: class {
        getTransaction = mockGetTransaction;
      },
    },
  };
});

import { waitForConfirmation } from '../soroban.js';

const RPC = 'https://rpc.example';

beforeEach(() => {
  vi.useFakeTimers();
  mockGetTransaction.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForConfirmation() — abort signal (#1172)', () => {
  it('rejects with AbortError as soon as the signal aborts, not after the poll interval', async () => {
    mockGetTransaction.mockResolvedValue({ status: 'NOT_FOUND' });
    const controller = new AbortController();

    const promise = waitForConfirmation(RPC, 'abc', {
      pollIntervalMs: 60_000,
      maxAttempts: 5,
      signal: controller.signal,
    });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it('does not poll at all when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const promise = waitForConfirmation(RPC, 'abc', {
      pollIntervalMs: 1_000,
      maxAttempts: 5,
      signal: controller.signal,
    });
    promise.catch(() => {});

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it('keeps polling until confirmation when the signal is not aborted', async () => {
    mockGetTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS' });
    const controller = new AbortController();

    const promise = waitForConfirmation(RPC, 'abc', {
      pollIntervalMs: 1_000,
      maxAttempts: 5,
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toEqual({ hash: 'abc', returnValue: undefined });
    expect(mockGetTransaction).toHaveBeenCalledTimes(2);
  });
});
