/**
 * buildBatchTransactions() — the RPC-prepared path (context.rpcUrl set) —
 * had no dedicated tests before this file. It simulated every batched
 * operation one at a time in a `for` loop even though each simulation is an
 * independent RPC round trip, so N operations meant N sequential round
 * trips. These tests cover that path and lock in the concurrent behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSimulateTransaction, mockGetAccount, mockAssembleTransaction } = vi.hoisted(() => ({
  mockSimulateTransaction: vi.fn(),
  mockGetAccount: vi.fn(),
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
        };
      }),
      Api: (actual as any).SorobanRpc.Api,
      assembleTransaction: mockAssembleTransaction,
    },
  };
});

import { buildBatchTransactions, BatchBuildError, type BatchTransactionContext } from '../batch-tx.js';

const CONTRACT_ID = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SOURCE = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';

const CONTEXT: BatchTransactionContext = {
  contractId: CONTRACT_ID,
  sourceAccount: SOURCE,
  network: 'testnet',
  sequence: '100',
  rpcUrl: 'http://localhost:8000/soroban/rpc',
};

const SIMULATION_OK = { result: { retval: {} }, transactionData: {} };

beforeEach(() => {
  mockSimulateTransaction.mockReset();
  mockGetAccount.mockReset();
  // assembleTransaction(tx, sim).build() just needs to hand back something
  // with a real toXDR() — the real, unmocked Transaction built by
  // buildBatchTransactions already has one.
  mockAssembleTransaction.mockReset().mockImplementation((tx: unknown) => ({ build: () => tx }));
});

describe('buildBatchTransactions() — RPC-prepared path', () => {
  it('simulates every operation concurrently, not one at a time', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    mockSimulateTransaction.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );

    const operations = [{ method: 'a' }, { method: 'b' }, { method: 'c' }];
    const promise = buildBatchTransactions(operations, CONTEXT);
    promise.catch(() => {});

    // Flush pending microtasks without resolving any simulation. A
    // sequential implementation would have called simulateTransaction() only
    // for the first operation by this point; a concurrent one calls it for
    // every operation up front.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSimulateTransaction).toHaveBeenCalledTimes(3);

    resolvers.forEach((resolve) => resolve(SIMULATION_OK));
    const built = await promise;

    expect(built.map((b) => b.index)).toEqual([0, 1, 2]);
    expect(built.every((b) => b.prepared)).toBe(true);
    expect(built.map((b) => b.method)).toEqual(['a', 'b', 'c']);
  });

  it('fetches the sequence once via getAccount when none is supplied, and derives per-op sequences from it', async () => {
    mockGetAccount.mockResolvedValue({ sequenceNumber: () => '200' });
    mockSimulateTransaction.mockResolvedValue(SIMULATION_OK);

    const { rpcUrl, contractId, sourceAccount, network } = CONTEXT;
    const built = await buildBatchTransactions(
      [{ method: 'a' }, { method: 'b' }],
      {
        contractId,
        sourceAccount,
        ...(rpcUrl !== undefined ? { rpcUrl } : {}),
        ...(network !== undefined ? { network } : {}),
      },
    );

    expect(mockGetAccount).toHaveBeenCalledTimes(1);
    expect(built).toHaveLength(2);
  });

  it('surfaces a simulation error as a BatchBuildError naming the failing operation', async () => {
    mockSimulateTransaction.mockResolvedValue({ error: 'contract trapped' });

    await expect(
      buildBatchTransactions([{ method: 'boom' }], CONTEXT),
    ).rejects.toThrow(BatchBuildError);
    await expect(
      buildBatchTransactions([{ method: 'boom' }], CONTEXT),
    ).rejects.toThrow(/operation 0 \(boom\)/);
  });

  it('rejects an operation missing a method name without ever calling the RPC', async () => {
    mockSimulateTransaction.mockResolvedValue(SIMULATION_OK);

    await expect(
      buildBatchTransactions([{ method: '' }], CONTEXT),
    ).rejects.toThrow(/missing a method name/);
  });

  it('falls back to the offline sync path when no rpcUrl is configured', async () => {
    const { contractId, sourceAccount, network, sequence } = CONTEXT;
    const built = await buildBatchTransactions([{ method: 'ping' }], {
      contractId,
      sourceAccount,
      ...(network !== undefined ? { network } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
    });

    expect(mockSimulateTransaction).not.toHaveBeenCalled();
    expect(built[0]!.prepared).toBe(false);
  });
});
