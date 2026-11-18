/**
 * FeeEstimator.getLedgerFeeStats() (#960) — percentile-based gas price
 * estimation from Horizon's /fee_stats, as an alternative to
 * getDynamicFee()'s fixed-multiplier-on-modal-fee approach.
 */

import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_FEE_CACHE_TTL_MS, FeeEstimator } from '../fee-estimator.js';

const feeStats = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    fee_charged: { mode: '100', p75: '250', p95: '900', ...(overrides.fee_charged as object ?? {}) },
    last_ledger_base_fee: '100',
    ...overrides,
  }),
});

describe('FeeEstimator.getLedgerFeeStats', () => {
  it('returns p75/p95 parsed as bigint stroops', async () => {
    const fetchMock = vi.fn().mockResolvedValue(feeStats());
    const est = new FeeEstimator(100n, { fetch: fetchMock as never, horizonUrl: 'https://h.test/', feeMultiplier: 1 });

    const stats = await est.getLedgerFeeStats();
    expect(stats.p75).toBe(250n);
    expect(stats.p95).toBe(900n);
    expect(fetchMock).toHaveBeenCalledWith('https://h.test/fee_stats');
  });

  it('applies the configured feeMultiplier buffer to both percentiles', async () => {
    const fetchMock = vi.fn().mockResolvedValue(feeStats());
    const est = new FeeEstimator(100n, { fetch: fetchMock as never, feeMultiplier: 1.2 });

    const stats = await est.getLedgerFeeStats();
    expect(stats.p75).toBe(300n); // 250 * 1.2
    expect(stats.p95).toBe(1080n); // 900 * 1.2
  });

  it('falls back to the modal fee when percentiles are absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ fee_charged: { mode: '150' } }),
    });
    const est = new FeeEstimator(100n, { fetch: fetchMock as never, feeMultiplier: 1 });

    const stats = await est.getLedgerFeeStats();
    expect(stats.p75).toBe(150n);
    expect(stats.p95).toBe(150n);
  });

  it('caches within the TTL window — a second call does not refetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(feeStats());
    const est = new FeeEstimator(100n, { fetch: fetchMock as never, feeMultiplier: 1 });

    await est.getLedgerFeeStats();
    await est.getLedgerFeeStats();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent in-flight requests into a single fetch', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise(resolve => { resolveFetch = resolve; }),
    );
    const est = new FeeEstimator(100n, { fetch: fetchMock as never, feeMultiplier: 1 });

    const first = est.getLedgerFeeStats();
    const second = est.getLedgerFeeStats();
    resolveFetch(feeStats());

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws and reports the error when there is no prior successful fetch to fall back to', async () => {
    const onError = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const est = new FeeEstimator(100n, { fetch: fetchMock as never, feeMultiplier: 1 });

    await expect(est.getLedgerFeeStats({ onError })).rejects.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it('falls back to the last known stats when a later fetch fails after the cache goes stale', async () => {
    vi.useFakeTimers();
    try {
      const onError = vi.fn();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(feeStats())
        .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
      const est = new FeeEstimator(100n, { fetch: fetchMock as never, feeMultiplier: 1 });

      const first = await est.getLedgerFeeStats();
      expect(first.p75).toBe(250n);

      vi.advanceTimersByTime(DEFAULT_FEE_CACHE_TTL_MS + 1); // past the default cache TTL

      const second = await est.getLedgerFeeStats({ onError });
      expect(second).toEqual(first);
      expect(onError).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
