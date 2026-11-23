import { describe, it, expect } from 'vitest';
import {
  getRecoveryHint,
  ConduitError,
  ContractError,
  parseContractError,
  StreamErrorCode,
  FactoryErrorCode,
  GovernorErrorCode,
  UNKNOWN_CONTRACT_ERROR_CODE,
} from '../errors.js';

describe('getRecoveryHint (#967)', () => {
  it('returns a dedicated hint for every known stream code', () => {
    for (const code of Object.values(StreamErrorCode)) {
      if (typeof code !== 'number') continue;
      const hint = getRecoveryHint('stream', code);
      expect(hint).not.toMatch(/No troubleshooting hint/);
      expect(hint.length).toBeGreaterThan(10);
    }
  });

  it('returns a dedicated hint for every known factory code', () => {
    for (const code of Object.values(FactoryErrorCode)) {
      if (typeof code !== 'number') continue;
      expect(getRecoveryHint('factory', code)).not.toMatch(/No troubleshooting hint/);
    }
  });

  it('returns a dedicated hint for every known governor code', () => {
    for (const code of Object.values(GovernorErrorCode)) {
      if (typeof code !== 'number') continue;
      expect(getRecoveryHint('governor', code)).not.toMatch(/No troubleshooting hint/);
    }
  });

  it('falls back to the default hint for unknown codes', () => {
    expect(getRecoveryHint('stream', UNKNOWN_CONTRACT_ERROR_CODE)).toMatch(/No troubleshooting hint/);
    expect(getRecoveryHint('factory', 999)).toMatch(/No troubleshooting hint/);
  });

  it('scopes the same numeric code differently per contract', () => {
    // Code 1 means NotAuthorized on stream/governor but NotInitialized on factory.
    expect(getRecoveryHint('stream', 1)).toMatch(/calling account/i);
    expect(getRecoveryHint('factory', 1)).toMatch(/initialized/i);
  });
});

describe('ConduitError.recoveryHint (#967)', () => {
  it('is populated from the contract + code', () => {
    const err = new ConduitError('stream', StreamErrorCode.AlreadyInitialized);
    expect(err.recoveryHint).toBe(getRecoveryHint('stream', StreamErrorCode.AlreadyInitialized));
    expect(err.recoveryHint).toMatch(/one-time setup/);
  });

  it('is surfaced when parsing a HostError-style message', () => {
    const err = parseContractError('HostError(Error(Contract, #14))', 'stream');
    expect(err).toBeInstanceOf(ConduitError);
    expect((err as ConduitError).recoveryHint).toMatch(/one-time setup/);
  });
});

describe('ContractError.recoveryHint (#967)', () => {
  it('falls back to the default hint when the contract is ambiguous', () => {
    // Code 1 is defined by all three contracts, so parseContractError without
    // a `contract` hint returns a ContractError listing the candidates.
    const err = parseContractError('Error(Contract, #1)');
    expect(err).toBeInstanceOf(ContractError);
    expect((err as ContractError).recoveryHint).toMatch(/No troubleshooting hint/);
  });

  it('resolves a hint when both contract and code are known', () => {
    const err = new ContractError('Unknown code', 'factory', FactoryErrorCode.RateExceedsMax);
    expect(err.recoveryHint).toMatch(/max_rate_per_second/);
  });
});
