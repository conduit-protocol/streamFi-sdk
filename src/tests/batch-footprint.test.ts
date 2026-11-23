import { describe, it, expect } from 'vitest';
import {
  estimateBatchFootprint,
  DEFAULT_CPU_INSTRUCTION_LIMIT,
  DEFAULT_INSTRUCTIONS_PER_BATCH_ITEM,
  DEFAULT_BATCH_FIXED_OVERHEAD_INSTRUCTIONS,
} from '../fee-estimator.js';

describe('estimateBatchFootprint', () => {
  it('scales linearly with item count using the default per-item cost', () => {
    const one = estimateBatchFootprint(1);
    const ten = estimateBatchFootprint(10);

    expect(one.cpuInstructions).toBe(DEFAULT_BATCH_FIXED_OVERHEAD_INSTRUCTIONS + DEFAULT_INSTRUCTIONS_PER_BATCH_ITEM);
    expect(ten.cpuInstructions).toBe(DEFAULT_BATCH_FIXED_OVERHEAD_INSTRUCTIONS + DEFAULT_INSTRUCTIONS_PER_BATCH_ITEM * 10);
    expect(ten.itemCount).toBe(10);
    expect(ten.cpuInstructionLimit).toBe(DEFAULT_CPU_INSTRUCTION_LIMIT);
  });

  it('flags a 25-item batch that exceeds the warn threshold', () => {
    const estimate = estimateBatchFootprint(25);

    expect(estimate.exceedsThreshold).toBe(true);
    expect(estimate.utilizationRatio).toBeGreaterThan(0.9);
    expect(estimate.recommendedMaxItems).toBeGreaterThanOrEqual(1);
    expect(estimate.recommendedMaxItems).toBeLessThan(25);
  });

  it('does not flag a small batch', () => {
    const estimate = estimateBatchFootprint(2);

    expect(estimate.exceedsThreshold).toBe(false);
    expect(estimate.utilizationRatio).toBeLessThan(0.9);
  });

  it('honors custom calibration options', () => {
    const estimate = estimateBatchFootprint(4, {
      instructionsPerItem: 1_000,
      fixedOverheadInstructions: 500,
      cpuInstructionLimit: 10_000,
      warnThreshold: 0.5,
    });

    expect(estimate.cpuInstructions).toBe(500 + 1_000 * 4);
    expect(estimate.cpuInstructionLimit).toBe(10_000);
    expect(estimate.utilizationRatio).toBeCloseTo(0.45, 5);
    expect(estimate.exceedsThreshold).toBe(false);
    // usable = 10000*0.5 - 500 = 4500; 4500 / 1000 = 4
    expect(estimate.recommendedMaxItems).toBe(4);
  });

  it('rejects a non-positive-integer itemCount', () => {
    expect(() => estimateBatchFootprint(0)).toThrow(/itemCount/);
    expect(() => estimateBatchFootprint(-1)).toThrow(/itemCount/);
    expect(() => estimateBatchFootprint(1.5)).toThrow(/itemCount/);
  });

  it('rejects an invalid warnThreshold', () => {
    expect(() => estimateBatchFootprint(1, { warnThreshold: 0 })).toThrow(/warnThreshold/);
    expect(() => estimateBatchFootprint(1, { warnThreshold: 1.5 })).toThrow(/warnThreshold/);
  });

  it('rejects an invalid cpuInstructionLimit', () => {
    expect(() => estimateBatchFootprint(1, { cpuInstructionLimit: 0 })).toThrow(/cpuInstructionLimit/);
  });

  it('always recommends at least 1 item even when a single item already exceeds the threshold', () => {
    const estimate = estimateBatchFootprint(1, {
      instructionsPerItem: 1_000_000,
      fixedOverheadInstructions: 0,
      cpuInstructionLimit: 100,
      warnThreshold: 0.9,
    });

    expect(estimate.recommendedMaxItems).toBe(1);
    expect(estimate.exceedsThreshold).toBe(true);
  });
});
