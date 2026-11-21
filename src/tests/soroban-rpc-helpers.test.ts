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
      Api: (actual as any).SorobanRpc.Api,
    },
  };
});

import { estimateRequiredFee, queryXlmBalance } from '../soroban.js';
import { nativeToScVal, Account } from '@stellar/stellar-sdk';

beforeEach(() => {
  mockSimulateTransaction.mockReset();
  mockGetAccount.mockReset();
});

describe('estimateRequiredFee', () => {
  it('should extract minResourceFee when available', () => {
    const fee = estimateRequiredFee({ minResourceFee: '12345' });
    expect(fee).toBe(12345n);
  });

  it('should extract fee when available', () => {
    const fee = estimateRequiredFee({ fee: 9999n });
    expect(fee).toBe(9999n);
  });

  it('should fallback to 1_000_000n when neither is available', () => {
    const fee = estimateRequiredFee({});
    expect(fee).toBe(1_000_000n);
  });

  it('should use custom fallback', () => {
    const fee = estimateRequiredFee({}, 100n);
    expect(fee).toBe(100n);
  });
});

describe('queryXlmBalance', () => {
  it('should return native balance', async () => {
    mockGetAccount.mockResolvedValue(new Account('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H', '100'));
    const retval = nativeToScVal(1000n, { type: 'i128' });
    mockSimulateTransaction.mockResolvedValue({ result: { retval } });

    const balance = await queryXlmBalance('http://localhost', 'Test SDF Network ; September 2015', 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H');
    expect(balance).toBe(1000n);
  });
});
