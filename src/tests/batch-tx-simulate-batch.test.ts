/**
 * simulateBatch() (#959) — a dry-run wrapper over preBatchSimulate() that
 * bundles operations + context into one BatchPayload and folds the
 * per-operation results into a single pass/fail verdict, so a caller can
 * gate wallet signing on `result.success` without spending an inclusion
 * fee on a batch that would revert.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSimulate, mockGetAccount } = vi.hoisted(() => ({
  mockSimulate: vi.fn(),
  mockGetAccount: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: class {
        simulateTransaction = mockSimulate;
        getAccount = mockGetAccount;
      },
    },
  };
});

import { simulateBatch, type BatchTransactionContext } from '../batch-tx.js';
import { clearServerCache } from '../soroban.js';

const CONTRACT_ID = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SOURCE      = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';

const CONTEXT: BatchTransactionContext = {
  contractId: CONTRACT_ID,
  sourceAccount: SOURCE,
  network: 'testnet',
  sequence: '100',
  rpcUrl: 'https://soroban-testnet.stellar.org',
};

beforeEach(() => {
  clearServerCache();
  mockSimulate.mockReset();
  mockGetAccount.mockReset();
});

describe('simulateBatch()', () => {
  it('reports success when every operation simulates cleanly', async () => {
    mockSimulate.mockResolvedValue({ result: {}, transactionData: {} });

    const summary = await simulateBatch({
      operations: [{ method: 'a' }, { method: 'b' }],
      context: CONTEXT,
    });

    expect(summary.success).toBe(true);
    expect(summary.invalidIndices).toEqual([]);
    expect(summary.results).toHaveLength(2);
    expect(summary.results.every(r => r.success)).toBe(true);
  });

  it('identifies exactly which operation would revert, e.g. an invalid recipient', async () => {
    mockSimulate
      .mockResolvedValueOnce({ result: {}, transactionData: {} })
      .mockResolvedValueOnce({ error: 'HostError: invalid recipient address' })
      .mockResolvedValueOnce({ result: {}, transactionData: {} });

    const summary = await simulateBatch({
      operations: [{ method: 'create_stream' }, { method: 'create_stream' }, { method: 'create_stream' }],
      context: CONTEXT,
    });

    expect(summary.success).toBe(false);
    expect(summary.invalidIndices).toEqual([1]);
    expect(summary.results[1]).toMatchObject({
      index: 1,
      success: false,
      error: 'HostError: invalid recipient address',
    });
  });

  it('never submits — only simulateTransaction is called, never sendTransaction', async () => {
    mockSimulate.mockResolvedValue({ result: {}, transactionData: {} });

    await simulateBatch({ operations: [{ method: 'a' }], context: CONTEXT });

    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it('propagates validateContext errors as a BatchBuildError', async () => {
    const { BatchBuildError } = await import('../batch-tx.js');
    // Destructure off a copy so the omitted keys are absent rather than
    // explicitly `undefined` — `exactOptionalPropertyTypes` rejects the latter.
    const { rpcUrl: _rpcUrl, sequence: _sequence, ...contextWithoutRpc } = CONTEXT;
    await expect(
      simulateBatch({ operations: [{ method: 'a' }], context: contextWithoutRpc }),
    ).rejects.toThrow(BatchBuildError);
  });
});
