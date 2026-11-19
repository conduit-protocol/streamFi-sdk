import { describe, it, expect } from 'vitest';
import {
  isRecoverableError, RateLimitError, RpcServiceUnavailableError, StreamFiNetworkError,
  IndexerTimeoutError, ConfirmationTimeoutError, CircuitOpenError, OperationAbortedError,
  SignatureTimeoutError, ValidationError, InsufficientBalanceError,
} from '../errors.js';

describe('isRecoverableError', () => {
  it('treats transient SDK errors as recoverable', () => {
    expect(isRecoverableError(new RateLimitError('slow down'))).toBe(true);
    expect(isRecoverableError(new RpcServiceUnavailableError('down'))).toBe(true);
    expect(isRecoverableError(new StreamFiNetworkError('net'))).toBe(true);
    expect(isRecoverableError(new IndexerTimeoutError('http://x', 10))).toBe(true);
    expect(isRecoverableError(new ConfirmationTimeoutError('h', 3, 100))).toBe(true);
    expect(isRecoverableError(new CircuitOpenError('http://x', null))).toBe(true);
  });

  it('treats caller/contract/validation errors as non-recoverable', () => {
    expect(isRecoverableError(new OperationAbortedError('op'))).toBe(false);
    expect(isRecoverableError(new SignatureTimeoutError(1))).toBe(false);
    expect(isRecoverableError(new ValidationError(['bad']))).toBe(false);
    expect(isRecoverableError(new InsufficientBalanceError(1n, 2n))).toBe(false);
  });

  it('inspects HTTP status and codes', () => {
    expect(isRecoverableError({ status: 503 })).toBe(true);
    expect(isRecoverableError({ response: { status: 429 } })).toBe(true);
    expect(isRecoverableError({ response: { status: 400 } })).toBe(false);
    expect(isRecoverableError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRecoverableError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRecoverableError({ code: 502 })).toBe(true);
  });

  it('detects fetch network failures and follows cause', () => {
    expect(isRecoverableError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRecoverableError(new Error('wrapped', { cause: { code: 'ECONNREFUSED' } }))).toBe(true);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(isRecoverableError(abort)).toBe(false);
  });

  it('returns false for unknown values', () => {
    expect(isRecoverableError(null)).toBe(false);
    expect(isRecoverableError('boom')).toBe(false);
    expect(isRecoverableError(new Error('generic'))).toBe(false);
  });
});
