import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfirmationTimeoutError, RateLimitError } from '../errors.js';

const { mockGetTransaction } = vi.hoisted(() => ({
  mockGetTransaction: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...(actual as any).SorobanRpc,
      Server: vi.fn().mockImplementation(function MockServer() {
        return { getTransaction: mockGetTransaction };
      }),
      Api: (actual as any).SorobanRpc.Api,
    },
  };
});

import { waitForConfirmation, clearServerCache } from '../soroban.js';
import { waitForConfirmation as waitForConfirmationFromIndex } from '../index.js';

describe('waitForConfirmation (#799)', () => {
  const RPC = 'http://localhost:8000/wait-for-confirmation';
  const HASH = 'abc123';

  beforeEach(() => {
    vi.useFakeTimers();
    clearServerCache();
    mockGetTransaction.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is exported from the package entry point', () => {
    expect(waitForConfirmationFromIndex).toBe(waitForConfirmation);
  });

  it('resolves with the hash and return value once the transaction succeeds', async () => {
    const returnValue = { tag: 'return-value' };
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS', returnValue });

    const promise = waitForConfirmation(RPC, HASH, { pollIntervalMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toEqual({ hash: HASH, returnValue });
    expect(mockGetTransaction).toHaveBeenCalledTimes(1);
    expect(mockGetTransaction).toHaveBeenCalledWith(HASH);
  });

  it('keeps polling while the transaction is NOT_FOUND', async () => {
    mockGetTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS', returnValue: undefined });

    const promise = waitForConfirmation(RPC, HASH, { pollIntervalMs: 100 });
    await vi.advanceTimersByTimeAsync(300);

    await expect(promise).resolves.toEqual({ hash: HASH, returnValue: undefined });
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
  });

  it('waits pollIntervalMs before each poll, using the SDK default when omitted', async () => {
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS', returnValue: undefined });

    const promise = waitForConfirmation(RPC, HASH);
    await vi.advanceTimersByTimeAsync(999);
    expect(mockGetTransaction).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(mockGetTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects when the transaction fails', async () => {
    mockGetTransaction.mockResolvedValue({ status: 'FAILED' });

    const assertion = expect(waitForConfirmation(RPC, HASH, { pollIntervalMs: 100 })).rejects.toThrow(
      `Transaction failed: ${HASH}`,
    );
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('rejects with ConfirmationTimeoutError after maxAttempts polls', async () => {
    mockGetTransaction.mockResolvedValue({ status: 'NOT_FOUND' });

    const promise = waitForConfirmation(RPC, HASH, { pollIntervalMs: 100, maxAttempts: 3 });
    const assertion = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(300);

    const err = await assertion;
    expect(err).toBeInstanceOf(ConfirmationTimeoutError);
    expect((err as ConfirmationTimeoutError).hash).toBe(HASH);
    expect((err as ConfirmationTimeoutError).attempts).toBe(3);
    expect((err as ConfirmationTimeoutError).timeoutMs).toBe(300);
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
  });

  it('rejects with an AbortError when the signal aborts while waiting', async () => {
    mockGetTransaction.mockResolvedValue({ status: 'NOT_FOUND' });
    const controller = new AbortController();

    const promise = waitForConfirmation(RPC, HASH, { pollIntervalMs: 100, signal: controller.signal });
    const assertion = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(150);
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);

    const err = await assertion;
    expect((err as Error).name).toBe('AbortError');
    expect(mockGetTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately, without polling, when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const err = await waitForConfirmation(RPC, HASH, { signal: controller.signal }).catch((e: unknown) => e);

    expect((err as Error).name).toBe('AbortError');
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it('propagates an RPC error raised while polling', async () => {
    mockGetTransaction.mockRejectedValue(new Error('rpc exploded'));

    const assertion = expect(waitForConfirmation(RPC, HASH, { pollIntervalMs: 100 })).rejects.toThrow(
      'rpc exploded',
    );
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('maps a 429 raised while polling to RateLimitError', async () => {
    // The RPC client retries rate-limited calls with backoff before giving
    // up, so run the timers to completion. A distinct URL keeps the retry
    // failures out of the circuit state the other tests use.
    mockGetTransaction.mockRejectedValue({ response: { status: 429, headers: {} } });

    const promise = waitForConfirmation('http://localhost:8000/wait-for-confirmation-429', HASH, {
      pollIntervalMs: 100,
    });
    const assertion = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await assertion).toBeInstanceOf(RateLimitError);
  });
});
