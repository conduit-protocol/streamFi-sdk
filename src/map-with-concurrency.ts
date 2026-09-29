/**
 * Bounded-concurrency `map` helper.
 *
 * Resolving N on-chain reads in a plain `Promise.all` fires N requests at
 * the same instant; a Soroban RPC serves `simulateTransaction` from a fixed
 * pool of preflight workers, so the extra fan-out turns into queue time and
 * then rate-limit/timeouts. Running a small worker pool instead keeps the
 * round trips overlapping without letting the client outrun the endpoint.
 *
 * Shared by `StreamsModule` (paged `list()` / `getStreamInfos()`) and
 * `FactoryModule.streamAddresses()` (#783) so both use the same bound and
 * the same result ordering.
 */

/**
 * Default ceiling on in-flight on-chain reads.
 *
 * Matches the 8 preflight workers a default `stellar-rpc` runs, so the
 * default client concurrency is matched to the server's capacity rather
 * than guessed at.
 */
export const DEFAULT_LIST_CONCURRENCY = 8;

/**
 * Runs `fn` over `items` with at most `concurrency` in-flight calls.
 * Preserves result ordering to match a naive `Promise.all` fan-out, and
 * rejects as soon as any call rejects (results already produced by other
 * workers are still returned to their callers, they are just not collected).
 *
 * A `concurrency` below 1, or one that is not a finite number, is treated
 * as 1 so a caller-supplied option can never silently resolve to no work
 * at all.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const limit = Math.max(1, Math.trunc(concurrency) || 1);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]!);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
