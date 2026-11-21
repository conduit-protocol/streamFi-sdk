/**
 * Generic LRU cache with hit/miss timing instrumentation.
 *
 * Shared by the memoized stream-analytics modules (`Module26`, `Module36`,
 * `Module48`) so the eviction and speedup-measurement logic lives in one
 * place instead of being re-implemented identically in each of them.
 */

export interface MemoCacheMetrics {
  cacheHits: number;
  cacheMisses: number;
  /**
   * `(avgMissMs - avgHitMs) / avgMissMs * 100`, measured from this
   * instance's own accumulated hit/miss timings - not a fixed assumption.
   * `null` until at least one hit and one miss have both been recorded.
   */
  measuredSpeedupPercent: number | null;
}

/** One cache entry as written to JSON. `expiresAt` is epoch ms, or `null` for no TTL. */
export interface SerializedCacheEntry<K, V> {
  key: K;
  value: V;
  expiresAt: number | null;
}

/** Envelope written by {@link LruMemoCache.serialize}. Versioned so a future
 *  shape change can be rejected instead of mis-read. */
export interface SerializedCache<K, V> {
  version: 1;
  maxSize: number;
  entries: SerializedCacheEntry<K, V>[];
}

/** Cache keys are used as JSON object-free tuples, so only primitives are allowed. */
function assertSerializableKey(key: unknown): asserts key is string | number {
  if (typeof key !== 'string' && typeof key !== 'number') {
    throw new TypeError(`LruMemoCache can only serialize string/number keys, got ${typeof key}`);
  }
}

export interface LruMemoCacheOptions {
  /** Entries kept before the least-recently-used one is evicted. */
  maxEntries: number;
  /**
   * Default time-to-live in milliseconds for `set()` calls that pass no
   * `ttlMs`. Omit for entries that never expire by default.
   */
  ttlMs?: number;
}

export class LruMemoCache<K, V> {
  private readonly store = new Map<K, V>();
  /** Absolute expiry (epoch ms) for entries stored with a `ttlMs`. */
  private readonly expiresAt = new Map<K, number>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private hitExecutionTimeMs = 0;
  private missExecutionTimeMs = 0;
  private readonly maxSize: number;
  private readonly defaultTtlMs: number | undefined;

  /**
   * Accepts either a bare max entry count (the original form) or
   * {@link LruMemoCacheOptions}.
   */
  constructor(options: number | LruMemoCacheOptions) {
    const resolved = typeof options === 'number' ? { maxEntries: options } : options;
    this.maxSize = resolved.maxEntries;
    this.defaultTtlMs = resolved.ttlMs;
    if (this.defaultTtlMs !== undefined && (!Number.isFinite(this.defaultTtlMs) || this.defaultTtlMs <= 0)) {
      throw new RangeError('LruMemoCache ttlMs must be a positive finite number');
    }
  }

  get size(): number {
    return this.store.size;
  }

  private isExpired(key: K): boolean {
    const expiry = this.expiresAt.get(key);
    return expiry !== undefined && Date.now() >= expiry;
  }

  private remove(key: K): void {
    this.store.delete(key);
    this.expiresAt.delete(key);
  }

  /**
   * Look up a key, refreshing its LRU position on hit. An entry past its
   * `ttlMs` is dropped and reported as a miss.
   */
  get(key: K): V | undefined {
    if (this.isExpired(key)) {
      this.remove(key);
      return undefined;
    }
    const value = this.store.get(key);
    if (value !== undefined) {
      this.store.delete(key);
      this.store.set(key, value);
    }
    return value;
  }

