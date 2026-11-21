/**
 * Bounded-concurrency `map` helper.
 *
 * Resolving N on-chain reads in a plain `Promise.all` fires N requests at
 * the same instant; a Soroban RPC serves `simulateTransaction` from a fixed
 * pool of preflight workers, so the extra fan-out turns into queue time and
 * then rate-limit/timeouts. Running a small worker pool instead keeps the
 * round trips overlapping without letting the client outrun the endpoint.
 *
 * Shared by `StreamsModule` (paged `list()` / `getStreamInfos()`) and
 * `FactoryModule.streamAddresses()` (#783) so both use the same bound and
 * the same result ordering.
 */

/**
 * Default ceiling on in-flight on-chain reads.
 *
 * Matches the 8 preflight workers a default `stellar-rpc` runs, so the
 * default client concurrency is matched to the server's capacity rather
 * than guessed at.
 */
export const DEFAULT_LIST_CONCURRENCY = 8;

/** Tuning for {@link mapWithConcurrency}. Every field is optional. */
export interface ConcurrencyOptions {
  /**
   * Maximum call starts per second, enforced with a token bucket. The bucket
   * holds up to this many tokens, so a burst of that size goes out at once and
   * the rest are spaced out. Omit (or pass a non-finite or non-positive value)
   * for no rate limit.
   */
  requestsPerSecond?: number;
}

interface TokenBucket {
  tokens: number;
  capacity: number;
  rate: number;
  last: number;
}

function createTokenBucket(requestsPerSecond: number): TokenBucket {
  // Capacity is at least 1 so a rate below 1/s can still ever take a token.
  const capacity = Math.max(1, requestsPerSecond);
  return { tokens: capacity, capacity, rate: requestsPerSecond, last: Date.now() };
}

async function takeToken(bucket: TokenBucket): Promise<void> {
  for (;;) {
    const now = Date.now();
    bucket.tokens = Math.min(
      bucket.capacity,
      bucket.tokens + ((now - bucket.last) / 1000) * bucket.rate,
    );
    bucket.last = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, ((1 - bucket.tokens) / bucket.rate) * 1000),
    );
  }
}

/**
 * Runs `fn` over `items` with at most `concurrency` in-flight calls.
 * Preserves result ordering to match a naive `Promise.all` fan-out, and
 * rejects as soon as any call rejects (results already produced by other
 * workers are still returned to their callers, they are just not collected).
 *
 * A `concurrency` below 1, or one that is not a finite number, is treated
 * as 1 so a caller-supplied option can never silently resolve to no work
 * at all.
 *
 * Pass `options.requestsPerSecond` to also cap how fast calls start, for
 * endpoints that rate-limit bursts even when concurrency is low.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  options: ConcurrencyOptions = {},
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const limit = Math.max(1, Math.trunc(concurrency) || 1);
  const rps = options.requestsPerSecond;
  const bucket =
    rps !== undefined && Number.isFinite(rps) && rps > 0 ? createTokenBucket(rps) : undefined;
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      if (bucket) await takeToken(bucket);
      results[i] = await fn(items[i]!);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Tuning for {@link mapWithAdaptiveConcurrency}. Every field is optional. */
export interface AdaptiveConcurrencyOptions {
  /** Number of calls allowed in flight at the start. Default: 2. */
  initial?: number;
  /** Lowest the limit may fall to. Default: 1. */
  min?: number;
  /** Highest the limit may grow to. Default: {@link DEFAULT_LIST_CONCURRENCY}. */
  max?: number;
  /**
   * When the moving-average latency is above this many milliseconds the
   * endpoint counts as congested and the limit halves; otherwise each finished
   * call adds one slot. Default: 1000.
   */
  targetLatencyMs?: number;
  /**
   * Weight given to the newest latency sample in the exponential moving
   * average the limit reacts to (#1076), in `(0, 1]`. Lower values smooth out
   * one-off slow calls; `1` reacts to every single sample. Default: 0.3.
   */
  latencySmoothing?: number;
  /** Called with the new limit each time it changes. Useful for metrics. */
  onLimitChange?: (limit: number, averageLatencyMs: number) => void;
}

const DEFAULT_ADAPTIVE_INITIAL = 2;
const DEFAULT_ADAPTIVE_MIN = 1;
const DEFAULT_ADAPTIVE_TARGET_LATENCY_MS = 1000;
const DEFAULT_LATENCY_SMOOTHING = 0.3;

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * Like {@link mapWithConcurrency}, but the in-flight limit adapts to measured
 * latency using AIMD (additive increase, multiplicative decrease). The signal
 * is an exponential moving average of call latency (#1076), so one slow
 * outlier doesn't collapse the window. While the average is within
 * `targetLatencyMs` each finished call adds one slot, up to `max`; once it
 * rises above, the limit halves, down to `min`. Fast links ramp up, and an
 * endpoint that is genuinely slowing down is backed off quickly.
 *
 * Results keep input order and the first rejection propagates, matching
 * {@link mapWithConcurrency}.
 */
export async function mapWithAdaptiveConcurrency<T, R>(
  items: T[],
  options: AdaptiveConcurrencyOptions,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const min = Math.max(1, finiteOr(options.min, DEFAULT_ADAPTIVE_MIN));
  const max = Math.max(min, finiteOr(options.max, DEFAULT_LIST_CONCURRENCY));
  const targetLatencyMs = finiteOr(options.targetLatencyMs, DEFAULT_ADAPTIVE_TARGET_LATENCY_MS);
  const initial = finiteOr(options.initial, DEFAULT_ADAPTIVE_INITIAL);
  const smoothing =
    options.latencySmoothing !== undefined &&
    Number.isFinite(options.latencySmoothing) &&
    options.latencySmoothing > 0 &&
    options.latencySmoothing <= 1
      ? options.latencySmoothing
      : DEFAULT_LATENCY_SMOOTHING;

  const results = new Array<R>(items.length);
  let limit = Math.min(max, Math.max(min, initial));
  let averageLatencyMs: number | undefined;
  let inFlight = 0;
  let index = 0;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    while (inFlight >= limit) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    inFlight += 1;
  }

  function release(): void {
    inFlight -= 1;
    for (const wake of waiters.splice(0)) wake();
  }

  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      await acquire();
      const startedAt = Date.now();
      try {
        results[i] = await fn(items[i] as T);
        const elapsed = Date.now() - startedAt;
        averageLatencyMs =
          averageLatencyMs === undefined
            ? elapsed
            : smoothing * elapsed + (1 - smoothing) * averageLatencyMs;
        const next =
          averageLatencyMs > targetLatencyMs
            ? Math.max(min, Math.floor(limit / 2))
            : Math.min(max, limit + 1);
        if (next !== limit) {
          limit = next;
          options.onLimitChange?.(limit, averageLatencyMs);
        }
      } finally {
        release();
      }
    }
  }

  const workerCount = Math.min(max, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
