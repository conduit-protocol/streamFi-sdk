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

const registry = new Map<string, typeof fetch>();
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

async function fetchAdapter(config: RequestConfig): Promise<unknown> {
  const url = config.url ?? '';
  const customFetch = registry.get(stripTrailingSlash(url));
  if (!customFetch) throw new Error(`No custom fetch registered for ${url}`);

  const signals: AbortSignal[] = [];
  if (config.signal) signals.push(config.signal);
  if (config.timeout && config.timeout > 0 && typeof AbortSignal.timeout === 'function') {
    signals.push(AbortSignal.timeout(config.timeout));
  }

  const init: RequestInit = {
    method: (config.method ?? 'post').toUpperCase(),
    headers: headerRecord(config),
  };
  if (config.data !== undefined) init.body = typeof config.data === 'string' ? config.data : JSON.stringify(config.data);
  if (signals.length === 1) init.signal = signals[0]!;
  else if (signals.length > 1 && typeof AbortSignal.any === 'function') init.signal = AbortSignal.any(signals);

  const res = await customFetch(url, init);
  const text = await res.text();
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

/** Route Soroban RPC requests for `rpcUrl` through `customFetch`. */
export function registerCustomFetch(rpcUrl: string, customFetch: typeof fetch): void {
  if (typeof customFetch !== 'function') {
    throw new TypeError('customFetch must be a function');
  }
  install();
  registry.set(stripTrailingSlash(rpcUrl), customFetch);
}

/** Remove a registration made by {@link registerCustomFetch}. Mainly for tests. */
export function unregisterCustomFetch(rpcUrl: string): void {
  registry.delete(stripTrailingSlash(rpcUrl));
}
