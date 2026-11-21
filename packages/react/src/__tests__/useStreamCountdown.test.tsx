import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStreamCountdown } from '../hooks/useStreamCountdown.js';

const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z
const BASE_SEC = Math.floor(BASE_MS / 1000);

describe('useStreamCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('splits the remaining time into days, hours, minutes and seconds', () => {
    const target = BASE_SEC + 86_400 + 2 * 3_600 + 3 * 60 + 4;

    const { result } = renderHook(() => useStreamCountdown(target));

    expect(result.current).toEqual({
      days: 1,
      hours: 2,
      minutes: 3,
      seconds: 4,
      isPast: false,
      progressFraction: null,
    });
  });

  it('auto-ticks once per second', () => {
    const target = BASE_SEC + 5;
    const { result } = renderHook(() => useStreamCountdown(target));

    expect(result.current.seconds).toBe(5);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.seconds).toBe(4);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current.seconds).toBe(2);
  });

  it('reports isPast once the target is reached and clamps at zero', () => {
    const target = BASE_SEC + 1;
    const { result } = renderHook(() => useStreamCountdown(target));

    expect(result.current.isPast).toBe(false);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(result.current.isPast).toBe(true);
    expect(result.current).toMatchObject({ days: 0, hours: 0, minutes: 0, seconds: 0 });
  });

  it('derives progressFraction from the start/end window', () => {
    const start = BASE_SEC;
    const target = BASE_SEC + 100;
    const { result } = renderHook(() => useStreamCountdown(target, start));

    expect(result.current.progressFraction).toBe(0);

    act(() => {
      vi.advanceTimersByTime(50_000);
    });
    expect(result.current.progressFraction).toBe(0.5);

    act(() => {
      vi.advanceTimersByTime(50_000);
    });
    expect(result.current.progressFraction).toBe(1);
  });

  it('clamps progressFraction to 0 before the window starts', () => {
    const { result } = renderHook(() =>
      useStreamCountdown(BASE_SEC + 150, BASE_SEC + 50),
    );

    expect(result.current.progressFraction).toBe(0);
    expect(result.current.isPast).toBe(false);
  });

  it('treats a zero-length window as complete only once past', () => {
    const target = BASE_SEC + 10;
    const { result } = renderHook(() => useStreamCountdown(target, target));

    expect(result.current.progressFraction).toBe(0);
    expect(result.current.isPast).toBe(false);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(result.current.progressFraction).toBe(1);
    expect(result.current.isPast).toBe(true);
  });

  it('returns a zeroed, not-started result when the target is missing', () => {
    const { result } = renderHook(() => useStreamCountdown(null, BASE_SEC));

    expect(result.current).toEqual({
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      isPast: false,
      progressFraction: null,
    });
  });

  it('treats non-finite targets as missing', () => {
    const { result } = renderHook(() => useStreamCountdown(Number.NaN, BASE_SEC));

    expect(result.current.isPast).toBe(false);
    expect(result.current.progressFraction).toBeNull();
  });

  it('ignores a non-finite start timestamp for progressFraction', () => {
    const { result } = renderHook(() =>
      useStreamCountdown(BASE_SEC + 60, Number.POSITIVE_INFINITY),
    );

    expect(result.current.progressFraction).toBeNull();
  });

  it('re-syncs when the target changes', () => {
    const { result, rerender } = renderHook(
      ({ target }: { target: number }) => useStreamCountdown(target),
      { initialProps: { target: BASE_SEC + 10 } },
    );

    expect(result.current.seconds).toBe(10);

    rerender({ target: BASE_SEC + 3 });
    expect(result.current.seconds).toBe(3);
  });

  it('clears its interval on unmount', () => {
    const { unmount } = renderHook(() => useStreamCountdown(BASE_SEC + 60));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('decomposes long durations into whole units', () => {
    const target = BASE_SEC + 2 * 86_400 + 5 * 3_600 + 59 * 60 + 59;
    const { result } = renderHook(() => useStreamCountdown(target));

    expect(result.current).toMatchObject({
      days: 2,
      hours: 5,
      minutes: 59,
      seconds: 59,
    });
  });

  it('flags isPast exactly at the target', () => {
    const target = BASE_SEC + 1;
    const { result } = renderHook(() => useStreamCountdown(target));

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(result.current.isPast).toBe(true);
    expect(result.current.progressFraction).toBeNull();
  });
});
