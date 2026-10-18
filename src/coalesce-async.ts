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
