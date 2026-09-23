import { describe, it, expect } from 'vitest';
import {
  toStroops,
  fromStroops,
  calculateRate,
  calculateYield,
  streamProgress,
  remainingTime,
  estimatedCompletionDate,
  normalizeProgress,
  withdrawableLocal,
  bigintSafeStringify,
  isValidAddress,
} from '../utils.js';
import { ZERO_ADDR } from '../constants.js';
import { Keypair } from '@stellar/stellar-sdk';
import type { StreamInfo } from '../types/index.js';

// ── toStroops / fromStroops ──────────────────────────────────────────────────

describe('toStroops', () => {
  it('converts whole numbers', () => {
    expect(toStroops('100')).toBe(1_000_000_000n);
  });

  it('converts decimal amounts', () => {
    expect(toStroops('0.0000001')).toBe(1n);
    expect(toStroops('1.5')).toBe(15_000_000n);
  });

  it('rounds to nearest instead of truncating', () => {
    // 1.00000005 should round to 1.0000001 (10000001)
    expect(toStroops('1.00000005')).toBe(10_000_001n);
    // 1.99999995 should round to 2.0 (20000000)
    expect(toStroops('1.99999995')).toBe(20_000_000n);
    // 0.99999995 should round to 1.0 (10000000)
    expect(toStroops('0.99999995')).toBe(10_000_000n);
  });

  it('truncates beyond 7 decimals', () => {
    expect(toStroops('1.00000001')).toBe(10_000_000n); // 8th decimal dropped
  });

  it('handles zero', () => {
    expect(toStroops('0')).toBe(0n);
    expect(toStroops('0.0')).toBe(0n);
  });
});

describe('fromStroops', () => {
  it('converts whole stroops', () => {
    expect(fromStroops(10_000_000n)).toBe('1.0');
  });

  it('converts fractional amounts', () => {
    expect(fromStroops(1n)).toBe('0.0000001');
    expect(fromStroops(15_000_000n)).toBe('1.5');
  });

  it('round-trips with toStroops', () => {
    const amounts = ['1', '100.5', '0.0000001', '9999.1234567'];
    for (const a of amounts) {
      expect(fromStroops(toStroops(a))).toBe(
        // strip trailing zeros the same way fromStroops does
        a.includes('.') ? a.replace(/\.?0+$/, '') || '0' : a + '.0',
      );
    }
  });
});

// ── calculateRate ────────────────────────────────────────────────────────────

describe('calculateRate', () => {
  it('computes rate for 1000 XLM over 30 days', () => {
    const duration = 30 * 24 * 3600; // 2_592_000 seconds
    const rate     = calculateRate('1000', duration);
    // 1000 XLM = 10_000_000_000 stroops; / 2_592_000 ≈ 3858 (rounded)
    const expected = 10_000_000_000n / BigInt(duration);
    const remainder = 10_000_000_000n % BigInt(duration);
    const rounded = remainder * 2n >= BigInt(duration) ? expected + 1n : expected;
    expect(rate).toBe(rounded);
  });

  it('rounds to nearest instead of truncating', () => {
    // 10 stroops / 3 seconds = 3.33... → rounds to 3
    // But 10 % 3 = 1, and 1 * 2 = 2 < 3, so rounds down to 3
    expect(calculateRate('0.0000010', 3)).toBe(3n);
    // 11 stroops / 3 seconds = 3.66... → rounds to 4
    // 11 % 3 = 2, and 2 * 2 = 4 >= 3, so rounds up to 4
    expect(calculateRate('0.0000011', 3)).toBe(4n);
    // 100 stroops / 7 seconds = 14.28... → rounds to 14
    // 100 % 7 = 2, and 2 * 2 = 4 < 7, so rounds down to 14
    expect(calculateRate('0.0000100', 7)).toBe(14n);
    // 105 stroops / 7 seconds = 15.0 exactly
    expect(calculateRate('0.0000105', 7)).toBe(15n);
  });

  it('returns 0 for zero deposit', () => {
    expect(calculateRate('0', 3600)).toBe(0n);
  });

  it('rejects a zero or negative duration (#536)', () => {
    expect(() => calculateRate('1000', 0)).toThrow(/positive integer/);
    expect(() => calculateRate('1000', -5)).toThrow(/positive integer/);
  });
});

// ── calculateYield ───────────────────────────────────────────────────────────

