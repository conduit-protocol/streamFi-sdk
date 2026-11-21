/**
 * Regression tests for #569 — `GraphQLIndexer.query()` had no timeout /
 * AbortSignal, so a hung indexer left the caller's `await` pending forever.
 *
 * The fix optionally accepts a `signal` and/or `timeoutMs` on
 * `GraphQLQueryOptions`, wires a per-request `AbortController` into the
 * `fetch` call, and defaults to a 15s timeout that rejects with an
 * {@link IndexerTimeoutError}.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GraphQLIndexer,
  DEFAULT_INDEXER_TIMEOUT_MS,
} from '../indexer.js';
import { IndexerTimeoutError, OperationAbortedError } from '../errors.js';

const endpoint = 'https://indexer.streamfi.io/graphql';

/**
 * A fetch mock that only ever settles when it is aborted — reproduces the
 * "hung indexer" scenario from the bug report.
 */
function hangingFetch() {
  return vi.fn(
    (_uri: string | URL, options?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        if (options?.signal) {
          if (options.signal.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
            return;
          }
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }
        // Otherwise the promise never settles — the bug.
      }),
  );
}

describe('GraphQLIndexer.query() — timeout & AbortSignal (fix for #569)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('passes a signal to the underlying fetch call', async () => {
    let captured: RequestInit | undefined;
    const fetchSpy = vi.fn(
      (_uri: string | URL, options?: RequestInit): Promise<Response> => {
        captured = options;
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: { ok: true } }),
        } as unknown as Response);
      },
    );
    vi.stubGlobal('fetch', fetchSpy);

    const indexer = new GraphQLIndexer(endpoint);
    await indexer.query({ query: '{ x }' });
    indexer.cleanup();

    expect(captured?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a hung request after the default 15s timeout with IndexerTimeoutError', async () => {
    const fetchSpy = hangingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const indexer = new GraphQLIndexer(endpoint);
    const resultPromise = indexer.query({ query: '{ x }' });
    resultPromise.catch(() => {}); // observe now; assertions below re-check it

    // The query hashes the operation (APQ, #629) with async WebCrypto before
    // the request goes out; wait for the fetch, then let the timeout fire.
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(DEFAULT_INDEXER_TIMEOUT_MS + 1);

    await expect(resultPromise).rejects.toBeInstanceOf(IndexerTimeoutError);
    await expect(resultPromise).rejects.toMatchObject({
      name: 'IndexerTimeoutError',
      endpoint,
      timeoutMs: DEFAULT_INDEXER_TIMEOUT_MS,
      message: expect.stringContaining(String(DEFAULT_INDEXER_TIMEOUT_MS)),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    indexer.cleanup();
  });

  it('respects a caller-supplied timeoutMs', async () => {
    const fetchSpy = hangingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const indexer = new GraphQLIndexer(endpoint);
    const resultPromise = indexer.query({ query: '{ x }', timeoutMs: 500 });
    resultPromise.catch(() => {});

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(501);

    await expect(resultPromise).rejects.toMatchObject({
      name: 'IndexerTimeoutError',
      timeoutMs: 500,
    });
    indexer.cleanup();
  });

  it('does not abort when the response arrives before the timeout', async () => {
    const fetchSpy = vi.fn(
      (): Promise<Response> =>
        Promise.resolve({
          ok: true,
          json: async () => ({ data: { streams: [] } }),
        } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const indexer = new GraphQLIndexer(endpoint);
    const result = await indexer.query({ query: '{ streams { id } }' });
    indexer.cleanup();

    expect(result).toEqual({ streams: [] });
    // Advancing past the timeout must not throw / leak a timer.
    vi.advanceTimersByTime(DEFAULT_INDEXER_TIMEOUT_MS + 1000);
  });

  it('clears the timer after a successful response', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const fetchSpy = vi.fn(
      (): Promise<Response> =>
        Promise.resolve({ ok: true, json: async () => ({}) } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const indexer = new GraphQLIndexer(endpoint);
    await indexer.query({ query: '{ x }' });
    indexer.cleanup();

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('rejects with an OperationAbortedError when the caller aborts via a supplied signal (#624)', async () => {
    const fetchSpy = hangingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const controller = new AbortController();
    const indexer = new GraphQLIndexer(endpoint);
    const resultPromise = indexer.query({ query: '{ x }', signal: controller.signal });

    controller.abort();

    await expect(resultPromise).rejects.toBeInstanceOf(OperationAbortedError);
    indexer.cleanup();
  });

  it('fails fast with an OperationAbortedError if the signal is already aborted (#624)', async () => {
    const fetchSpy = hangingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const controller = new AbortController();
    controller.abort();

    const indexer = new GraphQLIndexer(endpoint);
    await expect(
      indexer.query({ query: '{ x }', signal: controller.signal }),
    ).rejects.toBeInstanceOf(OperationAbortedError);

    // The request must never have been issued.
    expect(fetchSpy).not.toHaveBeenCalled();
    indexer.cleanup();
  });

  it('honours a caller-supplied signal even with timeoutMs disabled', async () => {
    const fetchSpy = hangingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const controller = new AbortController();
    const indexer = new GraphQLIndexer(endpoint);
    const resultPromise = indexer.query({
      query: '{ x }',
      timeoutMs: 0, // disable the SDK timeout entirely
      signal: controller.signal,
    });

    // Even well past the default window the SDK timeout must not fire.
    vi.advanceTimersByTime(DEFAULT_INDEXER_TIMEOUT_MS + 5000);
    controller.abort();

    await expect(resultPromise).rejects.toBeInstanceOf(OperationAbortedError);
    indexer.cleanup();
  });

  it('treats a caller abort during the timeout window as an OperationAbortedError, not a timeout', async () => {
    const fetchSpy = hangingFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const controller = new AbortController();
    const indexer = new GraphQLIndexer(endpoint);
    const resultPromise = indexer.query({ query: '{ x }', signal: controller.signal });

    // Caller aborts before the 15s window elapses.
    controller.abort();

    await expect(resultPromise).rejects.toBeInstanceOf(OperationAbortedError);
    indexer.cleanup();
  });
});