  /**
   * Insert a key, evicting the least-recently-used entry if at capacity.
   *
   * @param ttlMs Optional time-to-live in milliseconds. Once elapsed the entry
   *   is no longer returned by `get()`. Defaults to the cache's configured
   *   `ttlMs`; if that is also unset the entry never expires. Re-setting a key
   *   replaces any previous TTL.
   */
  set(key: K, value: V, ttlMs: number | undefined = this.defaultTtlMs): void {
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError('LruMemoCache ttlMs must be a positive finite number');
    }
    this.insert(key, value, ttlMs === undefined ? null : Date.now() + ttlMs);
  }

  /**
   * Shared insertion path for {@link set} and {@link hydrate}. `expiresAt` is an
   * absolute epoch-ms deadline (or `null`), which lets hydration restore the
   * original TTL instead of restarting it.
   */
  private insert(key: K, value: V, expiresAt: number | null): void {
    if (this.store.has(key)) {
      this.remove(key);
    } else if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.remove(oldest);
    }
    this.store.set(key, value);
    if (expiresAt !== null) this.expiresAt.set(key, expiresAt);
  }

  recordHit(elapsedMs: number): void {
    this.cacheHits++;
    this.hitExecutionTimeMs += elapsedMs;
  }

  recordMiss(elapsedMs: number): void {
    this.cacheMisses++;
    this.missExecutionTimeMs += elapsedMs;
  }

  clear(): void {
    this.store.clear();
    this.expiresAt.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.hitExecutionTimeMs = 0;
    this.missExecutionTimeMs = 0;
  }

  /**
   * Snapshot the cache as JSON so it can be persisted between processes — the
   * Next.js SSR case: the server component builds the cache on one request and
   * the next request hydrates it instead of re-querying the chain (#977).
   *
   * Expired entries are dropped, and the order is preserved (least recently
   * used first) so {@link hydrate} restores the same eviction order.
   *
   * Values must be JSON-serializable; anything else (a `Map`, a class instance
   * with private fields, a function) is silently flattened by `JSON.stringify`,
   * so keep cached values to plain data.
   */
  serialize(now: number = Date.now()): string {
    const entries: SerializedCacheEntry<K, V>[] = [];
    for (const [key, value] of this.store) {
      assertSerializableKey(key);
      const expiresAt = this.expiresAt.get(key) ?? null;
      if (expiresAt !== null && now >= expiresAt) continue;
      entries.push({ key, value, expiresAt });
    }
    const payload: SerializedCache<K, V> = { version: 1, maxSize: this.maxSize, entries };
    return JSON.stringify(payload);
  }

  /**
   * Load entries produced by {@link serialize}. Expired entries are skipped and
   * the cache's own `maxSize` still applies, so a snapshot taken with a larger
   * limit cannot overflow this instance.
   *
   * Metrics are left untouched: a hydrated cache has no measured hit/miss
   * timings of its own, and inventing them would make `measuredSpeedupPercent`
   * a lie.
   *
   * @returns the number of entries actually restored.
   */
  hydrate(json: string, now: number = Date.now()): number {
    let payload: unknown;
    try {
      payload = JSON.parse(json);
    } catch {
      throw new SyntaxError('LruMemoCache.hydrate: input is not valid JSON');
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new TypeError('LruMemoCache.hydrate: expected an object');
    }
    const { version, entries } = payload as { version?: unknown; entries?: unknown };
    if (version !== 1) {
      throw new TypeError(`LruMemoCache.hydrate: unsupported snapshot version ${String(version)}`);
    }
    if (!Array.isArray(entries)) {
      throw new TypeError('LruMemoCache.hydrate: entries must be an array');
    }

    let restored = 0;
    for (const raw of entries) {
      const entry = raw as Partial<SerializedCacheEntry<K, V>> | null;
      if (!entry || typeof entry !== 'object' || !('key' in entry)) continue;
      assertSerializableKey(entry.key);
      const expiresAt = entry.expiresAt ?? null;
      if (typeof expiresAt === 'number' && now >= expiresAt) continue;

      // Insert directly so the absolute deadline survives the round trip.
      this.insert(entry.key, entry.value as V, typeof expiresAt === 'number' ? expiresAt : null);
      restored += 1;
    }
    return restored;
  }

  metrics(): MemoCacheMetrics {
    const avgHitMs = this.cacheHits > 0 ? this.hitExecutionTimeMs / this.cacheHits : null;
    const avgMissMs = this.cacheMisses > 0 ? this.missExecutionTimeMs / this.cacheMisses : null;
    const measuredSpeedupPercent =
      avgHitMs !== null && avgMissMs !== null && avgMissMs > 0
        ? ((avgMissMs - avgHitMs) / avgMissMs) * 100
        : null;

    return { cacheHits: this.cacheHits, cacheMisses: this.cacheMisses, measuredSpeedupPercent };
  }
}

/**
 * Persist `cache` as JSON. Thin wrapper so callers that only hold the cache
 * through an interface can serialize without importing the class.
 */
export function serializeCache<K, V>(cache: LruMemoCache<K, V>, now: number = Date.now()): string {
  return cache.serialize(now);
}

/**
 * Restore a snapshot produced by {@link serializeCache} into `cache`.
 *
 * @returns the number of entries restored.
 */
export function hydrateCache<K, V>(
  cache: LruMemoCache<K, V>,
  json: string,
  now: number = Date.now(),
): number {
  return cache.hydrate(json, now);
}
