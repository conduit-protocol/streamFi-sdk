/**
 * Async request coalescing (#798, #1186).
 *
 * Deduplicates concurrent in-flight async calls for the same key: callers
 * asking for the same uncached value share one fetch instead of triggering
 * one fetch each. Extracted from the token-decimals cache in `soroban.ts`,
 * which hand-rolled this pattern inline (caching the in-flight `Promise`
 * itself, with cleanup on rejection).
 *
 * Usage with an explicit cache:
 *   const cache = new Map<string, Promise<number>>();
 *   const decimals = await coalesceAsync(cache, tokenId, () => fetchDecimals(tokenId));
 *
 * Usage with a self-contained coalescer (convenient for React hooks that must
 * share one in-flight request across component instances, #1186):
 *   const streams = createAsyncCoalescer<string, StreamInfo>();
 *   const stream = await streams.run(streamId, () => client.streams.get(streamId));
 */

/**
 * Returns the cached in-flight promise for `key` when present, otherwise
 * starts `fn()` and stores its promise in `cache`.
 *
 * A failed fetch is evicted (only if it is still the current entry) so a
 * later call retries instead of awaiting the rejected promise forever.
 */
export async function coalesceAsync<K, V>(
  cache: Map<K, Promise<V>>,
  key: K,
  fn: () => Promise<V>,
): Promise<V> {
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const promise = fn();

  cache.set(key, promise);
  promise.catch(() => {
    // Don't cache failed fetches — let a later call retry.
    if (cache.get(key) === promise) cache.delete(key);
  });

  return promise;
}

/**
 * A keyed registry of in-flight promises (#1186).
 *
 * Wraps {@link coalesceAsync} so callers do not have to manage a `Map`
 * themselves — useful when several React components mount at once and all
 * request the same stream. Entries live only while their promise is in
 * flight: a fulfilled promise is evicted so later calls can refresh, and a
 * rejected one is evicted by {@link coalesceAsync} so a later call retries.
 */
export class AsyncCoalescer<K, V> {
  private readonly inFlight = new Map<K, Promise<V>>();

  /** Returns the shared in-flight promise for `key`, starting `fn()` once. */
  run(key: K, fn: () => Promise<V>): Promise<V> {
    const result = coalesceAsync(this.inFlight, key, fn);
    // `coalesceAsync` retains fulfilled promises (it doubles as a cache) and
    // stores the *inner* promise from `fn()` in the map. Here we want pure
    // in-flight deduplication, so attach an eviction handler to that stored
    // promise: a later call must be free to fetch fresh stream info. The
    // identity check avoids clobbering a newer entry installed meanwhile.
    // When a request is already in flight, `result === stored` and the first
    // caller has already attached the handler.
    const stored = this.inFlight.get(key);
    if (stored && stored !== result) {
      void stored.then(
        () => {
          if (this.inFlight.get(key) === stored) this.inFlight.delete(key);
        },
        () => {
          // Rejections are already evicted by coalesceAsync.
        },
      );
    }
    return result;
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
   * Drop an entry. Without `key` every in-flight request is forgotten (the
   * promises themselves keep running; their results are simply no longer
   * shared). Useful on account/network switches when cached reads become
   * stale.
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
