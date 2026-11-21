import { describe, it, expect, vi } from 'vitest';
import { LruMemoCache } from '../lru-memo-cache.js';

describe('LruMemoCache', () => {
  it('stores and retrieves values by key', () => {
    const cache = new LruMemoCache<string, number>(10);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least-recently-used entry once at capacity', () => {
    const cache = new LruMemoCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('refreshes LRU order on read, protecting recently-accessed entries from eviction', () => {
    const cache = new LruMemoCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // touch 'a' so 'b' becomes the oldest
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('reports null speedup until at least one hit and one miss are recorded', () => {
    const cache = new LruMemoCache<string, number>(10);
    expect(cache.metrics().measuredSpeedupPercent).toBeNull();

    cache.recordMiss(5);
    expect(cache.metrics().measuredSpeedupPercent).toBeNull();

    cache.recordHit(1);
    const metrics = cache.metrics();
    expect(metrics.cacheHits).toBe(1);
    expect(metrics.cacheMisses).toBe(1);
    expect(metrics.measuredSpeedupPercent).toBeCloseTo(80); // (5 - 1) / 5 * 100
  });

  it('resets storage and counters on clear', () => {
    const cache = new LruMemoCache<string, number>(10);
    cache.set('a', 1);
    cache.recordHit(1);
    cache.recordMiss(2);

    cache.clear();

    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
    const metrics = cache.metrics();
    expect(metrics.cacheHits).toBe(0);
    expect(metrics.cacheMisses).toBe(0);
    expect(metrics.measuredSpeedupPercent).toBeNull();
  });
});

describe('LruMemoCache TTL', () => {
  it('returns an entry before its ttl elapses and drops it afterwards', () => {
    vi.useFakeTimers();
    try {
      const cache = new LruMemoCache<string, number>(10);
      cache.set('a', 1, 1000);
      vi.advanceTimersByTime(999);
      expect(cache.get('a')).toBe(1);
      vi.advanceTimersByTime(1);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never expires entries set without a ttl, and re-set replaces the ttl', () => {
    vi.useFakeTimers();
    try {
      const cache = new LruMemoCache<string, number>(10);
      cache.set('forever', 1);
      cache.set('a', 1, 100);
      cache.set('a', 2);
      vi.advanceTimersByTime(10_000);
      expect(cache.get('forever')).toBe(1);
      expect(cache.get('a')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a non-positive ttl', () => {
    const cache = new LruMemoCache<string, number>(10);
    expect(() => cache.set('a', 1, 0)).toThrow(RangeError);
    expect(() => cache.set('a', 1, NaN)).toThrow(RangeError);
  });
});
describe('LruMemoCache', () => {
  it('evicts the least recently used entry at capacity', () => {
    const cache = new LruMemoCache<string, number>({ capacity: 2 });

    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // 'a' is now most recently used
    cache.set('c', 3);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.stats.evictions).toBe(1);
    expect(cache.keys()).toEqual(['a', 'c']);
  });

  it('expires entries after the TTL', () => {
    let now = 1000;
    const cache = new LruMemoCache<string, number>({ capacity: 10, ttlMs: 100, now: () => now });

    cache.set('session', 1);
    now = 1099;
    expect(cache.get('session')).toBe(1);

    now = 1100;
    expect(cache.get('session')).toBeUndefined();
    expect(cache.has('session')).toBe(false);
    expect(cache.stats.expirations).toBe(1);
  });

  it('purgeExpired removes all stale entries at once', () => {
    let now = 0;
    const cache = new LruMemoCache<string, number>({ capacity: 10, ttlMs: 50, now: () => now });

    cache.set('a', 1);
    cache.set('b', 2);
    now = 25;
    cache.set('c', 3);
    now = 75; // all three entries have now reached their TTL

    expect(cache.purgeExpired()).toBe(3);
    expect(cache.size).toBe(0);
  });

  it('tracks hit and miss statistics', () => {
    const cache = new LruMemoCache<string, number>();
    cache.set('a', 1);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('missing')).toBeUndefined();

    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.capacity).toBe(100);
  });

  it('memoize caches results by key', () => {
    const cache = new LruMemoCache<number, number>();
    const fn = vi.fn((key: number) => key * 2);
    const memoized = cache.memoize(fn);

    expect(memoized(2)).toBe(4);
    expect(memoized(2)).toBe(4);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('memoizeAsync coalesces concurrent calls for the same key', async () => {
    const cache = new LruMemoCache<number, number>();
    let resolve!: (value: number) => void;
    const fn = vi.fn(() => new Promise<number>(r => { resolve = r; }));
    const memoized = cache.memoizeAsync(fn);

    const first = memoized(1);
    const second = memoized(1);
    expect(fn).toHaveBeenCalledTimes(1);

    resolve(42);
    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe(42);
  });

  it('memoizeAsync evicts rejected promises so callers can retry', async () => {
    const cache = new LruMemoCache<number, number>();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(7);
    const memoized = cache.memoizeAsync(fn);

    await expect(memoized(1)).rejects.toThrow('boom');
    await expect(memoized(1)).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('supports delete and clear', () => {
    const cache = new LruMemoCache<string, number>();
    cache.set('a', 1);
    cache.set('b', 2);

    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    cache.clear();

    expect(cache.size).toBe(0);
  });

  it('validates cache options', () => {
    expect(() => new LruMemoCache({ capacity: 0 })).toThrow(RangeError);
    expect(() => new LruMemoCache({ capacity: 1.5 })).toThrow(RangeError);
    expect(() => new LruMemoCache({ ttlMs: -1 })).toThrow(RangeError);
  });
});
