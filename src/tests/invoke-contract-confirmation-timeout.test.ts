import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfirmationTimeoutError, isConduitError } from '../errors.js';

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

import { invokeContract, clearServerCache } from '../soroban.js';

describe('invokeContract confirmation timeout (#596)', () => {
  const TEST_RPC = 'http://localhost:8000/test-timeout';
  const TEST_HASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

  beforeEach(() => {
    vi.useFakeTimers();
    clearServerCache();
    mockSimulateTransaction.mockReset();
    mockGetAccount.mockReset();
    mockSendTransaction.mockReset();
    mockGetTransaction.mockReset();
    mockAssembleTransaction.mockReset().mockReturnValue({ build: () => ({ sign: vi.fn() }) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ConfirmationTimeoutError creates well-formed error and is recognised by isConduitError', () => {
    const err = new ConfirmationTimeoutError(TEST_HASH, 5, 5000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConfirmationTimeoutError);
    expect(err.name).toBe('ConfirmationTimeoutError');
    expect(err.hash).toBe(TEST_HASH);
    expect(err.attempts).toBe(5);
    expect(err.timeoutMs).toBe(5000);
    expect(err.message).toContain(TEST_HASH);
    expect(err.message).toContain('timed out after 5 attempts (5000ms)');
    expect(isConduitError(err)).toBe(true);
  });

  it('default behavior without strict: true resolves hash as pending on timeout', async () => {
    const signer = { publicKey: () => 'GTEST', sign: vi.fn() };
    mockSimulateTransaction.mockResolvedValue({ result: { retval: {} }, transactionData: {} });
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: TEST_HASH });
    mockGetTransaction.mockResolvedValue({ status: 'NOT_FOUND' });

    const promise = invokeContract(
      TEST_RPC,
      'passphrase',
      signer as any,
      {} as any,
      { pollIntervalMs: 100, maxAttempts: 3 },
    );

    await vi.advanceTimersByTimeAsync(300);

    const result = await promise;
    expect(result).toBe(TEST_HASH);
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
  });

  it('with strict: true rejects with ConfirmationTimeoutError after maxAttempts', async () => {
    const signer = { publicKey: () => 'GTEST', sign: vi.fn() };
    mockSimulateTransaction.mockResolvedValue({ result: { retval: {} }, transactionData: {} });
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: TEST_HASH });
    mockGetTransaction.mockResolvedValue({ status: 'NOT_FOUND' });

    let caughtError: unknown;
    const promise = invokeContract(
      TEST_RPC,
      'passphrase',
      signer as any,
      {} as any,
      { pollIntervalMs: 100, maxAttempts: 3, strict: true },
    ).catch((err) => {
      caughtError = err;
    });

    await vi.advanceTimersByTimeAsync(300);
    await promise;

    expect(caughtError).toBeInstanceOf(ConfirmationTimeoutError);
    const timeoutErr = caughtError as ConfirmationTimeoutError;
    expect(timeoutErr.hash).toBe(TEST_HASH);
    expect(timeoutErr.attempts).toBe(3);
    expect(timeoutErr.timeoutMs).toBe(300);
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
  });

  it('with strict: true resolves immediately when status is SUCCESS', async () => {
    const signer = { publicKey: () => 'GTEST', sign: vi.fn() };
    mockSimulateTransaction.mockResolvedValue({ result: { retval: {} }, transactionData: {} });
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: TEST_HASH });
    mockGetTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS' });

    const promise = invokeContract(
      TEST_RPC,
      'passphrase',
      signer as any,
      {} as any,
      { pollIntervalMs: 100, maxAttempts: 5, strict: true },
    );

    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe(TEST_HASH);
    expect(mockGetTransaction).toHaveBeenCalledTimes(2);
  });

  it('with strict: true rejects with Error when status is FAILED', async () => {
    const signer = { publicKey: () => 'GTEST', sign: vi.fn() };
    mockSimulateTransaction.mockResolvedValue({ result: { retval: {} }, transactionData: {} });
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: TEST_HASH });
    mockGetTransaction.mockResolvedValue({ status: 'FAILED' });

    let caughtError: unknown;
    const promise = invokeContract(
      TEST_RPC,
      'passphrase',
      signer as any,
      {} as any,
      { pollIntervalMs: 100, maxAttempts: 5, strict: true },
    ).catch((err) => {
      caughtError = err;
    });

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toContain(`Transaction failed: ${TEST_HASH}`);
  });

  it('with strict: true rejects with ConfirmationTimeoutError when polling network error occurs', async () => {
    const signer = { publicKey: () => 'GTEST', sign: vi.fn() };
    mockSimulateTransaction.mockResolvedValue({ result: { retval: {} }, transactionData: {} });
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: TEST_HASH });
    mockGetTransaction.mockRejectedValue(new Error('Network connection dropped'));

    let caughtError: unknown;
    const promise = invokeContract(
      TEST_RPC,
      'passphrase',
      signer as any,
      {} as any,
      { pollIntervalMs: 100, maxAttempts: 5, strict: true },
    ).catch((err) => {
      caughtError = err;
    });

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(caughtError).toBeInstanceOf(ConfirmationTimeoutError);
    const timeoutErr = caughtError as ConfirmationTimeoutError;
    expect(timeoutErr.hash).toBe(TEST_HASH);
    expect(timeoutErr.attempts).toBe(1);
  });
});
