import { describe, it, expect } from 'vitest';
import { isStreamCancellableByAccount } from '../streams.js';
import type { StreamInfo } from '../types/index.js';

const SENDER = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLYC3ZCHB2D4P3CF';
const RECIPIENT = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const STRANGER = 'GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3';

const baseStream: StreamInfo = {
  id: 1n,
  address: 'CCSTREAM1ADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  sender: SENDER,
  recipient: RECIPIENT,
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

describe('isStreamCancellableByAccount', () => {
  it('returns true for the sender on an active stream', () => {
    expect(isStreamCancellableByAccount(baseStream, SENDER)).toBe(true);
  });

  it('returns false for the sender once the stream is already cancelled', () => {
    expect(
      isStreamCancellableByAccount({ ...baseStream, cancelled: true }, SENDER),
    ).toBe(false);
  });

  it('returns false for a stranger', () => {
    expect(isStreamCancellableByAccount(baseStream, STRANGER)).toBe(false);
  });

  it('returns false for an empty wallet address', () => {
    expect(isStreamCancellableByAccount(baseStream, '')).toBe(false);
  });

  it('returns false for the recipient on an unpaused stream', () => {
    expect(isStreamCancellableByAccount(baseStream, RECIPIENT)).toBe(false);
  });

  it('returns false for the recipient on a paused stream when no threshold is supplied', () => {
    const paused: StreamInfo = { ...baseStream, paused: true, pausedAt: 1200 };
    expect(isStreamCancellableByAccount(paused, RECIPIENT)).toBe(false);
  });

  it('returns false for the recipient when the pause has not yet crossed the threshold', () => {
    const paused: StreamInfo = { ...baseStream, paused: true, pausedAt: 1200 };
    expect(
      isStreamCancellableByAccount(paused, RECIPIENT, {
        pauseThresholdSeconds: 600,
        currentTimestamp: 1500,
      }),
    ).toBe(false);
  });

  it('returns true for the recipient once the pause has crossed the threshold', () => {
    const paused: StreamInfo = { ...baseStream, paused: true, pausedAt: 1200 };
    expect(
      isStreamCancellableByAccount(paused, RECIPIENT, {
        pauseThresholdSeconds: 600,
        currentTimestamp: 1800,
      }),
    ).toBe(true);
  });

  it('returns false for the recipient on a cancelled stream even past the threshold', () => {
    const cancelled: StreamInfo = {
      ...baseStream,
      paused: true,
      pausedAt: 1200,
      cancelled: true,
    };
    expect(
      isStreamCancellableByAccount(cancelled, RECIPIENT, {
        pauseThresholdSeconds: 600,
        currentTimestamp: 1800,
      }),
    ).toBe(false);
  });
});
