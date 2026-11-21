import { describe, it, expect } from 'vitest';
import { mapWithAdaptiveConcurrency } from '../map-with-concurrency.js';

/**
 * #978 — adaptive (AIMD) concurrency for `mapWithConcurrency`. The limit
 * grows by one after each call that finishes within `targetLatencyMs` and
 * halves after each call that does not, clamped to `[min, max]`.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** Records how many calls were in flight when each one started, and the peak. */
function trackInFlight(ms: number) {
  let inFlight = 0;
  let peak = 0;
  const startedWith: number[] = [];
  const fn = async (n: number): Promise<number> => {
    startedWith.push(inFlight);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(ms);
    inFlight -= 1;
    return n * 2;
  };
  return { fn, startedWith, peak: () => peak };
}

describe('mapWithAdaptiveConcurrency (#978)', () => {
  it('returns results in input order', async () => {
    const out = await mapWithAdaptiveConcurrency(
      [1, 2, 3, 4, 5],
      { initial: 2, max: 3 },
      async (n) => {
        await sleep(n % 2 === 0 ? 1 : 0);
        return n * 2;
      },
    );

    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it('returns an empty array for empty input without calling fn', async () => {
    let calls = 0;
    const out = await mapWithAdaptiveConcurrency([], {}, async () => {
      calls += 1;
      return 1;
    });

    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it('grows the limit toward max while calls finish under targetLatencyMs', async () => {
    const t = trackInFlight(2);

    await mapWithAdaptiveConcurrency(range(40), { initial: 1, min: 1, max: 4, targetLatencyMs: 60_000 }, t.fn);

    expect(t.peak()).toBe(4);
  });

  it('shrinks the limit when calls exceed targetLatencyMs', async () => {
    const t = trackInFlight(2);

    await mapWithAdaptiveConcurrency(range(16), { initial: 8, min: 1, max: 8, targetLatencyMs: 0 }, t.fn);

    // Every call is "slow", so the limit halves down to 1 and the final call starts alone.
    expect(t.startedWith[t.startedWith.length - 1]).toBe(0);
  });

  it('never drops the limit below min', async () => {
    const t = trackInFlight(2);

    await mapWithAdaptiveConcurrency(range(16), { initial: 2, min: 2, max: 8, targetLatencyMs: 0 }, t.fn);

    expect(t.peak()).toBe(2);
  });

  it('falls back to defaults for non-finite options', async () => {
    const out = await mapWithAdaptiveConcurrency(
      [1, 2, 3],
      { initial: NaN, min: NaN, max: NaN, targetLatencyMs: NaN },
      async (n) => n + 1,
    );

    expect(out).toEqual([2, 3, 4]);
  });

  it('rejects as soon as any call rejects', async () => {
    await expect(
      mapWithAdaptiveConcurrency([1, 2, 3], { initial: 2, max: 2 }, async (n) => {
        if (n === 3) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('mapWithAdaptiveConcurrency moving-average latency (#1076)', () => {
  // Five fast calls, one slow outlier, then fast again.
  const delays = [1, 1, 1, 1, 1, 120, 1, 1, 1, 1];

  async function run(latencySmoothing: number) {
    const limits: number[] = [];
    await mapWithAdaptiveConcurrency(
      delays,
      {
        initial: 2,
        min: 1,
        max: 2,
        targetLatencyMs: 50,
        latencySmoothing,
        onLimitChange: (limit) => limits.push(limit),
      },
      async (ms) => {
        await sleep(ms);
        return ms;
      },
    );
    return limits;
  }

  it('does not halve the limit for a single slow outlier with the default smoothing', async () => {
    const limits = await run(0.3);
    expect(limits).not.toContain(1);
  });

  it('reacts to every sample when latencySmoothing is 1', async () => {
    const limits = await run(1);
    expect(limits).toContain(1);
  });

  it('reports each limit change with the current average latency', async () => {
    const seen: Array<[number, number]> = [];
    await mapWithAdaptiveConcurrency(
      range(10),
      { initial: 1, min: 1, max: 3, targetLatencyMs: 60_000, onLimitChange: (l, avg) => seen.push([l, avg]) },
      async (n) => {
        await sleep(1);
        return n;
      },
    );

    expect(seen.map(([l]) => l)).toEqual([2, 3]);
    for (const [, avg] of seen) expect(avg).toBeGreaterThanOrEqual(0);
  });

  it('ignores an out-of-range latencySmoothing and uses the default', async () => {
    const out = await mapWithAdaptiveConcurrency([1, 2, 3], { latencySmoothing: 5 }, async (n) => n);
    expect(out).toEqual([1, 2, 3]);
  });
});
