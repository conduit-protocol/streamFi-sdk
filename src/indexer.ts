import { ConduitError, IndexerMaxPagesExceededError, UNKNOWN_CONTRACT_ERROR_CODE } from './errors.js';
import { IndexerTimeoutError, OperationAbortedError } from './errors.js';
import { bigintSafeStringify } from './utils.js';

export interface GraphQLQueryOptions {
  query: string;
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
  /**
   * Optional caller-supplied abort signal. When it fires, the in-flight
   * `fetch` is aborted and `query()` rejects with the resulting `AbortError`.
   * Use this to cancel a request from outside (e.g. when a component unmounts
   * or the user navigates away). Note that this is on top of the default
   * timeout — both surfaces can abort the request.
   */
  signal?: AbortSignal;
  /**
   * Timeout in milliseconds. When the indexer has not responded within this
   * window the request is aborted and `query()` rejects with an
   * {@link IndexerTimeoutError}. Defaults to 15_000ms (15s). Pass `0` or
   * `Infinity` to disable the SDK timeout entirely.
   */
  timeoutMs?: number;
  /**
   * Whether to use Automatic Persisted Queries (APQ). When `true` (default),
   * the client first sends a SHA-256 hash of the query and only falls back
   * to sending the full query string if the server reports
   * `PERSISTED_QUERY_NOT_FOUND`. Set to `false` to always send the full
   * query, e.g. for one-off queries the server has never seen.
   */
  persist?: boolean;
}

export interface IndexerQueryMetric {
  queryName: string;
  durationMs: number;
  success: boolean;
  error?: Error;
}

export interface IndexerConfig {
  endpoint: string;
  onQueryMetric?: (metric: IndexerQueryMetric) => void;
}

export interface GraphQLSubscriptionOptions {
  query: string;
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
  onData: (data: unknown) => void;
  onError?: (error: Error) => void;
  /** Matches WebSocketRelayer: how many reconnects after an unexpected close. Default 5. */
  maxReconnectAttempts?: number;
  /** Base delay in ms; actual wait uses capped exponential backoff (max 30s) with jitter. Default 1000. */
  reconnectDelayMs?: number;
  /**
   * Heartbeat interval (ms). When positive, the client sends a `ping` frame
   * every `heartbeatIntervalMs` and expects a `pong` back within
   * `heartbeatTimeoutMs`; if none arrives the socket is treated as half-open
   * (NAT timeout, device sleep) and force-reconnected. Defaults to 30_000ms.
   * Set to `0` to disable the heartbeat.
   */
  heartbeatIntervalMs?: number;
  /**
   * How long (ms) to wait for a `pong` after sending `ping` before assuming
   * the connection is dead and triggering a reconnect. Defaults to 5_000ms.
   */
  heartbeatTimeoutMs?: number;
}

export interface IndexerSubscription {
  unsubscribe: () => void;
}

/**
 * Minimal shape of a `graphql-transport-ws` server message. Every member is
 * `unknown` because the payload crosses a network boundary — `JSON.parse`
 * hands back `any`, which would silently defeat `noImplicitAny` for every
 * property read below.
 */
/**
 * APQ extension payload sent in place of the full query string when the
 * indexer supports Automatic Persisted Queries.
 */
interface PersistedQueryExtensions {
  persistedQuery: {
    version: 1;
    sha256Hash: string;
  };
}

interface GraphQLServerMessage {
  type?: unknown;
  payload?: unknown;
  data?: unknown;
  errors?: unknown;
}

/**
 * Default request timeout (ms) for {@link GraphQLIndexer.query}. Matches the
 * 15s budget the dashboard assumes in its abort handling (see
 * `dashboard/transaction-history.ts` and `examples/dashboard/.../apollo-client.ts`).
 */
export const DEFAULT_INDEXER_TIMEOUT_MS = 15_000;

/**
 * The default upper bound on the number of pages {@link GraphQLIndexer.fetchAll}
 * will request before throwing an {@link IndexerMaxPagesExceededError}.
 * Override per-call via `fetchAllOptions.maxPages`.
 */
export const DEFAULT_INDEXER_MAX_PAGES = 1_000;

/**
 * Options accepted by {@link GraphQLIndexer.fetchAll} (typed variant).
 */
export interface FetchAllOptions<TPage> {
  /**
   * The initial GraphQL query options (same shape as {@link GraphQLQueryOptions}).
   * `variables` will be merged with `{ cursor }` on every subsequent page.
   */
  query: string;
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
  /**
   * Called after each page is fetched. Return the cursor string to use for
   * the next page, or `null` / `undefined` when there are no more pages.
   */
  getNextCursor: (page: TPage) => string | null | undefined;
  /**
   * Maximum number of pages to fetch before throwing
   * {@link IndexerMaxPagesExceededError}. Defaults to
   * {@link DEFAULT_INDEXER_MAX_PAGES} (1 000).
   */
  maxPages?: number;
}

