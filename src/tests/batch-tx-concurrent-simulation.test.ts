/**
 * Regression tests: `buildBatchTransactions` must simulate independent
 * batch operations concurrently, not one at a time.
 *
 * The bug: each operation's transaction was `await`ed inside a `for` loop
 * even though nothing about simulating operation N depends on operation
 * N-1's simulation result (the sequence number for each is derived
 * synchronously from the batch's starting sequence). For an N-operation
 * batch that turned one round-trip's worth of work into N sequential ones.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { buildBatchTransactions, type BatchTransactionContext } from '../batch-tx.js';
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

function operations(count: number) {
  return Array.from({ length: count }, (_, i) => ({ method: `op${i}`, args: [] }));
}

describe('buildBatchTransactions — concurrent simulation', () => {
  beforeEach(() => {
    clearServerCache();
    mockSimulate.mockReset();
    mockAssemble.mockReset().mockReturnValue({ build: () => ({ toXDR: () => 'FAKE_XDR' }) });
  });

  it('runs simulations for independent operations concurrently, not serially', async () => {
    let active = 0;
    let maxActive = 0;

    mockSimulate.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { result: {}, transactionData: {} };
    });

    const built = await buildBatchTransactions(operations(5), CONTEXT);

    expect(built).toHaveLength(5);
    expect(mockSimulate).toHaveBeenCalledTimes(5);
    // If simulations ran one at a time, at most 1 would ever be in flight.
    expect(maxActive).toBeGreaterThan(1);
  });

  it('preserves result order by index even when simulations resolve out of order', async () => {
    // Operation 0 is the slowest, operation 4 the fastest — a serial
    // implementation can't produce this ordering by accident, so it's a
    // meaningful check that `index` (not resolution order) drives the output.
    mockSimulate.mockImplementation(async () => {
      const tx = mockSimulate.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 25 - tx * 5));
      return { result: {}, transactionData: {} };
    });

    const built = await buildBatchTransactions(operations(5), CONTEXT);

    expect(built.map((b) => b.index)).toEqual([0, 1, 2, 3, 4]);
    expect(built.map((b) => b.method)).toEqual(['op0', 'op1', 'op2', 'op3', 'op4']);
    expect(built.every((b) => b.prepared && b.xdr === 'FAKE_XDR')).toBe(true);
  });

  it('still rejects with BatchBuildError when simulation fails for one operation', async () => {
    mockSimulate.mockImplementation(async () => ({ error: 'HostError: boom' }));

    await expect(buildBatchTransactions(operations(3), CONTEXT)).rejects.toThrow(
      /Simulation failed for operation/,
    );
  });
});
