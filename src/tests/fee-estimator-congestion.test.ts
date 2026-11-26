import { describe, it, expect } from 'vitest';
import { FeeEstimator } from '../fee-estimator.js';

describe('FeeEstimator - ledger utilization congestion multiplier', () => {
  it('defaults to a multiplier of 1 with no ledger stats', () => {
    const estimator = new FeeEstimator(100n);

    expect(estimator.getUtilization()).toBe(0);
    expect(estimator.getCongestionMultiplier()).toBe(1);
    expect(estimator.getEffectiveFee()).toBe(100n);
  });

  it('ramps the multiplier with ledger utilization', () => {
    const estimator = new FeeEstimator(100n, {
      congestion: { ledgerCapacity: 100, congestionThreshold: 0.5, maxMultiplier: 3 },
    });

    estimator.recordLedgerStats({ operations: 50, ledger: 1 }); // 50% => no congestion
    expect(estimator.getUtilization()).toBeCloseTo(0.5);
    expect(estimator.getCongestionMultiplier()).toBe(1);

    estimator.recordLedgerStats({ operations: 75, ledger: 2 }); // avg 62.5%
    expect(estimator.getCongestionMultiplier()).toBeCloseTo(1.5);

    estimator.recordLedgerStats({ operations: 100, ledger: 3 }); // avg 75%
    expect(estimator.getCongestionMultiplier()).toBeCloseTo(2);
  });

  it('caps the multiplier at maxMultiplier', () => {
    const estimator = new FeeEstimator(100n, {
      congestion: { ledgerCapacity: 100, congestionThreshold: 0, maxMultiplier: 2 },
    });
    estimator.recordLedgerStats({ operations: 100 });

    expect(estimator.getUtilization()).toBe(1);
    expect(estimator.getCongestionMultiplier()).toBe(2);
  });

  it('averages only the most recent historySize ledgers', () => {
    const estimator = new FeeEstimator(100n, {
      congestion: { ledgerCapacity: 100, historySize: 2 },
    });
    estimator.recordLedgerStats({ operations: 100 });
    estimator.recordLedgerStats({ operations: 100 });
    estimator.recordLedgerStats({ operations: 0 });
    estimator.recordLedgerStats({ operations: 0 });

    expect(estimator.getUtilization()).toBe(0);
    expect(estimator.getCongestionMultiplier()).toBe(1);
  });

  it('applies congestion on demand without mutating the base fee', async () => {
    const estimator = new FeeEstimator(100n, {
      congestion: { ledgerCapacity: 100, congestionThreshold: 0, maxMultiplier: 2 },
    });
    estimator.recordLedgerStats({ operations: 100 });

    const adjusted = await estimator.estimateFee(async () => 120n, { applyCongestion: true });
    expect(adjusted).toBe(240n);
    expect(estimator.getBaseFee()).toBe(120n);

    // Default behaviour (no congestion) remains unchanged.
    const plain = await estimator.estimateFee(async () => 120n);
    expect(plain).toBe(120n);
  });

  it('falls back to the last known fee with congestion applied', async () => {
    const estimator = new FeeEstimator(100n, {
      congestion: { ledgerCapacity: 100, congestionThreshold: 0, maxMultiplier: 2 },
    });
    estimator.recordLedgerStats({ operations: 100 });

    await estimator.estimateFee(async () => 120n, { applyCongestion: true });
    const fallback = await estimator.estimateFee(
      async () => { throw new Error('network down'); },
      { applyCongestion: true },
    );

    expect(fallback).toBe(240n);
  });

  it('validates ledger stats and congestion options', () => {
    const estimator = new FeeEstimator(100n);
    expect(() => estimator.recordLedgerStats({ operations: -1 })).toThrow(RangeError);
    expect(() => estimator.recordLedgerStats({ operations: Number.NaN })).toThrow(RangeError);
    expect(() => estimator.recordLedgerStats({ operations: 1, ledger: -1 })).toThrow(RangeError);

    expect(() => new FeeEstimator(100n, { congestion: { ledgerCapacity: 0 } })).toThrow(RangeError);
    expect(() => new FeeEstimator(100n, { congestion: { congestionThreshold: 1 } })).toThrow(RangeError);
    expect(() => new FeeEstimator(100n, { congestion: { maxMultiplier: 0.5 } })).toThrow(RangeError);
    expect(() => new FeeEstimator(100n, { congestion: { historySize: 0 } })).toThrow(RangeError);
  });

  it('clears recorded ledger statistics', () => {
    const estimator = new FeeEstimator(100n, {
      congestion: { ledgerCapacity: 100, congestionThreshold: 0 },
    });
    estimator.recordLedgerStats({ operations: 100 });
    expect(estimator.getCongestionMultiplier()).toBeGreaterThan(1);

    estimator.clearLedgerStats();
    expect(estimator.getCongestionMultiplier()).toBe(1);
  });
});
