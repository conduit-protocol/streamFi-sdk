import type { StreamInfo } from './types/index.js';
import { withdrawableLocal, streamProgress, normalizeProgress } from './utils.js';
import { LruMemoCache } from './lru-memo-cache.js';

export interface Module48Config {
  /** Maximum number of calculated results to keep in the fast lookup cache */
  cacheSize?: number;
  /** Enable memoized calculation; actual speedup depends on hit rate — see `getPerformanceMetrics()` for a measured value */
  enableOptimization?: boolean;
  /** Preferred chunk size for batch processing stream items */
  batchChunkSize?: number;
}

export interface StreamBatchItem {
  id: string;
  stream: StreamInfo;
  timestamp?: number;
}

export interface Module48Result {
  id: string;
  withdrawable: bigint;
  progress: number;
  isCached: boolean;
  computedAt: number;
}

export interface Module48Metrics {
  totalProcessed: number;
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

interface CachedResult {
  withdrawable: bigint;
  progress: number;
  computedAt: number;
}

/**
 * Module 48: stream analytics batch-evaluation helper.
 *
 * Implements Feature #48 with memoized withdrawable/progress calculation.
 *
 * ## Comparison & Consolidation Note (Issue #778)
 * `Module48` and `Module49` serve related streaming analytics batch-evaluation tasks,
 * but differ in key structural and operational choices:
 *
 * 1. **Cache Key Scope**:
 *    - `Module48` key format: `${id}_${withdrawn}_${paused}_${nowSec}`.
 *      Focuses on basic stream identity and paused state.
 *    - `Module49` key format: `${id}_${withdrawn}_${paused}_${cancelled}_${pausedAt}_${ratePerSecond}_${startTime}_${endTime}_${nowSec}`.
 *      Includes full lifecycle and rate parameters for strict cache invalidation across rate changes or cancellations.
 *
 * 2. **Performance Metrics & Measurement**:
 *    - `Module48`: Measures exact cache hit vs miss execution duration per item and calculates `measuredSpeedupPercent` via `LruMemoCache.metrics()`.
 *    - `Module49`: Tracks overall batch processing time in `processStreamBatch()` and computes a straight `hitRate` ratio (`cacheHits / totalRequests`).
 *
 * 3. **Batch Allocation Strategy**:
 *    - `Module48`: Pre-allocates result array (`new Array(items.length)`) for deterministic index mapping during chunked processing.
 *    - `Module49`: Appends results dynamically per chunk while measuring total batch wall-clock execution time.
 */
export class Module48 {
  private readonly enableOptimization: boolean;
  private readonly batchChunkSize: number;

  private readonly cache: LruMemoCache<string, CachedResult>;
  private totalProcessed = 0;
  private totalExecutionTimeMs = 0;

  constructor(config: Module48Config = {}) {
    this.cache = new LruMemoCache(config.cacheSize ?? 1000);
    this.enableOptimization = config.enableOptimization ?? true;
    this.batchChunkSize = config.batchChunkSize ?? 50;
  }

  /**
   * Process a list of streams using optimized batch evaluation algorithms.
   *
   * Delegates to `processSingleItem()` per item so `totalProcessed` and
   * `averageExecutionTimeMs` are accurate regardless of whether callers go
   * through this batch entry point or call `processSingleItem()` directly.
   */
  public processStreamBatch(items: StreamBatchItem[]): Module48Result[] {
    const results: Module48Result[] = new Array(items.length);

    for (let i = 0; i < items.length; i += this.batchChunkSize) {
      const chunkEnd = Math.min(i + this.batchChunkSize, items.length);
      for (let j = i; j < chunkEnd; j++) {
        const item = items[j];
        if (!item) continue;

        results[j] = this.processSingleItem(item);
      }
    }

    return results;
  }

  /**
   * Evaluate a single stream item with fast-path cache lookup.
   */
  public processSingleItem(item: StreamBatchItem): Module48Result {
    const start = performance.now();
    const nowSec = item.timestamp ?? Math.floor(Date.now() / 1000);
    const cacheKey = `${item.id}_${item.stream.withdrawn.toString()}_${item.stream.paused ? 1 : 0}_${nowSec}`;

    if (this.enableOptimization) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const elapsed = performance.now() - start;
        this.cache.recordHit(elapsed);
        this.totalProcessed++;
        this.totalExecutionTimeMs += elapsed;
        return {
          id: item.id,
          withdrawable: cached.withdrawable,
          progress: cached.progress,
          isCached: true,
          computedAt: cached.computedAt,
        };
      }
    }

    const withdrawable = withdrawableLocal(item.stream, nowSec);

    const progress = normalizeProgress(streamProgress(item.stream, nowSec));

    const computedAt = nowSec;

    if (this.enableOptimization) {
      this.cache.set(cacheKey, { withdrawable, progress, computedAt });
    }

    const elapsed = performance.now() - start;
    this.cache.recordMiss(elapsed);
    this.totalProcessed++;
    this.totalExecutionTimeMs += elapsed;

    return {
      id: item.id,
      withdrawable,
      progress,
      isCached: false,
      computedAt,
    };
  }

  /**
   * High-performance fast calculation of stream yields over arbitrary durations.
   */
  public computeOptimizedYield(ratePerSecond: bigint, durationSecs: number): bigint {
    if (durationSecs <= 0 || ratePerSecond <= 0n) return 0n;
    return ratePerSecond * BigInt(durationSecs);
  }

  /**
   * Reset performance cache and internal state.
   */
  public clearCache(): void {
    this.cache.clear();
    this.totalProcessed = 0;
    this.totalExecutionTimeMs = 0;
  }

  /**
   * Retrieve performance metrics, including a measured (not assumed) cache speedup.
   */
  public getPerformanceMetrics(): Module48Metrics {
    const { cacheHits, cacheMisses, measuredSpeedupPercent } = this.cache.metrics();

    return {
      totalProcessed: this.totalProcessed,
      cacheHits,
      cacheMisses,
      measuredSpeedupPercent: this.enableOptimization ? measuredSpeedupPercent : null,
      averageExecutionTimeMs: this.totalProcessed > 0 ? this.totalExecutionTimeMs / this.totalProcessed : 0,
    };
  }
}
