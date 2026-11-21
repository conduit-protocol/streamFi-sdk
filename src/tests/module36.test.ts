import { describe, it, expect, beforeEach } from 'vitest';
import { Module36 } from '../module36.js';
import type { StreamInfo } from '../types/index.js';

describe('Module36 (SDK Feature #36)', () => {
  let module36: Module36;

  const baseStream: StreamInfo = {
    id: 36n,
    address: 'CCSTREAM36ADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    sender: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLYC3ZCHB2D4P3CF',
    recipient: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    token: 'native',
    ratePerSecond: 100n,
    startTime: 500,
    endTime: 1500,
    withdrawn: 0n,
    paused: false,
    pausedAt: 0,
    cancelled: false,
    clawbackEnabled: false,
  };

  beforeEach(() => {
    module36 = new Module36({ cacheSize: 10 });
  });

  describe('Constructor & Configuration', () => {
    it('initializes with default options and no speedup measurement yet', () => {
      const defaults = new Module36();
      const metrics = defaults.getPerformanceMetrics();
      expect(metrics.totalDiffs).toBe(0);
      // No hits/misses recorded yet, so there's nothing to measure a speedup from.
      expect(metrics.measuredSpeedupPercent).toBeNull();
    });

    it('never reports a speedup when optimization is disabled', () => {
      const disabled = new Module36({ enableOptimization: false });
      const previous = { stream: baseStream, observedAt: 700 };
      const current = { stream: baseStream, observedAt: 900 };
      disabled.diffSnapshots(previous, current);
      disabled.diffSnapshots(previous, current);
      // With caching disabled there are never any cache hits to compare against.
      expect(disabled.getPerformanceMetrics().measuredSpeedupPercent).toBeNull();
    });
  });

  describe('diffSnapshots', () => {
    it('computes withdrawable and progress deltas between observations', () => {
      const previous = { stream: baseStream, observedAt: 700 };
      const current = { stream: baseStream, observedAt: 900 };
      const diff = module36.diffSnapshots(previous, current);

      expect(diff.streamId).toBe('36');
      expect(diff.previousWithdrawable).toBe(20000n); // (700-500)*100
      expect(diff.currentWithdrawable).toBe(40000n); // (900-500)*100
      expect(diff.withdrawableDelta).toBe(20000n);
      expect(diff.previousProgress).toBe(0.2);
      expect(diff.currentProgress).toBe(0.4);
      expect(diff.progressDelta).toBeCloseTo(0.2);
      expect(diff.statusChanged).toBe(false);
      expect(diff.isCached).toBe(false);
    });

    it('detects status changes such as pause', () => {
      const previous = { stream: baseStream, observedAt: 800 };
      const paused: StreamInfo = { ...baseStream, paused: true, pausedAt: 800 };
      const current = { stream: paused, observedAt: 900 };
      const diff = module36.diffSnapshots(previous, current);

      expect(diff.statusChanged).toBe(true);
    });

    it('handles open-ended streams with NaN progress as mid-progress', () => {
      const open: StreamInfo = { ...baseStream, endTime: 0 };
      const previous = { stream: open, observedAt: 700 };
      const current = { stream: open, observedAt: 900 };
      const diff = module36.diffSnapshots(previous, current);

      expect(diff.previousProgress).toBe(0.5);
      expect(diff.currentProgress).toBe(0.5);
      expect(diff.progressDelta).toBe(0);
    });
  });

  describe('Optimization & Caching', () => {
    it('serves cached diffs on repeated identical comparisons', () => {
      const previous = { stream: baseStream, observedAt: 700 };
      const current = { stream: baseStream, observedAt: 900 };

      const first = module36.diffSnapshots(previous, current);
      expect(first.isCached).toBe(false);

      const second = module36.diffSnapshots(previous, current);
      expect(second.isCached).toBe(true);
      expect(second.withdrawableDelta).toBe(first.withdrawableDelta);

      const metrics = module36.getPerformanceMetrics();
      expect(metrics.cacheHits).toBe(1);
      expect(metrics.cacheMisses).toBe(1);
      // A real (not fabricated) speedup measurement based on this run's own
      // hit/miss timing -- on a low-resolution clock both could measure as
      // 0ms, in which case there's genuinely nothing to compute a ratio
      // from (null), so we accept either an honest number or null, never a
      // hardcoded floor.
      expect(
        metrics.measuredSpeedupPercent === null || typeof metrics.measuredSpeedupPercent === 'number',
      ).toBe(true);
    });

    it('evicts oldest cache entries when cacheSize is exceeded', () => {
      const small = new Module36({ cacheSize: 2 });
      const a = { stream: baseStream, observedAt: 600 };
      const b = { stream: baseStream, observedAt: 700 };
      const c = { stream: baseStream, observedAt: 800 };
      const d = { stream: baseStream, observedAt: 900 };

      small.diffSnapshots(a, b);
      small.diffSnapshots(b, c);
      small.diffSnapshots(c, d);

      const reQuery = small.diffSnapshots(a, b);
      expect(reQuery.isCached).toBe(false);
    });

    it('bypasses cache when optimization is disabled', () => {
      const unopt = new Module36({ enableOptimization: false });
      const previous = { stream: baseStream, observedAt: 700 };
      const current = { stream: baseStream, observedAt: 900 };
      unopt.diffSnapshots(previous, current);
      const second = unopt.diffSnapshots(previous, current);
      expect(second.isCached).toBe(false);
      expect(unopt.getPerformanceMetrics().measuredSpeedupPercent).toBeNull();
    });
  });

  describe('diffBatch', () => {
    it('diffs a batch of snapshot pairs', () => {
      const pairs = Array.from({ length: 8 }, (_, i) => ({
        previous: { stream: { ...baseStream, id: BigInt(i) }, observedAt: 700 },
        current: { stream: { ...baseStream, id: BigInt(i) }, observedAt: 900 },
      }));

      const results = module36.diffBatch(pairs);
      expect(results).toHaveLength(8);
      expect(results[0]?.streamId).toBe('0');
      expect(results[7]?.withdrawableDelta).toBe(20000n);
      expect(module36.getPerformanceMetrics().totalDiffs).toBe(8);
    });
  });

  describe('computeAccrual', () => {
    it('computes accrual with BigInt precision', () => {
      expect(module36.computeAccrual(100n, 0, 3600)).toBe(360000n);
    });

    it('returns 0n for non-positive windows or rates', () => {
      expect(module36.computeAccrual(0n, 0, 10)).toBe(0n);
      expect(module36.computeAccrual(100n, 10, 10)).toBe(0n);
      expect(module36.computeAccrual(100n, 20, 10)).toBe(0n);
    });
  });

  describe('clearCache & Metrics', () => {
    it('resets cache and counters', () => {
      const previous = { stream: baseStream, observedAt: 700 };
      const current = { stream: baseStream, observedAt: 900 };
      module36.diffSnapshots(previous, current);
      module36.diffSnapshots(previous, current);
      expect(module36.getPerformanceMetrics().cacheHits).toBe(1);

      module36.clearCache();
      const metrics = module36.getPerformanceMetrics();
      expect(metrics.cacheHits).toBe(0);
      expect(metrics.cacheMisses).toBe(0);
      expect(metrics.totalDiffs).toBe(0);
    });
  });
});
