import { describe, it, expect } from 'vitest';
import { BASE_FEE } from '@stellar/stellar-sdk';
import { simulateWithdraw } from '../streams.js';
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

describe('simulateWithdraw', () => {
  it('previews the full withdrawable balance when no amount is given', () => {
    const result = simulateWithdraw(baseStream, { currentTimestamp: 1500 });
    expect(result.withdrawable).toBe(50_000n); // 100/s * 500s
    expect(result.withdrawAmount).toBe(50_000n);
    expect(result.remainingWithdrawable).toBe(0n);
    expect(result.exceedsAvailable).toBe(false);
  });

  it('clamps a requested amount that exceeds the withdrawable balance', () => {
    const result = simulateWithdraw(baseStream, {
      currentTimestamp: 1500,
      amount: 999_999n,
    });
    expect(result.withdrawable).toBe(50_000n);
    expect(result.withdrawAmount).toBe(50_000n);
    expect(result.remainingWithdrawable).toBe(0n);
    expect(result.exceedsAvailable).toBe(true);
  });

  it('reports the remaining withdrawable balance after a partial withdrawal', () => {
    const result = simulateWithdraw(baseStream, {
      currentTimestamp: 1500,
      amount: 20_000n,
    });
    expect(result.withdrawAmount).toBe(20_000n);
    expect(result.remainingWithdrawable).toBe(30_000n);
    expect(result.exceedsAvailable).toBe(false);
  });

  it('defaults the estimated fee to BASE_FEE', () => {
    const result = simulateWithdraw(baseStream, { currentTimestamp: 1500 });
    expect(result.estimatedFee).toBe(BigInt(BASE_FEE));
  });

  it('honours an explicit fee override', () => {
    const result = simulateWithdraw(baseStream, {
      currentTimestamp: 1500,
      fee: '500',
    });
    expect(result.estimatedFee).toBe(500n);
  });

  it('returns 0 for a cancelled stream regardless of requested amount', () => {
    const cancelled: StreamInfo = { ...baseStream, cancelled: true };
    const result = simulateWithdraw(cancelled, {
      currentTimestamp: 1500,
      amount: 1n,
    });
    expect(result.withdrawable).toBe(0n);
    expect(result.withdrawAmount).toBe(0n);
    expect(result.exceedsAvailable).toBe(true);
  });

  it('accounts for amounts already withdrawn', () => {
    const partiallyWithdrawn: StreamInfo = { ...baseStream, withdrawn: 10_000n };
    const result = simulateWithdraw(partiallyWithdrawn, { currentTimestamp: 1500 });
    expect(result.withdrawable).toBe(40_000n);
  });

  it('defaults currentTimestamp to now', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const active: StreamInfo = {
      ...baseStream,
      startTime: nowSeconds - 100,
      endTime: nowSeconds + 100,
    };
    const result = simulateWithdraw(active);
    expect(result.withdrawable).toBeGreaterThan(0n);
  });
});
