/**
 * Direct unit tests for `estimateRequiredFee()` (src/soroban.ts) — issue #461.
 *
 * The function's fallback behaviour is the root cause of a separate bug where
 * `InsufficientBalanceError` overstates the required balance by ~500 XLM in
 * the common case: a WasmVm/InvalidAction simulation error carries neither
 * `minResourceFee` nor `fee`, so it always falls through to the
 * `5_000_000_000n` fallback. These tests lock in the fallback value and the
 * extraction logic for both the `minResourceFee` and `fee` shapes.
 */

import { describe, it, expect } from 'vitest';
import { estimateRequiredFee } from '../soroban.js';

const DEFAULT_FALLBACK = 1_000_000n; // DEFAULT_RESOURCE_FEE_ESTIMATE (0.1 XLM), realistic post-#477

describe('estimateRequiredFee', () => {
  it('falls back to ~500 XLM for a WasmVm/InvalidAction simulation error (no fee fields)', () => {
    // Error-shaped simulation results carry neither minResourceFee nor fee —
    // this is the shape that used to reach the fallback far more often than
    // intended, overstating the required balance by ~500 XLM.
    const simError = { error: 'host error: WasmVm', errorCode: 1 };
    expect(estimateRequiredFee(simError)).toBe(DEFAULT_FALLBACK);
  });

  it('extracts minResourceFee as a string', () => {
    expect(estimateRequiredFee({ minResourceFee: '123456789' })).toBe(123_456_789n);
  });

  it('extracts minResourceFee as a number', () => {
    expect(estimateRequiredFee({ minResourceFee: 250_000_000 })).toBe(250_000_000n);
  });

  it('extracts minResourceFee as a bigint', () => {
    expect(estimateRequiredFee({ minResourceFee: 250_000_000n })).toBe(250_000_000n);
  });

  it('extracts fee when minResourceFee is absent', () => {
    expect(estimateRequiredFee({ fee: '987654321' })).toBe(987_654_321n);
    expect(estimateRequiredFee({ fee: 42 })).toBe(42n);
    expect(estimateRequiredFee({ fee: 42n })).toBe(42n);
  });

  it('prefers minResourceFee over fee when both are present', () => {
    expect(estimateRequiredFee({ minResourceFee: '1000', fee: '2000' })).toBe(1000n);
  });

  it('skips a zero minResourceFee and falls through to fee', () => {
    expect(estimateRequiredFee({ minResourceFee: 0, fee: '5000' })).toBe(5000n);
  });

  it('skips a negative minResourceFee and falls through to fee', () => {
    expect(estimateRequiredFee({ minResourceFee: -10, fee: '5000' })).toBe(5000n);
  });

  it('ignores zero or negative fee and falls back', () => {
    expect(estimateRequiredFee({ fee: 0 })).toBe(DEFAULT_FALLBACK);
    expect(estimateRequiredFee({ fee: -5 })).toBe(DEFAULT_FALLBACK);
  });

  it('returns the fallback for non-object inputs', () => {
    expect(estimateRequiredFee(null)).toBe(DEFAULT_FALLBACK);
    expect(estimateRequiredFee(undefined)).toBe(DEFAULT_FALLBACK);
    expect(estimateRequiredFee('nope')).toBe(DEFAULT_FALLBACK);
    expect(estimateRequiredFee(42)).toBe(DEFAULT_FALLBACK);
  });

  it('respects a custom fallback value', () => {
    expect(estimateRequiredFee({}, 123n)).toBe(123n);
    expect(estimateRequiredFee({ error: 'boom' }, 456n)).toBe(456n);
  });

  it('falls back when only zero-valued fee fields are present', () => {
    expect(estimateRequiredFee({ minResourceFee: 0, fee: 0 })).toBe(DEFAULT_FALLBACK);
  });
});
