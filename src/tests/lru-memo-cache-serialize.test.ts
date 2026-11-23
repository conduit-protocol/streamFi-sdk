import { describe, it, expect, vi } from 'vitest';
import { LruMemoCache, serializeCache, hydrateCache } from '../lru-memo-cache.js';

interface Meta {
  name: string;
  decimals: number;
}

const TTL = 60_000;

describe('LruMemoCache serialize/hydrate (#977)', () => {
  it('round-trips values, including their remaining TTL', () => {
    const source = new LruMemoCache<string, Meta>(10);
    source.set('USDC', { name: 'USD Coin', decimals: 7 });
    source.set('XLM', { name: 'Lumen', decimals: 7 }, TTL);

    const snapshot = source.serialize();
    const restored = new LruMemoCache<string, Meta>(10);
    expect(restored.hydrate(snapshot)).toBe(2);

    expect(restored.get('USDC')).toEqual({ name: 'USD Coin', decimals: 7 });
    expect(restored.get('XLM')).toEqual({ name: 'Lumen', decimals: 7 });
    expect(restored.size).toBe(2);
  });

  it('keeps the absolute deadline instead of restarting the TTL', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const source = new LruMemoCache<string, number>(5);
      source.set('a', 1, 10_000);

      // Snapshot 9s later: only 1s of life is left.
      vi.setSystemTime(new Date('2026-01-01T00:00:09Z'));
      const snapshot = source.serialize();

      const restored = new LruMemoCache<string, number>(5);
      restored.hydrate(snapshot);

      vi.setSystemTime(new Date('2026-01-01T00:00:10.5Z'));
      expect(restored.get('a')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops entries that already expired before the snapshot', () => {
    const source = new LruMemoCache<string, number>(5);
    source.set('fresh', 1, TTL);
    source.set('stale', 2, TTL);

    // Snapshot as if 2 minutes had passed: both are gone.
    const snapshot = source.serialize(Date.now() + 120_000);
    const restored = new LruMemoCache<string, number>(5);
    expect(restored.hydrate(snapshot)).toBe(0);
    expect(restored.size).toBe(0);
  });

  it('preserves LRU order so eviction still drops the coldest entry', () => {
    const source = new LruMemoCache<string, number>(3);
    source.set('a', 1);
    source.set('b', 2);
    source.set('c', 3);
    source.get('a'); // 'a' becomes most recently used → order is b, c, a

    const restored = new LruMemoCache<string, number>(3);
    restored.hydrate(source.serialize());

    restored.set('d', 4); // evicts 'b', the least recently used
    expect(restored.get('b')).toBeUndefined();
    expect(restored.get('a')).toBe(1);
    expect(restored.get('d')).toBe(4);
  });

  it('respects the destination cache capacity', () => {
    const source = new LruMemoCache<string, number>(10);
    for (let i = 0; i < 10; i++) source.set(`k${i}`, i);

    const restored = new LruMemoCache<string, number>(3);
    expect(restored.hydrate(source.serialize())).toBe(10);
    expect(restored.size).toBe(3);
    // The newest three survive.
    expect([restored.get('k7'), restored.get('k8'), restored.get('k9')]).toEqual([7, 8, 9]);
  });

  it('does not fabricate hit/miss metrics while hydrating', () => {
    const source = new LruMemoCache<string, number>(5);
    source.set('a', 1);
    const restored = new LruMemoCache<string, number>(5);
    restored.hydrate(source.serialize());

    expect(restored.metrics()).toEqual({
      cacheHits: 0,
      cacheMisses: 0,
      measuredSpeedupPercent: null,
    });
  });

  it('rejects malformed input instead of returning a half-filled cache', () => {
    const cache = new LruMemoCache<string, number>(5);
    expect(() => cache.hydrate('{not json')).toThrow(SyntaxError);
    expect(() => cache.hydrate('[]')).toThrow(TypeError);
    expect(() => cache.hydrate(JSON.stringify({ version: 99, entries: [] }))).toThrow(/version/);
    expect(() => cache.hydrate(JSON.stringify({ version: 1, entries: 'nope' }))).toThrow(/entries/);
  });

  it('refuses keys that JSON would silently mangle', () => {
    const cache = new LruMemoCache<object, number>(5);
    cache.set({ id: 1 }, 1);
    expect(() => cache.serialize()).toThrow(/string\/number keys/);
  });

  it('exposes the same behaviour through the exported helpers', () => {
    const source = new LruMemoCache<string, number>(5);
    source.set('a', 1);
    const json = serializeCache(source);

    const restored = new LruMemoCache<string, number>(5);
    expect(hydrateCache(restored, json)).toBe(1);
    expect(restored.get('a')).toBe(1);
  });

  it('produces JSON a server can pass to another request verbatim', () => {
    const source = new LruMemoCache<string, Meta>(5);
    source.set('USDC', { name: 'USD Coin', decimals: 7 }, TTL);
    const json = source.serialize();

    expect(typeof json).toBe('string');
    expect(JSON.parse(json)).toMatchObject({ version: 1, maxSize: 5 });
  });
});
