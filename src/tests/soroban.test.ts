import { describe, it, expect } from 'vitest';
import { xdr, nativeToScVal } from '@stellar/stellar-sdk';
import {
  scValToI128,
  scValToU64,
  u64ToScVal,
  boolToScVal,
  estimateRequiredFee,
  DEFAULT_RESOURCE_FEE_ESTIMATE,
} from '../soroban.js';

// ── scValToI128 ────────────────────────────────────────────────────────────

describe('scValToI128', () => {
  it('decodes a small positive value', () => {
    expect(scValToI128(nativeToScVal(1_000n, { type: 'i128' }))).toBe(1_000n);
  });

  it('decodes zero', () => {
    expect(scValToI128(nativeToScVal(0n, { type: 'i128' }))).toBe(0n);
  });

  it('decodes a value spanning the 64-bit boundary', () => {
    const big = (1n << 70n) + 12345n; // requires the high 64 bits
    expect(scValToI128(nativeToScVal(big, { type: 'i128' }))).toBe(big);
  });

  it('decodes the max i128 value', () => {
    const max = (1n << 127n) - 1n;
    expect(scValToI128(nativeToScVal(max, { type: 'i128' }))).toBe(max);
  });

  it('decodes a negative value', () => {
    expect(scValToI128(nativeToScVal(-500n, { type: 'i128' }))).toBe(-500n);
  });

  it('decodes the min i128 value', () => {
    const min = -(1n << 127n);
    expect(scValToI128(nativeToScVal(min, { type: 'i128' }))).toBe(min);
  });
});

// ── scValToU64 / u64ToScVal ────────────────────────────────────────────────

describe('scValToU64', () => {
  it('decodes zero', () => {
    expect(scValToU64(xdr.ScVal.scvU64(xdr.Uint64.fromString('0')))).toBe(0n);
  });

  it('decodes a typical timestamp value', () => {
    expect(scValToU64(xdr.ScVal.scvU64(xdr.Uint64.fromString('1700000000')))).toBe(1_700_000_000n);
  });

  it('decodes the max u64 value', () => {
    const max = (1n << 64n) - 1n;
    expect(scValToU64(xdr.ScVal.scvU64(xdr.Uint64.fromString(max.toString())))).toBe(max);
  });
});

describe('u64ToScVal', () => {
  it('round-trips through scValToU64', () => {
    const values = [0n, 1n, 1_700_003_600n, (1n << 64n) - 1n];
    for (const v of values) {
      expect(scValToU64(u64ToScVal(v))).toBe(v);
    }
  });

  it('accepts a number as well as a bigint', () => {
    expect(scValToU64(u64ToScVal(42))).toBe(42n);
  });
});

// ── boolToScVal ────────────────────────────────────────────────────────────

describe('boolToScVal', () => {
  it('encodes true', () => {
    expect(boolToScVal(true).b()).toBe(true);
  });

  it('encodes false', () => {
    expect(boolToScVal(false).b()).toBe(false);
  });
});

// ── estimateRequiredFee ───────────────────────────────────────────────────

describe('estimateRequiredFee', () => {
  it('extracts minResourceFee from a successful simulation', () => {
    expect(estimateRequiredFee({ minResourceFee: '123456' })).toBe(123456n);
  });

  it('extracts fee when minResourceFee is missing', () => {
    expect(estimateRequiredFee({ fee: '98765' })).toBe(98765n);
  });

  it('ignores a zero minResourceFee and falls through', () => {
    expect(estimateRequiredFee({ minResourceFee: '0' })).toBe(DEFAULT_RESOURCE_FEE_ESTIMATE);
  });

  it('does not overstate the required fee for an error-response simulation (regression #430)', () => {
    // An error-response simulation (the shape passed from the
    // insufficient-balance path in StreamsModule.create()) carries neither
    // minResourceFee nor fee. The old 500 XLM fallback made the error say
    // "deposit + 500 XLM" when the real fee is a fraction of an XLM.
    const sim = { error: 'HostError: Error(WasmVm, InvalidAction)' };
    const fee = estimateRequiredFee(sim);
    expect(fee).toBe(DEFAULT_RESOURCE_FEE_ESTIMATE);
    expect(fee).toBeLessThan(5_000_000_000n); // far below the old 500 XLM default
    expect(fee).toBe(1_000_000n); // 0.1 XLM
  });

  it('uses an explicit fallback when provided', () => {
    expect(estimateRequiredFee(null, 42n)).toBe(42n);
  });
});
