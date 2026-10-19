/**
 * Async request coalescing (#798).
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
 */
export async function coalesceAsync<K, V>(
  cache: Map<K, Promise<V>>,
  key: K,
  fn: () => Promise<V>,
  windowMs?: number,
): Promise<V> {
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const promise = fn();

  cache.set(key, promise);
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
 */
export function coalesceInFlight<K, V>(
  inFlight: Map<K, Promise<V>>,
  key: K,
  fn: () => Promise<V>,
): Promise<V> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fn();
  inFlight.set(key, promise);
  const evict = () => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  };
  promise.then(evict, evict);
  return promise;
}
