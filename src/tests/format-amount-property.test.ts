import { describe, it, expect } from 'vitest';
import { formatAmount } from '../dashboard/transaction-history.js';

/**
 * #618 — property / fuzz coverage for `formatAmount`. The #565 fix made the
 * function reject non-integer stroop strings instead of silently mis-scaling
 * them; these tests lock in the invariants across a wide input space rather
 * than a handful of hand-picked cases.
 */

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Re-derive the integer stroop value from a `formatAmount(_, decimals)` output.
 * `formatAmount` trims trailing zeros from the fraction, so the fraction is
 * re-padded back to `decimals` digits before parsing.
 */
function valueOf(formatted: string, decimals: number): bigint {
  const negative = formatted.startsWith('-');
  const body = (negative ? formatted.slice(1) : formatted).replace(/,/g, '');
  const [whole, fraction = ''] = body.split('.');
  const paddedFraction = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return (negative ? -1n : 1n) * BigInt(`${whole}${paddedFraction}` || '0');
}

describe('formatAmount — properties (#618)', () => {
  it('never throws, for any input type', () => {
    const weird: unknown[] = [
      undefined,
      null,
      Number.NaN,
      Infinity,
      -Infinity,
      0,
      -0,
      1.5,
      1e30,
      '',
      '   ',
      'garbage',
      '0x10',
      '1e7',
      '1_000_000',
      '١٢٣', // arabic-indic digits
      '9'.repeat(5000),
      {},
      [],
      { toString: () => '10000000' },
      Symbol('x'),
      () => 1,
      123n,
      true,
    ];
    for (const input of weird) {
      expect(() => formatAmount(input as never)).not.toThrow();
      expect(typeof formatAmount(input as never)).toBe('string');
    }
  });

  it('round-trips: valueOf(format(n, d), d) === n for random integers and decimals', () => {
    const rand = mulberry32(0x5eed);
    for (let i = 0; i < 1000; i++) {
      const magnitude = Math.floor(rand() * 40); // up to 10^40
      const sign = rand() < 0.5 ? -1n : 1n;
      let n = 0n;
      for (let k = 0; k <= magnitude; k++) {
        n = n * 10n + BigInt(Math.floor(rand() * 10));
      }
      n *= sign;
      const decimals = Math.floor(rand() * 21); // 0..20

      const formatted = formatAmount(n.toString(), decimals);
      expect(formatted).toMatch(/^-?(0|[1-9]\d{0,2}(,\d{3})*)(\.\d+)?$/);
      expect(valueOf(formatted, decimals)).toBe(n);
    }
  });

  it('preserves sign except for zero', () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 300; i++) {
      const n = BigInt(Math.floor((rand() - 0.5) * 2e15));
      const out = formatAmount(n.toString(), 7);
      if (n === 0n) {
        expect(out.startsWith('-')).toBe(false);
      } else {
        expect(out.startsWith('-')).toBe(n < 0n);
      }
    }
  });

  it('groups the integer part in thousands and never uses scientific notation', () => {
    const out = formatAmount('123456789012345678901234567890', 0);
    expect(out).toBe('123,456,789,012,345,678,901,234,567,890');
    expect(out).not.toMatch(/e/i);
  });
});

describe('formatAmount — edge cases (#618)', () => {
  it('normalises every spelling of zero to "0" (no "-0", no "0,000")', () => {
    for (const z of ['0', '-0', '00', '0000000', '-0000000', ' -0 ', '-00000000000', '000000000000']) {
      expect(formatAmount(z)).toBe('0');
    }
  });

  it('handles very small amounts (more decimals than digits)', () => {
    expect(formatAmount('1', 18)).toBe('0.000000000000000001');
    expect(formatAmount('-1', 18)).toBe('-0.000000000000000001');
    expect(formatAmount('25', 30)).toBe(`0.${'0'.repeat(28)}25`);
  });

  it('handles very large amounts without precision loss', () => {
    const big = '9'.repeat(60);
    expect(valueOf(formatAmount(big, 7), 7)).toBe(BigInt(big));
  });

  it('clamps a non-finite / negative decimals argument to a sane value', () => {
    for (const d of [Number.NaN, Infinity, -Infinity, -5, -0.9]) {
      const out = formatAmount('12345678', d);
      expect(out).not.toMatch(/nan/i);
      expect(() => valueOf(out, 7)).not.toThrow();
    }
    expect(formatAmount('12345678', -5)).toBe(formatAmount('12345678', 0));
  });

  it('still rejects non-integer stroop strings (#565)', () => {
    for (const bad of ['1.5', '1,000', '1e7', '12345678.9', '--10000000', '0x10', '+10']) {
      expect(formatAmount(bad)).toBe('0');
    }
  });
});
