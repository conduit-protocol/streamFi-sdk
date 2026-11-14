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
