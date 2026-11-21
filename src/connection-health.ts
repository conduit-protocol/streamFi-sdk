/**
 * Rolling RPC connection-health monitoring.
 *
 * Records recent request latencies and derives p50 / p95 percentiles so callers
 * can detect RPC degradation early and fail over before an endpoint stops
 * responding altogether.
 */

export interface LatencyPercentiles {
  /** 50th percentile (median) latency in milliseconds. */
  p50: number;
  /** 95th percentile latency in milliseconds. */
  p95: number;
  /** Number of samples the statistics are based on. */
  count: number;
  min: number;
  max: number;
  mean: number;
}

export interface ConnectionHealthOptions {
  /** Maximum number of latency samples retained. Default: 100. */
  windowSize?: number;
  /** Discard samples older than this many milliseconds. Default: keep all. */
  maxAgeMs?: number;
  /** Injectable clock, primarily for deterministic tests. */
  now?: () => number;
}

interface LatencySample {
  latencyMs: number;
  timestamp: number;
}

const DEFAULT_WINDOW_SIZE = 100;

/**
 * Compute a percentile from raw values using linear interpolation between the
 * two closest ranks. Returns 0 for an empty input. `p` must be in [0, 100].
 */
export function percentile(values: readonly number[], p: number): number {
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new RangeError('percentile p must be a number between 0 and 100');
  }
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (rank - lower);
}

/** Fixed-size, optionally time-bounded rolling window of RPC latencies. */
export class ConnectionHealthMonitor {
  private readonly windowSize: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private samples: LatencySample[] = [];

  constructor(options: ConnectionHealthOptions = {}) {
    const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    if (!Number.isInteger(windowSize) || windowSize <= 0) {
      throw new RangeError('windowSize must be a positive integer');
    }

    const maxAgeMs = options.maxAgeMs ?? Infinity;
    if (maxAgeMs !== Infinity && (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0)) {
      throw new RangeError('maxAgeMs must be a positive number of milliseconds');
    }

    this.windowSize = windowSize;
    this.maxAgeMs = maxAgeMs;
    this.now = options.now ?? Date.now;
  }

  /** Record the latency (ms) of a single RPC request. */
  record(latencyMs: number): void {
    if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) {
      throw new RangeError('latencyMs must be a finite, non-negative number');
    }

    this.pruneExpired();
    this.samples.push({ latencyMs, timestamp: this.now() });

    if (this.samples.length > this.windowSize) {
      this.samples.splice(0, this.samples.length - this.windowSize);
    }
  }

  /** Compute statistics over the currently retained samples. */
  snapshot(): LatencyPercentiles {
    this.pruneExpired();
    const values = this.samples.map(sample => sample.latencyMs);
    if (values.length === 0) {
      return { p50: 0, p95: 0, count: 0, min: 0, max: 0, mean: 0 };
    }

    const sum = values.reduce((total, value) => total + value, 0);
    return {
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      count: values.length,
      min: values.reduce((min, value) => Math.min(min, value), Infinity),
      max: values.reduce((max, value) => Math.max(max, value), -Infinity),
      mean: sum / values.length,
    };
  }

  get p50(): number {
    return this.snapshot().p50;
  }

  get p95(): number {
    return this.snapshot().p95;
  }

  get sampleCount(): number {
    this.pruneExpired();
    return this.samples.length;
  }

  /**
   * True only when there is at least one sample and p95 is within the given
   * threshold. A monitor with no data is considered unhealthy (unknown state).
   */
  isHealthy(thresholdMs: number): boolean {
    if (!Number.isFinite(thresholdMs) || thresholdMs < 0) {
      throw new RangeError('thresholdMs must be a finite, non-negative number');
    }
    const { count, p95 } = this.snapshot();
    return count > 0 && p95 <= thresholdMs;
  }

  /** Forget all recorded samples. */
  reset(): void {
    this.samples = [];
  }

  clear(): void {
    this.reset();
  }

  private pruneExpired(): void {
    if (this.maxAgeMs === Infinity) return;
    const cutoff = this.now() - this.maxAgeMs;
    this.samples = this.samples.filter(sample => sample.timestamp >= cutoff);
  }
}
