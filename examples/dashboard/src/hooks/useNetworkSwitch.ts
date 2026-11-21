import { useEffect, useRef } from 'react';
import { useApolloClient } from '@apollo/client';

/**
 * Resets the Apollo cache and re-fetches all active queries whenever the
 * active network changes.
 *
 * ## Why this is necessary (#156)
 *
 * Apollo's `InMemoryCache` is keyed by query + variables. When the user
 * switches networks the variables that identify *which* network to read from
 * (e.g. `walletAddress`, RPC endpoint) change, but any previously cached
 * results for the *old* variables remain in the store. Components that
 * receive the new variables as props will issue new queries, but Apollo
 * may serve a stale cache hit for a key that looks similar, or a background
 * refetch may race with still-pending requests from the previous network,
 * resulting in a mix of old and new data being rendered.
 *
 * Calling `client.resetStore()` on every network transition:
 * 1. Evicts every cached entry unconditionally — no stale data survives.
 * 2. Re-executes every active `watchQuery` against the network, guaranteeing
 *    that the UI always reflects the current network's on-chain state.
 *
 * ## Usage
 *
 * ```tsx
 * // In your top-level component or layout:
 * useNetworkSwitch(activeNetwork);
 * ```
 *
 * `activeNetwork` should be the canonical network identifier string
 * (e.g. `'mainnet'`, `'testnet'`, `'local'`). The hook skips the reset on
 * the very first render (mount) because there is no "previous" network to
 * switch away from — the initial data fetch is handled by the query hooks
 * themselves.
 *
 * @param network - The currently active network identifier. The cache is
 *   reset every time this value changes after the initial mount.
 */
export function useNetworkSwitch(network: string): void {
  const client = useApolloClient();
  // Track the previous network value so we can detect a real change.
  const previousNetworkRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const previous = previousNetworkRef.current;
    previousNetworkRef.current = network;

    // Skip the reset on the very first render — no previous network means
    // there is nothing stale to evict.
    if (previous === undefined) return;

    // No change — nothing to do.
    if (previous === network) return;

    // Network changed: evict all cached entries and re-fetch active queries
    // so the UI never shows data from the previous network.
    client.resetStore().catch((err: unknown) => {
      // resetStore can reject if an active query re-fetch fails (e.g. network
      // is offline right after the switch). Log the error but do not crash —
      // the query's own error state will surface the failure to the user.
      console.warn('[useNetworkSwitch] Apollo store reset failed after network change:', err);
    });
  }, [client, network]);
}