/**
 * Computes the SHA-256 hex digest of `input` using the Web Crypto API,
 * falling back to Node's `crypto` module when `crypto.subtle` is not
 * available. Required for APQ hash generation.
 */
async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Node.js < 19 fallback: the dynamic import is only evaluated when the
  // Web Crypto API is absent, so bundlers targeting modern browsers can elide it.
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}

function isPersistedQueryNotFound(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (error) =>
      error &&
      typeof error === 'object' &&
      ((error as { message?: string }).message ?? '').includes('PERSISTED_QUERY_NOT_FOUND'),
  );
}

/** Relay-style page metadata decoded from a GraphQL `pageInfo` object. */
export interface IndexerPageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

/** A single cursor-paginated page of results. */
export interface IndexerPage<T> {
  items: T[];
  pageInfo: IndexerPageInfo;
}

/** Options for {@link GraphQLIndexer.fetchStreamsBySender}. */
export interface FetchStreamsBySenderOptions
  extends Omit<GraphQLQueryOptions, 'query' | 'variables'> {
  /** Page size when paging forward (with or without `afterCursor`). */
  first?: number;
  /** Page size when paging backward with `beforeCursor`. */
  last?: number;
  /** Return items after this cursor (a previous page's `pageInfo.endCursor`). */
  afterCursor?: string;
  /** Return items before this cursor (a previous page's `pageInfo.startCursor`). */
  beforeCursor?: string;
}

function decodePageInfo(raw: unknown): IndexerPageInfo {
  const info = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    hasNextPage: info.hasNextPage === true,
    hasPreviousPage: info.hasPreviousPage === true,
    startCursor: typeof info.startCursor === 'string' ? info.startCursor : null,
    endCursor: typeof info.endCursor === 'string' ? info.endCursor : null,
  };
}

interface PaginatedCollection {
  items: unknown[];
  hasNextPage: boolean;
  endCursor?: string;
}

function findPaginatedCollection(value: unknown): PaginatedCollection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const itemsKey = ['items', 'nodes', 'results'].find((key) => Array.isArray(candidate[key]));
    const pageInfo = candidate.pageInfo;
    if (itemsKey && pageInfo && typeof pageInfo === 'object') {
      const info = pageInfo as Record<string, unknown>;
      const result: PaginatedCollection = {
        items: candidate[itemsKey] as unknown[],
        hasNextPage: info.hasNextPage === true,
      };
      if (typeof info.endCursor === 'string') result.endCursor = info.endCursor;
      return result;
    }
    const nested = findPaginatedCollection(entry);
    if (nested) return nested;
  }
  return undefined;
}


/** A detected skip in an otherwise-monotonic ledger sequence. */
export interface LedgerGap {
  /** The ledger sequence that should have come next (`currentLedger + 1`). */
  expected: number;
  /** The ledger sequence actually observed. */
  actual: number;
}

/**
 * Tracks a monotonically increasing ledger sequence and flags a skip —
 * `nextLedger !== currentLedger + 1` — so a streaming poller can trigger a
 * backfill fetch instead of silently continuing past missed ledgers (a
 * network hiccup during polling would otherwise corrupt off-chain balance
 * indexing and state projections built from the stream).
 *
 * This is framework-agnostic: feed it any monotonically-intended ledger
 * sequence (e.g. each dispatched event's `event.ledger`) from whichever
 * poller observes it.
 */
export class LedgerGapDetector {
  private current: number | undefined;

  /** The last ledger sequence observed, or `undefined` before the first `observe()` call. */
  get currentLedger(): number | undefined {
    return this.current;
  }

  /**
   * Records the next observed ledger sequence.
   *
   * Returns the detected {@link LedgerGap} if `ledger` is not exactly one
   * past the previously observed ledger, otherwise `undefined`. A `ledger`
   * at or behind the current value (a duplicate or re-ordered delivery) is
   * recorded without being treated as a gap.
   */
  observe(ledger: number): LedgerGap | undefined {
    if (!Number.isInteger(ledger) || ledger < 0) {
      throw new Error(`LedgerGapDetector.observe: ledger must be a non-negative integer, got ${String(ledger)}`);
    }

    let gap: LedgerGap | undefined;
    if (this.current !== undefined && ledger > this.current + 1) {
      gap = { expected: this.current + 1, actual: ledger };
    }
    if (this.current === undefined || ledger > this.current) {
      this.current = ledger;
    }
    return gap;
  }

  /** Clears the tracked ledger so the next `observe()` call cannot be flagged as a gap. */
  reset(): void {
    this.current = undefined;
  }
}

