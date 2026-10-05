import type { StreamInfo } from './types/index.js';
import { withdrawableLocal } from './utils.js';
import { LruMemoCache } from './lru-memo-cache.js';

export interface Module26Config {
  /** Maximum number of portfolio summaries retained in the LRU cache */
  cacheSize?: number;
  /** Enable memoized aggregation; actual speedup depends on hit rate — see `getPerformanceMetrics()` for a measured value */
  enableOptimization?: boolean;
  /** Preferred chunk size when scanning large stream portfolios */
  batchChunkSize?: number;
}

export interface PortfolioStreamItem {
  id: string;
  stream: StreamInfo;
  /** Observation timestamp (unix seconds) */
  timestamp?: number;
}

export interface PortfolioSummary {
  totalWithdrawable: bigint;
  totalRatePerSecond: bigint;
  activeCount: number;
  pausedCount: number;
  cancelledCount: number;
  endedCount: number;
  isCached: boolean;
  computedAt: number;
}

export interface Module26Metrics {
  totalAggregations: number;
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

function classifyStream(stream: StreamInfo, nowSec: number): 'active' | 'paused' | 'cancelled' | 'ended' {
  if (stream.cancelled) return 'cancelled';
  if (stream.paused) return 'paused';
  if (stream.endTime > 0 && nowSec >= stream.endTime) return 'ended';
  return 'active';
}

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const DJB2_SEED = 5381;

function fnv1aFold(hash: number, input: string): number {
  let h = hash;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h;
}

function djb2Fold(hash: number, input: string): number {
  let h = hash;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h, 33) ^ input.charCodeAt(i);
  }
  return h;
}

/**
 * Incremental two-hash fingerprint (FNV-1a + djb2) of the portfolio's
 * cache-relevant fields, folding each item's
 * id/withdrawn/paused/cancelled/endTime/timestamp into two running 32-bit
 * hashes instead of allocating a full `items.map(...).join('|')` string
 * (which can run to many KB for a large portfolio) on every call, including
 * cache hits. Combining two independent 32-bit hashes into the key (rather
 * than relying on one alone) keeps collision odds negligible at realistic
 * cache volumes -- a single 32-bit hash hits the birthday bound around tens
 * of thousands of distinct portfolios, which is reachable in a long-running
 * instance and would silently return the wrong cached summary.
 */
