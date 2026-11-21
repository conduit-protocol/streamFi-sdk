import { describe, it, expect, vi } from 'vitest';
import { RateLimitError, RpcServiceUnavailableError } from '../errors.js';

describe('RateLimitError.fromRpcError', () => {
  it('detects an axios-style 429 response and returns a RateLimitError', () => {
    const axiosStyleError = {
      message: 'Request failed with status code 429',
      isAxiosError: true,
      response: {
        status: 429,
        headers: { 'retry-after': '2' },
        data: {},
      },
    };

    const result = RateLimitError.fromRpcError(axiosStyleError);
    expect(result).toBeInstanceOf(RateLimitError);
    expect(result).toBeInstanceOf(Error);
    expect(result?.name).toBe('RateLimitError');
    expect(result?.retryAfterMs).toBe(2000);
  });

  it('parses an HTTP-date Retry-After header into milliseconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T07:27:00.000Z'));

    const result = RateLimitError.fromRpcError({
      response: {
        status: 429,
        headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      },
    });

    expect(result).toBeInstanceOf(RateLimitError);
    expect(result?.retryAfterMs).toBe(60_000);

    vi.useRealTimers();
  });

  it('does not return NaN for past or invalid Retry-After values', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T07:29:00.000Z'));

    const pastDate = RateLimitError.fromRpcError({
      response: {
        status: 429,
        headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      },
    });
    const invalid = RateLimitError.fromRpcError({
      response: {
        status: 429,
        headers: { 'retry-after': 'not a date or delay' },
      },
    });

    expect(pastDate?.retryAfterMs).toBe(0);
    expect(invalid?.retryAfterMs).toBeUndefined();

    vi.useRealTimers();
  });

  it('classifies a 503 response as a distinct RpcServiceUnavailableError', () => {
    const serviceUnavailable = {
      message: 'Request failed with status code 503',
      response: {
        status: 503,
        headers: { 'retry-after': '10' },
        data: {},
      },
    };

    const result = RateLimitError.fromRpcError(serviceUnavailable);
    expect(result).toBeInstanceOf(RpcServiceUnavailableError);
    expect(result).toBeInstanceOf(Error);
    expect(result?.name).toBe('RpcServiceUnavailableError');
    expect((result as RpcServiceUnavailableError).retryAfterMs).toBe(10_000);
  });

  it('keeps 503 distinguishable from 429 for retry/failover decisions', () => {
    const r429 = RateLimitError.fromRpcError({ response: { status: 429 } });
    const r503 = RateLimitError.fromRpcError({ response: { status: 503 } });

    // A 429 is a RateLimitError (retry the same endpoint)…
    expect(r429).toBeInstanceOf(RateLimitError);
    // …while a 503 must NOT be, so backoff-and-retry loops keyed on
    // `instanceof RateLimitError` never retry a dead endpoint forever.
    expect(r503).not.toBeInstanceOf(RateLimitError);
    expect(r503).toBeInstanceOf(RpcServiceUnavailableError);
  });

  it('detects a raw JSON-RPC rate-limit error object (not an Error instance)', () => {
    const rawJsonRpcError = { code: -32029, message: 'Too many requests' };

    const result = RateLimitError.fromRpcError(rawJsonRpcError);
    expect(result).toBeInstanceOf(RateLimitError);
    expect(result?.name).toBe('RateLimitError');
  });

  it('returns null for a non-rate-limit error, leaving it to be handled elsewhere', () => {
    const unrelatedError = new Error('Simulation failed: some contract error');
    expect(RateLimitError.fromRpcError(unrelatedError)).toBeNull();
  });

  it('returns null for a plain 500 server error', () => {
    const serverError = {
      message: 'Request failed with status code 500',
      response: { status: 500, headers: {}, data: {} },
    };
    expect(RateLimitError.fromRpcError(serverError)).toBeNull();
  });
});
