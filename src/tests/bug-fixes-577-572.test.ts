/**
 * Regression tests for issue #577.
 *
 * - #577 `u64ToScVal` / `estimateRequiredFee` — no raw `RangeError` from an
 *   unguarded `BigInt(x)` on a float or negative value.
 */

import { describe, it, expect } from 'vitest';
import { u64ToScVal, estimateRequiredFee } from '../soroban.js';

// ── #577: u64ToScVal ─────────────────────────────────────────────────────────

describe('#577 — u64ToScVal input guards', () => {
  it('encodes a valid non-negative integer', () => {
    expect(u64ToScVal(0n).switch().name).toBe('scvU64');
    expect(u64ToScVal(5).switch().name).toBe('scvU64');
    expect(u64ToScVal(18446744073709551615n).switch().name).toBe('scvU64');
  });

  it('throws a clear RangeError for a negative value instead of an opaque XDR error', () => {
    expect(() => u64ToScVal(-1)).toThrow(RangeError);
    expect(() => u64ToScVal(-1n)).toThrow(/non-negative/);
  });

  it('throws a clear RangeError for a non-integer number', () => {
    expect(() => u64ToScVal(2.5)).toThrow(RangeError);
    expect(() => u64ToScVal(2.5)).toThrow(/integer/);
  });
});

// ── #577: estimateRequiredFee ────────────────────────────────────────────────

describe('#577 — estimateRequiredFee never throws on a non-conforming fee field', () => {
  it('does not throw on a float minResourceFee — the fallback is the whole point', () => {
    expect(() => estimateRequiredFee({ minResourceFee: 1234.5 })).not.toThrow();
    expect(estimateRequiredFee({ minResourceFee: 1234.5 })).toBe(1234n);
  });

  it('falls back on an un-parseable fee string', () => {
    expect(estimateRequiredFee({ minResourceFee: '12.5abc' }, 999n)).toBe(999n);
  });

  it('still extracts the normal string / number / bigint shapes', () => {
    expect(estimateRequiredFee({ minResourceFee: '250000000' })).toBe(250_000_000n);
    expect(estimateRequiredFee({ fee: 42 })).toBe(42n);
    expect(estimateRequiredFee({ minResourceFee: 1000n })).toBe(1000n);
  });
});
