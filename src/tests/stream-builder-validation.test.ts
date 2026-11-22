/**
 * Builder and schedule validation edge cases (#1166, #1169).
 *
 * - Zero or reversed durations, and durations at or just below the protocol
 *   minimum, must be rejected client-side before a transaction is built.
 * - Cliff timestamps outside [startTime, endTime) must be rejected by
 *   `validateStreamSchedule`.
 * - Zero and negative rates must be rejected by `ratePerSecond`.
 */
import { describe, it, expect } from 'vitest';
import { StreamBuilder } from '../builder.js';
import { ValidationError } from '../errors.js';
import { MIN_STREAM_DURATION_SECONDS } from '../constants.js';
import { InvalidScheduleError, validateStreamSchedule } from '../schedule.js';

const TOKEN = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SENDER = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
const RECIPIENT = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA';

/** A builder with a fixed window; `endTime` is the only field under test. */
function windowBuilder(startTime: number, endTime: number): StreamBuilder {
  return new StreamBuilder()
    .token(TOKEN)
    .sender(SENDER)
    .recipient(RECIPIENT)
    .amount(1000)
    .ratePerSecond(10)
    .startTime(startTime)
    .endTime(endTime);
}

describe('StreamBuilder duration validation (#1166, #1169)', () => {
  const START = Math.floor(Date.now() / 1000);

  it('rejects a zero-length stream (endTime equals startTime)', () => {
    expect(() => windowBuilder(START, START).build()).toThrow(ValidationError);
  });

  it('rejects an endTime that precedes startTime', () => {
    expect(() => windowBuilder(START, START - 1).build()).toThrow(ValidationError);
  });

  it('rejects a duration equal to the protocol minimum (must strictly exceed it)', () => {
    const end = START + MIN_STREAM_DURATION_SECONDS;
    expect(() => windowBuilder(START, end).build()).toThrow(ValidationError);
  });

  it('rejects a duration one second below the protocol minimum', () => {
    const end = START + MIN_STREAM_DURATION_SECONDS - 1;
    expect(() => windowBuilder(START, end).build()).toThrow(ValidationError);
  });

  it('rejects a short duration such as 60 seconds', () => {
    expect(() => windowBuilder(START, START + 60).build()).toThrow(ValidationError);
  });

  it('accepts a duration one second above the protocol minimum', () => {
    const end = START + MIN_STREAM_DURATION_SECONDS + 1;
    expect(() => windowBuilder(START, end).build()).not.toThrow();
  });

  it('measures duration from now when no startTime is set', () => {
    const now = Math.floor(Date.now() / 1000);
    const base = () =>
      new StreamBuilder().token(TOKEN).sender(SENDER).recipient(RECIPIENT).amount(1000).ratePerSecond(10);

    expect(() => base().endTime(now + 60).build()).toThrow(ValidationError);
    expect(() => base().endTime(now).build()).toThrow(ValidationError);
    expect(() => base().endTime(now + MIN_STREAM_DURATION_SECONDS + 120).build()).not.toThrow();
  });

  it('accepts an open-ended stream that sets no endTime', () => {
    expect(() =>
      new StreamBuilder().token(TOKEN).sender(SENDER).recipient(RECIPIENT).amount(1000).ratePerSecond(10).startTime(START).build(),
    ).not.toThrow();
  });

  it('reports a descriptive duration issue from validate()', () => {
    const issues = windowBuilder(START, START + 60).validate();
    expect(issues.some((issue) => issue.includes(String(MIN_STREAM_DURATION_SECONDS)))).toBe(true);
  });

  it('does not report a duration issue for an open-ended stream (no endTime)', () => {
    const issues = new StreamBuilder()
      .token(TOKEN)
      .sender(SENDER)
      .recipient(RECIPIENT)
      .amount(1000)
      .ratePerSecond(10)
      .startTime(START)
      .validate();
    expect(issues.some((issue) => issue.toLowerCase().includes('duration'))).toBe(false);
  });
});

describe('cliff schedule bounds (#1166)', () => {
  const base = { kind: 'cliff' as const, startTime: 1_000, endTime: 2_000 };

  it('rejects a cliff before the stream start', () => {
    expect(() => validateStreamSchedule({ ...base, cliffTime: 999 })).toThrow(InvalidScheduleError);
    expect(() => validateStreamSchedule({ ...base, cliffTime: 999 })).toThrow(
      'cliffTime must not be before startTime',
    );
  });

  it('rejects a cliff after the stop time', () => {
    expect(() => validateStreamSchedule({ ...base, cliffTime: 2_500 })).toThrow(
      'endTime must be after cliffTime',
    );
  });

  it('rejects a cliff exactly at the stop time', () => {
    expect(() => validateStreamSchedule({ ...base, cliffTime: 2_000 })).toThrow(
      'endTime must be after cliffTime',
    );
  });

  it('accepts a cliff exactly at the stream start', () => {
    expect(() => validateStreamSchedule({ ...base, cliffTime: 1_000 })).not.toThrow();
  });

  it('accepts a cliff one second before the stop time', () => {
    expect(() => validateStreamSchedule({ ...base, cliffTime: 1_999 })).not.toThrow();
  });

  it('rejects a negative cliff timestamp', () => {
    expect(() => validateStreamSchedule({ ...base, cliffTime: -1 })).toThrow(
      'cliffTime must be a non-negative integer Unix timestamp',
    );
  });
});

describe('ratePerSecond rejects zero and negative rates (#1166)', () => {
  const builder = () => new StreamBuilder();

  it('rejects a zero number rate', () => {
    expect(() => builder().ratePerSecond(0)).toThrow('ratePerSecond must be a positive');
  });

  it('rejects a negative number rate', () => {
    expect(() => builder().ratePerSecond(-5)).toThrow('ratePerSecond must be a positive');
  });

  it('rejects a negative bigint rate', () => {
    expect(() => builder().ratePerSecond(-5n)).toThrow('ratePerSecond must be a positive');
  });

  it('rejects a negative numeric string rate', () => {
    expect(() => builder().ratePerSecond('-5')).toThrow('ratePerSecond must be a positive');
  });

  it('rejects a zero numeric string rate', () => {
    expect(() => builder().ratePerSecond('0')).toThrow('ratePerSecond must be a positive');
  });
});
