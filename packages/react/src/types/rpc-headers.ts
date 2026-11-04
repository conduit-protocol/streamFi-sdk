/**
 * HTTP headers forwarded to every Soroban RPC request the provider's client
 * makes.
 *
 * The usual use is an RPC gateway that authenticates or traces by header —
 * a project-scoped API key, a trace id, a tenant discriminator. Values are
 * merged into the request by {@link makeHeaderFetch} in the React package, and
 * a header set per request still wins over the value here.
 */
export type RpcHeaders = Record<string, string | undefined>;
