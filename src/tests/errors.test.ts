import { describe, it, expect } from 'vitest';
import {
  ConduitError,
  StreamErrorCode,
  FactoryErrorCode,
  GovernorErrorCode,
} from '../errors.js';

describe('ConduitError', () => {
  it('carries the right contract and code', () => {
    const err = new ConduitError('stream', StreamErrorCode.NothingToWithdraw);
    expect(err.contract).toBe('stream');
    expect(err.code).toBe(StreamErrorCode.NothingToWithdraw);
    expect(err.name).toBe('ConduitError');
    expect(err).toBeInstanceOf(Error);
  });

  it('has a human-readable message by default', () => {
    const err = new ConduitError('stream', StreamErrorCode.StreamCancelled);
    expect(err.message).toMatch(/cancelled/i);
  });

  it('accepts a custom message', () => {
    const err = new ConduitError('stream', StreamErrorCode.NotAuthorized, 'custom detail');
    expect(err.message).toBe('custom detail');
  });

  it('all 15 stream error codes have messages', () => {
    for (let code = 1; code <= 15; code++) {
      const err = new ConduitError('stream', code);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it('all 10 factory error codes have messages', () => {
    for (let code = 1; code <= 10; code++) {
      const err = new ConduitError('factory', code);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it('all 3 governor error codes have messages', () => {
    for (let code = 1; code <= 3; code++) {
      const err = new ConduitError('governor', code);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it('the same numeric code means something different per contract', () => {
    // Regression test for the bug this replaced: code 1 must not resolve to
    // the same message across contracts.
    const streamErr   = new ConduitError('stream', 1);
    const factoryErr  = new ConduitError('factory', 1);
    const governorErr = new ConduitError('governor', GovernorErrorCode.NotAuthorized);

    expect(streamErr.message).toMatch(/not authorized|sender or recipient/i);
    expect(factoryErr.message).toMatch(/not.*initialized/i);
    expect(governorErr.message).toMatch(/not authorized|governor authority/i);
    expect(streamErr.message).not.toBe(factoryErr.message);
  });
});

describe('ConduitError.fromContractError', () => {
  it('parses a code object scoped to the given contract', () => {
    const err = ConduitError.fromContractError('stream', { code: 6 });
    expect(err.contract).toBe('stream');
    expect(err.code).toBe(StreamErrorCode.NothingToWithdraw);
  });

  it('resolves factory code 1 as NotInitialized, not stream NotAuthorized', () => {
    const err = ConduitError.fromContractError('factory', { code: 1 });
    expect(err.code).toBe(FactoryErrorCode.NotInitialized);
    expect(err.message).toMatch(/not.*initialized/i);
  });

  it('falls back to code -1 for an unknown code', () => {
    const err = ConduitError.fromContractError('governor', { code: 999 });
    expect(err.code).toBe(-1);
  });

  it('handles non-object input', () => {
    const err = ConduitError.fromContractError('stream', 'unexpected string');
    expect(err.code).toBe(-1);
    expect(err.message).toContain('unexpected string');
  });
});

describe('ConduitError.fromSorobanMessage', () => {
  it('extracts the contract error code from a HostError message', () => {
    const err = ConduitError.fromSorobanMessage('stream', 'HostError: Error(Contract, #6)');
    expect(err).toBeInstanceOf(ConduitError);
    expect((err as ConduitError).code).toBe(StreamErrorCode.NothingToWithdraw);
    expect((err as ConduitError).contract).toBe('stream');
  });

  it('scopes the same code to the correct contract', () => {
    const err = ConduitError.fromSorobanMessage('factory', 'HostError: Error(Contract, #7)');
    expect((err as ConduitError).code).toBe(FactoryErrorCode.AlreadyInitialized);
    expect((err as ConduitError).message).toMatch(/already.*initialized/i);
  });

  it('falls back to a plain Error when no contract code is present', () => {
    const err = ConduitError.fromSorobanMessage('stream', 'HostError: Error(WasmVm, InvalidAction)');
    expect(err).not.toBeInstanceOf(ConduitError);
    expect(err.message).toBe('HostError: Error(WasmVm, InvalidAction)');
  });

  it('falls back to a plain Error for a network-level failure message', () => {
    const err = ConduitError.fromSorobanMessage('stream', 'fetch failed: ECONNREFUSED');
    expect(err).not.toBeInstanceOf(ConduitError);
  });
});
