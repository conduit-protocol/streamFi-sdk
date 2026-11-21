import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimitError, RpcServiceUnavailableError } from '../errors.js';

const {
  mockSimulateTransaction,
  mockGetAccount,
  mockSendTransaction,
  mockGetTransaction,
  mockAssembleTransaction,
} = vi.hoisted(() => ({
  mockSimulateTransaction: vi.fn(),
  mockGetAccount: vi.fn(),
  mockSendTransaction: vi.fn(),
  mockGetTransaction: vi.fn(),
  mockAssembleTransaction: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...(actual as any).SorobanRpc,
      Server: vi.fn().mockImplementation(function MockServer() {
        return {
          simulateTransaction: mockSimulateTransaction,
          getAccount: mockGetAccount,
          sendTransaction: mockSendTransaction,
          getTransaction: mockGetTransaction,
        };
      }),
      Api: (actual as any).SorobanRpc.Api,
      assembleTransaction: mockAssembleTransaction,
    },
  };
});


import { invokeContract, simulateReadOnly } from '../soroban.js';

beforeEach(() => {
  vi.useFakeTimers();
  mockSimulateTransaction.mockReset();
  mockGetAccount.mockReset();
  mockSendTransaction.mockReset();
  mockGetTransaction.mockReset();
  mockAssembleTransaction.mockReset().mockReturnValue({ build: () => ({ sign: vi.fn() }) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('soroban.ts rate limit handling', () => {
  it('converts a 429 thrown by simulateTransaction into a RateLimitError', async () => {
    const axiosStyle429 = {
      message: 'Request failed with status code 429',
      response: { status: 429, headers: { 'retry-after': '1' } },
    };
    // createRpcServer() now retries a rate-limited call internally (3
    // attempts at the "retry-after"-supplied delay) before giving up, so
    // the mock must stay rejected across all of them rather than just once.
    mockSimulateTransaction.mockRejectedValue(axiosStyle429);

    const promise = simulateReadOnly('http://localhost:8000', 'passphrase', {} as any);
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(1000 * 3);

    await expect(promise).rejects.toBeInstanceOf(RateLimitError);
  });

  it('surfaces a 503 as RpcServiceUnavailableError without retrying the same endpoint', async () => {
    // Regression test for #456: a 503 means the node is down, so the retry
    // proxy must not backoff-and-retry it like a 429 — it fails fast with a
    // distinguishable error so callers can fail over to another RPC URL.
    mockSimulateTransaction.mockRejectedValue({
      response: { status: 503, headers: {} },
    });

    await expect(
      simulateReadOnly('http://localhost:8000', 'passphrase', {} as any)
    ).rejects.toBeInstanceOf(RpcServiceUnavailableError);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('still throws the original error for non-rate-limit failures', async () => {
    mockSimulateTransaction.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(
      simulateReadOnly('http://localhost:8000', 'passphrase', {} as any)
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('uses custom polling interval and attempts in invokeContract()', async () => {
    const signer = { publicKey: () => 'GTEST', sign: vi.fn() };
    mockSimulateTransaction.mockResolvedValue({ result: { retval: {} }, transactionData: {} });
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'abc123' });
    mockGetTransaction.mockResolvedValue({ status: 'NOT_FOUND' });

    const promise = invokeContract(
      'http://localhost:8000',
      'passphrase',
      signer as any,
      {} as any,
      { pollIntervalMs: 200, maxAttempts: 2 },
    );
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(199);
    expect(mockGetTransaction).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockGetTransaction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    // After maxAttempts without a terminal status, invokeContract resolves the
    // submitted hash as pending rather than throwing a misleading timeout (#509).
    await expect(promise).resolves.toBe('abc123');
    expect(mockGetTransaction).toHaveBeenCalledTimes(2);
  });
});
