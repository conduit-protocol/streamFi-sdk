import { useState, useEffect, useCallback, useRef } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface UseWithdrawableAmountResult {
  amount: bigint | null;
  /**
   * Accrual rate in stroops/second, estimated from the two most recent polls
   * (#930). `null` until a second poll lands (or if a withdrawal elsewhere
   * made the delta negative, in which case the previous estimate is kept).
   */
  ratePerSecond: bigint | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export interface UseWithdrawableAmountOptions {
  /**
   * Polling interval in milliseconds. Defaults to 1000. Use a small value
   * (e.g. 100) for smooth high-frequency streams, or a larger one to save
   * battery on mobile. Pass `0` (or a non-finite value) to disable polling.
   * The timer is paused while `document.hidden` is true.
   */
  intervalMs?: number;
}

export const DEFAULT_WITHDRAWABLE_INTERVAL_MS = 1000;

/** Cadence of the local live-ticker that interpolates `amount` between RPC polls (#930). */
const LIVE_TICK_INTERVAL_MS = 1000;

export function useWithdrawableAmount(
  streamId: bigint | string | null | undefined,
  options: UseWithdrawableAmountOptions = {},
): UseWithdrawableAmountResult {
  const intervalMs = options.intervalMs ?? DEFAULT_WITHDRAWABLE_INTERVAL_MS;
  const { client, isReady } = useStreamFiClient();
  const [amount, setAmount] = useState<bigint | null>(null);
  const [ratePerSecond, setRatePerSecond] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);
  // The last authoritative (polled) sample, used both to estimate
  // `ratePerSecond` and as the baseline the live ticker interpolates from.
  const lastSampleRef = useRef<{ amount: bigint; atMs: number } | null>(null);

  const fetch = useCallback((silent = false) => {
    const requestId = ++requestIdRef.current;

    if (!isReady || !client || streamId == null) {
      setAmount(null);
      setRatePerSecond(null);
      setLoading(false);
      setError(null);
      lastSampleRef.current = null;
      return;
    }

    if (!silent) setLoading(true);
    setError(null);

    client.streams
      .withdrawable(streamId)
      .then((data) => {
        if (requestIdRef.current !== requestId) return;

        const now = Date.now();
        const previous = lastSampleRef.current;
        if (previous) {
          const elapsedSeconds = (now - previous.atMs) / 1000;
          const delta = data - previous.amount;
          // A withdrawal elsewhere between polls makes the delta negative,
          // which says nothing about the accrual rate, so the previous
          // estimate is kept rather than overwritten with a bogus value.
          if (elapsedSeconds > 0 && delta >= 0n) {
            setRatePerSecond(BigInt(Math.round(Number(delta) / elapsedSeconds)));
          }
        }
        lastSampleRef.current = { amount: data, atMs: now };

        setAmount(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [client, isReady, streamId]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  useEffect(() => {
    if (!isReady || !client || streamId == null) return;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

    const isHidden = () => typeof document !== 'undefined' && document.hidden;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) timer = setInterval(() => fetch(true), intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibilityChange = () => {
      if (isHidden()) {
        stop();
      } else {
        // Catch up immediately after the tab becomes visible again.
        fetch(true);
        start();
      }
    };

    if (!isHidden()) start();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [client, isReady, streamId, intervalMs, fetch]);

  // Live ticker (#930): between polls, interpolates `amount` upward using the
  // estimated accrual rate so the balance keeps ticking every second even
  // when `intervalMs` is tuned larger to reduce RPC load. Runs only while
  // polling itself is enabled, and never ticks the displayed amount backward.
  useEffect(() => {
    if (!isReady || !client || streamId == null) return;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

    const isHidden = () => typeof document !== 'undefined' && document.hidden;

    const tick = () => {
      if (isHidden()) return;
      const sample = lastSampleRef.current;
      if (sample === null || ratePerSecond === null || ratePerSecond <= 0n) return;

      const elapsedSeconds = (Date.now() - sample.atMs) / 1000;
      if (elapsedSeconds <= 0) return;

      const interpolated = sample.amount + BigInt(Math.floor(elapsedSeconds * Number(ratePerSecond)));
      setAmount((current) => (current !== null && interpolated > current ? interpolated : current));
    };

    const timer = setInterval(tick, LIVE_TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [client, isReady, streamId, intervalMs, ratePerSecond]);

  const refetch = useCallback(() => fetch(), [fetch]);

  return { amount, ratePerSecond, loading, error, refetch };
}
