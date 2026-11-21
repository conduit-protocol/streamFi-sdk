/**
 * Custom `fetch` support for Soroban RPC traffic (#862).
 *
 * `@stellar/stellar-sdk` v12 issues every RPC request through a process-wide
 * axios instance and exposes no `fetch` hook, so a `ConduitConfig.customFetch`
 * (Cloudflare Workers, proxies, tracing headers, per-request timeouts) cannot
 * be handed to `SorobanRpc.Server` directly. Instead an axios request
 * interceptor routes requests for a registered RPC URL through the supplied
 * `fetch`, and leaves every other URL on axios's default adapter.
 *
 * Registration is therefore per RPC URL, process-wide: if two clients target
 * the same `rpcUrl` with different `customFetch` functions, the most recently
 * constructed one wins.
 */

import { SorobanRpc } from '@stellar/stellar-sdk';

/** Default per-request timeout for custom-fetch RPC calls (#926). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

interface Registration {
  fetch: typeof fetch;
  timeoutMs: number;
}

const registry = new Map<string, Registration>();
let installed = false;

/** Minimal slice of the axios request config the adapter reads. */
interface RequestConfig {
  url?: string;
  method?: string;
  data?: unknown;
  headers?: { toJSON?: () => Record<string, unknown> } & Record<string, unknown>;
  timeout?: number;
  signal?: AbortSignal;
  adapter?: unknown;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function headerRecord(config: RequestConfig): Record<string, string> {
  const raw = typeof config.headers?.toJSON === 'function' ? config.headers.toJSON() : config.headers ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

/** Gateway statuses retried for idempotent requests (#980). Other 5xx responses are not. */
const RETRYABLE_GATEWAY_STATUSES = new Set([502, 503, 504]);
/** HTTP 429 Too Many Requests — retried with Retry-After or exponential backoff. */
const RATE_LIMIT_STATUS = 429;
/** Retries after the first attempt, so an idempotent call makes at most 4 requests. */
const GATEWAY_MAX_RETRIES = 3;
/** Wait before retry `n` is `GATEWAY_BASE_DELAY_MS * 2 ** n`: 250, 500, then 1000 ms. */
const GATEWAY_BASE_DELAY_MS = 250;

/**
 * Soroban RPC is JSON-RPC over POST, so the HTTP method cannot tell a read from
 * a write. These JSON-RPC methods only read chain state or simulate. Leave
 * `sendTransaction` out: replaying it could submit the same transaction twice.
 */
const IDEMPOTENT_RPC_METHODS = new Set([
  'getHealth',
  'getNetwork',
  'getVersionInfo',
  'getLatestLedger',
  'getLedgers',
  'getLedgerEntries',
  'getTransaction',
  'getTransactions',
  'getEvents',
  'getFeeStats',
  'simulateTransaction',
]);

function isIdempotentRequest(config: RequestConfig): boolean {
  if ((config.method ?? 'post').toUpperCase() === 'GET') return true;

  let body: unknown = config.data;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return false;
    }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const method = (body as { method?: unknown }).method;
  return typeof method === 'string' && IDEMPOTENT_RPC_METHODS.has(method);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('RPC request aborted during gateway retry backoff'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Parse the Retry-After header to determine backoff delay in milliseconds.
 * Handles both delay-seconds and HTTP-date formats per RFC 7231.
 *
 * @param header - Value of the Retry-After response header.
 * @param defaultMs - Fallback delay if header is invalid.
 * @returns Delay in milliseconds to wait before retrying.
 */
function parseRetryAfter(header: string | null | undefined, defaultMs: number): number {
  if (!header || typeof header !== 'string') return defaultMs;

  const trimmed = header.trim();

  // Try parsing as delay-seconds (e.g., "120").
  const seconds = parseInt(trimmed, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try parsing as HTTP-date (e.g., "Wed, 21 Oct 2026 07:28:00 GMT").
  const retryDate = new Date(trimmed);
  if (!isNaN(retryDate.getTime())) {
    const delayMs = Math.max(0, retryDate.getTime() - Date.now());
    return delayMs;
  }

  return defaultMs;
}

/**
 * Re-runs `send` after a 502/503/504 or 429 response, with exponential backoff
 * or Retry-After header parsing, up to {@link GATEWAY_MAX_RETRIES} times.
 * Any other error, and any abort, is thrown through unchanged so callers see
 * the same error shape as before.
 */
async function retryGatewayErrors(send: () => Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (err) {
      const status = (err as { response?: { status?: unknown; headers?: Record<string, string> } } | null)?.response?.status;
      const headers = (err as { response?: { headers?: Record<string, string> } } | null)?.response?.headers ?? {};

      const isGatewayError = typeof status === 'number' && RETRYABLE_GATEWAY_STATUSES.has(status);
      const isRateLimit = status === RATE_LIMIT_STATUS;
      const retryable = isGatewayError || isRateLimit;

      if (!retryable || attempt >= GATEWAY_MAX_RETRIES || signal?.aborted) throw err;

      let delayMs: number;
      if (isRateLimit && headers['retry-after']) {
        delayMs = parseRetryAfter(headers['retry-after'], GATEWAY_BASE_DELAY_MS * 2 ** attempt);
      } else {
        delayMs = GATEWAY_BASE_DELAY_MS * 2 ** attempt;
      }

      await sleep(delayMs, signal);
    }
  }
}

async function fetchAdapter(config: RequestConfig): Promise<unknown> {
  const url = config.url ?? '';
  const registration = registry.get(stripTrailingSlash(url));
  if (!registration) throw new Error(`No custom fetch registered for ${url}`);

  const send = () => sendOnce(config, url, registration.fetch);
  return isIdempotentRequest(config) ? retryGatewayErrors(send, config.signal) : send();
}

async function sendOnce(config: RequestConfig, url: string, customFetch: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(config.signal?.reason);
  if (config.signal) {
    if (config.signal.aborted) controller.abort(config.signal.reason);
    else config.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  // Apply timeout via AbortSignal.timeout or manual timer, whichever is available.
  let timeoutSignal: AbortSignal | undefined;
  if (config.timeout && config.timeout > 0) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      timeoutSignal = AbortSignal.timeout(config.timeout);
    }
  }

  // If we have both a caller signal and a timeout, we need to listen to both.
  // Create a composite signal by mirroring the timeout signal's abort to our controller.
  if (timeoutSignal) {
    if (timeoutSignal.aborted) {
      controller.abort(new Error('RPC request timed out'));
    } else {
      timeoutSignal.addEventListener('abort', () => {
        if (!controller.signal.aborted) {
          controller.abort(timeoutSignal.reason ?? new Error('RPC request timed out'));
        }
      }, { once: true });
    }
  }

  const init: RequestInit = {
    method: (config.method ?? 'post').toUpperCase(),
    headers: headerRecord(config),
    signal: controller.signal,
  };
  if (config.data !== undefined) init.body = typeof config.data === 'string' ? config.data : JSON.stringify(config.data);

  let res: Response;
  let text: string;
  try {
    res = await customFetch(url, init);
    text = await res.text();
  } finally {
    config.signal?.removeEventListener('abort', onCallerAbort);
  }
  const response = {
    // axios's transformResponse parses JSON from a string body.
    data: text,
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries()),
    config,
    request: {},
  };

  if (res.status >= 200 && res.status < 300) return response;

  // Mirror axios's rejection shape: callers (RateLimitError.fromRpcError)
  // inspect `err.response.status` and `err.response.headers['retry-after']`.
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* keep raw text */ }
  throw Object.assign(new Error(`Request failed with status code ${res.status}`), {
    isAxiosError: true,
    config,
    response: { ...response, data },
  });
}

function install(): void {
  if (installed) return;
  installed = true;
  SorobanRpc.AxiosClient.interceptors.request.use((config) => {
    const req = config as unknown as RequestConfig;
    if (req.url && registry.has(stripTrailingSlash(req.url))) {
      req.adapter = fetchAdapter;
    }
    return config;
  });
}

/**
 * Route Soroban RPC requests for `rpcUrl` through `customFetch`. Each request
 * is aborted after `timeoutMs` (default {@link DEFAULT_REQUEST_TIMEOUT_MS});
 * pass `0` to disable the timeout.
 */
export function registerCustomFetch(
  rpcUrl: string,
  customFetch: typeof fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): void {
  if (typeof customFetch !== 'function') {
    throw new TypeError('customFetch must be a function');
  }
  install();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('timeoutMs must be a non-negative finite number');
  }
  registry.set(stripTrailingSlash(rpcUrl), { fetch: customFetch, timeoutMs });
}

/** Remove a registration made by {@link registerCustomFetch}. Mainly for tests. */
export function unregisterCustomFetch(rpcUrl: string): void {
  registry.delete(stripTrailingSlash(rpcUrl));
}
