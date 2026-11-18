import { describe, it, expect, vi } from 'vitest';
import { FeeEstimator } from '../fee-estimator.js';

const stats = (mode: string) => ({ ok: true, status: 200, json: async () => ({ fee_charged: { mode }, last_ledger_base_fee: '100' }) });

describe('FeeEstimator.getDynamicFee', () => {
  it('applies priority multipliers to the modal fee', async () => {
    const fetchMock = vi.fn().mockResolvedValue(stats('200'));
    const est = new FeeEstimator(100n, { fetch: fetchMock as never, horizonUrl: 'https://h.test/' });
    expect(await est.getDynamicFee({ priority: 'low' })).toBe(200n);
    expect(await est.getDynamicFee({ priority: 'standard' })).toBe(300n);
    expect(await est.getDynamicFee({ priority: 'urgent' })).toBe(600n);
    expect(fetchMock).toHaveBeenCalledWith('https://h.test/fee_stats');
  });

  it('falls back to the last known fee on network failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const onError = vi.fn();
    const est = new FeeEstimator(150n, { fetch: fetchMock as never });
    expect(await est.getDynamicFee({ onError })).toBe(150n);
    expect(onError).toHaveBeenCalled();
  });

  it('rejects multipliers below 1', async () => {
    const est = new FeeEstimator(100n, { fetch: vi.fn() as never });
    await expect(est.getDynamicFee({ priority: 0.5 })).rejects.toThrow('Invalid fee priority');
  });
});