function fingerprintPortfolio(items: PortfolioStreamItem[], nowSec: number): string {
  let h1 = FNV_OFFSET_BASIS;
  let h2 = DJB2_SEED;
  for (const item of items) {
    const ts = item.timestamp ?? nowSec;
    const fields = [
      item.id,
      ':',
      item.stream.withdrawn.toString(),
      item.stream.paused ? ':1:' : ':0:',
      item.stream.cancelled ? '1:' : '0:',
      String(item.stream.endTime),
      ':',
      String(ts),
      '|',
    ];
    for (const field of fields) {
      h1 = fnv1aFold(h1, field);
      h2 = djb2Fold(h2, field);
    }
  }
  return `${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

/**
 * Module 26: stream portfolio aggregator.
 *
 * Implements Feature #26 with LRU-memoized portfolio summaries. Speedup
 * from caching is workload-dependent (proportional to cache hit rate);
 * call `getPerformanceMetrics()` for this instance's own measured hit/miss
 * timing rather than assuming a fixed percentage.
 *
 * @example
 * ```ts
 * import { Module26 } from '@conduit-protocol/sdk';
 *
 * // `active` and `cancelled` are StreamInfo values (for example from
 * // client.getStream()). `active` streams 10n per second from t=1000 to
 * // t=2000 with nothing withdrawn yet.
 * const portfolio = new Module26({ cacheSize: 500 });
 * const items = [
 *   { id: 'a', stream: active },
 *   { id: 'b', stream: cancelled },
 * ];
 *
 * const summary = portfolio.aggregatePortfolio(items, 1_500);
 * console.log(summary.activeCount);        // 1
 * console.log(summary.cancelledCount);     // 1
 * console.log(summary.totalWithdrawable);  // 5000n
 * console.log(summary.totalRatePerSecond); // 10n
 *
 * // Same inputs again: served from the LRU cache.
 * portfolio.aggregatePortfolio(items, 1_500).isCached; // true
 *
 * // What the active stream will still release over the next 100 seconds.
 * portfolio.projectRemaining(active, 100, 1_500); // 1000n
 * ```
 */
export class Module26 {
  private readonly enableOptimization: boolean;
  private readonly batchChunkSize: number;

  private readonly cache: LruMemoCache<string, PortfolioSummary>;
  private totalAggregations = 0;
  private totalExecutionTimeMs = 0;

  constructor(config: Module26Config = {}) {
    this.cache = new LruMemoCache(config.cacheSize ?? 1000);
    this.enableOptimization = config.enableOptimization ?? true;
    this.batchChunkSize = config.batchChunkSize ?? 50;
  }

  /**
   * Aggregate a portfolio of streams into totals and lifecycle counts.
   */
  public aggregatePortfolio(items: PortfolioStreamItem[], nowSec = Math.floor(Date.now() / 1000)): PortfolioSummary {
    const start = performance.now();

    let cacheKey: string | undefined;
    if (this.enableOptimization) {
      cacheKey = fingerprintPortfolio(items, nowSec);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const elapsed = performance.now() - start;
        this.cache.recordHit(elapsed);
        this.totalAggregations++;
        this.totalExecutionTimeMs += elapsed;
        return { ...cached, isCached: true };
      }
    }

    let totalWithdrawable = 0n;
    let totalRatePerSecond = 0n;
    let activeCount = 0;
    let pausedCount = 0;
    let cancelledCount = 0;
    let endedCount = 0;

    for (let i = 0; i < items.length; i += this.batchChunkSize) {
      const chunkEnd = Math.min(i + this.batchChunkSize, items.length);
      for (let j = i; j < chunkEnd; j++) {
        const item = items[j];
        if (!item) continue;
        const ts = item.timestamp ?? nowSec;
        totalWithdrawable += withdrawableLocal(item.stream, ts);
        const status = classifyStream(item.stream, ts);
        if (status === 'active') {
          activeCount++;
          totalRatePerSecond += item.stream.ratePerSecond;
        } else if (status === 'paused') {
          pausedCount++;
        } else if (status === 'cancelled') {
          cancelledCount++;
        } else {
          endedCount++;
        }
      }
    }

    const summary: PortfolioSummary = {
      totalWithdrawable,
      totalRatePerSecond,
      activeCount,
      pausedCount,
      cancelledCount,
      endedCount,
      isCached: false,
      computedAt: nowSec,
    };

    if (this.enableOptimization && cacheKey !== undefined) {
      this.cache.set(cacheKey, summary);
    }

    const elapsed = performance.now() - start;
    this.cache.recordMiss(elapsed);
    this.totalAggregations++;
    this.totalExecutionTimeMs += elapsed;
    return summary;
  }

  /**
   * Project remaining streamable amount for an active stream over a horizon.
   */
  public projectRemaining(stream: StreamInfo, horizonSecs: number, nowSec = Math.floor(Date.now() / 1000)): bigint {
    if (horizonSecs <= 0 || stream.cancelled || stream.paused) return 0n;
    if (stream.endTime > 0 && nowSec >= stream.endTime) return 0n;

    const effectiveEnd =
      stream.endTime > 0 ? Math.min(stream.endTime, nowSec + horizonSecs) : nowSec + horizonSecs;
    if (effectiveEnd <= nowSec) return 0n;
    return stream.ratePerSecond * BigInt(effectiveEnd - nowSec);
  }

  public clearCache(): void {
    this.cache.clear();
    this.totalAggregations = 0;
    this.totalExecutionTimeMs = 0;
  }

  public getPerformanceMetrics(): Module26Metrics {
    const { cacheHits, cacheMisses, measuredSpeedupPercent } = this.cache.metrics();

    return {
      totalAggregations: this.totalAggregations,
      cacheHits,
      cacheMisses,
      measuredSpeedupPercent: this.enableOptimization ? measuredSpeedupPercent : null,
      averageExecutionTimeMs:
        this.totalAggregations > 0 ? this.totalExecutionTimeMs / this.totalAggregations : 0,
    };
  }
}
