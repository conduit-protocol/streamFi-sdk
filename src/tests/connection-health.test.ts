import { describe, it, expect } from 'vitest';
import { ConnectionHealthMonitor, percentile } from '../connection-health.js';

describe('percentile', () => {
  it('returns 0 for an empty dataset', () => {
    expect(percentile([], 50)).toBe(0);
  });

  it('linearly interpolates between the closest ranks', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBeCloseTo(95.05);
  });

  it('returns min and max at the boundaries', () => {
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile([5, 1, 3], 100)).toBe(5);
  });

  it('rejects invalid percentiles', () => {
    expect(() => percentile([1], -1)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
    expect(() => percentile([1], Number.NaN)).toThrow(RangeError);
  });
});

describe('ConnectionHealthMonitor', () => {
  it('computes p50 / p95 over recorded latencies', () => {
    const monitor = new ConnectionHealthMonitor();
    for (let i = 1; i <= 100; i++) monitor.record(i);

    const snapshot = monitor.snapshot();
    expect(snapshot.count).toBe(100);
    expect(snapshot.p50).toBeCloseTo(50.5);
    expect(snapshot.p95).toBeCloseTo(95.05);
    expect(snapshot.min).toBe(1);
    expect(snapshot.max).toBe(100);
    expect(snapshot.mean).toBe(50.5);
  });

  it('keeps only the most recent windowSize samples', () => {
    const monitor = new ConnectionHealthMonitor({ windowSize: 3 });
    [1, 2, 3, 4, 5].forEach(latency => monitor.record(latency));

    expect(monitor.sampleCount).toBe(3);
    expect(monitor.p50).toBe(4);
    expect(monitor.p95).toBeCloseTo(4.9);
  });

  it('drops samples older than maxAgeMs', () => {
    let now = 1000;
    const monitor = new ConnectionHealthMonitor({ maxAgeMs: 100, now: () => now });

    monitor.record(10);
    now = 1050;
    monitor.record(20);
    now = 1101; // first sample is now 101ms old

    const snapshot = monitor.snapshot();
    expect(snapshot.count).toBe(1);
    expect(snapshot.p50).toBe(20);
  });

  it('reports health from p95 against a threshold', () => {
    const monitor = new ConnectionHealthMonitor();
    expect(monitor.isHealthy(100)).toBe(false); // no data => unknown/unhealthy

    [10, 20, 1000].forEach(latency => monitor.record(latency));
    expect(monitor.isHealthy(50)).toBe(false);
    expect(monitor.isHealthy(2000)).toBe(true);
  });

  it('validates latency and threshold inputs', () => {
    const monitor = new ConnectionHealthMonitor();
    expect(() => monitor.record(-1)).toThrow(RangeError);
    expect(() => monitor.record(Number.NaN)).toThrow(RangeError);
    expect(() => monitor.isHealthy(-1)).toThrow(RangeError);
    expect(() => new ConnectionHealthMonitor({ windowSize: 0 })).toThrow(RangeError);
    expect(() => new ConnectionHealthMonitor({ maxAgeMs: 0 })).toThrow(RangeError);
  });

  it('resets recorded samples', () => {
    const monitor = new ConnectionHealthMonitor();
    monitor.record(10);
    monitor.reset();

    expect(monitor.sampleCount).toBe(0);
    expect(monitor.snapshot()).toEqual({ p50: 0, p95: 0, count: 0, min: 0, max: 0, mean: 0 });
  });
});