export class GraphQLIndexer {
  private endpoint: string;
  private readonly onQueryMetric: ((metric: IndexerQueryMetric) => void) | undefined;
  private activeSubscriptions: Set<IndexerSubscription> = new Set();
  private isDestroyed = false;
  private subCounter = 0;

  constructor(endpointOrConfig: string | IndexerConfig) {
    const endpoint = typeof endpointOrConfig === 'string' ? endpointOrConfig : endpointOrConfig?.endpoint;
    if (!endpoint || typeof endpoint !== 'string' || endpoint.trim().length === 0) {
      throw new Error('GraphQLIndexer endpoint must be a non-empty string');
    }
    this.endpoint = endpoint;
    this.onQueryMetric = typeof endpointOrConfig === 'string' ? undefined : endpointOrConfig.onQueryMetric;
  }

  /**
   * Issues a single GraphQL query as an HTTP POST and returns the unwrapped data payload.
   *
   * **Return Contract (Unwrapped Data)**:
   * Unlike raw GraphQL HTTP clients that return the `{ data, errors }` envelope,
   * `GraphQLIndexer.query()` automatically unwraps the payload and returns `body.data`
   * directly. If the GraphQL endpoint returns any errors in `errors[]`, `query()`
   * aggregates them and throws a {@link ConduitError}.
   *
   * Supply the generic type parameter `<T = unknown>` to strongly type the returned data:
   * ```typescript
   * interface StreamCountResponse {
   *   streamCount: number;
   * }
   * const data = await indexer.query<StreamCountResponse>({ query: 'query { streamCount }' });
   * console.log(data.streamCount);
   * ```
   *
   * @template T The expected type of the unwrapped `data` payload (defaults to `unknown`).
   * @param options Query configuration including query string, variables, headers, timeoutMs, and signal.
   * @returns The unwrapped `body.data` payload typed as `T`.
   */
  async query<T = unknown>(options: GraphQLQueryOptions): Promise<T> {
    const startedAt = Date.now();
    const queryName = this.getQueryName(options?.query);
    try {
      const result = await this.queryInternal<T>(options);
      this.emitQueryMetric({ queryName, durationMs: Date.now() - startedAt, success: true });
      return result;
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.emitQueryMetric({ queryName, durationMs: Date.now() - startedAt, success: false, error: normalizedError });
      throw error;
    }
  }

  private async queryInternal<T = unknown>(options: GraphQLQueryOptions): Promise<T> {
    if (this.isDestroyed) {
      throw new Error('GraphQLIndexer has been destroyed');
    }
    if (!options || typeof options !== 'object') {
      throw new Error('GraphQLQueryOptions cannot be null or undefined');
    }
    if (!options.query || typeof options.query !== 'string' || options.query.trim().length === 0) {
      throw new Error('GraphQL query string cannot be null or empty');
    }

    const variables = options.variables ?? {};
    if (typeof variables !== 'object' || variables === null) {
      throw new Error('GraphQL query variables must be an object');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    };

    const fetchFn = typeof fetch !== 'undefined' ? fetch : (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (typeof fetchFn !== 'function') {
      throw new Error('Fetch API is not available in the current environment');
    }

    const persist = options.persist !== false;
    const extensions: PersistedQueryExtensions | undefined = persist
      ? { persistedQuery: { version: 1, sha256Hash: await sha256hex(options.query) } }
      : undefined;

    let body = await this.executeGraphQLRequest(
      fetchFn,
      headers,
      { query: persist ? null : options.query, variables, extensions },
      options.timeoutMs,
      options.signal,
    );

    // APQ fallback: the server has not seen this query hash yet, so replay
    // with the full query string plus the hash so the server can cache it.
    if (persist && isPersistedQueryNotFound(body)) {
      body = await this.executeGraphQLRequest(
        fetchFn,
        headers,
        { query: options.query, variables, extensions },
        options.timeoutMs,
        options.signal,
      );
    }

    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const messages = body.errors
        .map((error) => {
          if (error && typeof error === 'object' && 'message' in error) {
            const message = (error as { message?: unknown }).message;
            return typeof message === 'string' && message.length > 0 ? message : JSON.stringify(error);
          }
          return String(error);
        })
        .filter((message) => message.length > 0);

      throw new ConduitError('stream', UNKNOWN_CONTRACT_ERROR_CODE, messages.join('; '));
    }

    return (body?.data) as T;
  }

