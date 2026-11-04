import type { RpcHeaders } from '../types/rpc-headers.js';

/**
 * Wrap the global `fetch` so every outgoing request carries `headers`.
 *
 * The SDK's `ConduitConfig.customFetch` is the documented hook for
 * request-tracing headers, so `StreamFiProvider`'s `rpcHeaders` prop is
 * implemented by supplying one of these instead of monkey-patching `fetch`.
 *
 * Headers passed per request win over the defaults: a caller that already set
 * `Content-Type` (or anything else) keeps it. `Headers` handles the
 * case-insensitive merge, so `Authorization` and `authorization` do not
 * produce two entries.
 *
 * @param headers Headers applied to every request. An empty object is a no-op
 *   and the provider skips wrapping entirely, so the SDK keeps using the
 *   platform `fetch`.
 * @param baseFetch Fetch implementation to wrap. Defaults to `globalThis.fetch`
 *   at call time, so a polyfill installed after module load is still picked up.
 */
export function makeHeaderFetch(
  headers: RpcHeaders,
  baseFetch: typeof fetch = (...args) => globalThis.fetch(...args),
): typeof fetch {
  return (input, init) => {
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers)) {
      // `Headers` would stringify `undefined` into the literal "undefined",
      // so skip anything the caller left unset.
      if (value === undefined) continue;
      if (!merged.has(name)) merged.set(name, value);
    }
    return baseFetch(input, { ...init, headers: merged });
  };
}
