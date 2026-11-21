/**
 * Direct unit tests for `queryXlmBalance()` (src/soroban.ts) — issue #460.
 *
 * Before this file the function had no dedicated test: it was only exercised
 * indirectly (if at all) through `StreamsModule.create()`'s
 * insufficient-balance branch, so a regression in the RPC simulation → i128
 * extraction pipeline could slip through unnoticed. These tests mock
 * `SorobanRpc.Server`'s `simulateTransaction()`/`getAccount()` and assert the
 * exact stroop value returned for a range of balances, plus the error path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSimulateTransaction, mockGetAccount } = vi.hoisted(() => ({
  mockSimulateTransaction: vi.fn(),
  mockGetAccount: vi.fn(),
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
        };
      }),
    },
  };
});

import { Account, nativeToScVal } from '@stellar/stellar-sdk';
import { queryXlmBalance, clearServerCache } from '../soroban.js';

const RPC_URL    = 'http://localhost:8000/soroban/rpc';
const PASSPHRASE = 'Test SDF Network ; September 2015';
const ACCOUNT    = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';

/** Build the simulateTransaction success shape `simulateReadOnly` expects. */
function simOk(balance: bigint): unknown {
  return { result: { retval: nativeToScVal(balance, { type: 'i128' }) } };
}

beforeEach(() => {
  clearServerCache();
  mockSimulateTransaction.mockReset();
  // getAccount() returns a real Account, which TransactionBuilder.build()
  // needs for accountId()/sequenceNumber()/incrementSequenceNumber().
  mockGetAccount.mockReset().mockResolvedValue(new Account(ACCOUNT, '100'));
});

describe('queryXlmBalance', () => {
  it('returns the simulated balance in stroops (1 XLM = 10_000_000 stroops)', async () => {
    mockSimulateTransaction.mockResolvedValue(simOk(500_000_000n)); // 50 XLM
    await expect(queryXlmBalance(RPC_URL, PASSPHRASE, ACCOUNT)).resolves.toBe(500_000_000n);
  });

  it('returns 0n when the account holds no XLM', async () => {
    mockSimulateTransaction.mockResolvedValue(simOk(0n));
    await expect(queryXlmBalance(RPC_URL, PASSPHRASE, ACCOUNT)).resolves.toBe(0n);
  });

  it('decodes balances spanning the 64-bit boundary exactly', async () => {
    const big = (1n << 70n) + 12345n;
    mockSimulateTransaction.mockResolvedValue(simOk(big));
    await expect(queryXlmBalance(RPC_URL, PASSPHRASE, ACCOUNT)).resolves.toBe(big);
  });

  it('rejects when the simulation returns an error instead of a result', async () => {
    mockSimulateTransaction.mockResolvedValue({ error: 'host error: wasm vm', errorCode: 1 });
    await expect(queryXlmBalance(RPC_URL, PASSPHRASE, ACCOUNT)).rejects.toThrow('Simulation error');
  });

  it('fetches the caller account via getAccount to build the balance() call', async () => {
    mockSimulateTransaction.mockResolvedValue(simOk(1n));
    await queryXlmBalance(RPC_URL, PASSPHRASE, ACCOUNT);
    expect(mockGetAccount).toHaveBeenCalledWith(ACCOUNT);
  });

  it('passes a built transaction to simulateTransaction', async () => {
    mockSimulateTransaction.mockResolvedValue(simOk(123_456_789n));
    await queryXlmBalance(RPC_URL, PASSPHRASE, ACCOUNT);

    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
    const tx = mockSimulateTransaction.mock.calls[0]![0] as { toXDR: unknown };
    expect(typeof tx.toXDR).toBe('function');
  });
});
