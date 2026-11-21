import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * #635 — end-to-end coverage of `createRpcServer`'s 429 retry path: a
 * rate-limited call is retried, and when the RPC supplies a `Retry-After`
 * header the wait honours it instead of the default exponential backoff.
 */

const { mockGetLatestLedger } = vi.hoisted(() => ({
  mockGetLatestLedger: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(actual as any).SorobanRpc,
      Server: vi.fn().mockImplementation(function MockServer() {
        return { getLatestLedger: mockGetLatestLedger };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Api: (actual as any).SorobanRpc.Api,
    },
  };
});

import { createRpcServer, clearServerCache } from '../soroban.js';

const RPC = 'http://localhost:8000/soroban/rpc';

function rateLimited(retryAfter?: string) {
  return {
    message: 'Request failed with status code 429',
    response: { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  clearServerCache();
  mockGetLatestLedger.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRpcServer — 429 retry (#635)', () => {
  it('retries a rate-limited call and waits exactly the Retry-After delay', async () => {
    mockGetLatestLedger
      .mockRejectedValueOnce(rateLimited('2')) // Retry-After: 2s
      .mockResolvedValueOnce({ sequence: 12_345 });

    const server = createRpcServer(RPC);
    const promise = server.getLatestLedger();
    promise.catch(() => {});

    // Default backoff would be 500 ms; the header says 2 s.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ sequence: 12_345 });
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(2);
  });

  it('falls back to the default backoff when no Retry-After header is present', async () => {
    mockGetLatestLedger
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce({ sequence: 7 });

    const server = createRpcServer(RPC);
    const promise = server.getLatestLedger();
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(499);
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ sequence: 7 });
  });

  it('gives up after MAX_RETRIES and rejects with a RateLimitError', async () => {
    const { RateLimitError } = await import('../errors.js');
    mockGetLatestLedger.mockRejectedValue(rateLimited('1'));

    const server = createRpcServer(RPC);
    const promise = server.getLatestLedger();
    promise.catch(() => {});

    // 3 retries at 1s each (Retry-After overrides the growing backoff).
    await vi.advanceTimersByTimeAsync(1_000 * 4);

    await expect(promise).rejects.toBeInstanceOf(RateLimitError);
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(4); // initial + 3 retries
  });
});
