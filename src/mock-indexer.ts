/**
 * In-memory mock transport for {@link GraphQLIndexer}.
 *
 * Lets consumers unit-test indexer-backed code without stubbing the global
 * `fetch` or running a real GraphQL server. Query results and subscription
 * events are injected up-front and returned deterministically.
 *
 * @example
 * ```ts
 * const indexer = createMockIndexer({
 *   'query GetStreams { streams { id } }': { streams: [{ id: '1' }] },
 * });
 *
 * const result = await indexer.query({ query: 'query GetStreams { streams { id } }' });
 * // result === { streams: [{ id: '1' }] }
 * ```
 */

import type { GraphQLQueryOptions, GraphQLSubscriptionOptions, IndexerSubscription } from './indexer.js';

/** Preset response map: query string → resolved data. */
export type MockQueryMap = Record<string, unknown>;

/** Preset subscription event map: query string → array of events to emit. */
export type MockSubscriptionMap = Record<string, unknown[]>;

export interface MockIndexerOptions {
  /** Pre-baked responses for `query()` calls. */
  queries?: MockQueryMap;
  /** Pre-baked event arrays for `subscribe()` calls. */
  subscriptions?: MockSubscriptionMap;
  /** When true, unknown queries throw instead of returning undefined. Default false. */
  strict?: boolean;
}

/**
 * A drop-in replacement for {@link GraphQLIndexer} that serves injected
 * responses from memory. Useful in unit tests and offline demos.
 */
export class MockGraphQLIndexer {
  private readonly queries: MockQueryMap;
  private readonly subscriptions: MockSubscriptionMap;
  private readonly strict: boolean;
  private _destroyed = false;

  constructor(options: MockIndexerOptions = {}) {
    this.queries = options.queries ?? {};
    this.subscriptions = options.subscriptions ?? {};
    this.strict = options.strict ?? false;
  }

  async query(options: GraphQLQueryOptions): Promise<unknown> {
    if (this._destroyed) {
      throw new Error('MockGraphQLIndexer has been destroyed');
    }
    const q = options.query.trim();
    if (q in this.queries) {
      return this.queries[q];
    }
    if (this.strict) {
      throw new Error(`MockGraphQLIndexer: no preset response for query "${q}"`);
    }
    return undefined;
  }

  subscribe(options: GraphQLSubscriptionOptions): IndexerSubscription {
    if (this._destroyed) {
      throw new Error('MockGraphQLIndexer has been destroyed');
    }
    const q = options.query.trim();
    const events = this.subscriptions[q] ?? [];

    // Emit events on next tick so the caller can attach listeners first.
    const timers = events.map((evt, i) =>
      setTimeout(() => {
        if (!unsubscribed) {
          options.onData(evt);
        }
      }, i * 10),
    );

    let unsubscribed = false;
    return {
      unsubscribe: () => {
        if (unsubscribed) return;
        unsubscribed = true;
        for (const timer of timers) {
          clearTimeout(timer);
        }
      },
    };
  }

  getSubscriptionCount(): number {
    return 0;
  }

  cleanup(): void {
    this._destroyed = true;
  }
}

/**
 * Convenience factory for {@link MockGraphQLIndexer}.
 *
 * @example
 * ```ts
 * const indexer = createMockIndexer({
 *   queries: {
 *     'query { streams }': { streams: [] },
 *   },
 * });
 * ```
 */
export function createMockIndexer(options?: MockIndexerOptions): MockGraphQLIndexer {
  return new MockGraphQLIndexer(options);
}
