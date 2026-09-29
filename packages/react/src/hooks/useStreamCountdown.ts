import { useEffect, useMemo, useState } from 'react';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;

export interface UseStreamCountdownResult {
  /** Whole days remaining (0 once the target has passed). */
  days: number;
  /** Whole hours remaining within the day, 0-23. */
  hours: number;
  /** Whole minutes remaining within the hour, 0-59. */
  minutes: number;
  /** Whole seconds remaining within the minute, 0-59. */
  seconds: number;
  /** True once the current time is at or past `targetTimestamp`. */
  isPast: boolean;
  /**
   * Fraction (0-1) of the window between `startTimestamp` and
   * `targetTimestamp` that has elapsed, clamped to [0, 1].
   *
   * `null` when no `startTimestamp` is supplied (or when either timestamp is
   * not a finite number), since a fraction needs both ends of the window.
   */
  progressFraction: number | null;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isFiniteTimestamp(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

/**
 * Live countdown to a cliff or cancellation/completion deadline.
 *
 * `targetTimestamp` and the optional `startTimestamp` are Unix timestamps in
 * **seconds** (the same unit as `StreamInfo.startTime`/`endTime`), not
 * milliseconds. The hook re-renders every second so a vesting or payroll card
 * can render `{days}d {hours}h {minutes}m {seconds}s` without wiring up its
 * own timer.
 *
 * Pass `startTimestamp` as well to also get `progressFraction`, the share of
 * the window that has already elapsed. Without it `progressFraction` is
 * `null`; a countdown does not have enough information to derive a fraction
 * from the deadline alone.
 *
 * @example
 * ```tsx
 * const { days, hours, minutes, seconds, isPast, progressFraction } =
 *   useStreamCountdown(stream.endTime, stream.startTime);
 * ```
 */
export function useStreamCountdown(
  targetTimestamp: number | null | undefined,
  startTimestamp?: number | null,
): UseStreamCountdownResult {
  const [now, setNow] = useState(currentUnixSeconds);

  const hasTarget = isFiniteTimestamp(targetTimestamp);

  // Re-sync on mount and whenever the target changes, then tick once per
  // second. `targetTimestamp` is intentionally a dependency: a changed
  // deadline must not keep counting down against the old value.
  useEffect(() => {
    if (!hasTarget) return;

    setNow(currentUnixSeconds());
    const interval = setInterval(() => {
      setNow(currentUnixSeconds());
    }, 1_000);

    return () => clearInterval(interval);
  }, [hasTarget, targetTimestamp]);

  return useMemo(() => {
    if (!hasTarget) {
      return {
        days: 0,
        hours: 0,
        minutes: 0,
        seconds: 0,
        isPast: false,
        progressFraction: null,
      };
    }

    const remaining = Math.max(0, targetTimestamp - now);
    const isPast = now >= targetTimestamp;

    const days = Math.floor(remaining / SECONDS_PER_DAY);
    const hours = Math.floor((remaining % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
    const minutes = Math.floor((remaining % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const seconds = remaining % SECONDS_PER_MINUTE;

    let progressFraction: number | null = null;
    if (isFiniteTimestamp(startTimestamp)) {
      const span = targetTimestamp - startTimestamp;
      progressFraction =
        span <= 0
          ? isPast
            ? 1
            : 0
          : Math.min(1, Math.max(0, (now - startTimestamp) / span));
    }

    return { days, hours, minutes, seconds, isPast, progressFraction };
  }, [hasTarget, targetTimestamp, startTimestamp, now]);
}
