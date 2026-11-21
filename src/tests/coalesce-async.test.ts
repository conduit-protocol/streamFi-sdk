import { describe, it, expect, vi, beforeEach } from 'vitest';
import { coalesceAsync } from '../coalesce-async.js';

/**
 * #798 — async request coalescing, extracted from soroban.ts's inline
 * token-decimals-cache pattern.
 */

describe('coalesceAsync (#798)', () => {
  let cache: Map<string, Promise<number>>;

  beforeEach(() => {
    cache = new Map();
  });

  it('invokes fn once and shares the value across concurrent callers for the same key', async () => {
    const fn = vi.fn(async () => 7);

    const [a, b, c] = await Promise.all([
      coalesceAsync(cache, 'k', fn),
      coalesceAsync(cache, 'k', fn),
      coalesceAsync(cache, 'k', fn),
    ]);

    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(c).toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls fn separately for different keys', async () => {
    const fn = vi.fn(async (v: number) => v);
    const wrapperA = () => coalesceAsync(cache, 'a', () => fn(1));
    const wrapperB = () => coalesceAsync(cache, 'b', () => fn(2));

    const [a, b] = await Promise.all([wrapperA(), wrapperB()]);

    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('evicts a failed fetch so a later call retries', async () => {
    const fn = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(7);

    await expect(coalesceAsync(cache, 'k', fn)).rejects.toThrow('boom');
    expect(cache.has('k')).toBe(false);

    const value = await coalesceAsync(cache, 'k', fn);
    expect(value).toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates the rejection to every concurrent caller', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });

    const results = await Promise.allSettled([
      coalesceAsync(cache, 'k', fn),
      coalesceAsync(cache, 'k', fn),
      coalesceAsync(cache, 'k', fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.status).toBe('rejected');
    }
  });

  it('does not evict a replacement entry when the original in-flight promise rejects', async () => {
    let rejectFn!: (err: Error) => void;
    const first = coalesceAsync(cache, 'k', () => new Promise<number>((_, reject) => { rejectFn = reject; }));

    // The caller overwrites the cache entry mid-flight (e.g. cleared or
    // replaced); the stale promise's cleanup must not clobber the new entry.
    const replacement = Promise.resolve(9);
    cache.set('k', replacement);

    rejectFn(new Error('stale'));
    await expect(first).rejects.toThrow('stale');

    expect(cache.get('k')).toBe(replacement);
  });
});
