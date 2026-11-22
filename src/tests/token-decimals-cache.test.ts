/**
 * Token decimals cache TTL (#1167).
 *
 * Cached `decimals()` results must expire after one hour so a token's stale
 * metadata is not retained indefinitely, and expired entries must be evicted
 * from the cache rather than lingering until the next lookup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Account, StrKey, xdr } from '@stellar/stellar-sdk';

const { mockGetAccount, mockSimulate } = vi.hoisted(() => ({
  mockGetAccount: vi.fn(),
  mockSimulate: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: class {
        getAccount = mockGetAccount;
        simulateTransaction = mockSimulate;
      },
    },
  };
});

import {
  getTokenDecimals,
  clearTokenDecimalsCache,
  clearServerCache,
  getTokenDecimalsCacheMetrics,
  resetTokenDecimalsCacheMetrics,
} from '../soroban.js';

const RPC_URL = 'https://soroban-testnet.stellar.org';
const PASSPHRASE = 'Test SDF Network ; September 2015';
const CALLER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const TOKEN_A = StrKey.encodeContract(Buffer.alloc(32, 2));
const TOKEN_B = StrKey.encodeContract(Buffer.alloc(32, 3));

/** The decimals cache TTL under test: one hour. */
const TTL_MS = 60 * 60 * 1000;

function decimalsSimResult(n: number) {
  return { result: { retval: xdr.ScVal.scvU32(n) }, transactionData: {} };
}

describe('token decimals cache TTL (#1167)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearServerCache();
    clearTokenDecimalsCache();
    resetTokenDecimalsCacheMetrics();
    mockGetAccount.mockReset().mockResolvedValue(new Account(CALLER, '0'));
    mockSimulate.mockReset().mockResolvedValue(decimalsSimResult(7));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves cached decimals without a new RPC call while the entry is fresh', async () => {
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    await vi.advanceTimersByTimeAsync(TTL_MS - 1_000);

    const again = await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);

    expect(again).toBe(7);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
    expect(getTokenDecimalsCacheMetrics()).toEqual({ hits: 1, misses: 1, size: 1 });
  });

  it('re-queries decimals once the TTL has elapsed', async () => {
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    await vi.advanceTimersByTimeAsync(TTL_MS + 1_000);

    mockSimulate.mockResolvedValue(decimalsSimResult(6));
    const refreshed = await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);

    expect(refreshed).toBe(6);
    expect(mockSimulate).toHaveBeenCalledTimes(2);
    expect(getTokenDecimalsCacheMetrics().misses).toBe(2);
  });

  it('does not keep a failed lookup, so the next call retries the RPC', async () => {
    mockSimulate.mockRejectedValueOnce(new Error('rpc unavailable'));

    await expect(getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A)).rejects.toThrow('rpc unavailable');
    expect(getTokenDecimalsCacheMetrics().size).toBe(0);

    await expect(getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A)).resolves.toBe(7);
    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });

  it('evicts an expired entry without waiting for another lookup', async () => {
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    expect(getTokenDecimalsCacheMetrics().size).toBe(1);

    await vi.advanceTimersByTimeAsync(TTL_MS + 1_000);

    expect(getTokenDecimalsCacheMetrics().size).toBe(0);
  });

  it('expires each token on its own schedule', async () => {
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    await vi.advanceTimersByTimeAsync(TTL_MS / 2);
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_B);

    // Token A's TTL lapses half an hour before token B's.
    await vi.advanceTimersByTimeAsync(TTL_MS / 2 + 1_000);
    expect(getTokenDecimalsCacheMetrics().size).toBe(1);

    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_B);
    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });
});
