/**
 * Bounded LRU memo cache with optional TTL expiration.
 *
 * Long-lived browser sessions can otherwise retain contract state forever.
 * This cache caps the number of entries and drops entries whose TTL has
 * elapsed, keeping the client's memory footprint bounded.
 */

export interface LruMemoCacheOptions {
  /** Maximum number of entries retained. Default: 100. */
  capacity?: number;
  /** Time-to-live in milliseconds. Default: no expiration. */
  ttlMs?: number;
  /** Injectable clock, primarily for deterministic tests. */
  now?: () => number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  size: number;
  capacity: number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

const DEFAULT_CAPACITY = 100;

export class LruMemoCache<K, V> {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<K, CacheEntry<V>>();

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(options: LruMemoCacheOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('capacity must be a positive integer');
    }

    const ttlMs = options.ttlMs ?? Infinity;
    if (ttlMs !== Infinity && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new RangeError('ttlMs must be a positive number of milliseconds');
    }

    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.now = options.now ?? Date.now;
  }

  /** Fetch a value, marking it as most recently used. */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      this.expirations++;
      this.misses++;
      return undefined;
    }

    // Delete + reinsert moves the entry to the end (most-recently used).
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry.value;
  }

  /** Check validity without affecting LRU order. */
  has(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      this.expirations++;
      return false;
    }
    return true;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.purgeExpired();

    if (this.entries.size >= this.capacity) {
      const lruKey = this.entries.keys().next().value;
      if (lruKey !== undefined) {
        this.entries.delete(lruKey);
        this.evictions++;
      }
    }

    const expiresAt = this.ttlMs === Infinity ? Infinity : this.now() + this.ttlMs;
    this.entries.set(key, { value, expiresAt });
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Remove all expired entries; returns the number removed. */
  purgeExpired(): number {
    const expired: K[] = [];
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) expired.push(key);
    }
    for (const key of expired) {
      this.entries.delete(key);
      this.expirations++;
    }
    return expired.length;
  }

  get size(): number {
    this.purgeExpired();
    return this.entries.size;
  }

  get stats(): CacheStats {
    this.purgeExpired();
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      size: this.entries.size,
      capacity: this.capacity,
    };
  }

  /** Current keys from least- to most-recently used. */
  keys(): K[] {
    this.purgeExpired();
    return [...this.entries.keys()];
  }

  /** Wrap a synchronous function with memoization keyed by its argument. */
  memoize(fn: (key: K) => V): (key: K) => V {
    return (key: K): V => {
      if (this.has(key)) {
        return this.get(key) as V;
      }
      const value = fn(key);
      this.set(key, value);
      return value;
    };
  }

  /**
   * Wrap an async function, caching in-flight promises so concurrent callers
   * with the same key share a single request. Rejected promises are evicted.
   */
  memoizeAsync(fn: (key: K) => Promise<V>): (key: K) => Promise<V> {
    const cache = this as unknown as LruMemoCache<K, V | Promise<V>>;
    return async (key: K): Promise<V> => {
      if (cache.has(key)) {
        const cached = cache.get(key);
        if (cached !== undefined) return Promise.resolve(cached) as Promise<V>;
      }

      const pending = fn(key);
      cache.set(key, pending);
      try {
        return await pending;
      } catch (error) {
        // Only evict if the rejected promise is still the cached value.
        if (cache.get(key) === pending) cache.delete(key);
        throw error;
      }
    };
  }

  private isExpired(entry: CacheEntry<V>): boolean {
    return this.ttlMs !== Infinity && this.now() >= entry.expiresAt;
  }
}
