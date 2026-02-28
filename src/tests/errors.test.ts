import { describe, it, expect } from 'vitest';
import { ConduitError, ErrorCode } from '../errors.js';

describe('ConduitError', () => {
  it('carries the right code', () => {
    const err = new ConduitError(ErrorCode.NothingToWithdraw);
    expect(err.code).toBe(ErrorCode.NothingToWithdraw);
    expect(err.name).toBe('ConduitError');
    expect(err).toBeInstanceOf(Error);
  });

  it('has a human-readable message by default', () => {
    const err = new ConduitError(ErrorCode.StreamCancelled);
    expect(err.message).toMatch(/cancelled/i);
  });

  it('accepts a custom message', () => {
    const err = new ConduitError(ErrorCode.NotAuthorized, 'custom detail');
    expect(err.message).toBe('custom detail');
  });

  it('fromContractError parses a code object', () => {
    const err = ConduitError.fromContractError({ code: 6 });
    expect(err.code).toBe(ErrorCode.NothingToWithdraw);
  });

  it('fromContractError falls back to StreamNotFound for unknown codes', () => {
    const err = ConduitError.fromContractError({ code: 999 });
    expect(err.code).toBe(ErrorCode.StreamNotFound);
  });

  it('fromContractError handles non-object input', () => {
    const err = ConduitError.fromContractError('unexpected string');
    expect(err.code).toBe(ErrorCode.StreamNotFound);
    expect(err.message).toContain('unexpected string');
  });

  it('all 12 error codes have messages', () => {
    for (let code = 1; code <= 12; code++) {
      const err = new ConduitError(code as ErrorCode);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});
