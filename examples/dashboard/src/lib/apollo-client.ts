import { ApolloClient, InMemoryCache, HttpLink } from "@apollo/client";

/**
 * Default timeout (ms) for GraphQL requests to the indexer.
 * If the RPC provider / indexer does not respond within this window the
 * fetch is aborted so the Apollo loading state is always cleared — fixes
 * the infinite-spinner bug (#158) where a timed-out request left the
 * Profile Page stuck in a permanent loading state.
 */
const REQUEST_TIMEOUT_MS =
  Number(import.meta.env.VITE_GRAPHQL_TIMEOUT_MS) || 15_000;

const httpLink = new HttpLink({
  uri:
    import.meta.env.VITE_GRAPHQL_ENDPOINT ||
    "https://indexer.streamfi.io/graphql",
  /**
   * Attach a per-request AbortController so every in-flight fetch is
   * cancelled after REQUEST_TIMEOUT_MS. Apollo surfaces the resulting
   * AbortError as a network error, which sets `error` and clears `loading`
   * on the query, preventing the infinite-spinner scenario.
   */
  fetch: (uri, options) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return fetch(uri, { ...options, signal: controller.signal }).finally(() =>
      clearTimeout(timeoutId),
    );
  },
});

export const apolloClient = new ApolloClient({
  link: httpLink,
  cache: new InMemoryCache({
    typePolicies: {
      Query: {
        fields: {
          streams: {
            // keyArgs controls what makes a distinct cache entry.
            // Including 'walletAddress', 'limit', and 'orderBy' ensures that
            // different query shapes are cached separately and that a refetch
            // with the same args fully replaces the cached list rather than
            // appending to it (the previous merge accumulated stale entries).
            // This also fixes #156: a network switch changes `walletAddress`,
            // so each network now gets its own cache slot instead of the old
            // merge policy mixing data from the previous and current networks.
            keyArgs: ["walletAddress", "limit", "orderBy"],
            // Replace the entire list on every incoming response so that
            // mutations followed by refetchQueries always surface fresh data.
            merge(_existing, incoming) {
              return incoming;
            },
          },
          dashboardStats: {
            // Always replace with fresh server data.
            merge(_existing, incoming) {
              return incoming;
            },
          },
        },
      },
    },
  }),
  defaultOptions: {
    watchQuery: {
      // cache-and-network renders cached data immediately while the network
      // request completes, then updates the UI with the fresh response.
      fetchPolicy: "cache-and-network",
      nextFetchPolicy: "cache-first",
    },
  },
});
