import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { timeoutSignal } from '../utils.js';

describe('timeoutSignal (#634)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns an AbortSignal that is not aborted yet', () => {
    const signal = timeoutSignal(1_000);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('prefers the native AbortSignal.timeout when available', () => {
    const native = new AbortController().signal;
    const spy = vi
      .spyOn(AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }, 'timeout')
      .mockReturnValue(native);

    const signal = timeoutSignal(5_000);

    expect(spy).toHaveBeenCalledWith(5_000);
    expect(signal).toBe(native);
  });

  it('falls back to AbortController + setTimeout when AbortSignal.timeout is absent', async () => {
    const AS = AbortSignal as unknown as { timeout?: unknown };
    const original = AS.timeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (AS as any).timeout;
    try {
      const signal = timeoutSignal(2_000);
      expect(signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (AS as any).timeout = original;
    }
  });

  it('the fallback signal fires an "abort" event listener exactly once', async () => {
    const AS = AbortSignal as unknown as { timeout?: unknown };
    const original = AS.timeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (AS as any).timeout;
    try {
      const signal = timeoutSignal(1_000);
      const onAbort = vi.fn();
      signal.addEventListener('abort', onAbort);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(onAbort).toHaveBeenCalledTimes(1);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (AS as any).timeout = original;
    }
  });
});
