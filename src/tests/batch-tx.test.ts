import {
  resolvePassphrase,
  BatchTransactionContext,
  BatchBuildError,
  chunkBatchOperations,
  buildBatchTransactionsSync,
  buildBatchTransactions,
  preBatchSimulate,
} from '../batch-tx.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Networks, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { clearServerCache } from '../soroban.js';

const { mockSimulate, mockAssemble } = vi.hoisted(() => ({
  mockSimulate: vi.fn(),
  mockAssemble: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: class {
        simulateTransaction = mockSimulate;
      },
      assembleTransaction: mockAssemble,
    },
  };
});

describe('resolvePassphrase', () => {
  it('should return networkPassphrase when provided', () => {
    const ctx = { networkPassphrase: 'custom passphrase' } as BatchTransactionContext;
    expect(resolvePassphrase(ctx)).toBe('custom passphrase');
  });

  it('should resolve named networks', () => {
    expect(resolvePassphrase({ network: 'mainnet' } as BatchTransactionContext)).toBe(Networks.PUBLIC);
    expect(resolvePassphrase({ network: 'testnet' } as BatchTransactionContext)).toBe(Networks.TESTNET);
    expect(resolvePassphrase({ network: 'local' } as BatchTransactionContext)).toBe(Networks.STANDALONE);
  });

  it('should throw BatchBuildError on unknown network', () => {
    expect(() => resolvePassphrase({ network: 'unknown' as any } as BatchTransactionContext))
      .toThrowError(BatchBuildError);
  });

  it('should throw BatchBuildError when neither is provided', () => {
    expect(() => resolvePassphrase({} as BatchTransactionContext))
      .toThrowError(BatchBuildError);
  });
});

// #1104 — boundary sizes: an empty batch and a single-item batch must flow
// through chunking, building and simulation without off-by-one errors.
describe('batch edge cases: empty and single-item batches', () => {
  const CONTRACT_ID = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
  const SOURCE = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
  const OFFLINE: BatchTransactionContext = {
    contractId: CONTRACT_ID,
    sourceAccount: SOURCE,
    network: 'testnet',
    sequence: '100',
  };
  const ONLINE: BatchTransactionContext = {
    ...OFFLINE,
    rpcUrl: 'https://soroban-testnet.stellar.org',
  };
  const ONE = [{ method: 'withdraw', args: [] }];

  beforeEach(() => {
    clearServerCache();
    mockSimulate.mockReset();
    mockAssemble.mockReset().mockReturnValue({ build: () => ({ toXDR: () => 'FAKE_XDR' }) });
  });

  describe('chunkBatchOperations', () => {
    it('returns no chunks for an empty batch, not one empty chunk', () => {
      expect(chunkBatchOperations([])).toEqual([]);
      expect(chunkBatchOperations([], 1)).toEqual([]);
    });

    it('returns exactly one chunk for a single item', () => {
      expect(chunkBatchOperations(['a'])).toEqual([['a']]);
      expect(chunkBatchOperations(['a'], 1)).toEqual([['a']]);
    });

    it('still rejects a non-positive chunk size for an empty batch', () => {
      expect(() => chunkBatchOperations([], 0)).toThrow(BatchBuildError);
    });
  });

  describe('buildBatchTransactionsSync (offline)', () => {
    it('builds nothing for an empty batch', () => {
      expect(buildBatchTransactionsSync([], OFFLINE)).toEqual([]);
    });

    it('builds one transaction using the starting sequence for a single item', () => {
      const built = buildBatchTransactionsSync(ONE, OFFLINE);

      expect(built).toHaveLength(1);
      expect(built[0]).toMatchObject({ index: 0, method: 'withdraw', prepared: false });

      const tx = TransactionBuilder.fromXDR(built[0]!.xdr, Networks.TESTNET) as Transaction;
      // Account sequence 100 -> the transaction consumes 101, with no extra offset.
      expect(tx.sequence).toBe('101');
      expect(tx.operations).toHaveLength(1);
    });

    it('still validates the context for an empty batch', () => {
      expect(() => buildBatchTransactionsSync([], { ...OFFLINE, contractId: 'bad' }))
        .toThrow(BatchBuildError);
    });
  });

  describe('buildBatchTransactions (prepared via RPC)', () => {
    it('returns an empty list without simulating anything for an empty batch', async () => {
      await expect(buildBatchTransactions([], ONLINE)).resolves.toEqual([]);
      expect(mockSimulate).not.toHaveBeenCalled();
      expect(mockAssemble).not.toHaveBeenCalled();
    });

    it('simulates and prepares exactly one transaction for a single item', async () => {
      mockSimulate.mockResolvedValue({});

      const built = await buildBatchTransactions(ONE, ONLINE);

      expect(mockSimulate).toHaveBeenCalledTimes(1);
      expect(built).toEqual([{ index: 0, method: 'withdraw', xdr: 'FAKE_XDR', prepared: true }]);
    });

    it('fails a single-item batch whose simulation errors, naming index 0', async () => {
      mockSimulate.mockResolvedValue({ error: 'HostError: boom' });

      await expect(buildBatchTransactions(ONE, ONLINE)).rejects.toThrow(
        /operation 0 \(withdraw\).*HostError: boom/,
      );
    });
  });

  describe('preBatchSimulate', () => {
    it('returns no results for an empty batch without calling the RPC', async () => {
      await expect(preBatchSimulate([], ONLINE)).resolves.toEqual([]);
      expect(mockSimulate).not.toHaveBeenCalled();
    });

    it('reports the single operation result for a one-item batch', async () => {
      mockSimulate.mockResolvedValue({ error: 'HostError: reverted' });

      await expect(preBatchSimulate(ONE, ONLINE)).resolves.toEqual([
        { index: 0, method: 'withdraw', success: false, error: 'HostError: reverted' },
      ]);
    });
  });
});
