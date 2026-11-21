import { describe, it, expect } from 'vitest';
import { calculateVestedPercentage } from '../streams.js';
import type { StreamInfo } from '../types/index.js';

const baseStream: StreamInfo = {
  id: 1n,
  address: 'CCSTREAM1ADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  sender: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLYC3ZCHB2D4P3CF',
  recipient: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
  token: 'native',
  ratePerSecond: 100n,
  startTime: 1000,
  endTime: 2000,
  withdrawn: 0n,
  paused: false,
  pausedAt: 0,
  cancelled: false,
  clawbackEnabled: false,
};

describe('calculateVestedPercentage', () => {
  it('returns 0 before the stream starts', () => {
    expect(calculateVestedPercentage(baseStream, 500)).toBe(0);
  });

  it('returns 0 exactly at startTime', () => {
    expect(calculateVestedPercentage(baseStream, 1000)).toBe(0);
  });

  it('returns 0.5 at the midpoint of a bounded stream', () => {
    expect(calculateVestedPercentage(baseStream, 1500)).toBe(0.5);
  });

  it('returns 1 exactly at endTime', () => {
    expect(calculateVestedPercentage(baseStream, 2000)).toBe(1);
  });

  it('clamps to 1 after endTime', () => {
    expect(calculateVestedPercentage(baseStream, 9000)).toBe(1);
  });

  it('returns 0 for an open-ended stream (endTime === 0)', () => {
    expect(calculateVestedPercentage({ ...baseStream, endTime: 0 }, 1500)).toBe(0);
  });

  it('returns 0 for a malformed stream where endTime <= startTime', () => {
    expect(
      calculateVestedPercentage({ ...baseStream, endTime: baseStream.startTime }, 1500),
    ).toBe(0);
  });

  it('returns 0 for a cancelled stream', () => {
    expect(calculateVestedPercentage({ ...baseStream, cancelled: true }, 1500)).toBe(0);
  });

  it('freezes progress at pausedAt while the stream is paused', () => {
    const paused: StreamInfo = { ...baseStream, paused: true, pausedAt: 1200 };
    expect(calculateVestedPercentage(paused, 1800)).toBeCloseTo(0.2, 10);
  });

  it('ignores a stale pausedAt once currentTimestamp passes it while unpaused', () => {
    expect(calculateVestedPercentage(baseStream, 1800)).toBeCloseTo(0.8, 10);
  });

  it('is unaffected by ratePerSecond or withdrawn, since progress is time-based', () => {
    const highRate: StreamInfo = { ...baseStream, ratePerSecond: 999_999n, withdrawn: 123n };
    expect(calculateVestedPercentage(highRate, 1500)).toBe(0.5);
  });

  it('defaults currentTimestamp to now', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const openEnded: StreamInfo = {
      ...baseStream,
      startTime: nowSeconds - 100,
      endTime: nowSeconds + 100,
    };
    const result = calculateVestedPercentage(openEnded);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });
});
