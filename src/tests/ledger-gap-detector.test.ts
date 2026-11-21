import { describe, it, expect } from 'vitest';
import { LedgerGapDetector } from '../indexer.js';

describe('LedgerGapDetector', () => {
  it('reports no gap for a contiguous ledger sequence', () => {
    const detector = new LedgerGapDetector();

    expect(detector.observe(100)).toBeUndefined();
    expect(detector.observe(101)).toBeUndefined();
    expect(detector.observe(102)).toBeUndefined();
    expect(detector.currentLedger).toBe(102);
  });

  it('detects a skipped ledger and reports expected vs actual', () => {
    const detector = new LedgerGapDetector();

    detector.observe(100);
    const gap = detector.observe(105);

    expect(gap).toEqual({ expected: 101, actual: 105 });
    expect(detector.currentLedger).toBe(105);
  });

  it('does not flag the very first observation', () => {
    const detector = new LedgerGapDetector();

    expect(detector.observe(500)).toBeUndefined();
    expect(detector.currentLedger).toBe(500);
  });

  it('does not treat a duplicate or re-ordered ledger as a gap', () => {
    const detector = new LedgerGapDetector();

    detector.observe(100);
    expect(detector.observe(100)).toBeUndefined();
    expect(detector.observe(99)).toBeUndefined();
    expect(detector.currentLedger).toBe(100);
  });

  it('resets so the next observation is never flagged', () => {
    const detector = new LedgerGapDetector();

    detector.observe(100);
    detector.reset();

    expect(detector.currentLedger).toBeUndefined();
    expect(detector.observe(9999)).toBeUndefined();
  });

  it('rejects a negative or non-integer ledger', () => {
    const detector = new LedgerGapDetector();

    expect(() => detector.observe(-1)).toThrow(/non-negative integer/);
    expect(() => detector.observe(1.5)).toThrow(/non-negative integer/);
  });
});
