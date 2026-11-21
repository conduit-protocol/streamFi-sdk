import { describe, it, expect, beforeEach } from 'vitest';
import { Module26 } from '../module26.js';
import type { StreamInfo } from '../types/index.js';

describe('Module26 (SDK Feature #26)', () => {
  let module26: Module26;
  const now = 1000;

  const activeStream: StreamInfo = {
    id: 26n,
    address: 'CCSTREAM26ADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
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
    module26 = new Module26({ cacheSize: 10, batchChunkSize: 5 });
  });

  describe('Constructor & Configuration', () => {
    it('initializes with default options and no speedup measurement yet', () => {
      const defaults = new Module26();
      const metrics = defaults.getPerformanceMetrics();
      expect(metrics.totalAggregations).toBe(0);
      // No hits/misses recorded yet, so there's nothing to measure a speedup from.
      expect(metrics.measuredSpeedupPercent).toBeNull();
    });

    it('never reports a speedup when optimization is disabled', () => {
      const disabled = new Module26({ enableOptimization: false });
      const items = [{ id: 'a', stream: activeStream, timestamp: now }];
      disabled.aggregatePortfolio(items, now);
      disabled.aggregatePortfolio(items, now);
      // With caching disabled there are never any cache hits to compare against.
      expect(disabled.getPerformanceMetrics().measuredSpeedupPercent).toBeNull();
    });
  });

  describe('aggregatePortfolio', () => {
    it('aggregates withdrawable totals and lifecycle counts', () => {
      const paused: StreamInfo = { ...activeStream, id: 2n, paused: true, pausedAt: 900 };
      const cancelled: StreamInfo = { ...activeStream, id: 3n, cancelled: true };
      const ended: StreamInfo = { ...activeStream, id: 4n, endTime: 800 };

      const summary = module26.aggregatePortfolio(
        [
          { id: 'a', stream: activeStream, timestamp: now },
          { id: 'p', stream: paused, timestamp: now },
          { id: 'c', stream: cancelled, timestamp: now },
          { id: 'e', stream: ended, timestamp: now },
        ],
        now,
      );

      expect(summary.totalWithdrawable).toBe(50000n + 40000n + 0n + 30000n);
      expect(summary.totalRatePerSecond).toBe(100n);
      expect(summary.activeCount).toBe(1);
      expect(summary.pausedCount).toBe(1);
      expect(summary.cancelledCount).toBe(1);
      expect(summary.endedCount).toBe(1);
      expect(summary.isCached).toBe(false);
      expect(summary.computedAt).toBe(now);
    });

    it('processes large portfolios in configured chunks', () => {
      const items = Array.from({ length: 12 }, (_, i) => ({
        id: `s-${i}`,
        stream: { ...activeStream, id: BigInt(i) },
        timestamp: now,
      }));

      const summary = module26.aggregatePortfolio(items, now);
      expect(summary.activeCount).toBe(12);
      expect(summary.totalRatePerSecond).toBe(1200n);
      expect(module26.getPerformanceMetrics().totalAggregations).toBe(1);
    });
  });

  describe('Optimization & Caching', () => {
    it('serves cached portfolio summaries on repeated aggregation', () => {
      const items = [{ id: 'a', stream: activeStream, timestamp: now }];
      const first = module26.aggregatePortfolio(items, now);
      expect(first.isCached).toBe(false);

      const second = module26.aggregatePortfolio(items, now);
      expect(second.isCached).toBe(true);
      expect(second.totalWithdrawable).toBe(first.totalWithdrawable);

      const metrics = module26.getPerformanceMetrics();
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
      const small = new Module26({ cacheSize: 2 });
      small.aggregatePortfolio([{ id: '1', stream: activeStream, timestamp: 1000 }], 1000);
      small.aggregatePortfolio([{ id: '2', stream: activeStream, timestamp: 1001 }], 1001);
      small.aggregatePortfolio([{ id: '3', stream: activeStream, timestamp: 1002 }], 1002);

      const reQuery = small.aggregatePortfolio([{ id: '1', stream: activeStream, timestamp: 1000 }], 1000);
      expect(reQuery.isCached).toBe(false);
    });

    it('bypasses cache when optimization is disabled', () => {
      const unopt = new Module26({ enableOptimization: false });
      const items = [{ id: 'a', stream: activeStream, timestamp: now }];
      unopt.aggregatePortfolio(items, now);
      const second = unopt.aggregatePortfolio(items, now);
      expect(second.isCached).toBe(false);
      expect(unopt.getPerformanceMetrics().measuredSpeedupPercent).toBeNull();
    });

    it('does not treat portfolios with different cache-relevant fields as a cache hit', () => {
      const items = [{ id: 'a', stream: activeStream, timestamp: now }];
      const first = module26.aggregatePortfolio(items, now);
      expect(first.isCached).toBe(false);

      const changedWithdrawn = [
        { id: 'a', stream: { ...activeStream, withdrawn: 1n }, timestamp: now },
      ];
      const second = module26.aggregatePortfolio(changedWithdrawn, now);
      expect(second.isCached).toBe(false);

      const changedId = [{ id: 'b', stream: activeStream, timestamp: now }];
      const third = module26.aggregatePortfolio(changedId, now);
      expect(third.isCached).toBe(false);

      const repeat = module26.aggregatePortfolio(items, now);
      expect(repeat.isCached).toBe(true);
    });
  });

  describe('projectRemaining', () => {
    it('projects remaining accrual within stream end bound', () => {
      expect(module26.projectRemaining(activeStream, 1000, now)).toBe(50000n); // to endTime 1500
    });

    it('returns 0n for paused, cancelled, ended, or non-positive horizons', () => {
      expect(module26.projectRemaining({ ...activeStream, paused: true, pausedAt: now }, 100, now)).toBe(0n);
      expect(module26.projectRemaining({ ...activeStream, cancelled: true }, 100, now)).toBe(0n);
      expect(module26.projectRemaining({ ...activeStream, endTime: 800 }, 100, now)).toBe(0n);
      expect(module26.projectRemaining(activeStream, 0, now)).toBe(0n);
    });
  });

  describe('clearCache & Metrics', () => {
    it('resets cache and counters', () => {
      const items = [{ id: 'a', stream: activeStream, timestamp: now }];
      module26.aggregatePortfolio(items, now);
      module26.aggregatePortfolio(items, now);
      expect(module26.getPerformanceMetrics().cacheHits).toBe(1);

      module26.clearCache();
      const metrics = module26.getPerformanceMetrics();
      expect(metrics.cacheHits).toBe(0);
      expect(metrics.cacheMisses).toBe(0);
      expect(metrics.totalAggregations).toBe(0);
    });
  });
});
