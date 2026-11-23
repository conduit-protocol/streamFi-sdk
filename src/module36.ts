import type { StreamInfo } from './types/index.js';
import { streamProgress, normalizeProgress, withdrawableLocal } from './utils.js';
import { LruMemoCache } from './lru-memo-cache.js';

export interface Module36Config {
  /** Maximum number of snapshot diffs retained in the LRU cache */
  cacheSize?: number;
  /** Enable memoized diffing; actual speedup depends on hit rate — see `getPerformanceMetrics()` for a measured value */
  enableOptimization?: boolean;
}

export interface StreamSnapshot {
  stream: StreamInfo;
  /** Observation timestamp (unix seconds) */
  observedAt: number;
}

export interface StreamDiff {
  streamId: string;
  withdrawableDelta: bigint;
  progressDelta: number;
  statusChanged: boolean;
  previousWithdrawable: bigint;
  currentWithdrawable: bigint;
  previousProgress: number;
  currentProgress: number;
  isCached: boolean;
  computedAt: number;
}

export interface Module36Metrics {
  totalDiffs: number;
  cacheHits: number;
  cacheMisses: number;
  /**
   * Measured, not assumed: `(avgMissMs - avgHitMs) / avgMissMs * 100`, based
   * on this instance's own accumulated timings. `null` until at least one
   * hit and one miss have both been recorded (nothing to compare yet).
   */
  measuredSpeedupPercent: number | null;
  averageExecutionTimeMs: number;
}

function statusKey(stream: StreamInfo): string {
  return `${stream.paused ? 1 : 0}:${stream.cancelled ? 1 : 0}:${stream.endTime}`;
}

/**
 * Module 36: stream snapshot diff engine with LRU-memoized diffing.
 *
 * Implements Feature #36. Speedup from caching is workload-dependent
 * (proportional to cache hit rate); call `getPerformanceMetrics()` for
 * this instance's own measured hit/miss timing rather than assuming a
 * fixed percentage.
 *
 * @example
 * ```ts
 * import { Module36 } from '@conduit-protocol/sdk';
 *
 * // `stream` is an active StreamInfo: 10n per second from t=1000 to t=2000
 * // with nothing withdrawn yet.
 * const differ = new Module36();
 * const diff = differ.diffSnapshots(
 *   { stream, observedAt: 1_200 },
 *   { stream, observedAt: 1_500 },
 * );
 * console.log(diff.withdrawableDelta); // 3000n
 * console.log(diff.progressDelta);     // 0.3
 * console.log(diff.statusChanged);     // false
 *
 * // Accrual between two timestamps at a constant rate.
 * differ.computeAccrual(10n, 1_200, 1_500); // 3000n
 * ```
 */
export class Module36 {
  private readonly enableOptimization: boolean;

  private readonly cache: LruMemoCache<string, StreamDiff>;
  private totalDiffs = 0;
  private totalExecutionTimeMs = 0;

  constructor(config: Module36Config = {}) {
    this.cache = new LruMemoCache(config.cacheSize ?? 1000);
    this.enableOptimization = config.enableOptimization ?? true;
  }

  /**
   * Diff two snapshots of the same stream, returning withdrawable/progress deltas.
   */
  public diffSnapshots(previous: StreamSnapshot, current: StreamSnapshot): StreamDiff {
    const start = performance.now();
    const streamId = current.stream.id.toString();
    const cacheKey = [
      streamId,
      previous.observedAt,
      current.observedAt,
      previous.stream.withdrawn.toString(),
      current.stream.withdrawn.toString(),
      statusKey(previous.stream),
      statusKey(current.stream),
    ].join('|');

    if (this.enableOptimization) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const elapsed = performance.now() - start;
        this.cache.recordHit(elapsed);
        this.totalDiffs++;
        this.totalExecutionTimeMs += elapsed;
        return { ...cached, isCached: true };
      }
    }

    const previousWithdrawable = withdrawableLocal(previous.stream, previous.observedAt);
    const currentWithdrawable = withdrawableLocal(current.stream, current.observedAt);
    const previousProgress = normalizeProgress(streamProgress(previous.stream, previous.observedAt));
    const currentProgress = normalizeProgress(streamProgress(current.stream, current.observedAt));

    const result: StreamDiff = {
      streamId,
      withdrawableDelta: currentWithdrawable - previousWithdrawable,
      progressDelta: currentProgress - previousProgress,
      statusChanged: statusKey(previous.stream) !== statusKey(current.stream),
      previousWithdrawable,
      currentWithdrawable,
      previousProgress,
      currentProgress,
      isCached: false,
      computedAt: current.observedAt,
    };

    if (this.enableOptimization) {
      this.cache.set(cacheKey, result);
    }

    const elapsed = performance.now() - start;
    this.cache.recordMiss(elapsed);
    this.totalDiffs++;
    this.totalExecutionTimeMs += elapsed;
    return result;
  }

  /**
   * Diff many snapshot pairs in a single pass (pre-sized result buffer).
   */
  public diffBatch(
    pairs: Array<{ previous: StreamSnapshot; current: StreamSnapshot }>,
  ): StreamDiff[] {
    const results: StreamDiff[] = new Array(pairs.length);
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      if (!pair) continue;
      results[i] = this.diffSnapshots(pair.previous, pair.current);
    }
    return results;
  }

  /**
   * Fast BigInt accrual between two timestamps at a constant rate.
   */
  public computeAccrual(ratePerSecond: bigint, fromSec: number, toSec: number): bigint {
    if (ratePerSecond <= 0n || toSec <= fromSec) return 0n;
    return ratePerSecond * BigInt(toSec - fromSec);
  }

  public clearCache(): void {
    this.cache.clear();
    this.totalDiffs = 0;
    this.totalExecutionTimeMs = 0;
  }

  public getPerformanceMetrics(): Module36Metrics {
    const { cacheHits, cacheMisses, measuredSpeedupPercent } = this.cache.metrics();

    return {
      totalDiffs: this.totalDiffs,
      cacheHits,
      cacheMisses,
      measuredSpeedupPercent: this.enableOptimization ? measuredSpeedupPercent : null,
      averageExecutionTimeMs: this.totalDiffs > 0 ? this.totalExecutionTimeMs / this.totalDiffs : 0,
    };
  }
}
