import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { coalesceAsync } from '../coalesce-async.js';

/**
 * #979 — optional `windowMs` on `coalesceAsync`. A settled value stays
 * cached for `windowMs` so back-to-back render cycles reuse it. Without a
 * window, settled entries are kept as before. Failures are never kept.
 */

describe('coalesceAsync windowMs (#979)', () => {
  let cache: Map<string, Promise<number>>;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new Map();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses a settled value until windowMs has elapsed', async () => {
    const fn = vi.fn(async () => 7);

    await expect(coalesceAsync(cache, 'k', fn, 500)).resolves.toBe(7);

    vi.advanceTimersByTime(499);
    await expect(coalesceAsync(cache, 'k', fn, 500)).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await expect(coalesceAsync(cache, 'k', fn, 500)).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keeps a settled entry indefinitely when windowMs is omitted', async () => {
    const fn = vi.fn(async () => 7);

    await coalesceAsync(cache, 'k', fn);
    vi.advanceTimersByTime(10_000);
    await coalesceAsync(cache, 'k', fn);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('treats zero, negative and non-finite windowMs as no window', async () => {
    for (const windowMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      cache = new Map();
      const fn = vi.fn(async () => 7);

      await coalesceAsync(cache, 'k', fn, windowMs);
      vi.advanceTimersByTime(10_000);
      await coalesceAsync(cache, 'k', fn, windowMs);

      expect(fn, `windowMs=${windowMs}`).toHaveBeenCalledTimes(1);
    }
  });

  it('still evicts a failed fetch immediately when a window is set', async () => {
    const fn = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(7);

    await expect(coalesceAsync(cache, 'k', fn, 500)).rejects.toThrow('boom');
    expect(cache.has('k')).toBe(false);

    await expect(coalesceAsync(cache, 'k', fn, 500)).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not evict a replacement entry when the window timer fires', async () => {
    const fn = vi.fn(async () => 7);
    await coalesceAsync(cache, 'k', fn, 500);

    const replacement = Promise.resolve(9);
    cache.set('k', replacement);

    vi.advanceTimersByTime(500);

    expect(cache.get('k')).toBe(replacement);
  });
});
