import { useContext } from 'react';
import { StreamFiContext } from '../context/StreamFiProvider.js';
import type { Network } from '@conduit-protocol/sdk';

export interface UseNetworkSwitcherResult {
  /** The currently active network, or null if no client or network is configured. */
  network: Network | null;
  /** Switch to a different network, re-instantiating the ConduitClient and invalidating downstream queries. */
  setNetwork: (network: Network) => void;
  /** Validate whether a given network identifier is supported by the Conduit SDK. */
  isSupportedNetwork: (network: string) => network is Network;
  /** The list of all supported networks. */
  availableNetworks: readonly Network[];
}

/**
 * Hook for reactive network reading and toggling in StreamFi React applications.
 *
 * Switching network seamlessly reconfigures the active `ConduitClient`
 * and updates context state so that all dependent stream query hooks
 * automatically refresh for the selected network without needing to
 * remount `<StreamFiProvider>` or manage out-of-band global state.
 *
 * @returns {UseNetworkSwitcherResult} Current network state and switcher controls.
 *
 * @example
 * ```tsx
 * import { useNetworkSwitcher } from '@streamfi/react';
 *
 * function NetworkSelector() {
 *   const { network, setNetwork, availableNetworks, isSupportedNetwork } = useNetworkSwitcher();
 *
 *   return (
 *     <select
 *       value={network ?? ''}
 *       onChange={(e) => {
 *         const target = e.target.value;
 *         if (isSupportedNetwork(target)) {
 *           setNetwork(target);
 *         }
 *       }}
 *     >
 *       {availableNetworks.map((net) => (
 *         <option key={net} value={net}>
 *           {net}
 *         </option>
 *       ))}
 *     </select>
 *   );
 * }
 * ```
 */
export function useNetworkSwitcher(): UseNetworkSwitcherResult {
  const ctx = useContext(StreamFiContext);
  if (!ctx) {
    throw new Error(
      'useNetworkSwitcher must be used within a <StreamFiProvider>. ' +
      'Wrap your component tree with <StreamFiProvider> to enable reactive network switching.',
    );
  }

  return {
    network: ctx.network,
    setNetwork: ctx.setNetwork,
    isSupportedNetwork: ctx.isSupportedNetwork,
    availableNetworks: ctx.availableNetworks,
  };
}
