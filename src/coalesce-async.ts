/**
 * Async request coalescing (#798, #1186).
 *
 * Deduplicates concurrent in-flight async calls for the same key: callers
 * asking for the same uncached value share one fetch instead of triggering
 * one fetch each. Extracted from the token-decimals cache in `soroban.ts`,
 * which hand-rolled this pattern inline (caching the in-flight `Promise`
 * itself, with cleanup on rejection).
 *
 * Usage:
 *   const cache = new Map<string, Promise<number>>();
 *   const decimals = await coalesceAsync(cache, tokenId, () => fetchDecimals(tokenId));
 */

/**
 * Thrown when starting another fetch would exceed `maxQueueDepth` (#1075).
 * Callers asking for a key that is already in flight still join it; only a
 * *new* key is refused, so a stalled backend can't grow the map without bound.
 */
export class CoalesceQueueFullError extends Error {
  constructor(public readonly maxQueueDepth: number) {
    super(`coalesce queue is full: ${maxQueueDepth} requests already pending`);
    this.name = 'CoalesceQueueFullError';
  }
}

/** Options for {@link coalesceAsync}. */
export interface CoalesceOptions {
  /** See the `windowMs` parameter of {@link coalesceAsync}. */
  windowMs?: number | undefined;
  /**
   * Maximum number of distinct fetches allowed in flight at once for this
   * cache. Starting one more rejects with {@link CoalesceQueueFullError}.
   * Omitted, or a non-finite or non-positive value, means no limit.
   */
  maxQueueDepth?: number | undefined;
}

/** In-flight (not yet settled) promises per cache map, for `maxQueueDepth`. */
const pendingByCache = new WeakMap<Map<unknown, unknown>, Set<Promise<unknown>>>();

function queueLimit(maxQueueDepth: number | undefined): number | undefined {
  return maxQueueDepth !== undefined && Number.isFinite(maxQueueDepth) && maxQueueDepth > 0
    ? Math.trunc(maxQueueDepth) || 1
    : undefined;
}

/**
 * Returns the cached in-flight promise for `key` when present, otherwise
 * starts `fn()` and stores its promise in `cache`.
 *
 * A failed fetch is evicted (only if it is still the current entry) so a
 * later call retries instead of awaiting the rejected promise forever.
 *
 * `windowMs` (#979) bounds how long a *settled* value is reused. When it is a
 * positive finite number, a successful entry is evicted `windowMs` after it
 * resolves, so calls from separate render cycles inside that window share the
 * value instead of refetching. Omitted, zero, negative or non-finite values
 * keep the entry until the caller removes it, as before.
 *
 * The fourth argument may instead be a {@link CoalesceOptions} object, which
 * also accepts `maxQueueDepth` (#1075) to cap how many distinct fetches may be
 * pending at once.
 */
export async function coalesceAsync<K, V>(
  cache: Map<K, Promise<V>>,
  key: K,
  fn: () => Promise<V>,
  windowMsOrOptions?: number | CoalesceOptions,
): Promise<V> {
  const options: CoalesceOptions =
    typeof windowMsOrOptions === 'object' && windowMsOrOptions !== null
      ? windowMsOrOptions
      : { windowMs: windowMsOrOptions };
  const { windowMs } = options;

  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const limit = queueLimit(options.maxQueueDepth);
  let pending = pendingByCache.get(cache as Map<unknown, unknown>);
  if (limit !== undefined && pending && pending.size >= limit) {
    throw new CoalesceQueueFullError(limit);
  }

  const promise = fn();

  cache.set(key, promise);
  if (!pending) {
    pending = new Set();
    pendingByCache.set(cache as Map<unknown, unknown>, pending);
  }
  const tracked = pending;
  tracked.add(promise);
  const untrack = () => {
    tracked.delete(promise);
  };
  promise.then(untrack, untrack);
  promise.then(
    () => {
      if (windowMs === undefined || !Number.isFinite(windowMs) || windowMs <= 0) return;
      const timer = setTimeout(() => {
        if (cache.get(key) === promise) cache.delete(key);
      }, windowMs);
      // Don't keep a Node process alive just to expire a cache entry.
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    () => {
      // Don't cache failed fetches — let a later call retry.
      if (cache.get(key) === promise) cache.delete(key);
    },
  );

  return promise;
}

/**
 * Like {@link coalesceAsync}, but only shares the promise while it is in
 * flight (#925): the entry is evicted as soon as it settles, success or
 * failure, so later calls always fetch fresh data. Used to collapse
 * concurrent identical reads (e.g. several components calling
 * `streams.get(id)` during the same render) into one network request.
 *
 * `maxQueueDepth` (#1075) caps how many distinct keys may be in flight at
 * once; starting one more rejects with {@link CoalesceQueueFullError}.
 */
export function coalesceInFlight<K, V>(
  inFlight: Map<K, Promise<V>>,
  key: K,
  fn: () => Promise<V>,
  options: Pick<CoalesceOptions, 'maxQueueDepth'> = {},
): Promise<V> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const limit = queueLimit(options.maxQueueDepth);
  if (limit !== undefined && inFlight.size >= limit) {
    return Promise.reject(new CoalesceQueueFullError(limit));
  }

  const promise = fn();
  inFlight.set(key, promise);
  const evict = () => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  };
  promise.then(evict, evict);
  return promise;
}

/**
 * A stateful wrapper around {@link coalesceInFlight} (#1186).
 *
 * Keeps the in-flight map for callers that would otherwise have to share one
 * (e.g. React components mounted at once that all request the same stream).
 * Entries exist only while their promise is in flight, so a later call is
 * always free to fetch fresh data.
 */
export class AsyncCoalescer<K, V> {
  private readonly inFlight = new Map<K, Promise<V>>();

  /** Returns the shared in-flight promise for `key`, starting `fn()` once. */
  run(key: K, fn: () => Promise<V>, options?: Pick<CoalesceOptions, 'maxQueueDepth'>): Promise<V> {
    return coalesceInFlight(this.inFlight, key, fn, options);
  }

  /** Number of requests currently in flight. */
  get size(): number {
    return this.inFlight.size;
  }

  /** Whether a request for `key` is currently in flight. */
  has(key: K): boolean {
    return this.inFlight.has(key);
  }

  /**
   * Forget one (or all) in-flight entry without cancelling the underlying
   * requests. Useful when a network/account switch makes pending reads stale.
   */
  clear(key?: K): void {
    if (key === undefined) this.inFlight.clear();
    else this.inFlight.delete(key);
  }
}

/** Creates a standalone {@link AsyncCoalescer}. */
export function createAsyncCoalescer<K, V>(): AsyncCoalescer<K, V> {
  return new AsyncCoalescer<K, V>();
}