  private getQueryName(query: unknown): string {
    if (typeof query !== 'string') return 'unknown';
    const match = query.match(/\b(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    return match?.[1] ?? 'anonymous';
  }

  private emitQueryMetric(metric: IndexerQueryMetric): void {
    try {
      this.onQueryMetric?.(metric);
    } catch {
      // Telemetry must never change query behavior.
    }
  }

  /**
   * Fetches every page of a cursor-based GraphQL collection.
   *
   * The response is expected to contain one collection with an `items`,
   * `nodes`, or `results` array and GraphQL-style `pageInfo`. The helper
   * preserves the original query and updates its `variables.cursor` value.
   *
   * @deprecated Use the typed {@link fetchAll} overload with {@link FetchAllOptions}
   * and a `getNextCursor` callback instead, which provides stronger types and
   * throws {@link IndexerMaxPagesExceededError} on page-limit violations.
   */
  async fetchAllAuto(options: GraphQLQueryOptions): Promise<unknown[]> {
    const results: unknown[] = [];
    let cursor: unknown = options.variables?.cursor;

    for (let page = 0; page < DEFAULT_INDEXER_MAX_PAGES; page++) {
      const data = await this.query({
        ...options,
        variables: { ...(options.variables ?? {}), cursor },
      });
      const collection = findPaginatedCollection(data);
      if (!collection) {
        throw new Error('GraphQLIndexer.fetchAllAuto expected a paginated collection response');
      }
      results.push(...collection.items);

      if (!collection.hasNextPage) return results;
      if (typeof collection.endCursor !== 'string' || collection.endCursor.length === 0) {
        throw new Error('GraphQLIndexer.fetchAllAuto received a page with no next cursor');
      }
      if (collection.endCursor === cursor) {
        throw new Error('GraphQLIndexer.fetchAllAuto received an unchanged pagination cursor');
      }
      cursor = collection.endCursor;
    }

    throw new IndexerMaxPagesExceededError(DEFAULT_INDEXER_MAX_PAGES, DEFAULT_INDEXER_MAX_PAGES);
  }

  /**
   * Issues a single GraphQL POST and parses the JSON response. Extracted so
   * APQ can retry with the full query string without duplicating fetch,
   * timeout, and error-handling logic.
   */
  private async executeGraphQLRequest(
    fetchFn: typeof fetch,
    headers: Record<string, string>,
    payload: { query: string | null; variables: Record<string, unknown>; extensions?: PersistedQueryExtensions | undefined },
    timeoutMs: number | undefined,
    callerSignal?: AbortSignal,
  ): Promise<{ data?: unknown; errors?: unknown[] }> {
    const response = await this.fetchWithTimeout(
      fetchFn,
      this.endpoint,
      headers,
      JSON.stringify({ ...payload, variables: bigintSafeStringify(payload.variables) }),
      timeoutMs,
      callerSignal,
    );

    if (!response.ok) {
      throw new Error(`GraphQL query failed with status ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as { data?: unknown; errors?: unknown[] };
  }

    /**
   * Runs a single GraphQL POST against the indexer, combining the SDK's
   * default timeout (or the caller's `timeoutMs`) with any caller-supplied
   * `AbortSignal`. If the request does not complete within the time window
   * the `AbortController` fires and the promise rejects with an
   * {@link IndexerTimeoutError}; an externally-aborted request instead
   * surfaces the underlying `AbortError`. See #569.
   */
  private async fetchWithTimeout(
    fetchFn: typeof fetch,
    endpoint: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number | undefined,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    // `undefined` is a valid ECMA-262/TS number (Infinity); `0` and `NaN`
    // both disable the timeout too. Cubed to a sane default otherwise.
    const effectiveTimeout =
      timeoutMs === undefined ? DEFAULT_INDEXER_TIMEOUT_MS : timeoutMs;
    const useTimeout =
      typeof effectiveTimeout === 'number' &&
      Number.isFinite(effectiveTimeout) &&
      effectiveTimeout > 0;

    // If the caller already aborted, fail fast without issuing the request.
    if (callerSignal?.aborted) {
      throw new OperationAbortedError('GraphQLIndexer.query');
    }

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) {
        // Handled above, but keep safety for races.
        controller.abort();
      } else {
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (useTimeout) {
      timer = setTimeout(() => controller.abort(), effectiveTimeout);
    }

    try {
      return await fetchFn(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (useTimeout && controller.signal.aborted && !(callerSignal && callerSignal.aborted)) {
        // The SDK's timeout aborted the request (and the caller's own signal
        // was not the trigger), so report it as an indexer timeout.
        throw new IndexerTimeoutError(endpoint, effectiveTimeout);
      }
      throw err;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (callerSignal) {
        callerSignal.removeEventListener('abort', onCallerAbort);
      }
    }
  }

  subscribe(options: GraphQLSubscriptionOptions): IndexerSubscription {
    if (this.isDestroyed) {
      throw new Error('GraphQLIndexer has been destroyed');
    }
    if (!options || typeof options !== 'object') {
      throw new Error('GraphQLSubscriptionOptions cannot be null or undefined');
    }
    if (!options.query || typeof options.query !== 'string' || options.query.trim().length === 0) {
      throw new Error('GraphQL subscription query string cannot be null or empty');
    }
    if (typeof options.onData !== 'function') {
      throw new Error('GraphQL subscription onData callback must be a function');
    }

    const variables = options.variables ?? {};
    if (typeof variables !== 'object' || variables === null) {
      throw new Error('GraphQL query variables must be an object');
    }

    const maxReconnectAttempts = this.parseBoundedInt(
      options.maxReconnectAttempts,
      5,
      0,
      32,
      'maxReconnectAttempts',
    );
    const reconnectDelayMs = this.parseBoundedInt(
      options.reconnectDelayMs,
      1000,
      0,
      60_000,
      'reconnectDelayMs',
    );
    const heartbeatIntervalMs = this.parseBoundedInt(
      options.heartbeatIntervalMs,
      30_000,
      0,
      600_000,
      'heartbeatIntervalMs',
    );
    const heartbeatTimeoutMs = this.parseBoundedInt(
      options.heartbeatTimeoutMs,
      5_000,
      0,
      600_000,
      'heartbeatTimeoutMs',
    );

    let unsubscribed = false;
    const subId = `sub_${++this.subCounter}_${Date.now()}`;

    let ws: WebSocket | null = null;
    let abortController: AbortController | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
    let awaitingPong = false;

    const clearReconnectTimer = (): void => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const clearHeartbeatTimeout = (): void => {
      if (heartbeatTimeout !== null) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = null;
      }
    };

    const stopHeartbeat = (): void => {
      clearHeartbeatTimeout();
      if (heartbeatInterval !== null) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      awaitingPong = false;
    };

    /**
     * Schedule a reconnect using the same capped exponential backoff already
     * used by {@link socket.onclose}. Extracted so a dead socket whose
     * `close()` never fires `onclose` (the classic half-open failure) can drive
     * a reconnect itself after a heartbeat timeout.
     */
    const scheduleReconnect = (): void => {
      if (unsubscribed || this.isDestroyed) return;
      if (reconnectAttempts >= maxReconnectAttempts) {
        this.handleError(
          options.onError,
          new Error(
            `GraphQL subscription WebSocket closed on ${this.endpoint} after ${maxReconnectAttempts} reconnect attempts exhausted`,
          ),
        );
        subscription.unsubscribe();
        return;
      }
      reconnectAttempts += 1;
      const baseDelay = reconnectDelayMs * reconnectAttempts;
      const cappedDelay = Math.min(baseDelay, 30_000);
      const jitter = Math.random() * 0.3 * cappedDelay;
      const delay = cappedDelay + jitter;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (unsubscribed || this.isDestroyed) return;
        openSocket();
      }, delay);
    };

    /**
     * Drive the keepalive ping/pong heartbeat for one socket. Every
     * `heartbeatIntervalMs` (when the socket is OPEN and we are not already
     * awaiting a `pong`) we send a `ping` and arm a `heartbeatTimeoutMs`
     * timer; if no `pong` comes back in time, the connection is considered
     * dead and force-reconnected.
     */
    const startHeartbeat = (socket: WebSocket): void => {
      stopHeartbeat();
      if (!(heartbeatIntervalMs > 0)) return;
      heartbeatInterval = setInterval(() => {
        if (unsubscribed || this.isDestroyed) return;
        if (socket.readyState === 1 /* OPEN */ && !awaitingPong) {
          try {
            socket.send(JSON.stringify({ type: 'ping' }));
            awaitingPong = true;
            heartbeatTimeout = setTimeout(() => {
              if (awaitingPong) {
                handleHeartbeatTimeout();
              }
            }, heartbeatTimeoutMs);
          } catch {
            // Ignore send errors — the next interval will retry.
          }
        }
      }, heartbeatIntervalMs);
    };

    /**
     * No `pong` arrived in time: the socket is half-open. `close()` on such a
     * socket may never fire `onclose`, so detach the dead socket and drive the
     * reconnect ourselves rather than waiting on an event that may never come.
     */
    const handleHeartbeatTimeout = (): void => {
      const dead = ws;
      stopHeartbeat();
      ws = null;
      if (dead) {
        dead.onopen = null;
        dead.onmessage = null;
        dead.onerror = null;
        dead.onclose = null;
        try {
          dead.close();
        } catch {
          // Socket already closed/closing; nothing to clean up.
        }
      }
      scheduleReconnect();
    };

    const subscription: IndexerSubscription = {
      unsubscribe: () => {
        if (unsubscribed) return;
        unsubscribed = true;
        clearReconnectTimer();
        stopHeartbeat();

        if (ws) {
          try {
            ws.onclose = null;
            ws.onerror = null;
            ws.onmessage = null;
            ws.onopen = null;
            if (ws.readyState === 1 /* OPEN */) {
              ws.send(JSON.stringify({ id: subId, type: 'complete' }));
            }
            ws.close();
          } catch {
            // Ignore socket closure errors
          }
          ws = null;
        }

        if (abortController) {
          try {
            abortController.abort();
          } catch {
            // Ignore abort error
          }
          abortController = null;
        }

        this.activeSubscriptions.delete(subscription);
      },
    };

    this.activeSubscriptions.add(subscription);

    const openSocket = (): void => {
      if (unsubscribed || this.isDestroyed) return;
      const WebSocketCtor = this.getWebSocketCtor();
      if (!WebSocketCtor) return;

      const wsUrl = this.getWsUrl(this.endpoint);
      let socket: WebSocket;
      try {
        try {
          socket = new WebSocketCtor(wsUrl, 'graphql-transport-ws');
        } catch {
          socket = new WebSocketCtor(wsUrl);
        }
      } catch (err) {
        this.handleError(options.onError, err);
        return;
      }
      ws = socket;
      let queuedSubscribeMessage: string | null = null;

      socket.onopen = () => {
        if (unsubscribed || this.isDestroyed) {
          subscription.unsubscribe();
          return;
        }
        reconnectAttempts = 0;
        startHeartbeat(socket);
        try {
          socket.send(JSON.stringify({ type: 'connection_init' }));
          queuedSubscribeMessage = JSON.stringify({
            id: subId,
            type: 'subscribe',
            payload: {
              query: options.query,
              variables: bigintSafeStringify(variables),
            },
          });
        } catch (err) {
          this.handleError(options.onError, err);
        }
      };

      socket.onmessage = (event: MessageEvent) => {
        if (unsubscribed || this.isDestroyed) return;
        try {
          const raw: unknown =
            typeof event.data === 'string'
              ? (JSON.parse(event.data) as unknown)
              : (event.data as unknown);
          if (!raw || typeof raw !== 'object') return;
          const data = raw as GraphQLServerMessage;

          // Heartbeat keepalive (graphql-transport-ws).
          if (data.type === 'ping') {
            // Server-initiated keepalive — the client MUST respond with pong.
            try {
              socket.send(JSON.stringify({ type: 'pong' }));
            } catch {
              // Ignore send errors — the next ping will retry.
            }
            return;
          }
          if (data.type === 'pong') {
            // Response to our heartbeat ping: the link is alive.
            awaitingPong = false;
            clearHeartbeatTimeout();
            return;
          }

          if (data.type === 'connection_ack') {
            if (queuedSubscribeMessage !== null) {
              socket.send(queuedSubscribeMessage);
              queuedSubscribeMessage = null;
            }
            return;
          }

          if (data.type === 'next' || data.type === 'data') {
            const payload = data.payload ?? data.data;
            options.onData(payload);
          } else if (data.type === 'error') {
            const errPayload = data.payload ?? data.errors;
            const errMsg = typeof errPayload === 'string' ? errPayload : JSON.stringify(errPayload);
            this.handleError(options.onError, new Error(errMsg));
          }
        } catch (err) {
          this.handleError(options.onError, err);
        }
      };

      socket.onerror = (_event: Event) => {
        if (unsubscribed || this.isDestroyed) return;
        this.handleError(options.onError, new Error(`GraphQL subscription WebSocket error on ${this.endpoint}`));
      };

      socket.onclose = () => {
        stopHeartbeat();
        if (unsubscribed || this.isDestroyed) return;
        this.handleError(
          options.onError,
          new Error(`GraphQL subscription WebSocket closed on ${this.endpoint}`),
        );
        scheduleReconnect();
      };
    };

    const WebSocketCtor = this.getWebSocketCtor();
    if (WebSocketCtor) {
      openSocket();
    } else {
      const fetchFn = typeof fetch !== 'undefined' ? fetch : (globalThis as unknown as { fetch?: typeof fetch }).fetch;
      if (typeof fetchFn === 'function' && typeof AbortController !== 'undefined') {
        abortController = new AbortController();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream, application/json',
          ...options.headers,
        };

        fetchFn(this.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query: options.query, variables: bigintSafeStringify(variables) }),
          signal: abortController.signal,
        })
          .then(async (response: Response) => {
            if (unsubscribed || this.isDestroyed) return;
            if (!response.ok) {
              this.handleError(options.onError, new Error(`GraphQL subscription HTTP error: ${response.status}`));
              return;
            }
            if (response.body && typeof response.body.getReader === 'function') {
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
              while (!unsubscribed && !this.isDestroyed) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed.startsWith('data:')) {
                    const dataStr = trimmed.slice(5).trim();
                    if (dataStr === '[DONE]') break;
                    try {
                      const parsed = JSON.parse(dataStr) as unknown;
                      const inner =
                        parsed && typeof parsed === 'object'
                          ? (parsed as GraphQLServerMessage).data
                          : undefined;
                      options.onData(inner ?? parsed);
                    } catch {
                      // Ignore malformed line
                    }
                  }
                }
              }
            }
          })
          .catch((err: unknown) => {
            const isAbort = err instanceof Error && err.name === 'AbortError';
            if (!unsubscribed && !this.isDestroyed && !isAbort) {
              this.handleError(options.onError, err);
            }
          });
      }
    }

    return subscription;
  }

  /**
   * Fetches all pages of a paginated GraphQL query and returns the
   * accumulated results as a single array.
   *
   * Each successive page is requested by merging the cursor returned by
   * `getNextCursor` into the query variables as `{ cursor }`. Pagination
   * stops when `getNextCursor` returns `null` or `undefined`.
   *
   * Throws {@link IndexerMaxPagesExceededError} (not a plain `Error`) if more
   * than `maxPages` (default {@link DEFAULT_INDEXER_MAX_PAGES}) pages are
   * required, so callers can `instanceof`-check for the page-limit case
   * independently of network failures or timeouts. See #801.
   *
   * @example
   * ```ts
   * const rows = await indexer.fetchAll<{ transfers: Transfer[] }>({
   *   query: LIST_TRANSFERS_QUERY,
   *   variables: { limit: 100 },
   *   getNextCursor: (page) => page.transfers.at(-1)?.cursor ?? null,
   * });
   * ```
   */
  async fetchAll<TPage>(options: FetchAllOptions<TPage>): Promise<TPage[]> {
    const maxPages = options.maxPages ?? DEFAULT_INDEXER_MAX_PAGES;
    const pages: TPage[] = [];
    let cursor: string | null | undefined = undefined;
    let pagesFetched = 0;

    // Paginate until the indexer stops returning a cursor. The loop condition
    // is explicit rather than `while (true)` so the exit paths are visible.
    for (;;) {
      if (pagesFetched >= maxPages) {
        throw new IndexerMaxPagesExceededError(pagesFetched, maxPages);
      }

      const variables: Record<string, unknown> = {
        ...options.variables,
        ...(cursor != null ? { cursor } : {}),
      };

      const result = await this.query({
        query: options.query,
        variables,
        ...(options.headers != null ? { headers: options.headers } : {}),
      });

      pages.push(result as TPage);
      pagesFetched += 1;

      cursor = options.getNextCursor(result as TPage);
      if (cursor == null) break;
    }

    return pages;
  }

  getSubscriptionCount(): number {
    return this.activeSubscriptions.size;
  }

  cleanup(): void {
    this.isDestroyed = true;
    for (const sub of Array.from(this.activeSubscriptions)) {
      sub.unsubscribe();
    }
    this.activeSubscriptions.clear();
  }

  /**
   * Convenience method to query all streams sent by a specific address.
   *
   * Builds and executes a GraphQL query to fetch all streams where the given
   * address is the sender. Uses the standard pagination pattern expected by
   * most Conduit indexers.
   *
   * @template T The type of stream objects returned by the indexer
   * @param senderAddress The sender's Stellar account address
   * @param options Optional query configuration (timeoutMs, signal, etc.)
   * @returns The query response data (typically contains paginated stream results)
   */
  async streamsBySender<T = unknown>(
    senderAddress: string,
    options?: Omit<GraphQLQueryOptions, 'query' | 'variables'>,
  ): Promise<T> {
    const query = `
      query StreamsBySender($sender: String!) {
        streamsBySender(sender: $sender) {
          items {
            id
            sender
            recipient
            token
            ratePerSecond
            startTime
            endTime
            withdrawn
            deposited
            paused
            pausedAt
            cancelled
            clawbackEnabled
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;
    return this.query<T>({
      ...options,
      query,
      variables: { sender: senderAddress },
    });
  }

  /**
   * Cursor-paginated variant of {@link streamsBySender}.
   *
   * Uses Relay-style `first`/`after` (forward) or `last`/`before` (backward)
   * arguments instead of offset/limit, so deep pages cost the same as the
   * first and records created between page fetches cannot shift the window.
   * The returned `pageInfo` is decoded so callers can feed `endCursor` /
   * `startCursor` straight back in as `afterCursor` / `beforeCursor`.
   *
   * @param senderAddress The sender's Stellar account address
   * @param options Page size, cursors and query configuration
   * @throws if both `afterCursor` and `beforeCursor` are given, if a cursor is
   *   mixed with the opposite page-size argument, or if a page size is not a
   *   positive integer
   */
  async fetchStreamsBySender<T = unknown>(
    senderAddress: string,
    options: FetchStreamsBySenderOptions = {},
  ): Promise<IndexerPage<T>> {
    const { first, last, afterCursor, beforeCursor, ...queryOptions } = options;

    if (afterCursor !== undefined && beforeCursor !== undefined) {
      throw new Error('fetchStreamsBySender: afterCursor and beforeCursor are mutually exclusive');
    }
    for (const [name, size] of [['first', first], ['last', last]] as const) {
      if (size !== undefined && (!Number.isInteger(size) || size < 1)) {
        throw new Error(`fetchStreamsBySender: ${name} must be a positive integer`);
      }
    }
    if (first !== undefined && last !== undefined) {
      throw new Error('fetchStreamsBySender: first and last are mutually exclusive');
    }
    if (beforeCursor !== undefined && first !== undefined) {
      throw new Error('fetchStreamsBySender: beforeCursor must be paired with last, not first');
    }
    if (afterCursor !== undefined && last !== undefined) {
      throw new Error('fetchStreamsBySender: afterCursor must be paired with first, not last');
    }

    const backward = beforeCursor !== undefined || last !== undefined;
    const variables: Record<string, unknown> = { sender: senderAddress };
    if (backward) {
      if (last !== undefined) variables.last = last;
      if (beforeCursor !== undefined) variables.before = beforeCursor;
    } else {
      if (first !== undefined) variables.first = first;
      if (afterCursor !== undefined) variables.after = afterCursor;
    }

    const query = `
      query FetchStreamsBySender($sender: String!, $first: Int, $after: String, $last: Int, $before: String) {
        streamsBySender(sender: $sender, first: $first, after: $after, last: $last, before: $before) {
          items {
            id
            sender
            recipient
            token
            ratePerSecond
            startTime
            endTime
            withdrawn
            deposited
            paused
            pausedAt
            cancelled
            clawbackEnabled
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }
    `;
    const data = await this.query<{
      streamsBySender?: { items?: T[]; nodes?: T[]; results?: T[]; pageInfo?: unknown };
    }>({ ...queryOptions, query, variables });

    const connection = data?.streamsBySender;
    return {
      items: connection?.items ?? connection?.nodes ?? connection?.results ?? [],
      pageInfo: decodePageInfo(connection?.pageInfo),
    };
  }

  /**
   * Convenience method to query all streams received by a specific address.
   *
   * Builds and executes a GraphQL query to fetch all streams where the given
   * address is the recipient. Uses the standard pagination pattern expected by
   * most Conduit indexers.
   *
   * @template T The type of stream objects returned by the indexer
   * @param recipientAddress The recipient's Stellar account address
   * @param options Optional query configuration (timeoutMs, signal, etc.)
   * @returns The query response data (typically contains paginated stream results)
   */
  async streamsByRecipient<T = unknown>(
    recipientAddress: string,
    options?: Omit<GraphQLQueryOptions, 'query' | 'variables'>,
  ): Promise<T> {
    const query = `
      query StreamsByRecipient($recipient: String!) {
        streamsByRecipient(recipient: $recipient) {
          items {
            id
            sender
            recipient
            token
            ratePerSecond
            startTime
            endTime
            withdrawn
            deposited
            paused
            pausedAt
            cancelled
            clawbackEnabled
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;
    return this.query<T>({
      ...options,
      query,
      variables: { recipient: recipientAddress },
    });
  }

  private getWebSocketCtor(): (new (url: string | URL, protocols?: string | string[]) => WebSocket) | null {
    if (typeof globalThis !== 'undefined' && 'WebSocket' in globalThis && typeof (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket === 'function') {
      return (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket ?? null;
    }
    if (typeof WebSocket !== 'undefined' && typeof WebSocket === 'function') {
      return WebSocket;
    }
    return null;
  }

  private getWsUrl(endpoint: string): string {
    if (endpoint.startsWith('https://')) {
      return 'wss://' + endpoint.slice(8);
    }
    if (endpoint.startsWith('http://')) {
      return 'ws://' + endpoint.slice(7);
    }
    return endpoint;
  }

  private parseBoundedInt(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    name: string,
  ): number {
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`GraphQL subscription ${name} must be an integer between ${min} and ${max}`);
    }
    return value;
  }

  private handleError(onError: ((err: Error) => void) | undefined, err: unknown): void {
    if (onError && typeof onError === 'function') {
      try {
        onError(err instanceof Error ? err : new Error(String(err)));
      } catch {
        // Prevent uncaught errors from user error handlers
      }
    }
  }
}
