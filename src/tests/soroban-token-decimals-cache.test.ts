import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Account, StrKey, xdr } from '@stellar/stellar-sdk';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockGetAccount, mockSimulate } = vi.hoisted(() => ({
  mockGetAccount: vi.fn(),
  mockSimulate:   vi.fn(),
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

import { getTokenDecimals, clearTokenDecimalsCache, clearServerCache } from '../soroban.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const RPC_URL    = 'https://soroban-testnet.stellar.org';
const PASSPHRASE = 'Test SDF Network ; September 2015';
const CALLER     = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const TOKEN_A    = StrKey.encodeContract(Buffer.alloc(32, 2));
const TOKEN_B    = StrKey.encodeContract(Buffer.alloc(32, 3));

function decimalsSimResult(n: number) {
  return { result: { retval: xdr.ScVal.scvU32(n) }, transactionData: {} };
}

// ── getTokenDecimals — caching behaviour ────────────────────────────────────

describe('getTokenDecimals caching', () => {
  beforeEach(() => {
    clearServerCache();
    clearTokenDecimalsCache();
    mockGetAccount.mockReset().mockResolvedValue(new Account(CALLER, '0'));
    mockSimulate.mockReset().mockResolvedValue(decimalsSimResult(7));
  });

  it('only simulates once for repeated calls with the same rpcUrl + token', async () => {
    const a = await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    const b = await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    const c = await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);

    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(c).toBe(7);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent in-flight calls for the same token onto one simulation', async () => {
    const [a, b] = await Promise.all([
      getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A),
      getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A),
    ]);

    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it('simulates separately for different tokens', async () => {
    mockSimulate
      .mockResolvedValueOnce(decimalsSimResult(7))
      .mockResolvedValueOnce(decimalsSimResult(2));

    const a = await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    const b = await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_B);

    expect(a).toBe(7);
    expect(b).toBe(2);
    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed simulation, and retries on the next call', async () => {
    mockSimulate
      .mockRejectedValueOnce(new Error('simulation boom'))
      .mockResolvedValueOnce(decimalsSimResult(7));

    await expect(getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A)).rejects.toThrow('simulation boom');

    const value = await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    expect(value).toBe(7);
    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });

  it('clearTokenDecimalsCache forces a fresh simulation', async () => {
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);
    clearTokenDecimalsCache();
    await getTokenDecimals(RPC_URL, PASSPHRASE, CALLER, TOKEN_A);

    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });
});
