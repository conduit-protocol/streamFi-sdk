/**
 * #1100 — idempotent RPC reads are retried on transport failures, not just
 * on 429s; writes (`sendTransaction`) and 503s are not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimitError, RpcServiceUnavailableError, StreamFiNetworkError } from '../errors.js';

const { mockGetLatestLedger, mockSendTransaction } = vi.hoisted(() => ({
  mockGetLatestLedger: vi.fn(),
  mockSendTransaction: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...(actual as any).SorobanRpc,
      Server: vi.fn().mockImplementation(function MockServer() {
        return { getLatestLedger: mockGetLatestLedger, sendTransaction: mockSendTransaction };
      }),
      Api: (actual as any).SorobanRpc.Api,
    },
  };
});

import {
  createRpcServer,
  clearServerCache,
  isRetryableReadError,
  IDEMPOTENT_RPC_METHODS,
} from '../soroban.js';

const connReset = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

describe('createRpcServer — transport-failure retry for reads (#1100)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearServerCache();
    mockGetLatestLedger.mockReset();
    mockSendTransaction.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a read after a connection reset and returns the result', async () => {
    mockGetLatestLedger.mockRejectedValueOnce(connReset()).mockResolvedValueOnce({ sequence: 42 });

    const promise = createRpcServer('http://localhost:8000/read-retry-1').getLatestLedger();
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toEqual({ sequence: 42 });
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(2);
  });

  it('retries `fetch failed` TypeErrors from the fetch stack', async () => {
    mockGetLatestLedger
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ sequence: 7 });

    const promise = createRpcServer('http://localhost:8000/read-retry-2').getLatestLedger();
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toEqual({ sequence: 7 });
  });

  it('gives up after 3 retries on a persistent transport failure', async () => {
    mockGetLatestLedger.mockRejectedValue(connReset());

    const promise = createRpcServer('http://localhost:8000/read-retry-3').getLatestLedger();
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(500 + 1_000 + 2_000);

    await expect(promise).rejects.toThrow('socket hang up');
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(4);
  });

  it('does not retry a non-transport error on a read', async () => {
    mockGetLatestLedger.mockRejectedValueOnce(new Error('ECONNREFUSED in a message only'));

    await expect(
      createRpcServer('http://localhost:8000/read-retry-4').getLatestLedger(),
    ).rejects.toThrow('ECONNREFUSED in a message only');
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
  });

  it('still fails fast on a 503 (#456)', async () => {
    mockGetLatestLedger.mockRejectedValue({ response: { status: 503, headers: {} } });

    await expect(
      createRpcServer('http://localhost:8000/read-retry-5').getLatestLedger(),
    ).rejects.toBeInstanceOf(RpcServiceUnavailableError);
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
  });

  it('does not retry sendTransaction on a transport failure', async () => {
    mockSendTransaction.mockRejectedValueOnce(connReset());

    await expect(
      createRpcServer('http://localhost:8000/read-retry-6').sendTransaction({} as any),
    ).rejects.toThrow('socket hang up');
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('isRetryableReadError', () => {
  it('classifies errors', () => {
    expect(isRetryableReadError(new RateLimitError('slow down'))).toBe(true);
    expect(isRetryableReadError(new StreamFiNetworkError('down', new Error('x')))).toBe(true);
    expect(isRetryableReadError(connReset())).toBe(true);
    expect(isRetryableReadError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryableReadError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isRetryableReadError(new Error('contract trapped'))).toBe(false);
  });

  it('covers reads only, never sendTransaction or getAccount', () => {
    expect(IDEMPOTENT_RPC_METHODS.has('getTransaction')).toBe(true);
    expect(IDEMPOTENT_RPC_METHODS.has('simulateTransaction')).toBe(true);
    expect(IDEMPOTENT_RPC_METHODS.has('sendTransaction')).toBe(false);
    expect(IDEMPOTENT_RPC_METHODS.has('getAccount')).toBe(false);
  });
});