describe('calculateYield', () => {
  it('returns 0 for zero rate', () => {
    expect(calculateYield(0n)).toBe('0.0');
  });

  it('computes annual yield from rate per second', () => {
    // 1000 stroops/s * 31,536,000 s = 31,536,000,000 stroops = 3153.6 XLM
    const result = calculateYield(1000n);
    expect(result).toBe('3153.6');
  });

  it('uses custom duration', () => {
    // 1000 stroops/s * 86400 s (1 day) = 86,400,000 stroops = 8.64 XLM
    const result = calculateYield(1000n, 86400);
    expect(result).toBe('8.64');
  });

  it('handles large amounts without precision loss', () => {
    // 100,000,000 XLM = 10^15 stroops, deposited for 30 days (2,592,000 s)
    // rate = 10^15 / 2,592,000 ≈ 385,802,469 stroops/s (rounded)
    const rate = calculateRate('100000000', 2_592_000);
    // Annual yield = rate * 31,536,000
    const result = calculateYield(rate);
    // Reconstruct expected with BigInt to verify
    const expectedStroops = rate * 31_536_000n;
    const expected = fromStroops(expectedStroops);
    expect(result).toBe(expected);
    // Should be substantially less
    expect(result).not.toBe('0.0');
  });

  it('handles very large rates beyond Number.MAX_SAFE_INTEGER', () => {
    // rate of 10^15 stroops/s for 1 year → 3.1536e22 stroops
    const rate = 1_000_000_000_000_000n; // 10^15 stroops/s
    const result = calculateYield(rate);
    // 10^15 * 31,536,000 = 3.1536e22 stroops = 3,153,600,000,000,000 XLM
    expect(result).toContain('3153600000000000');
  });

  it('works with short durations', () => {
    // 100 stroops/s * 1 second = 100 stroops = 0.00001 XLM
    expect(calculateYield(100n, 1)).toBe('0.00001');
  });
});

// ── streamProgress ───────────────────────────────────────────────────────────

function makeStream(overrides: Partial<StreamInfo> = {}): StreamInfo {
  const now = Math.floor(Date.now() / 1000);
  return {
    id:              0n,
    address:         'C...',
    sender:          'G...',
    recipient:       'G...',
    token:           'native',
    ratePerSecond:   100n,
    startTime:       now - 1800,
    endTime:         now + 1800,
    withdrawn:       0n,
    paused:          false,
    pausedAt:        0,
    cancelled:       false,
    clawbackEnabled: false,
    ...overrides,
  };
}

describe('streamProgress', () => {
  it('returns 0 before start', () => {
    const now = Math.floor(Date.now() / 1000);
    const s   = makeStream({ startTime: now + 1000, endTime: now + 2000 });
    expect(streamProgress(s)).toBe(0);
  });

  it('returns 1 after end', () => {
    const now = Math.floor(Date.now() / 1000);
    const s   = makeStream({ startTime: now - 2000, endTime: now - 1000 });
    expect(streamProgress(s)).toBe(1);
  });

  it('returns 0.5 at halfway', () => {
    const now = Math.floor(Date.now() / 1000);
    const s   = makeStream({ startTime: now - 1800, endTime: now + 1800 });
    const p   = streamProgress(s);
    expect(p).toBeGreaterThan(0.49);
    expect(p).toBeLessThan(0.51);
  });

  it('returns NaN for open-ended streams that have already started', () => {
    const now = Math.floor(Date.now() / 1000);
    const s = makeStream({ startTime: now - 100, endTime: 0 });
    expect(Number.isNaN(streamProgress(s, now))).toBe(true);
  });
});

describe('stream time helpers', () => {
  it('returns seconds remaining and clamps completed streams to zero', () => {
    const stream = makeStream({ startTime: 900, endTime: 2_000 });
    expect(remainingTime(stream, 1_500)).toBe(500);
    expect(remainingTime(stream, 2_001)).toBe(0);
  });

  it('returns zero for open-ended streams', () => {
    expect(remainingTime(makeStream({ endTime: 0 }), 1_500)).toBe(0);
  });

  it('returns the stream end timestamp as a Date', () => {
    expect(estimatedCompletionDate(makeStream({ endTime: 1_700_000_000 }))).toEqual(
      new Date(1_700_000_000 * 1000),
    );
  });
});

// ── normalizeProgress ────────────────────────────────────────────────────────
// Module36 and Module48 both need to turn streamProgress()'s NaN
// (open-ended, already-started) result into a defined midpoint value.
// This must be a single shared helper — see #482 — not two independent
// reimplementations that can drift out of sync at the edges.

