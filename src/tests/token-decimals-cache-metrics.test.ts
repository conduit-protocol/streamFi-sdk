import { describe, it, expect, vi, beforeEach } from 'vitest';
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

function decimalsSimResult(n: number) {
  return { result: { retval: xdr.ScVal.scvU32(n) }, transactionData: {} };
}

describe('getTokenDecimalsCacheMetrics (#807)', () => {
  beforeEach(() => {
    clearServerCache();
    clearTokenDecimalsCache();
    resetTokenDecimalsCacheMetrics();
    mockGetAccount.mockReset().mockResolvedValue(new Account(CALLER, '0'));
    mockSimulate.mockReset().mockResolvedValue(decimalsSimResult(7));
  });

  it('reports 0 hits, 0 misses, and 0 size initially', () => {
    const metrics = getTokenDecimalsCacheMetrics();
    expect(metrics).toEqual({ hits: 0, misses: 0, size: 0 });
  });

  it('increments misses on cache miss and hits on repeated calls', async () => {
    // First lookup: miss
    const res1 = await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    expect(res1).toBe(7);
    expect(getTokenDecimalsCacheMetrics()).toEqual({ hits: 0, misses: 1, size: 1 });

    // Second lookup: hit
    const res2 = await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    expect(res2).toBe(7);
    expect(getTokenDecimalsCacheMetrics()).toEqual({ hits: 1, misses: 1, size: 1 });

    // Third lookup: hit
    const res3 = await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    expect(res3).toBe(7);
    expect(getTokenDecimalsCacheMetrics()).toEqual({ hits: 2, misses: 1, size: 1 });
  });

  it('tracks distinct tokens and multiple misses', async () => {
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_B);

    expect(getTokenDecimalsCacheMetrics()).toEqual({ hits: 0, misses: 2, size: 2 });

    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_B);

    expect(getTokenDecimalsCacheMetrics()).toEqual({ hits: 2, misses: 2, size: 2 });
  });

  it('resets hit/miss stats independently of cache entries via resetTokenDecimalsCacheMetrics', async () => {
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);

    expect(getTokenDecimalsCacheMetrics()).toEqual({ hits: 1, misses: 1, size: 1 });

    resetTokenDecimalsCacheMetrics();
    expect(getTokenDecimalsCacheMetrics()).toEqual({ hits: 0, misses: 0, size: 1 });

    // Next lookup hits existing cached entry
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    expect(getTokenDecimalsCacheMetrics()).toEqual({ hits: 1, misses: 0, size: 1 });
  });

  it('clears cache size and can reset metrics on clearTokenDecimalsCache', async () => {
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    expect(getTokenDecimalsCacheMetrics().size).toBe(1);

    clearTokenDecimalsCache();
    expect(getTokenDecimalsCacheMetrics().size).toBe(0);

    // Can optionally reset counters too
    clearTokenDecimalsCache(true);
    expect(getTokenDecimalsCacheMetrics()).toEqual({ hits: 0, misses: 0, size: 0 });
  });

  it('evicts rejected simulations from cache size and records miss', async () => {
    mockSimulate.mockRejectedValueOnce(new Error('simulation failure'));

    await expect(getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A)).rejects.toThrow('simulation failure');

    // Miss was recorded, but failed promise is evicted from cache
    expect(getTokenDecimalsCacheMetrics()).toEqual({ hits: 0, misses: 1, size: 0 });
  });
});
