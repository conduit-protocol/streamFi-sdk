export type ConnectionHealthLevel = "healthy" | "degraded" | "disconnected";

export interface EndpointHealth {
  url: string;
  connected: boolean;
  latencyMs: number | null;
  packetLossRate: number;
  samples: number;
  successes: number;
  failures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  updatedAt: number | null;
  status: ConnectionHealthLevel;
}

export interface RelayerHealth {
  connected: boolean;
  latencyMs: number | null;
  packetLossRate: number;
  samples: number;
  successes: number;
  failures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  updatedAt: number | null;
  status: ConnectionHealthLevel;
}

export interface ConnectionHealthStatus {
  connected: boolean;
  status: ConnectionHealthLevel;
  latencyMs: number | null;
  packetLossRate: number;
  activeRpcUrl: string;
  rpc: EndpointHealth;
  endpoints: EndpointHealth[];
  relayer: RelayerHealth;
  updatedAt: number | null;
}

interface HealthSample {
  at: number;
  durationMs: number;
  ok: boolean;
}

const HEALTH_WINDOW_MS = 60_000;
const MAX_SAMPLES = 200;
const RELAYER_SCOPE = "relayer";
const samplesByScope = new Map<string, HealthSample[]>();

function scopeKey(scope: string, kind: "rpc" | "relayer"): string {
  return kind === "relayer" ? RELAYER_SCOPE : `rpc:${scope}`;
}

export function recordConnectionResult(
  scope: string,
  ok: boolean,
  durationMs: number,
  kind: "rpc" | "relayer" = "rpc",
): void {
  const key = scopeKey(scope, kind);
  const now = Date.now();
  const existing = samplesByScope.get(key) ?? [];
  const recent = existing.filter((sample) => now - sample.at <= HEALTH_WINDOW_MS);
  recent.push({ at: now, durationMs: Math.max(0, durationMs), ok });
  samplesByScope.set(key, recent.slice(-MAX_SAMPLES));
}

function healthLevel(connected: boolean, packetLossRate: number): ConnectionHealthLevel {
  if (!connected) return "disconnected";
  if (packetLossRate >= 0.5) return "degraded";
  return "healthy";
}

function snapshot(key: string, url: string): EndpointHealth {
  const samples = samplesByScope.get(key) ?? [];
  const now = Date.now();
  const recent = samples.filter((sample) => now - sample.at <= HEALTH_WINDOW_MS);
  const successes = recent.filter((sample) => sample.ok);
  const failures = recent.length - successes.length;
  const last = recent[recent.length - 1];
  const lastSuccess = successes[successes.length - 1];
  const lastFailure = recent.filter((sample) => !sample.ok).at(-1);
  const connected = recent.length > 0 && last?.ok === true;
  const latencyMs =
    successes.length === 0
      ? null
      : Math.round(
          (successes.reduce((sum, sample) => sum + sample.durationMs, 0) /
            successes.length) *
            100,
        ) / 100;

  return {
    url,
    connected,
    latencyMs,
    packetLossRate: recent.length === 0 ? 0 : failures / recent.length,
    samples: recent.length,
    successes: successes.length,
    failures,
    lastSuccessAt: lastSuccess?.at ?? null,
    lastFailureAt: lastFailure?.at ?? null,
    updatedAt: last?.at ?? null,
    status: healthLevel(connected, failures / Math.max(1, recent.length)),
  };
}

export function getEndpointHealth(url: string): EndpointHealth {
  return snapshot(scopeKey(url, "rpc"), url);
}

export function getRelayerHealth(): RelayerHealth {
  const { url: _url, ...health } = snapshot(RELAYER_SCOPE, RELAYER_SCOPE);
  return health;
}

export function resetConnectionHealth(scope?: string): void {
  if (scope === undefined) {
    samplesByScope.clear();
    return;
  }
  if (scope === RELAYER_SCOPE) {
    samplesByScope.delete(RELAYER_SCOPE);
  } else {
    samplesByScope.delete(scopeKey(scope, "rpc"));
  }
}
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