describe('normalizeProgress', () => {
  it('maps NaN to the midpoint 0.5', () => {
    expect(normalizeProgress(Number.NaN)).toBe(0.5);
  });

  it('passes finite values through unchanged', () => {
    expect(normalizeProgress(0)).toBe(0);
    expect(normalizeProgress(1)).toBe(1);
    expect(normalizeProgress(0.25)).toBe(0.25);
  });
});

// ── withdrawableLocal ────────────────────────────────────────────────────────

describe('withdrawableLocal', () => {
  it('returns 0 before stream starts', () => {
    const now = Math.floor(Date.now() / 1000);
    const s   = makeStream({ startTime: now + 100, endTime: now + 3700 });
    expect(withdrawableLocal(s, now)).toBe(0n);
  });

  it('equals rate × elapsed', () => {
    const now  = Math.floor(Date.now() / 1000);
    const rate = 100n;
    const s    = makeStream({ ratePerSecond: rate, startTime: now - 500, endTime: now + 500 });
    const w    = withdrawableLocal(s, now);
    expect(w).toBe(rate * 500n);
  });

  it('caps at end_time', () => {
    const now  = Math.floor(Date.now() / 1000);
    const rate = 100n;
    const s    = makeStream({
      ratePerSecond: rate,
      startTime:     now - 2000,
      endTime:       now - 1000, // already ended
    });
    // Should be capped at end_time − start_time = 1000 seconds
    expect(withdrawableLocal(s, now)).toBe(rate * 1000n);
  });

  it('returns 0 for cancelled stream', () => {
    const s = makeStream({ cancelled: true });
    expect(withdrawableLocal(s)).toBe(0n);
  });

  it('freezes at pause_at when paused', () => {
    const now     = Math.floor(Date.now() / 1000);
    const rate    = 100n;
    const pausedAt = now - 500;
    const s = makeStream({
      ratePerSecond: rate,
      startTime:     now - 1000,
      endTime:       now + 1000,
      paused:        true,
      pausedAt,
    });
    // Withdrawable = rate × (pausedAt − startTime) = 100 × 500 = 50_000
    expect(withdrawableLocal(s, now)).toBe(rate * 500n);
  });

  it('subtracts already withdrawn', () => {
    const now  = Math.floor(Date.now() / 1000);
    const rate = 100n;
    const s    = makeStream({ ratePerSecond: rate, startTime: now - 1000, withdrawn: 50_000n });
    expect(withdrawableLocal(s, now)).toBe(rate * 1000n - 50_000n);
  });

  it('a stream paused *after* end_time has fully streamed (matches on-chain clamp order)', () => {
    const now  = Math.floor(Date.now() / 1000);
    const rate = 100n;
    // start .. end (1000s of streaming) .. then paused, then now
    const s = makeStream({
      ratePerSecond: rate,
      startTime:     now - 3000,
      endTime:       now - 2000,
      paused:        true,
      pausedAt:      now - 500, // pause began well after the stream ended
    });
    // end_time wins: rate × (endTime − startTime) = 100 × 1000
    expect(withdrawableLocal(s, now)).toBe(rate * 1000n);
  });

  it('a pause that began before end_time still freezes accrual', () => {
    const now  = Math.floor(Date.now() / 1000);
    const rate = 100n;
    const s = makeStream({
      ratePerSecond: rate,
      startTime:     now - 1000,
      endTime:       now + 1000,
      paused:        true,
      pausedAt:      now - 400, // pause began while still running
    });
    expect(withdrawableLocal(s, now)).toBe(rate * 600n);
  });
});

// ── bigintSafeStringify ─────────────────────────────────────────────────────

