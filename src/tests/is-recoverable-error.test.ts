import { describe, it, expect } from 'vitest';
import {
  isRecoverableError, RateLimitError, RpcServiceUnavailableError, StreamFiNetworkError,
  IndexerTimeoutError, ConfirmationTimeoutError, CircuitOpenError, OperationAbortedError,
  SignatureTimeoutError, ValidationError, InsufficientBalanceError,
  StreamFiError, StreamNotFoundError,
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

describe('StreamFiError.isRecoverable (#1101)', () => {
  it('is true for transient SDK errors, so a UI can offer "Retry"', () => {
    const transient: StreamFiError[] = [
      new RateLimitError('slow down'),
      new RpcServiceUnavailableError('down'),
      new StreamFiNetworkError('net'),
      new IndexerTimeoutError('http://x', 10),
      new ConfirmationTimeoutError('h', 3, 100),
      new CircuitOpenError('http://x', null),
    ];
    for (const err of transient) {
      expect(err).toBeInstanceOf(StreamFiError);
      expect(err).toBeInstanceOf(Error);
      expect(err.isRecoverable).toBe(true);
    }
  });

  it('is false for logic, auth, validation and cancellation errors', () => {
    const permanent: StreamFiError[] = [
      new OperationAbortedError('op'),
      new SignatureTimeoutError(1),
      new ValidationError(['bad']),
      new InsufficientBalanceError(1n, 2n),
      new StreamNotFoundError(7n),
    ];
    for (const err of permanent) {
      expect(err).toBeInstanceOf(StreamFiError);
      expect(err.isRecoverable).toBe(false);
    }
  });

  it('always agrees with isRecoverableError', () => {
    const errors: StreamFiError[] = [
      new RateLimitError('slow down'),
      new ValidationError(['bad']),
      new StreamNotFoundError(1n),
    ];
    for (const err of errors) {
      expect(err.isRecoverable).toBe(isRecoverableError(err));
    }
  });

  it('is not an own enumerable property, so serialised errors are unchanged', () => {
    const err = new RateLimitError('slow down');
    expect(Object.keys(err)).not.toContain('isRecoverable');
  });
});
