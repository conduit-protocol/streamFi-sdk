import type { StreamInfo } from './types/index.js';
import { LruMemoCache } from './lru-memo-cache.js';

export interface Module44Config {
  /** Maximum number of risk assessments retained in the LRU cache */
  cacheSize?: number;
  /** Enable memoized assessment; actual speedup depends on hit rate — see `getPerformanceMetrics()` for a measured value */
  enableOptimization?: boolean;
  /** Preferred chunk size for batch processing stream items */
  batchChunkSize?: number;
  /** Runway (seconds) below which a stream is classified 'critical'. Default 86400 (1 day). */
  criticalThresholdSecs?: number;
  /** Runway (seconds) below which a stream is classified 'warning'. Default 604800 (7 days). */
  warningThresholdSecs?: number;
}

export interface StreamRiskItem {
  id: string;
  stream: StreamInfo;
  /** Observation timestamp (unix seconds) */
  timestamp?: number;
}

export type LiquidityRiskLevel = 'inactive' | 'critical' | 'warning' | 'healthy';

export interface StreamRiskAssessment {
  id: string;
  /**
   * Seconds of streaming remaining before the stream reaches `endTime`.
   * `null` for an open-ended stream (`endTime === 0`) — its runway is not
   * bounded by a schedule, only by the sender keeping the balance topped up.
   */
  runwaySecs: number | null;
  riskLevel: LiquidityRiskLevel;
  isCached: boolean;
  computedAt: number;
}

export interface Module44Metrics {
  totalAssessed: number;
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

const DEFAULT_CRITICAL_THRESHOLD_SECS = 86_400;   // 1 day
const DEFAULT_WARNING_THRESHOLD_SECS  = 604_800;  // 7 days

/**
 * Module 44: stream liquidity-risk / runway calculator.
 *
 * Implements Feature #44 with LRU-memoized runway and risk-level assessment
 * per stream, so a dashboard can flag streams that are about to run out of
 * scheduled balance. Speedup from caching is workload-dependent
 * (proportional to cache hit rate); call `getPerformanceMetrics()` for this
 * instance's own measured hit/miss timing rather than assuming a fixed
 * percentage.
 *
 * @example
 * ```ts
 * import { Module44 } from '@conduit-protocol/sdk';
 *
 * // `stream` is an active StreamInfo streaming 10n per second until t=2000.
 * // By default, under 1 day of runway is 'critical' and under 7 days is 'warning'.
 * const risk = new Module44();
 * const assessment = risk.assessSingleItem({ id: 'a', stream, timestamp: 1_500 });
 * console.log(assessment.runwaySecs); // 500
 * console.log(assessment.riskLevel);  // 'critical'
 *
 * // Amount to add via top_up() so the stream has 1000 seconds of runway left.
 * risk.estimateTopUpNeeded(stream, 1_000, 1_500); // 5000n
 *
 * // Custom thresholds (`warningThresholdSecs` must exceed `criticalThresholdSecs`).
 * const strict = new Module44({ criticalThresholdSecs: 300, warningThresholdSecs: 3_600 });
 * strict.assessSingleItem({ id: 'a', stream, timestamp: 1_500 }).riskLevel; // 'warning'
 * ```
 *
 * An open-ended stream (`endTime === 0`) has no scheduled runway: it is
 * reported as `{ runwaySecs: null, riskLevel: 'healthy' }`.
 */
export class Module44 {
  private readonly enableOptimization: boolean;
  private readonly batchChunkSize: number;
  private readonly criticalThresholdSecs: number;
  private readonly warningThresholdSecs: number;

  private readonly cache: LruMemoCache<string, StreamRiskAssessment>;
  private totalAssessed = 0;
  private totalExecutionTimeMs = 0;

  constructor(config: Module44Config = {}) {
    this.cache = new LruMemoCache(config.cacheSize ?? 1000);
    this.enableOptimization = config.enableOptimization ?? true;
    this.batchChunkSize = config.batchChunkSize ?? 50;
    this.criticalThresholdSecs = config.criticalThresholdSecs ?? DEFAULT_CRITICAL_THRESHOLD_SECS;
    this.warningThresholdSecs = config.warningThresholdSecs ?? DEFAULT_WARNING_THRESHOLD_SECS;

    if (this.criticalThresholdSecs < 0) {
      throw new Error('Module44: criticalThresholdSecs cannot be negative');
    }
    if (this.warningThresholdSecs <= this.criticalThresholdSecs) {
      throw new Error('Module44: warningThresholdSecs must be greater than criticalThresholdSecs');
    }
  }

