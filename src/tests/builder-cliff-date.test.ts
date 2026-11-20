import { describe, it, expect } from 'vitest';
import { StreamBuilder } from '../builder.js';

const TOKEN = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SENDER = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
const RECIPIENT = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA';

/** Timestamp for "now + days", so tests never depend on a fixed wall clock. */
function inDays(days: number): number {
  return Math.floor(Date.now() / 1000) + days * 86_400;
}

function baseBuilder(): StreamBuilder {
  return new StreamBuilder().token(TOKEN).sender(SENDER).recipient(RECIPIENT).amount(1000);
}

describe('StreamBuilder.withCliffDate', () => {
  it('accepts a Date object and stores it as Unix seconds in startTime', () => {
    const cliff = new Date(inDays(30) * 1000);
    const config = baseBuilder().withCliffDate(cliff).build();

    expect(config.startTime).toBe(Math.floor(cliff.getTime() / 1000));
  });

  it('accepts an ISO-8601 string', () => {
    const iso = new Date(inDays(10) * 1000).toISOString();
    const config = baseBuilder().withCliffDate(iso).build();

    expect(config.startTime).toBe(Math.floor(new Date(iso).getTime() / 1000));
  });

  it('accepts a date-only string (YYYY-MM-DD)', () => {
    const config = baseBuilder().withCliffDate('2030-01-15').build();

    expect(config.startTime).toBe(Math.floor(new Date('2030-01-15').getTime() / 1000));
  });

  it('accepts a raw numeric Unix timestamp', () => {
    const seconds = inDays(45);
    const config = baseBuilder().withCliffDate(seconds).build();

    expect(config.startTime).toBe(seconds);
  });

  it('accepts a numeric string as Unix seconds, not as a year', () => {
    const seconds = String(inDays(60));
    const config = baseBuilder().withCliffDate(seconds).build();

    // A naive `new Date("1893456000")` would parse as a year; digit strings
    // must be read as absolute seconds instead.
    expect(config.startTime).toBe(Number(seconds));
  });

  it('truncates sub-second precision from a Date', () => {
    const cliff = new Date(inDays(5) * 1000 + 750);
    const config = baseBuilder().withCliffDate(cliff).build();

    expect(config.startTime).toBe(inDays(5));
    expect(Number.isInteger(config.startTime)).toBe(true);
  });

  it('is chainable and equivalent to startTime(seconds)', () => {
    const seconds = inDays(20);
    const viaCliff = baseBuilder().withCliffDate(seconds).build();
    const viaStart = baseBuilder().startTime(seconds).build();

    expect(viaCliff).toEqual(viaStart);
  });

  it('produces the same contract arguments as startTime for a cliff', () => {
    const seconds = inDays(30);
    const withCliff = baseBuilder()
      .ratePerSecond(10)
      .withCliffDate(seconds)
      .toContractArgs();
    const withStart = baseBuilder().ratePerSecond(10).startTime(seconds).toContractArgs();

    expect(withCliff).toEqual(withStart);
  });

  it('rejects a cliff in the past', () => {
    expect(() => baseBuilder().withCliffDate(new Date(Date.now() - 86_400_000))).toThrow(
      /startTime cannot be in the past/,
    );
  });

  it('rejects an empty or blank string', () => {
    expect(() => baseBuilder().withCliffDate('')).toThrow(/empty string/);
    expect(() => baseBuilder().withCliffDate('   ')).toThrow(/empty string/);
  });

  it('rejects an unparseable string', () => {
    expect(() => baseBuilder().withCliffDate('not-a-real-date')).toThrow(
      /could not resolve a valid date/,
    );
  });

  it('rejects an invalid Date instance', () => {
    expect(() => baseBuilder().withCliffDate(new Date('nope'))).toThrow(
      /could not resolve a valid date/,
    );
  });

  it('rejects a non-integer timestamp passed as a number', () => {
    expect(() => baseBuilder().withCliffDate(inDays(10) + 0.5)).toThrow(
      /non-negative integer Unix timestamp/,
    );
  });

  it('rejects a negative timestamp', () => {
    expect(() => baseBuilder().withCliffDate(-1)).toThrow(/non-negative integer Unix timestamp/);
  });

  it('is cleared by reset()', () => {
    const builder = baseBuilder().withCliffDate(inDays(15));
    builder.reset().token(TOKEN).sender(SENDER).recipient(RECIPIENT).amount(1000);

    expect(builder.build().startTime).toBeUndefined();
  });

  it('is preserved by clone()', () => {
    const seconds = inDays(25);
    const original = baseBuilder().withCliffDate(seconds);
    const copy = original.clone();

    expect(copy.build().startTime).toBe(seconds);
  });
});
