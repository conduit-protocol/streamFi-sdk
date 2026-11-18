import { describe, it, expect } from 'vitest';
import { coalesceAsync, coalesceInFlight, CoalesceQueueFullError } from '../coalesce-async.js';

/**
 * #1075 — `maxQueueDepth` caps how many distinct fetches can be pending at
 * once, so a stalled backend can't grow the in-flight map without bound.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('coalesceAsync maxQueueDepth (#1075)', () => {
  it('rejects a new key once maxQueueDepth fetches are pending', async () => {
    const cache = new Map<string, Promise<number>>();
    const a = deferred<number>();
    const b = deferred<number>();

    const pa = coalesceAsync(cache, 'a', () => a.promise, { maxQueueDepth: 2 });
    const pb = coalesceAsync(cache, 'b', () => b.promise, { maxQueueDepth: 2 });

    await expect(
      coalesceAsync(cache, 'c', async () => 3, { maxQueueDepth: 2 }),
    ).rejects.toBeInstanceOf(CoalesceQueueFullError);

    a.resolve(1);
    b.resolve(2);
    await expect(pa).resolves.toBe(1);
    await expect(pb).resolves.toBe(2);
  });

  it('still lets callers join a key that is already in flight', async () => {
    const cache = new Map<string, Promise<number>>();
    const a = deferred<number>();
    let calls = 0;
    const fetchA = () => {
      calls += 1;
      return a.promise;
    };

    const first = coalesceAsync(cache, 'a', fetchA, { maxQueueDepth: 1 });
    const second = coalesceAsync(cache, 'a', fetchA, { maxQueueDepth: 1 });

    a.resolve(7);
    await expect(first).resolves.toBe(7);
    await expect(second).resolves.toBe(7);
    expect(calls).toBe(1);
  });

  it('frees capacity once a pending fetch settles', async () => {
    const cache = new Map<string, Promise<number>>();
    const a = deferred<number>();

    const pa = coalesceAsync(cache, 'a', () => a.promise, { maxQueueDepth: 1 });
    a.resolve(1);
    await pa;

    await expect(coalesceAsync(cache, 'b', async () => 2, { maxQueueDepth: 1 })).resolves.toBe(2);
  });

  it('has no limit by default and keeps the numeric windowMs signature', async () => {
    const cache = new Map<string, Promise<number>>();
    const pending = Array.from({ length: 50 }, (_, i) =>
      coalesceAsync(cache, `k${i}`, async () => i, 0),
    );

    await expect(Promise.all(pending)).resolves.toHaveLength(50);
  });
});

describe('coalesceInFlight maxQueueDepth (#1075)', () => {
  it('rejects a new key once maxQueueDepth keys are in flight', async () => {
    const inFlight = new Map<string, Promise<number>>();
    const a = deferred<number>();

    const pa = coalesceInFlight(inFlight, 'a', () => a.promise, { maxQueueDepth: 1 });
    await expect(
      coalesceInFlight(inFlight, 'b', async () => 2, { maxQueueDepth: 1 }),
    ).rejects.toThrow('coalesce queue is full');

    a.resolve(1);
    await expect(pa).resolves.toBe(1);
  });
});
