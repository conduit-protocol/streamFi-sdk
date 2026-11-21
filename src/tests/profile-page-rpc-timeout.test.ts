/**
 * Regression test for #158 — Profile Page hangs infinitely when the RPC
 * provider times out.
 *
 * The fix wraps every `HttpLink` fetch with an AbortController tied to a
 * configurable timeout and adds `errorPolicy: 'all'` to the query hooks so
 * that network errors (including AbortErrors from the timeout) always clear
 * `loading` rather than leaving the page stuck on a spinner.
 *
 * These tests verify the timeout/abort logic in isolation without needing a
 * browser or Apollo Client, since the custom `fetch` wrapper in
 * `apollo-client.ts` is a pure function we can exercise directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers — replicate the fetch-wrapper logic from apollo-client.ts so we
// can unit-test it without importing the example dashboard code (which
// depends on Vite-specific `import.meta.env`).
// ---------------------------------------------------------------------------

function createTimeoutFetch(timeoutMs: number) {
  return async (uri: string | URL, options?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(uri, { ...options, signal: controller.signal }).finally(() =>
      clearTimeout(timeoutId),
    );
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Profile Page — RPC provider timeout (fix for #158)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('aborts the fetch when the server does not respond within the timeout', async () => {
    // Simulate a server that never responds (hangs indefinitely)
    const hangingFetch = vi.fn(
      (_uri: string | URL, options?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          // Only reject if the signal fires (abort)
          if (options?.signal) {
            options.signal.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }
          // Otherwise the promise hangs forever — reproduces the bug
        }),
    );

    vi.stubGlobal('fetch', hangingFetch);

    const timeoutFetch = createTimeoutFetch(15_000);
    const resultPromise = timeoutFetch('https://indexer.streamfi.io/graphql', {
      method: 'POST',
    });

    // Fast-forward past the 15-second timeout
    vi.advanceTimersByTime(15_001);

    // DOMException's .message is "The operation was aborted." — the
    // 'AbortError' string only appears in .name, not the message text.
    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
    // The fetch must have been called exactly once
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT abort when the server responds before the timeout', async () => {
    const fastFetch = vi.fn(
      (_uri: string | URL, _options?: RequestInit): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify({ data: { streams: [] } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    );

    vi.stubGlobal('fetch', fastFetch);

    const timeoutFetch = createTimeoutFetch(15_000);
    const response = await timeoutFetch('https://indexer.streamfi.io/graphql', {
      method: 'POST',
    });

    expect(response.ok).toBe(true);
    expect(fastFetch).toHaveBeenCalledTimes(1);

    // Timeout fires after response — should not throw
    vi.advanceTimersByTime(20_000);
  });

  it('clears the timeout after a successful response to prevent memory leaks', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const fastFetch = vi.fn(
      (): Promise<Response> =>
        Promise.resolve(new Response('{}', { status: 200 })),
    );
    vi.stubGlobal('fetch', fastFetch);

    const timeoutFetch = createTimeoutFetch(15_000);
    await timeoutFetch('https://example.com/graphql');

    // clearTimeout must have been called (via .finally()) to avoid leaked timers
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('clears the timeout even when the fetch rejects (non-timeout error)', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const failingFetch = vi.fn(
      (): Promise<Response> => Promise.reject(new Error('Network error')),
    );
    vi.stubGlobal('fetch', failingFetch);

    const timeoutFetch = createTimeoutFetch(15_000);
    await expect(timeoutFetch('https://example.com/graphql')).rejects.toThrow(
      'Network error',
    );

    // .finally() must still clean up the timer
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('passes the merged AbortSignal through to the underlying fetch options', async () => {
    let capturedOptions: RequestInit | undefined;
    const captureFetch = vi.fn(
      (_uri: string | URL, options?: RequestInit): Promise<Response> => {
        capturedOptions = options;
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    );
    vi.stubGlobal('fetch', captureFetch);

    const timeoutFetch = createTimeoutFetch(15_000);
    await timeoutFetch('https://example.com/graphql', { method: 'POST' });

    // The signal must be present so Apollo / the browser can abort on timeout
    expect(capturedOptions?.signal).toBeInstanceOf(AbortSignal);
  });
});
