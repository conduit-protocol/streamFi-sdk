import { describe, it, expect } from 'vitest';
import { FeeEstimator, extractResourceFees } from '../fee-estimator.js';
import type { SorobanResourceFees } from '../fee-estimator.js';

type Sim = import('@stellar/stellar-sdk').SorobanRpc.Api.SimulateTransactionResponse;

function fakeSimulation(minResourceFee: string, instructions: bigint, readBytes: bigint, writeBytes: bigint): Sim {
  return {
    minResourceFee,
    results: [
      { transactionData: { resources: () => ({ instructions, diskReadBytes: readBytes, writeBytes }) } },
    ],
  } as unknown as Sim;
}

describe('extractResourceFees', () => {
  it('reads the total resourceFee and the per-result breakdown', () => {
    const fees = extractResourceFees(fakeSimulation('12345', 5000n, 200n, 100n));
    expect(fees).toEqual({ resourceFee: 12345n, cpuInstructions: 5000n, readBytes: 200n, writeBytes: 100n });
  });

  it('aggregates across multiple host-function results', () => {
    const sim = {
      minResourceFee: '999',
      results: [
        { transactionData: { resources: () => ({ instructions: 10n, diskReadBytes: 1n, writeBytes: 2n }) } },
        { transactionData: { resources: () => ({ instructions: 20n, diskReadBytes: 3n, writeBytes: 4n }) } },
      ],
    } as unknown as Sim;
    const fees = extractResourceFees(sim);
    expect(fees.cpuInstructions).toBe(30n);
    expect(fees.readBytes).toBe(4n);
    expect(fees.writeBytes).toBe(6n);
  });

  it('defaults missing fields to 0n', () => {
    const fees = extractResourceFees({ minResourceFee: '', results: [] } as unknown as Sim);
    expect(fees).toEqual({ resourceFee: 0n, cpuInstructions: 0n, readBytes: 0n, writeBytes: 0n });
  });
});

describe('FeeEstimator.estimateResourceFees', () => {
  it('simulates via an injected callback and returns the breakdown', async () => {
    const estimator = new FeeEstimator();
    const sim = fakeSimulation('777', 100n, 10n, 20n);
    const fees: SorobanResourceFees = await estimator.estimateResourceFees({} as never, {
      simulate: async () => sim,
    });
    expect(fees.resourceFee).toBe(777n);
    expect(fees.cpuInstructions).toBe(100n);
  });

  it('throws when neither rpcUrl nor a simulate callback is provided', async () => {
    const estimator = new FeeEstimator();
    await expect(estimator.estimateResourceFees({} as never)).rejects.toThrow();
  });
});
