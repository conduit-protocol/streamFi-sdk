import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { ConduitClient } from '../client.js';
import type { ConduitConfig, Network } from '../types/index.js';
import type { WalletAdapter } from '../adapters/types.js';

export const ConduitContext = createContext<ConduitClient | null>(null);

export interface ConduitProviderProps {
  client: ConduitClient;
  children: React.ReactNode;
}

export function ConduitProvider({ client, children }: ConduitProviderProps): React.JSX.Element {
  return React.createElement(ConduitContext.Provider, { value: client }, children);
}

export function useConduitClient(customClient?: ConduitClient): ConduitClient {
  const contextClient = useContext(ConduitContext);
  const client = customClient ?? contextClient;

  if (!client) {
    throw new Error(
      'ConduitClient not found. Wrap your component in <ConduitProvider client={client}> or pass client option.',
    );
  }

  return client;
}

// ── StreamFiProvider (#1095) ─────────────────────────────────────────────────

/** Network used by {@link StreamFiProvider} when neither `client` nor `config.network` is given. */
export const DEFAULT_STREAMFI_NETWORK: Network = 'testnet';

export interface StreamFiContextValue {
  /** The client every hook under the provider uses. */
  client: ConduitClient;
  /**
   * Network the provider was configured with. `undefined` when an existing
   * `client` was passed without `config.network`, since the client does not
   * expose its own configuration.
   */
  network: Network | undefined;
}

export const StreamFiContext = createContext<StreamFiContextValue | null>(null);

export interface StreamFiProviderProps {
  /** Use an existing client instead of letting the provider create one. */
  client?: ConduitClient;
  /**
   * Config for the client the provider creates when `client` is omitted.
   * `network` defaults to {@link DEFAULT_STREAMFI_NETWORK}. Read when the
   * client is created; pass a new `client` to change configuration later.
   */
  config?: Partial<ConduitConfig>;
  /** Wallet adapter to attach to the client (via `client.setWallet`). */
  wallet?: WalletAdapter;
  children: React.ReactNode;
}

/**
 * Provides a {@link ConduitClient} to the component tree so dApps don't have
 * to instantiate it and pass it down manually. Also provides the legacy
 * {@link ConduitContext}, so every existing hook (`useStreamBalance`,
 * `useBatchWithdraw`, ...) works unchanged under this provider.
 */
export function StreamFiProvider({
  client,
  config,
  wallet,
  children,
}: StreamFiProviderProps): React.JSX.Element {
  const network = config?.network ?? (client ? undefined : DEFAULT_STREAMFI_NETWORK);

  const resolved = useMemo(
    () =>
      client ??
      new ConduitClient({ ...config, network: config?.network ?? DEFAULT_STREAMFI_NETWORK }),
    // Rebuilt only when the caller swaps `client` or changes network, not on
    // every new `config` object identity (inline objects change each render).
    [client, config?.network],
  );

  useEffect(() => {
    if (wallet) resolved.setWallet(wallet);
  }, [resolved, wallet]);

  const value = useMemo<StreamFiContextValue>(
    () => ({ client: resolved, network }),
    [resolved, network],
  );

  return React.createElement(
    StreamFiContext.Provider,
    { value },
    React.createElement(ConduitContext.Provider, { value: resolved }, children),
  );
}

/** Reads the value provided by the nearest {@link StreamFiProvider}. */
export function useStreamFiContext(): StreamFiContextValue {
  const value = useContext(StreamFiContext);
  if (!value) {
    throw new Error(
      'StreamFi context not found. Wrap your component in <StreamFiProvider>.',
    );
  }
  return value;
}