describe('bigintSafeStringify', () => {
  it('converts a top-level bigint to string', () => {
    expect(bigintSafeStringify(123n)).toBe('123');
  });

  it('leaves primitives untouched', () => {
    expect(bigintSafeStringify(42)).toBe(42);
    expect(bigintSafeStringify('hello')).toBe('hello');
    expect(bigintSafeStringify(true)).toBe(true);
    expect(bigintSafeStringify(null)).toBe(null);
    expect(bigintSafeStringify(undefined)).toBe(undefined);
  });

  it('converts bigint values inside a plain object', () => {
    const input = { rate: 9007199254740993n, name: 'stream' };
    const result = bigintSafeStringify(input);
    expect(result).toEqual({ rate: '9007199254740993', name: 'stream' });
  });

  it('converts bigint values inside nested objects', () => {
    const input = {
      a: { b: { c: 100n } },
      d: [1n, 2n, 3n],
    };
    const result = bigintSafeStringify(input);
    expect(result).toEqual({
      a: { b: { c: '100' } },
      d: ['1', '2', '3'],
    });
  });

  it('preserves non-object primitives untouched', () => {
    const input = [1, 'two', null, undefined, 3.14];
    expect(bigintSafeStringify(input)).toEqual([1, 'two', null, undefined, 3.14]);
  });

  it('handles a realistic stream payload with BigInt rate', () => {
    const payload = {
      token: 'CD...',
      sender: 'GA...',
      recipient: 'GB...',
      amount: 1000,
      ratePerSecond: BigInt('9007199254740993'),
      deposit: 50000n,
    };
    const result = bigintSafeStringify(payload);
    expect(result.ratePerSecond).toBe('9007199254740993');
    expect(result.deposit).toBe('50000');
    // Non-bigint fields are unchanged
    expect(result.token).toBe('CD...');
    expect(result.amount).toBe(1000);

    // The result must survive JSON.stringify without throwing
    const json = JSON.parse(JSON.stringify(result));
    expect(json.ratePerSecond).toBe('9007199254740993');
    expect(json.deposit).toBe('50000');
  });

  // ── Lazy cloning / reference identity tests ──────────────────────────────

  it('returns the same array reference when no bigints are present', () => {
    const input = [1, 'two', 3.14, null, undefined, true];
    const result = bigintSafeStringify(input);
    expect(result).toBe(input); // same reference — no allocation
  });

  it('returns the same object reference when no bigints are present', () => {
    const input = { a: 1, b: 'two', c: 3.14, d: null, e: undefined, f: true };
    const result = bigintSafeStringify(input);
    expect(result).toBe(input); // same reference — no allocation
  });

  it('returns the same deeply-nested object reference when no bigints', () => {
    const inner = { x: 1, y: 2 };
    const input = { a: { b: inner }, c: [1, 2, 3] };
    const result = bigintSafeStringify(input);
    expect(result).toBe(input); // top-level is unchanged
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).a.b).toBe(inner); // deeply nested is also unchanged
  });

  it('allocates a new array when a bigint is present', () => {
    const input = [1, 2n, 3];
    const result = bigintSafeStringify(input);
    expect(result).not.toBe(input); // new array allocated
    expect(result).toEqual([1, '2', 3]);
  });

  it('allocates a new object when a bigint is present', () => {
    const input = { a: 1, b: 2n };
    const result = bigintSafeStringify(input);
    expect(result).not.toBe(input); // new object allocated
    expect(result).toEqual({ a: 1, b: '2' });
  });

  it('allocates a new parent but keeps unchanged child references intact', () => {
    const child = { x: 1, y: 2 };
    const input = { a: child, b: 100n };
    const result = bigintSafeStringify(input);
    expect(result).not.toBe(input); // parent changed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).a).toBe(child); // child unchanged — same reference
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).b).toBe('100');
  });

  it('handles empty objects', () => {
    const input = {};
    const result = bigintSafeStringify(input);
    expect(result).toBe(input); // no allocation
  });

  it('handles empty arrays', () => {
    const input: unknown[] = [];
    const result = bigintSafeStringify(input);
    expect(result).toBe(input); // no allocation
  });

  it('handles Date objects (non-plain objects pass through)', () => {
    const input = new Date('2024-01-01');
    const result = bigintSafeStringify(input);
    // Dates are typeof 'object' and non-null, so they go through the
    // Object.keys path, enumerating own properties (which a Date has none).
    // The result should be an empty plain object if no own enum keys exist,
    // or the original Date if we return it unchanged (no bigints found).
    // Since Date has no own enumerable string keys, the loop is empty and no
    // bigints are found → returns the original Date unchanged.
    expect(result).toBe(input);
  });

  it('survives multiple round-trips (idempotent)', () => {
    const input = { a: 1n, b: { c: 2n } };
    const first = bigintSafeStringify(input) as Record<string, unknown>;
    const second = bigintSafeStringify(first);
    // Second pass: no bigints remain, so reference should be preserved
    expect(second).toBe(first);
    expect(second).toEqual({ a: '1', b: { c: '2' } });
  });

  it('handles bigints in mixed nested structures efficiently', () => {
    const input = {
      streamId: '42',
      info: {
        ratePerSecond: 38580n,
        withdrawn: 0n,
        paused: false,
        metadata: { name: 'test', active: true },
      },
    };
    const result = bigintSafeStringify(input) as typeof input;
    expect(result.info.ratePerSecond).toBe('38580');
    expect(result.info.withdrawn).toBe('0');
    // Non-bigint sub-object returned as-is (reference preserved)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any).info.metadata).toBe(input.info.metadata);
  });

  it('handles arrays with bigint at various positions', () => {
    const input = [1, 'two', 3n, 4, 5n];
    const result = bigintSafeStringify(input) as unknown[];
    expect(result).toEqual([1, 'two', '3', 4, '5']);
    // Elements without bigint should be reference-equal
    expect(result[0]).toBe(input[0]);
    expect(result[1]).toBe(input[1]);
    expect(result[3]).toBe(input[3]);
  });

  it('preserves undefined inside objects', () => {
    const input = { a: undefined, b: 1n };
    const result = bigintSafeStringify(input) as Record<string, unknown>;
    expect(result.a).toBeUndefined();
    expect(result.b).toBe('1');
    // JSON.stringify should skip undefined (standard behavior)
    const json = JSON.parse(JSON.stringify(result));
    expect(json.b).toBe('1');
    expect('a' in json).toBe(false);
  });
});

