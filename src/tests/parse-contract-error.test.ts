import { describe, it, expect } from 'vitest';
import {
  parseContractError,
  ContractError,
  ConduitError,
  StreamErrorCode,
  FactoryErrorCode,
  GovernorErrorCode,
  StreamNotFoundError,
  UnauthorizedStreamActionError,
  InvalidStreamStateError,
  ClawbackNotEnabledError,
  RateExceedsMaxError,
  DurationTooShortError,
  BackdatedStreamError,
  GovernorInvalidParamError,
  StreamFiNetworkError,
} from '../errors.js';

describe('parseContractError', () => {
  it('maps a host-error message to the contract-scoped ConduitError', () => {
    const err = parseContractError(
      new Error('HostError: Error(Contract, #3)'),
      'stream',
    );
    expect(err).toBeInstanceOf(ConduitError);
    expect((err as ConduitError).contract).toBe('stream');
    expect((err as ConduitError).code).toBe(StreamErrorCode.StreamCancelled);
    expect(err.message).toMatch(/cancelled/i);
  });

  it('maps a raw code object to the matching typed error class', () => {
    const err = parseContractError({ code: FactoryErrorCode.RateExceedsMax }, 'factory');
    expect(err).toBeInstanceOf(RateExceedsMaxError);
  });

  it('maps a governor InvalidParam code to GovernorInvalidParamError', () => {
    const err = parseContractError({ code: GovernorErrorCode.InvalidParam }, 'governor');
    expect(err).toBeInstanceOf(GovernorInvalidParamError);
  });

  it('maps factory duration/rate/backdated codes to their typed errors', () => {
    expect(parseContractError({ code: 9 }, 'factory')).toBeInstanceOf(DurationTooShortError);
    expect(parseContractError({ code: 6 }, 'factory')).toBeInstanceOf(BackdatedStreamError);
  });

  it('maps the stream clawback code to ClawbackNotEnabledError', () => {
    const err = parseContractError({ code: StreamErrorCode.ClawbackDisabled }, 'stream');
    expect(err).toBeInstanceOf(ClawbackNotEnabledError);
  });

  it('uses the context to build richer stream errors', () => {
    const notFound = parseContractError({ code: StreamErrorCode.StreamNotFound }, 'stream', {
      streamId: 42n,
    });
    expect(notFound).toBeInstanceOf(StreamNotFoundError);
    expect((notFound as StreamNotFoundError).streamId).toBe(42n);

    const unauthorized = parseContractError({ code: StreamErrorCode.NotAuthorized }, 'stream', {
      operation: 'cancel',
      caller: 'GABC',
    });
    expect(unauthorized).toBeInstanceOf(UnauthorizedStreamActionError);
    expect((unauthorized as UnauthorizedStreamActionError).operation).toBe('cancel');
    expect((unauthorized as UnauthorizedStreamActionError).caller).toBe('GABC');

    const badState = parseContractError({ code: StreamErrorCode.StreamEnded }, 'stream', {
      operation: 'withdraw',
    });
    expect(badState).toBeInstanceOf(InvalidStreamStateError);
    expect((badState as InvalidStreamStateError).currentState).toBe('ended');
  });

  it('falls back to ConduitError when the rich context is missing', () => {
    const err = parseContractError({ code: StreamErrorCode.StreamNotFound }, 'stream');
    expect(err).toBeInstanceOf(ConduitError);
    expect(err).not.toBeInstanceOf(StreamNotFoundError);
    expect(err.message).toMatch(/not found/i);
  });

  it('returns an already-typed contract error unchanged', () => {
    const original = new ClawbackNotEnabledError();
    expect(parseContractError(original, 'stream')).toBe(original);
  });

  it('returns non-contract errors unchanged', () => {
    const network = new StreamFiNetworkError('fetch failed');
    expect(parseContractError(network, 'stream')).toBe(network);

    const plain = new Error('something else');
    expect(parseContractError(plain)).toBe(plain);
  });

  it('resolves the contract automatically when only one catalogue defines the code', () => {
    // Stream code 14 is unique to the stream catalogue.
    const err = parseContractError({ code: 14 });
    expect(err).toBeInstanceOf(ConduitError);
    expect((err as ConduitError).contract).toBe('stream');
  });

  it('reports ambiguity instead of guessing when several contracts define the code', () => {
    // Code 1 exists on all three contracts with different meanings.
    const err = parseContractError({ code: 1 });
    expect(err).toBeInstanceOf(ContractError);
    expect((err as ContractError).code).toBe(1);
    expect(err.message).toMatch(/ambiguous/i);
  });

  it('reports an unknown code for the given contract', () => {
    const err = parseContractError({ code: 999 }, 'stream');
    expect(err).toBeInstanceOf(ContractError);
    expect((err as ContractError).code).toBe(999);
    expect(err.message).toMatch(/unknown/i);
  });

  it('extracts the code from a nested cause chain', () => {
    const inner = new Error('HostError: Error(Contract, #6)');
    const outer = new Error('wrapped', { cause: inner });
    const err = parseContractError(outer, 'stream');
    expect(err).toBeInstanceOf(ConduitError);
    expect((err as ConduitError).code).toBe(StreamErrorCode.NothingToWithdraw);
  });

  it('wraps a non-Error value that carries no contract code', () => {
    const err = parseContractError('just a string');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('just a string');
  });
});
