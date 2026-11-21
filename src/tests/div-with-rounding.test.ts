import { describe, it, expect } from 'vitest';
import { divWithRounding } from '../utils.js';

describe('divWithRounding (#1102)', () => {
  it('returns the exact quotient when there is no remainder, in every mode', () => {
    for (const mode of ['floor', 'ceil', 'round'] as const) {
      expect(divWithRounding(12n, 3n, mode)).toBe(4n);
      expect(divWithRounding(-12n, 3n, mode)).toBe(-4n);
      expect(divWithRounding(0n, 7n, mode)).toBe(0n);
    }
  });

  it('floors toward negative infinity', () => {
    expect(divWithRounding(10n, 3n, 'floor')).toBe(3n);
    expect(divWithRounding(-10n, 3n, 'floor')).toBe(-4n);
    expect(divWithRounding(10n, -3n, 'floor')).toBe(-4n);
    expect(divWithRounding(-10n, -3n, 'floor')).toBe(3n);
  });

  it('ceils toward positive infinity', () => {
    expect(divWithRounding(10n, 3n, 'ceil')).toBe(4n);
    expect(divWithRounding(-10n, 3n, 'ceil')).toBe(-3n);
    expect(divWithRounding(10n, -3n, 'ceil')).toBe(-3n);
    expect(divWithRounding(-10n, -3n, 'ceil')).toBe(4n);
  });

  it('rounds to nearest, with halves away from zero', () => {
    expect(divWithRounding(10n, 3n, 'round')).toBe(3n); // 3.33
    expect(divWithRounding(11n, 3n, 'round')).toBe(4n); // 3.67
    expect(divWithRounding(5n, 2n, 'round')).toBe(3n); // 2.5
    expect(divWithRounding(-5n, 2n, 'round')).toBe(-3n); // -2.5
    expect(divWithRounding(-10n, 3n, 'round')).toBe(-3n); // -3.33
    expect(divWithRounding(-11n, 3n, 'round')).toBe(-4n); // -3.67
  });

  it('defaults to floor', () => {
    expect(divWithRounding(10n, 3n)).toBe(3n);
  });

  it('stays exact for amounts far beyond Number.MAX_SAFE_INTEGER', () => {
    const deposit = 10n ** 30n + 1n;
    expect(divWithRounding(deposit, 3n, 'floor')).toBe(333333333333333333333333333333n);
    expect(divWithRounding(deposit, 3n, 'ceil')).toBe(333333333333333333333333333334n);
  });

  it('distributes a deposit over a duration without losing a stroop to truncation', () => {
    // 1_000_000 stroops over 7 seconds: floor under-funds, ceil covers it.
    const rate = divWithRounding(1_000_000n, 7n, 'ceil');
    expect(rate * 7n).toBeGreaterThanOrEqual(1_000_000n);
    expect(divWithRounding(1_000_000n, 7n, 'floor') * 7n).toBeLessThan(1_000_000n);
  });

  it('throws RangeError on division by zero', () => {
    expect(() => divWithRounding(1n, 0n, 'round')).toThrow(RangeError);
  });

  it('throws RangeError on an unknown mode', () => {
    expect(() => divWithRounding(1n, 3n, 'up' as never)).toThrow(RangeError);
  });
});
