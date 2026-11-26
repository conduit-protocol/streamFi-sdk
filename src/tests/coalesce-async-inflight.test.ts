import { describe, it, expect, vi } from 'vitest';
import { AsyncCoalescer, createAsyncCoalescer } from '../coalesce-async.js';

/** #1186 — in-flight promise deduplication across concurrent callers. */
describe('AsyncCoalescer (#1186)', () => {
  it('shares one in-flight request across concurrent callers for the same key', async () => {
    const coalescer = createAsyncCoalescer<string, number>();
    let resolve!: (value: number) => void;
    const fn = vi.fn(() => new Promise<number>((r) => { resolve = r; }));

    const a = coalescer.run('stream-1', fn);
    const b = coalescer.run('stream-1', fn);
    expect(coalescer.has('stream-1')).toBe(true);
    expect(coalescer.size).toBe(1);

    resolve(7);
    await expect(Promise.all([a, b])).resolves.toEqual([7, 7]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('forgets a settled entry so a later call can fetch fresh data', async () => {
    const coalescer = new AsyncCoalescer<string, number>();
    const fn = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await coalescer.run('k', fn)).toBe(1);
    // Let the fulfillment callback evict the entry (one macrotask so every
    // promise-adoption microtask from coalesceAsync has drained).
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(coalescer.has('k')).toBe(false);
    expect(await coalescer.run('k', fn)).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('evicts failures so the next call retries', async () => {
    const coalescer = new AsyncCoalescer<string, number>();
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(9);

    await expect(coalescer.run('k', fn)).rejects.toThrow('boom');
    expect(coalescer.has('k')).toBe(false);
    expect(await coalescer.run('k', fn)).toBe(9);
  });

  it('keeps different keys independent and supports clear()', async () => {
    const coalescer = new AsyncCoalescer<string, number>();
    const fn = vi.fn(async (n: number) => n);

    await Promise.all([
      coalescer.run('a', () => fn(1)),
      coalescer.run('b', () => fn(2)),
    ]);
    expect(fn).toHaveBeenCalledTimes(2);

    let resolve!: (value: number) => void;
    void coalescer.run('c', () => new Promise<number>((r) => { resolve = r; }));
    coalescer.clear();
    expect(coalescer.size).toBe(0);
    resolve(3);
  });
});
