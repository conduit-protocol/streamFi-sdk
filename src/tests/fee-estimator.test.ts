import { describe, it, expect, vi } from 'vitest';
import { FeeEstimator } from '../fee-estimator.js';

describe('FeeEstimator - Race condition and edge cases', () => {
  it('should gracefully handle 100+ rapid simultaneous requests without race conditions', async () => {
    const estimator = new FeeEstimator(100n);

    // Simulate network latency and a fetcher
    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount++;
      // Exceeds Number.MAX_SAFE_INTEGER — only representable exactly as a
      // bigint, demonstrating the precision floating-point math used to lose.
      return new Promise<bigint>((resolve) => {
        setTimeout(() => resolve(9007199254740993n), 50); // Artificially introduce network latency
      });
    };

    // Trigger 150 rapid requests simultaneously
    const promises = [];
    for (let i = 0; i < 150; i++) {
      promises.push(estimator.estimateFee(fetcher));
    }

    const results = await Promise.all(promises);

    // Assert that the network fetch was only performed once due to the locking mechanism
    expect(fetchCount).toBe(1);

    // Assert that all returned values are exact — no floating-point rounding.
    results.forEach(res => {
      expect(res).toBe(9007199254740993n);
    });

    expect(estimator.getBaseFee()).toBe(9007199254740993n);
    expect(estimator.lastSuccessfulFetchAt).toEqual(expect.any(Number));
    expect(estimator.lastError).toBeNull();
    expect(estimator.isStale).toBe(false);
  });

  it('should surface the specific error when falling back after network failure', async () => {
    const estimator = new FeeEstimator(100n);
    const onError = vi.fn();

    const failingFetcher = async (): Promise<bigint> => {
      throw new Error('Network error');
    };

    const fee = await estimator.estimateFee(failingFetcher, { onError });

    // Fallback should return the original base fee
    expect(fee).toBe(100n);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]![0].message).toBe('Network error');
    expect(estimator.lastError?.message).toBe('Network error');
    expect(estimator.lastSuccessfulFetchAt).toBeNull();
    expect(estimator.isStale).toBe(true);
  });

  it('should expose stale state when invalid math falls back', async () => {
    const estimator = new FeeEstimator(100n);
    const onError = vi.fn();

    // Simulates a misbehaving network fetcher returning a non-bigint value
    // at runtime, despite the declared bigint-returning contract.
    const badMathFetcher = async () => NaN as unknown as bigint;

    const fee = await estimator.estimateFee(badMathFetcher, { onError });
    // Boundary checks should catch this and fallback
    expect(fee).toBe(100n);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0].message).toBe('Invalid network fee response');
    expect(estimator.lastError?.message).toBe('Invalid network fee response');
    expect(estimator.isStale).toBe(true);
  });

  it('should handle multiple sequential requests successfully', async () => {
    const estimator = new FeeEstimator(100n);

    const fetcher1 = async () => 120n;
    const fetcher2 = async () => 130n;

    const fee1 = await estimator.estimateFee(fetcher1);
    expect(fee1).toBe(120n);

    const fee2 = await estimator.estimateFee(fetcher2);
    expect(fee2).toBe(130n);
    expect(estimator.isStale).toBe(false);
  });

  it('should clear stale status after a later successful fetch', async () => {
    const estimator = new FeeEstimator(100n);

    await estimator.estimateFee(async () => {
      throw new Error('temporary outage');
    });
    expect(estimator.isStale).toBe(true);
    expect(estimator.lastError?.message).toBe('temporary outage');

    const recoveredFee = await estimator.estimateFee(async () => 140n);
    expect(recoveredFee).toBe(140n);
    expect(estimator.lastError).toBeNull();
    expect(estimator.lastSuccessfulFetchAt).toEqual(expect.any(Number));
    expect(estimator.isStale).toBe(false);
  });

  it('caches successful estimates independently by operation key for three seconds', async () => {
    const estimator = new FeeEstimator(100n);
    const fetcher = vi.fn(async () => 140n);

    await estimator.estimateFee(fetcher, { cacheKey: 'withdraw:1' });
    await estimator.estimateFee(fetcher, { cacheKey: 'withdraw:1' });
    await estimator.estimateFee(fetcher, { cacheKey: 'withdraw:2' });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not share in-flight estimates across different operation keys', async () => {
    const estimator = new FeeEstimator(100n);
    let releaseFirst: (fee: bigint) => void = () => {};
    const first = new Promise<bigint>(resolve => { releaseFirst = resolve; });

    const firstRequest = estimator.estimateFee(() => first, { cacheKey: 'create:a' });
    const secondRequest = estimator.estimateFee(async () => 220n, { cacheKey: 'create:b' });
    releaseFirst(110n);

    await expect(firstRequest).resolves.toBe(110n);
    await expect(secondRequest).resolves.toBe(220n);
  });
});
