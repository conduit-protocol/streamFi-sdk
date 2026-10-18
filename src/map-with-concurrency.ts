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

/**
 * Runs `fn` over `items` with at most `concurrency` in-flight calls.
 * Preserves result ordering to match a naive `Promise.all` fan-out, and
 * rejects as soon as any call rejects (results already produced by other
 * workers are still returned to their callers, they are just not collected).
 *
 * A `concurrency` below 1, or one that is not a finite number, is treated
 * as 1 so a caller-supplied option can never silently resolve to no work
 * at all.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const limit = Math.max(1, Math.trunc(concurrency) || 1);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
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
   * A call slower than this many milliseconds counts as congestion and halves
   * the limit. A faster call adds one slot. Default: 1000.
   */
  targetLatencyMs?: number;
}

const DEFAULT_ADAPTIVE_INITIAL = 2;
const DEFAULT_ADAPTIVE_MIN = 1;
const DEFAULT_ADAPTIVE_TARGET_LATENCY_MS = 1000;

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/**
 * Like {@link mapWithConcurrency}, but the in-flight limit adapts to measured
 * latency using AIMD (additive increase, multiplicative decrease). A call that
 * finishes within `targetLatencyMs` adds one slot, up to `max`. A slower call
 * halves the limit, down to `min`. Fast links ramp up, and an endpoint that
 * starts to slow down is backed off quickly.
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

  const results = new Array<R>(items.length);
  let limit = Math.min(max, Math.max(min, initial));
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
        limit = elapsed > targetLatencyMs ? Math.max(min, Math.floor(limit / 2)) : Math.min(max, limit + 1);
      } finally {
        release();
      }
    }
  }

  const workerCount = Math.min(max, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
