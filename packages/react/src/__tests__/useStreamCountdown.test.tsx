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
});
