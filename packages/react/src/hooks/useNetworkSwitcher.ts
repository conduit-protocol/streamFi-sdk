import { useContext, useEffect, useCallback } from 'react';
import { StreamFiContext } from '../context/StreamFiProvider.js';
import { UnsupportedChainError, type Network } from '@conduit-protocol/sdk';

export interface UseNetworkSwitcherResult {
  /** The currently active network, or null if no client or network is configured. */
  network: Network | null;
  /** Switch to a different network, re-instantiating the ConduitClient and invalidating downstream queries. */
  setNetwork: (network: Network) => void;
  /** Prompt wallet extensions / RPC adapters to switch network, and update client network state. */
  promptSwitchNetwork: (targetNetwork: string) => Promise<boolean>;
  /** Validate whether a given network identifier is supported by the Conduit SDK. */
  isSupportedNetwork: (network: string) => network is Network;
  /** The list of all supported networks. */
  availableNetworks: readonly Network[];
}

export interface UseNetworkSwitcherOptions {
  /** Optional callback fired when the network changes. */
  onNetworkChange?: (newNetwork: Network) => void;
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
 *   const { network, promptSwitchNetwork, availableNetworks, isSupportedNetwork } = useNetworkSwitcher();
 *
 *   return (
 *     <select
 *       value={network ?? ''}
 *       onChange={(e) => {
 *         const target = e.target.value;
 *         if (isSupportedNetwork(target)) {
 *           promptSwitchNetwork(target);
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
export function useNetworkSwitcher(options?: UseNetworkSwitcherOptions): UseNetworkSwitcherResult {
  const ctx = useContext(StreamFiContext);
  if (!ctx) {
    throw new Error(
      'useNetworkSwitcher must be used within a <StreamFiProvider>. ' +
      'Wrap your component tree with <StreamFiProvider> to enable reactive network switching.',
    );
  }

  useEffect(() => {
    if (ctx.network && options?.onNetworkChange) {
      options.onNetworkChange(ctx.network);
    }
  }, [ctx.network, options]);

  const promptSwitchNetwork = useCallback(
    async (targetNetwork: string): Promise<boolean> => {
      if (!ctx.isSupportedNetwork(targetNetwork)) {
        throw new UnsupportedChainError(targetNetwork);
      }

      const win = typeof window !== 'undefined' ? (window as any) : undefined;
      const clientWallet = (ctx.client as any)?.wallet;

      if (clientWallet) {
        if (typeof clientWallet.switchNetwork === 'function') {
          await clientWallet.switchNetwork(targetNetwork);
        } else if (typeof clientWallet.request === 'function') {
          await clientWallet.request({
            method: 'wallet_switchNetwork',
            params: [{ network: targetNetwork }],
          });
        }
      } else if (win?.freighter) {
        if (typeof win.freighter.switchNetwork === 'function') {
          await win.freighter.switchNetwork(targetNetwork);
        } else if (typeof win.freighter.request === 'function') {
          await win.freighter.request({
            method: 'wallet_switchNetwork',
            params: [{ network: targetNetwork }],
          });
        }
      } else if (win?.stellar) {
        if (typeof win.stellar.switchNetwork === 'function') {
          await win.stellar.switchNetwork(targetNetwork);
        } else if (typeof win.stellar.request === 'function') {
          await win.stellar.request({
            method: 'wallet_switchNetwork',
            params: [{ network: targetNetwork }],
          });
        }
      }

      ctx.setNetwork(targetNetwork as Network);
      return true;
    },
    [ctx],
  );

  return {
    network: ctx.network,
    setNetwork: ctx.setNetwork,
    promptSwitchNetwork,
    isSupportedNetwork: ctx.isSupportedNetwork,
    availableNetworks: ctx.availableNetworks,
  };
}
