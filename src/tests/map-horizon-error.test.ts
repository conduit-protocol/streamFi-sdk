import { describe, it, expect } from 'vitest';
import {
  mapHorizonError,
  BadAuthError,
  HorizonTransactionError,
  InsufficientBalanceError,
} from '../errors.js';
import { mapHorizonError as mapHorizonErrorFromRelayer } from '../relayer/ErrorMapper.js';

function horizonBody(transaction: string, operations?: string[]) {
  return {
    type: 'https://stellar.org/horizon-errors/transaction_failed',
    title: 'Transaction Failed',
    status: 400,
    detail: 'The transaction failed.',
    extras: {
      envelope_xdr: 'AAAA...',
      result_codes: { transaction, operations },
      result_xdr: 'AAAA...',
    },
  };
}

describe('mapHorizonError (#975)', () => {
  it('maps tx_bad_auth to BadAuthError', () => {
    const err = mapHorizonError(horizonBody('tx_bad_auth'));
    expect(err).toBeInstanceOf(BadAuthError);
    expect((err as BadAuthError).resultCodes.transaction).toBe('tx_bad_auth');
  });

  it('maps op_bad_auth (inside a tx_failed envelope) to BadAuthError', () => {
    const err = mapHorizonError(horizonBody('tx_failed', ['op_success', 'op_bad_auth']));
    expect(err).toBeInstanceOf(BadAuthError);
    expect((err as BadAuthError).resultCodes.operations).toEqual(['op_success', 'op_bad_auth']);
  });

  it('maps op_underfunded to InsufficientBalanceError', () => {
    const err = mapHorizonError(horizonBody('tx_failed', ['op_underfunded']));
    expect(err).toBeInstanceOf(InsufficientBalanceError);
  });

  it('maps tx_insufficient_balance to InsufficientBalanceError', () => {
    const err = mapHorizonError(horizonBody('tx_insufficient_balance'));
    expect(err).toBeInstanceOf(InsufficientBalanceError);
  });

  it('maps an unrecognised but present result code to HorizonTransactionError', () => {
    const err = mapHorizonError(horizonBody('tx_bad_seq'));
    expect(err).toBeInstanceOf(HorizonTransactionError);
    expect((err as HorizonTransactionError).resultCodes.transaction).toBe('tx_bad_seq');
    expect((err as HorizonTransactionError).raw).toBeDefined();
  });

  it('unwraps an axios-style { response: { data } } error', () => {
    const axiosLike = { response: { data: horizonBody('tx_bad_auth') } };
    const err = mapHorizonError(axiosLike);
    expect(err).toBeInstanceOf(BadAuthError);
  });

  it('unwraps a fetch-style { data } error', () => {
    const fetchLike = { data: horizonBody('op_underfunded' as unknown as string, ['op_underfunded']) };
    const err = mapHorizonError(fetchLike);
    expect(err).toBeInstanceOf(InsufficientBalanceError);
  });

  it('returns the original Error unchanged when there are no result codes (e.g. network failure)', () => {
    const networkErr = new Error('fetch failed');
    expect(mapHorizonError(networkErr)).toBe(networkErr);
  });

  it('wraps a non-Error, non-Horizon value in a plain Error', () => {
    const err = mapHorizonError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom');
  });

  it('is also importable from relayer/ErrorMapper.js (#975 target file)', () => {
    expect(mapHorizonErrorFromRelayer(horizonBody('tx_bad_auth'))).toBeInstanceOf(BadAuthError);
  });
});
