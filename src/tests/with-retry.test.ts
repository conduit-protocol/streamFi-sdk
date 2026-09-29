import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, isTransientRpcError } from '../with-retry.js';
import {
  RateLimitError,
  StreamFiNetworkError,
  RpcServiceUnavailableError,
  CircuitOpenError,
} from '../errors.js';
import { recordFailure, resetCircuit } from '../rpc-circuit-state.js';

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately on success', async () => {
    const operation = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries on RateLimitError and honours Retry-After', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError('slow down', 2_000))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(operation);
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(1_999);
    expect(operation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('falls back to exponential backoff when no Retry-After is present', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError('slow down'))
      .mockRejectedValueOnce(new RateLimitError('still slow'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(operation, { baseDelayMs: 100, backoffFactor: 2 });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(99);
    expect(operation).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(199);
    expect(operation).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const err = new RateLimitError('slow down');
    const operation = vi.fn().mockRejectedValue(err);

    const promise = withRetry(operation, { maxRetries: 2, baseDelayMs: 10 });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toBe(err);
    expect(operation).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('throws non-retryable errors immediately', async () => {
    const err = new Error('boom');
    const operation = vi.fn().mockRejectedValue(err);

    await expect(withRetry(operation)).rejects.toBe(err);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('respects a custom shouldRetry predicate', async () => {
    const err = new Error('transient');
    const operation = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(operation, {
      shouldRetry: (e) => e instanceof Error && e.message === 'transient',
      baseDelayMs: 50,
    });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBe('ok');
  });

  it('caps the delay at maxDelayMs', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError('1'))
      .mockRejectedValueOnce(new RateLimitError('2'))
      .mockRejectedValueOnce(new RateLimitError('3'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(operation, {
      baseDelayMs: 100,
      backoffFactor: 10,
      maxDelayMs: 500,
    });
    promise.catch(() => {});

    // First retry: 100 ms
    await vi.advanceTimersByTimeAsync(100);
    expect(operation).toHaveBeenCalledTimes(2);

    // Second retry would be 1000 ms, but capped to 500 ms
    await vi.advanceTimersByTimeAsync(499);
    expect(operation).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(3);

    // Third retry also capped to 500 ms
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it('calls onRetry before each retry', async () => {
    const onRetry = vi.fn();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError('slow'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(operation, {
      baseDelayMs: 100,
      onRetry,
    });
    promise.catch(() => {});

    expect(onRetry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      delayMs: 100,
      error: expect.any(RateLimitError),
    });

    await expect(promise).resolves.toBe('ok');
  });

  it('can be aborted before the first attempt', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      withRetry(vi.fn().mockResolvedValue('ok'), { signal: controller.signal }),
    ).rejects.toThrow('withRetry aborted before first attempt');
  });

  it('can be aborted while waiting to retry', async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValue(new RateLimitError('slow'));

    const promise = withRetry(operation, {
      signal: controller.signal,
      baseDelayMs: 100,
    });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(50);
    controller.abort();

    await expect(promise).rejects.toThrow('withRetry sleep aborted');
  });

  it('applies full jitter within the delay window', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const operation = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError('slow'))
      .mockResolvedValueOnce('ok');

    const onRetry = vi.fn();
    const promise = withRetry(operation, {
      baseDelayMs: 100,
      jitter: 'full',
      onRetry,
    });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBe('ok');

    // full jitter: Math.floor(0.5 * (100 + 1)) = 50
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 50 }),
    );

    vi.restoreAllMocks();
  });

  it('applies equal jitter around half the delay', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const operation = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError('slow'))
      .mockResolvedValueOnce('ok');

    const onRetry = vi.fn();
    const promise = withRetry(operation, {
      baseDelayMs: 100,
      jitter: 'equal',
      onRetry,
    });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(75);
    await expect(promise).resolves.toBe('ok');

    // equal jitter: Math.floor(50 + 0.5 * 50) = 75
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 75 }),
    );

    vi.restoreAllMocks();
  });
});

describe('withRetry — circuitScope', () => {
  const scope = 'https://rpc.example.test';

  beforeEach(() => {
    vi.useFakeTimers();
    resetCircuit(scope);
  });

  afterEach(() => {
    resetCircuit(scope);
    vi.useRealTimers();
  });

  it('fails fast with CircuitOpenError when the scope circuit is open, without calling the operation', async () => {
    for (let i = 0; i < 5; i += 1) {
      recordFailure(scope, { threshold: 5, cooldownMs: 30_000 });
    }

    const operation = vi.fn().mockResolvedValue('ok');

    await expect(
      withRetry(operation, { circuitScope: scope }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(operation).not.toHaveBeenCalled();
  });

  it('proceeds normally when the scope circuit is closed', async () => {
    const operation = vi.fn().mockResolvedValue('ok');

    await expect(
      withRetry(operation, { circuitScope: scope }),
    ).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('ignores circuit state when circuitScope is not provided', async () => {
    for (let i = 0; i < 5; i += 1) {
      recordFailure(scope, { threshold: 5, cooldownMs: 30_000 });
    }

    const operation = vi.fn().mockResolvedValue('ok');

    await expect(withRetry(operation)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('proceeds normally once the circuit has moved to half-open after cooldown', async () => {
    for (let i = 0; i < 5; i += 1) {
      recordFailure(scope, { threshold: 5, cooldownMs: 30_000 });
    }

    await vi.advanceTimersByTimeAsync(30_000);

    const operation = vi.fn().mockResolvedValue('ok');

    await expect(
      withRetry(operation, { circuitScope: scope }),
    ).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('isTransientRpcError', () => {
  it('matches transient RPC error classes', () => {
    expect(isTransientRpcError(new RateLimitError('slow'))).toBe(true);
    expect(isTransientRpcError(new StreamFiNetworkError('offline'))).toBe(true);
    expect(
      isTransientRpcError(new RpcServiceUnavailableError('down')),
    ).toBe(true);
    expect(isTransientRpcError(new Error('boom'))).toBe(false);
  });
});
