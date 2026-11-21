import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_FEE_CACHE_TTL_MS, FeeEstimator } from '../fee-estimator.js';

/**
 * #1074 — fee estimates are reused for a short, configurable TTL so several
 * transactions assembled together share one network lookup.
 */
describe('FeeEstimator - cache TTL (#1074)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses a keyed estimate for the default 5s TTL, then refetches', async () => {
    vi.useFakeTimers();
    const est = new FeeEstimator(100n);
    const fetcher = vi.fn().mockResolvedValue(500n);

    expect(DEFAULT_FEE_CACHE_TTL_MS).toBe(5_000);
    expect(await est.estimateFee(fetcher, { cacheKey: 'op' })).toBe(500n);
    vi.advanceTimersByTime(DEFAULT_FEE_CACHE_TTL_MS - 1);
    expect(await est.estimateFee(fetcher, { cacheKey: 'op' })).toBe(500n);
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    await est.estimateFee(fetcher, { cacheKey: 'op' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('honours a custom cacheTtlMs', async () => {
    vi.useFakeTimers();
    const est = new FeeEstimator(100n, { cacheTtlMs: 10_000 });
    const fetcher = vi.fn().mockResolvedValue(500n);

    await est.estimateFee(fetcher, { cacheKey: 'op' });
    vi.advanceTimersByTime(9_999);
    await est.estimateFee(fetcher, { cacheKey: 'op' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refetches every time when cacheTtlMs is 0', async () => {
    const est = new FeeEstimator(100n, { cacheTtlMs: 0 });
    const fetcher = vi.fn().mockResolvedValue(500n);

    await est.estimateFee(fetcher, { cacheKey: 'op' });
    await est.estimateFee(fetcher, { cacheKey: 'op' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shares one Horizon request across dynamic-fee calls inside the TTL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ fee_charged: { mode: '200' } }),
    });
    const est = new FeeEstimator(100n, { fetch: fetchMock as never, feeMultiplier: 1 });

    await est.getDynamicFee({ priority: 'low' });
    await est.getDynamicFee({ priority: 'low' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a negative or non-finite cacheTtlMs', () => {
    expect(() => new FeeEstimator(100n, { cacheTtlMs: -1 })).toThrow('Invalid cacheTtlMs');
    expect(() => new FeeEstimator(100n, { cacheTtlMs: NaN })).toThrow('Invalid cacheTtlMs');
  });
});
