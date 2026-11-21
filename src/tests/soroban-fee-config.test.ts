import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BASE_FEE, StrKey } from '@stellar/stellar-sdk';

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));

const { mockGetAccount, mockTransactionBuilder } = vi.hoisted(() => ({
  mockGetAccount: vi.fn(),
  mockTransactionBuilder: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: class {
        getAccount = mockGetAccount;
      },
    },
    TransactionBuilder: mockTransactionBuilder,
  };
});

import { resolveFee, buildContractCallTx } from '../soroban.js';

beforeEach(() => {
  mockGetAccount.mockReset().mockResolvedValue({ accountId: () => 'GACCOUNT', sequenceNumber: () => '1' });
  mockTransactionBuilder.mockReset().mockImplementation(function MockTransactionBuilder() {
    return {
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({ _stub: 'tx' }),
    };
  });
});

describe('resolveFee() (#509)', () => {
  it('defaults to BASE_FEE when neither fee nor feeMultiplier is set', () => {
    expect(resolveFee({})).toBe(BASE_FEE);
  });

  it('returns the explicit fee, ignoring feeMultiplier', () => {
    expect(resolveFee({ fee: '5000', feeMultiplier: 10 })).toBe('5000');
  });

  it('scales BASE_FEE by feeMultiplier', () => {
    expect(resolveFee({ feeMultiplier: 10 })).toBe((BigInt(BASE_FEE) * 10n).toString());
  });
});

describe('buildContractCallTx() fee parameter (#509)', () => {
  it('defaults the TransactionBuilder fee to BASE_FEE when no fee is passed', async () => {
    await buildContractCallTx('https://rpc', 'passphrase', 'GCALLER', CONTRACT_ID, 'withdraw', []);

    expect(mockTransactionBuilder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fee: BASE_FEE }),
    );
  });

  it('passes an explicit fee through to the TransactionBuilder', async () => {
    await buildContractCallTx('https://rpc', 'passphrase', 'GCALLER', CONTRACT_ID, 'withdraw', [], '10000');

    expect(mockTransactionBuilder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fee: '10000' }),
    );
  });
});
