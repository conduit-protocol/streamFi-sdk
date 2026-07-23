import { describe, it, expect } from 'vitest';
import {
  toStroops,
  fromStroops,
  calculateRate,
  streamProgress,
  withdrawableLocal,
  bigintSafeStringify,
  isValidAddress,
} from '../utils.js';
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
    // 1000 XLM = 10_000_000_000 stroops; / 2_592_000 ≈ 3858
    expect(rate).toBe(10_000_000_000n / BigInt(duration));
  });

  it('returns 0 for zero deposit', () => {
    expect(calculateRate('0', 3600)).toBe(0n);
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

  it('returns 0 for open-ended streams', () => {
    const s = makeStream({ endTime: 0 });
    expect(streamProgress(s)).toBe(0);
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
});

// -- isValidAddress -----------------------------------------------------------

describe('isValidAddress', () => {
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

  it('returns false for a random unrelated string', () => {
    expect(isValidAddress('not-a-stellar-address')).toBe(false);
  });
});
