import { describe, it, expect } from 'vitest';
import { calculateVestedAmount, calculateWithdrawableAmount } from '../streams.js';
import type { StreamInfo } from '../types/index.js';

// Stream: 1000 stroops/second for 1000 seconds (startTime 1000s → endTime 2000s).
function makeStream(overrides: Partial<StreamInfo> = {}): StreamInfo {
  return {
    id: 1n,
    address: 'CAAAA',
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    token: 'native',
    ratePerSecond: 1000n,
    startTime: 1000,
    endTime: 2000,
    withdrawn: 0n,
    paused: false,
    pausedAt: 0,
    cancelled: false,
    clawbackEnabled: false,
    ...overrides,
  };
}

describe('calculateVestedAmount (#1173)', () => {
  it('returns 0n before the stream starts', () => {
    expect(calculateVestedAmount(makeStream(), 999_000)).toBe(0n);
  });

  it('returns 0n exactly at the start time', () => {
    expect(calculateVestedAmount(makeStream(), 1_000_000)).toBe(0n);
  });

  it('accrues whole seconds', () => {
    // 500 s elapsed × 1000 stroops/s
    expect(calculateVestedAmount(makeStream(), 1_500_000)).toBe(500_000n);
  });

  it('interpolates between seconds (sub-second precision)', () => {
    // 250 ms elapsed × 1000 stroops/s = 250 stroops
    expect(calculateVestedAmount(makeStream(), 1_000_250)).toBe(250n);
    // 1500.5 s elapsed → 500.5 s × 1000 = 500_500
    expect(calculateVestedAmount(makeStream(), 1_500_500)).toBe(500_500n);
  });

  it('floors fractional stroops instead of rounding up', () => {
    // rate 3 stroops/s (startTime 1000s), 1 ms elapsed → 0.003 stroops → 0
    const slow = makeStream({ ratePerSecond: 3n });
    expect(calculateVestedAmount(slow, 1_000_001)).toBe(0n);
    // 333 ms elapsed → 0.999 stroops → 0
    expect(calculateVestedAmount(slow, 1_000_333)).toBe(0n);
    // 334 ms elapsed → 1.002 stroops → 1
    expect(calculateVestedAmount(slow, 1_000_334)).toBe(1n);
  });

  it('caps at the total deposit once endTime has passed', () => {
    // total = 1000 s × 1000 stroops/s = 1_000_000
    expect(calculateVestedAmount(makeStream(), 3_000_000)).toBe(1_000_000n);
  });

  it('freezes accrual at pausedAt while paused', () => {
    const paused = makeStream({ paused: true, pausedAt: 1500 });
    expect(calculateVestedAmount(paused, 1_800_000)).toBe(500_000n);
  });

  it('returns 0n for a cancelled stream', () => {
    expect(calculateVestedAmount(makeStream({ cancelled: true }), 1_500_000)).toBe(0n);
  });

  it('accrues without a cap for an open-ended stream (endTime 0)', () => {
    const open = makeStream({ endTime: 0 });
    expect(calculateVestedAmount(open, 1_500_000)).toBe(500_000n);
    expect(calculateVestedAmount(open, 5_000_000)).toBe(4_000_000n);
  });

  it('agrees with calculateWithdrawableAmount at whole-second timestamps', () => {
    const stream = makeStream();
    for (const sec of [999, 1000, 1001, 1250, 1999, 2000, 2500]) {
      expect(calculateVestedAmount(stream, sec * 1000)).toBe(
        calculateWithdrawableAmount(stream, sec),
      );
    }
  });

  it('returns a bigint', () => {
    expect(typeof calculateVestedAmount(makeStream(), 1_500_000)).toBe('bigint');
  });
});

describe('calculateVestedAmount — edge cases (#1173)', () => {
  it('returns the full deposit exactly at endTime', () => {
    expect(calculateVestedAmount(makeStream(), 2_000_000)).toBe(1_000_000n);
  });

  it('does not reduce the vested total by amounts already withdrawn', () => {
    // Vested is total accrued; calculateWithdrawableAmount is the net figure.
    const stream = makeStream({ withdrawn: 200_000n });
    expect(calculateVestedAmount(stream, 1_500_000)).toBe(500_000n);
  });

  it('ignores a pausedAt that lies in the future and keeps accruing to now', () => {
    const paused = makeStream({ paused: true, pausedAt: 1800 });
    expect(calculateVestedAmount(paused, 1_500_000)).toBe(500_000n);
  });

  it('keeps full precision for very large rates and long durations', () => {
    // 1e12 stroops/s for 1e6 s = 1e18 stroops, well past Number.MAX_SAFE_INTEGER.
    const huge = makeStream({
      ratePerSecond: 10n ** 12n,
      startTime: 0,
      endTime: 0,
    });
    expect(calculateVestedAmount(huge, 1_000_000_000)).toBe(10n ** 18n);
  });

  it('returns 0n at the start instant of a paused stream', () => {
    const paused = makeStream({ paused: true, pausedAt: 1000 });
    expect(calculateVestedAmount(paused, 1_500_000)).toBe(0n);
  });
});