// -- isValidAddress -----------------------------------------------------------

describe('isValidAddress', () => {
  it('keeps the SDK fallback ZERO_ADDR as a valid Stellar public key', () => {
    expect(ZERO_ADDR).toHaveLength(56);
    expect(isValidAddress(ZERO_ADDR)).toBe(true);
  });

  it('returns true for a valid ed25519 public key', () => {
    const kp = Keypair.random();
    expect(isValidAddress(kp.publicKey())).toBe(true);
  });

  it('returns false for a corrupted checksum', () => {
    const kp = Keypair.random();
    const valid = kp.publicKey();
    const tampered = valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A');
    expect(isValidAddress(tampered)).toBe(false);
  });

  it('returns false for a secret key (S...) instead of a public key', () => {
    const kp = Keypair.random();
    expect(isValidAddress(kp.secret())).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isValidAddress('')).toBe(false);
  });

  it('returns false for non-string input', () => {
    expect(isValidAddress(null as unknown as string)).toBe(false);
    expect(isValidAddress(undefined as unknown as string)).toBe(false);
  });

  it('returns true for a valid Soroban contract address (C...) (#512)', () => {
    const contractId = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
    expect(isValidAddress(contractId)).toBe(true);
  });

  it('returns false for a random unrelated string', () => {
    expect(isValidAddress('not-a-stellar-address')).toBe(false);
  });
});

// ── POW10 precomputation coverage ──────────────────────────────────────

describe('toStroops with non-default decimals', () => {
  it('works with decimals=0', () => {
    expect(toStroops('100', 0)).toBe(100n);
  });

  it('works with decimals=1', () => {
    expect(toStroops('1.5', 1)).toBe(15n);
  });

  it('works with decimals=8 (beyond default 7)', () => {
    expect(toStroops('1.00000001', 8)).toBe(100000001n);
  });

  it('works with decimals=18 (beyond default 7)', () => {
    expect(toStroops('1.000000000000000001', 18)).toBe(1000000000000000001n);
  });
});

describe('fromStroops with non-default decimals', () => {
  it('works with decimals=0', () => {
    expect(fromStroops(100n, 0)).toBe('100.0');
  });

  it('works with decimals=1', () => {
    expect(fromStroops(15n, 1)).toBe('1.5');
  });

  it('works with decimals=8', () => {
    expect(fromStroops(100000001n, 8)).toBe('1.00000001');
  });
});

describe('calculateRate with non-default decimals', () => {
  it('works with decimals=0', () => {
    expect(calculateRate('100', 10, 0)).toBe(10n);
  });

  it('works with decimals=18', () => {
    const rate = calculateRate('1', 1000, 18);
    expect(rate).toBeGreaterThan(0n);
  });
});

describe('bigintSafeStringify edge cases', () => {
  it('handles an empty object', () => {
    expect(bigintSafeStringify({})).toEqual({});
  });

  it('handles an empty array', () => {
    expect(bigintSafeStringify([])).toEqual([]);
  });

  it('handles deeply nested bigint values', () => {
    const input = { a: { b: { c: { d: 9007199254740993n } } } };
    const result = bigintSafeStringify(input);
    expect(result.a.b.c.d).toBe('9007199254740993');
  });
});