  /**
   * Assess a batch of streams' liquidity risk with fast-path cache lookup.
   */
  public assessBatch(items: StreamRiskItem[]): StreamRiskAssessment[] {
    const results: StreamRiskAssessment[] = new Array(items.length);

    for (let i = 0; i < items.length; i += this.batchChunkSize) {
      const chunkEnd = Math.min(i + this.batchChunkSize, items.length);
      for (let j = i; j < chunkEnd; j++) {
        const item = items[j];
        if (!item) continue;

        results[j] = this.assessSingleItem(item);
      }
    }

    return results;
  }

  /**
   * Assess a single stream's runway and liquidity risk level.
   */
  public assessSingleItem(item: StreamRiskItem): StreamRiskAssessment {
    const start = performance.now();
    const nowSec = item.timestamp ?? Math.floor(Date.now() / 1000);
    const cacheKey = `${item.id}_${item.stream.paused ? 1 : 0}_${item.stream.cancelled ? 1 : 0}_${item.stream.ratePerSecond.toString()}_${item.stream.endTime}_${nowSec}`;

    if (this.enableOptimization) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const elapsed = performance.now() - start;
        this.cache.recordHit(elapsed);
        this.totalAssessed++;
        this.totalExecutionTimeMs += elapsed;
        return { ...cached, isCached: true };
      }
    }

    const result = this.computeAssessment(item.id, item.stream, nowSec);

    if (this.enableOptimization) {
      this.cache.set(cacheKey, result);
    }

    const elapsed = performance.now() - start;
    this.cache.recordMiss(elapsed);
    this.totalAssessed++;
    this.totalExecutionTimeMs += elapsed;
    return result;
  }

  private computeAssessment(id: string, stream: StreamInfo, nowSec: number): StreamRiskAssessment {
    if (stream.cancelled || stream.paused || stream.ratePerSecond <= 0n) {
      return { id, runwaySecs: 0, riskLevel: 'inactive', isCached: false, computedAt: nowSec };
    }

    if (stream.endTime === 0) {
      // Open-ended: not bounded by a schedule, so treat as healthy — the
      // sender is expected to keep the balance topped up via top_up().
      return { id, runwaySecs: null, riskLevel: 'healthy', isCached: false, computedAt: nowSec };
    }

    const runwaySecs = Math.max(0, stream.endTime - nowSec);
    let riskLevel: LiquidityRiskLevel;
    if (runwaySecs <= 0) {
      riskLevel = 'inactive';
    } else if (runwaySecs < this.criticalThresholdSecs) {
      riskLevel = 'critical';
    } else if (runwaySecs < this.warningThresholdSecs) {
      riskLevel = 'warning';
    } else {
      riskLevel = 'healthy';
    }

    return { id, runwaySecs, riskLevel, isCached: false, computedAt: nowSec };
  }

  /**
   * Amount (in stroops) that must be added via `top_up()` for the stream's
   * runway to reach `targetRunwaySecs` from `nowSec`. Returns `0n` when the
   * stream is already inactive/paused/cancelled or already meets the target.
   */
  public estimateTopUpNeeded(
    stream: StreamInfo,
    targetRunwaySecs: number,
    nowSec = Math.floor(Date.now() / 1000),
  ): bigint {
    if (targetRunwaySecs <= 0 || stream.ratePerSecond <= 0n || stream.cancelled || stream.paused) {
      return 0n;
    }

    const currentRunwaySecs = stream.endTime === 0 ? Infinity : Math.max(0, stream.endTime - nowSec);
    if (currentRunwaySecs >= targetRunwaySecs) return 0n;

    const deficitSecs = Math.ceil(targetRunwaySecs - currentRunwaySecs);
    return stream.ratePerSecond * BigInt(deficitSecs);
  }

  /**
   * Reset performance cache and internal state.
   */
  public clearCache(): void {
    this.cache.clear();
    this.totalAssessed = 0;
    this.totalExecutionTimeMs = 0;
  }

  /**
   * Retrieve performance metrics, including a measured (not assumed) cache speedup.
   */
  public getPerformanceMetrics(): Module44Metrics {
    const { cacheHits, cacheMisses, measuredSpeedupPercent } = this.cache.metrics();

    return {
      totalAssessed: this.totalAssessed,
      cacheHits,
      cacheMisses,
      measuredSpeedupPercent: this.enableOptimization ? measuredSpeedupPercent : null,
      averageExecutionTimeMs: this.totalAssessed > 0 ? this.totalExecutionTimeMs / this.totalAssessed : 0,
    };
  }
}
