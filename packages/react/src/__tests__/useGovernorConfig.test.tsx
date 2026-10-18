import { describe, it, expect } from 'vitest';
import { formatLedgerDuration } from '../hooks/useGovernorConfig.js';

describe('formatLedgerDuration (#996)', () => {
  it('formats 17,280 ledgers as ~24 hours', () => {
    expect(formatLedgerDuration(17_280)).toBe('~24 hours');
  });

  it('formats 51,840 ledgers as ~3 days', () => {
    expect(formatLedgerDuration(51_840)).toBe('~3 days');
  });

  it('formats 720 ledgers as ~1 hour', () => {
    expect(formatLedgerDuration(720)).toBe('~1 hour');
  });

  it('formats 34,560 ledgers as ~2 days', () => {
    expect(formatLedgerDuration(34_560)).toBe('~2 days');
  });

  it('formats 360 ledgers as ~30 minutes', () => {
    expect(formatLedgerDuration(360)).toBe('~30 minutes');
  });

  it('formats 0 or negative ledgers as ~0 hours', () => {
    expect(formatLedgerDuration(0)).toBe('~0 hours');
    expect(formatLedgerDuration(-10)).toBe('~0 hours');
  });
});
