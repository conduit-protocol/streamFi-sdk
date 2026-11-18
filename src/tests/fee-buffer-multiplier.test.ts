import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_FEE_MULTIPLIER, FeeEstimator } from '../fee-estimator.js';

const stats = (mode: string) => ({ ok: true, status: 200, json: async () => ({ fee_charged: { mode }, last_ledger_base_fee: '100' }) });

describe('FeeEstimator - fee buffer multiplier (#907)', () => {
  it('applies a 20% buffer by default (#1073)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(stats('200'));
    const est = new FeeEstimator(100n, { fetch: fetchMock as never, horizonUrl: 'https://h.test/' });
    // low priority => base 200n; default 1.2x buffer => 240n
    expect(DEFAULT_FEE_MULTIPLIER).toBe(1.2);
    expect(await est.getDynamicFee({ priority: 'low' })).toBe(240n);
  });

  it('leaves the fee unchanged when feeMultiplier is 1', async () => {
    const fetchMock = vi.fn().mockResolvedValue(stats('200'));
    const est = new FeeEstimator(100n, { fetch: fetchMock as never, horizonUrl: 'https://h.test/', feeMultiplier: 1 });
    // low priority => base 200n, no buffer => 200n
    expect(await est.getDynamicFee({ priority: 'low' })).toBe(200n);
  });

  it('adds a 20% buffer when feeMultiplier is 1.2', async () => {
    const fetchMock = vi.fn().mockResolvedValue(stats('200'));
    const est = new FeeEstimator(100n, { fetch: fetchMock as never, horizonUrl: 'https://h.test/', feeMultiplier: 1.2 });
    // low priority => 200n base; 20% buffer => ceil(200 * 1.2) = 240n
    expect(await est.getDynamicFee({ priority: 'low' })).toBe(240n);
  });

  it('applies the buffer on top of priority multipliers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(stats('200'));
    const est = new FeeEstimator(100n, { fetch: fetchMock as never, horizonUrl: 'https://h.test/', feeMultiplier: 1.5 });
    // urgent => 600n base; 50% buffer => ceil(600 * 1.5) = 900n
    expect(await est.getDynamicFee({ priority: 'urgent' })).toBe(900n);
  });

  it('rejects a feeMultiplier below 1', () => {
    expect(() => new FeeEstimator(100n, { feeMultiplier: 0.5 })).toThrow('Invalid feeMultiplier');
  });

  it('rejects a non-finite feeMultiplier', () => {
    expect(() => new FeeEstimator(100n, { feeMultiplier: NaN })).toThrow('Invalid feeMultiplier');
  });
});
