import { ConduitError, UNKNOWN_CONTRACT_ERROR_CODE } from './errors.js';
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


export class GraphQLIndexer {
  private endpoint: string;
  private activeSubscriptions: Set<IndexerSubscription> = new Set();
  private isDestroyed = false;
  private subCounter = 0;

  constructor(endpoint: string) {
    if (!endpoint || typeof endpoint !== 'string' || endpoint.trim().length === 0) {
      throw new Error('GraphQLIndexer endpoint must be a non-empty string');
    }
    this.endpoint = endpoint;
  }

  async query(options: GraphQLQueryOptions): Promise<unknown> {
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

    return body?.data;
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

    let unsubscribed = false;
    const subId = `sub_${++this.subCounter}_${Date.now()}`;

    let ws: WebSocket | null = null;
    let abortController: AbortController | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const clearReconnectTimer = (): void => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const subscription: IndexerSubscription = {
      unsubscribe: () => {
        if (unsubscribed) return;
        unsubscribed = true;
        clearReconnectTimer();

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
        if (unsubscribed || this.isDestroyed) return;
        this.handleError(
          options.onError,
          new Error(`GraphQL subscription WebSocket closed on ${this.endpoint}`),
        );
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
