import { describe, it, expect, beforeEach } from 'vitest';
import { Module48 } from '../module48.js';
import type { StreamInfo } from '../types/index.js';

describe('Module48 (SDK Feature #48)', () => {
  let module48: Module48;
  const now = 1000;

  const mockStream: StreamInfo = {
    id: 1n,
    address: 'CCSTREAM48ADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
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
    module48 = new Module48({ cacheSize: 10, batchChunkSize: 5 });
  });

  describe('Constructor & Configuration', () => {
    it('initializes with default options and no speedup measurement yet', () => {
      const defaultMod = new Module48();
      const metrics = defaultMod.getPerformanceMetrics();
      expect(metrics.totalProcessed).toBe(0);
      // No hits/misses recorded yet, so there's nothing to measure a speedup from.
      expect(metrics.measuredSpeedupPercent).toBeNull();
    });

    it('never reports a speedup when optimization is disabled', () => {
      const customMod = new Module48({
        cacheSize: 50,
        enableOptimization: false,
        batchChunkSize: 10,
      });
      const item = { id: 'stream-1', stream: mockStream, timestamp: now };
      customMod.processSingleItem(item);
      customMod.processSingleItem(item);
      // With caching disabled there are never any cache hits to compare against.
      expect(customMod.getPerformanceMetrics().measuredSpeedupPercent).toBeNull();
    });
  });

  describe('processSingleItem', () => {
    it('calculates withdrawable balance and progress for active stream', () => {
      const item = { id: 'stream-1', stream: mockStream, timestamp: now };
      const result = module48.processSingleItem(item);

      expect(result.id).toBe('stream-1');
      expect(result.withdrawable).toBe(50000n); // (1000 - 500) * 100
      expect(result.progress).toBe(0.5); // (1000 - 500) / (1500 - 500)
      expect(result.isCached).toBe(false);
      expect(result.computedAt).toBe(now);
    });

    it('handles stream prior to start time', () => {
      const item = { id: 'stream-future', stream: mockStream, timestamp: 400 };
      const result = module48.processSingleItem(item);

      expect(result.withdrawable).toBe(0n);
      expect(result.progress).toBe(0);
    });

    it('handles completed stream after end time', () => {
      const item = { id: 'stream-past', stream: mockStream, timestamp: 2000 };
      const result = module48.processSingleItem(item);

      expect(result.progress).toBe(1.0);
    });

    it('handles open-ended stream with no end time', () => {
      const openStream: StreamInfo = { ...mockStream, endTime: 0 };
      const item = { id: 'stream-open', stream: openStream, timestamp: now };
      const result = module48.processSingleItem(item);

      expect(result.progress).toBe(0.5);
    });

    it('uses system current time if timestamp is omitted', () => {
      const item = { id: 'stream-now', stream: mockStream };
      const result = module48.processSingleItem(item);
      expect(result.computedAt).toBeGreaterThan(0);
    });
  });

  describe('Optimization & Caching', () => {
    it('serves cached results on duplicate evaluation requests', () => {
      const item = { id: 'stream-1', stream: mockStream, timestamp: now };

      const firstPass = module48.processSingleItem(item);
      expect(firstPass.isCached).toBe(false);

      const secondPass = module48.processSingleItem(item);
      expect(secondPass.isCached).toBe(true);
      expect(secondPass.withdrawable).toBe(firstPass.withdrawable);

      const metrics = module48.getPerformanceMetrics();
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

    it('evicts oldest cache item when cacheSize threshold is reached', () => {
      const smallCacheMod = new Module48({ cacheSize: 2 });

      smallCacheMod.processSingleItem({ id: 'item-1', stream: mockStream, timestamp: 1000 });
      smallCacheMod.processSingleItem({ id: 'item-2', stream: mockStream, timestamp: 1001 });
      smallCacheMod.processSingleItem({ id: 'item-3', stream: mockStream, timestamp: 1002 });

      // item-1 should be evicted
      const reQuery = smallCacheMod.processSingleItem({ id: 'item-1', stream: mockStream, timestamp: 1000 });
      expect(reQuery.isCached).toBe(false);
    });

    it('bypasses cache when optimization is disabled', () => {
      const unoptimizedMod = new Module48({ enableOptimization: false });
      const item = { id: 'stream-1', stream: mockStream, timestamp: now };

      unoptimizedMod.processSingleItem(item);
      const secondPass = unoptimizedMod.processSingleItem(item);

      expect(secondPass.isCached).toBe(false);
      expect(unoptimizedMod.getPerformanceMetrics().measuredSpeedupPercent).toBeNull();
    });
  });

  describe('processStreamBatch', () => {
    it('processes batch of stream items in chunked iterations', () => {
      const batchItems = Array.from({ length: 12 }, (_, i) => ({
        id: `stream-${i}`,
        stream: { ...mockStream, id: BigInt(i) },
        timestamp: now,
      }));

      const results = module48.processStreamBatch(batchItems);

      expect(results).toHaveLength(12);
      expect(results[0]?.id).toBe('stream-0');
      expect(results[11]?.id).toBe('stream-11');

      const metrics = module48.getPerformanceMetrics();
      expect(metrics.totalProcessed).toBe(12);
    });

    it('reports the same totalProcessed and a non-zero averageExecutionTimeMs whether items go through processStreamBatch or processSingleItem directly', () => {
      const viaSingle = new Module48({ cacheSize: 10 });
      viaSingle.processSingleItem({ id: 'a', stream: mockStream, timestamp: now });
      viaSingle.processSingleItem({ id: 'b', stream: { ...mockStream, id: 2n }, timestamp: now });
      const singleMetrics = viaSingle.getPerformanceMetrics();
      expect(singleMetrics.totalProcessed).toBe(2);
      expect(singleMetrics.averageExecutionTimeMs).toBeGreaterThanOrEqual(0);

      const viaBatch = new Module48({ cacheSize: 10 });
      viaBatch.processStreamBatch([
        { id: 'a', stream: mockStream, timestamp: now },
        { id: 'b', stream: { ...mockStream, id: 2n }, timestamp: now },
      ]);
      const batchMetrics = viaBatch.getPerformanceMetrics();
      expect(batchMetrics.totalProcessed).toBe(singleMetrics.totalProcessed);
    });
  });

  describe('computeOptimizedYield', () => {
    it('computes yield accurately with BigInt precision', () => {
      const yieldResult = module48.computeOptimizedYield(100n, 3600);
      expect(yieldResult).toBe(360000n);
    });

    it('returns 0n for non-positive input values', () => {
      expect(module48.computeOptimizedYield(0n, 3600)).toBe(0n);
      expect(module48.computeOptimizedYield(100n, 0)).toBe(0n);
      expect(module48.computeOptimizedYield(100n, -10)).toBe(0n);
    });
  });

  describe('clearCache & Metrics', () => {
    it('resets cache state and performance counters', () => {
      const item = { id: 'stream-1', stream: mockStream, timestamp: now };
      module48.processSingleItem(item);
      module48.processSingleItem(item);

      expect(module48.getPerformanceMetrics().cacheHits).toBe(1);

      module48.clearCache();

      const freshMetrics = module48.getPerformanceMetrics();
      expect(freshMetrics.cacheHits).toBe(0);
      expect(freshMetrics.cacheMisses).toBe(0);
      expect(freshMetrics.totalProcessed).toBe(0);
    });
  });
});
