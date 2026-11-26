import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { ConduitClient } from '../client.js';
import type { ConduitConfig } from '../types/index.js';
import type { WalletAdapter } from '../adapters/types.js';

/**
 * RPC connectivity and latency status indicator.
 */
export interface RpcStatus {
  url: string;
  latencyMs: number;
  isHealthy: boolean;
}

/**
 * State and methods exposed by the StreamFiContext.
 */
export interface StreamFiContextState {
  client: ConduitClient | null;
  isReady: boolean;
  error: Error | null;
  rpcStatus: RpcStatus;
  connect: (config: ConduitConfig) => void;
  disconnect: () => void;
  activeListeners?: Set<() => void>;
  registerStreamListener: (unsubscribe: () => void) => () => void;
  unsubscribeAll: () => void;
}

export type StreamFiContextValue = StreamFiContextState;

export const StreamFiContext = createContext<StreamFiContextState | null>(null);

export interface StreamFiProviderProps {
  config?: ConduitConfig;
  client?: ConduitClient;
  wallet?: WalletAdapter;
  children: ReactNode;
}

/**
 * StreamFiProvider manages the root ConduitClient instance, tracks RPC
 * node responsiveness and latency, and automatically cleans up stream
 * event listeners and cached state upon wallet disconnection.
 */
export function StreamFiProvider({
  config,
  client: clientProp,
  wallet: walletProp,
  children,
}: StreamFiProviderProps): React.JSX.Element {
  const [state, setState] = useState<{
    client: ConduitClient | null;
    error: Error | null;
  }>(() => {
    if (clientProp) {
      return { client: clientProp, error: null };
    }
    if (config) {
      try {
        return { client: new ConduitClient(config), error: null };
      } catch (err: unknown) {
        return {
          client: null,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
    return { client: null, error: null };
  });

  useEffect(() => {
    if (clientProp) {
      setState({ client: clientProp, error: null });
    }
  }, [clientProp]);

  // Registry for active stream event listeners
  const activeListenersRef = useRef<Set<() => void>>(new Set());

  const registerStreamListener = useCallback((unsub: () => void) => {
    activeListenersRef.current.add(unsub);
    return () => {
      activeListenersRef.current.delete(unsub);
    };
  }, []);

  const unsubscribeAll = useCallback(() => {
    activeListenersRef.current.forEach((unsub) => {
      try {
        unsub();
      } catch (err) {
        console.warn('[StreamFiProvider] Error unsubscribing stream listener:', err);
      }
    });
    activeListenersRef.current.clear();
    state.client?.clearAddressCache?.();
  }, [state.client]);

  // Unsubscribe all stream listeners when the provider unmounts
  useEffect(() => {
    return () => {
      unsubscribeAll();
    };
  }, [unsubscribeAll]);

  // Determine the active wallet
  const currentWallet =
    walletProp ?? (state.client as any)?.config?.wallet ?? config?.wallet;

  const prevWalletRef = useRef<WalletAdapter | undefined>(currentWallet);
  const prevConnectedRef = useRef<boolean>(
    typeof currentWallet?.isConnected === 'function'
      ? currentWallet.isConnected()
      : Boolean(currentWallet),
  );

  // Automatic wallet disconnection cleanup handler (Issue 3 / #1156)
  useEffect(() => {
    if (prevWalletRef.current && !currentWallet) {
      unsubscribeAll();
    }
    prevWalletRef.current = currentWallet;

    if (!currentWallet) return;

    let isSubscribed = true;
    const handleDisconnect = () => {
      if (isSubscribed) {
        unsubscribeAll();
      }
    };

    if (typeof (currentWallet as any).on === 'function') {
      (currentWallet as any).on('disconnect', handleDisconnect);
      (currentWallet as any).on('disconnected', handleDisconnect);
      (currentWallet as any).on('accountsChanged', (accounts: unknown[]) => {
        if (!accounts || accounts.length === 0) {
          handleDisconnect();
        }
      });
    }

    let intervalId: ReturnType<typeof setInterval> | undefined;
    if (typeof currentWallet.isConnected === 'function') {
      intervalId = setInterval(() => {
        if (!isSubscribed) return;
        const isConnected = currentWallet.isConnected?.() ?? false;
        if (prevConnectedRef.current && !isConnected) {
          handleDisconnect();
        }
        prevConnectedRef.current = isConnected;
      }, 1000);
    }

    return () => {
      isSubscribed = false;
      if (intervalId) clearInterval(intervalId);
      if (typeof (currentWallet as any).off === 'function') {
        (currentWallet as any).off('disconnect', handleDisconnect);
        (currentWallet as any).off('disconnected', handleDisconnect);
      }
    };
  }, [currentWallet, unsubscribeAll]);

  // Network latency and RPC status monitoring (Issue 2 / #1155)
  const clientRpcUrl =
    (state.client as any)?.config?.rpcUrl ??
    config?.rpcUrl ??
    '';

  const [rpcStatus, setRpcStatus] = useState<RpcStatus>(() => ({
    url: clientRpcUrl,
    latencyMs: 0,
    isHealthy: false,
  }));

  useEffect(() => {
    const url =
      (state.client as any)?.config?.rpcUrl ??
      config?.rpcUrl ??
      (state.client?.rpcServer as any)?.serverURL?.toString?.() ??
      '';

    if (!state.client) {
      setRpcStatus({ url, latencyMs: 0, isHealthy: false });
      return;
    }

    let isMounted = true;
    const measureRpc = async () => {
      const start = Date.now();
      try {
        if (state.client?.rpcServer && typeof state.client.rpcServer.getLatestLedger === 'function') {
          await state.client.rpcServer.getLatestLedger();
        }
        const latencyMs = Date.now() - start;
        if (isMounted) {
          setRpcStatus({ url, latencyMs, isHealthy: true });
        }
      } catch {
        const latencyMs = Date.now() - start;
        if (isMounted) {
          setRpcStatus({ url, latencyMs, isHealthy: false });
        }
      }
    };

    measureRpc();
    const intervalId = setInterval(measureRpc, 30000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [state.client, config?.rpcUrl]);

  const connect = useCallback((cfg: ConduitConfig) => {
    try {
      const newClient = new ConduitClient(cfg);
      setState({ client: newClient, error: null });
    } catch (err: unknown) {
      setState({
        client: null,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }, []);

  const disconnect = useCallback(() => {
    unsubscribeAll();
    setState({ client: null, error: null });
  }, [unsubscribeAll]);

  const value = useMemo<StreamFiContextState>(
    () => ({
      client: state.client,
      isReady: state.client !== null,
      error: state.error,
      rpcStatus,
      connect,
      disconnect,
      activeListeners: activeListenersRef.current,
      registerStreamListener,
      unsubscribeAll,
    }),
    [state.client, state.error, rpcStatus, connect, disconnect, registerStreamListener, unsubscribeAll],
  );

  return React.createElement(
    ConduitContext.Provider,
    { value: state.client },
    React.createElement(
      StreamFiContext.Provider,
      { value },
      children,
    ),
  );
}

// ── Legacy Conduit Context & Provider Compatibility ──────────────────────────
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ConduitClient } from '../client.js';
import type { ConduitConfig, Network } from '../types/index.js';
import type { WalletAdapter } from '../adapters/types.js';

export const ConduitContext = createContext<ConduitClient | null>(null);

export interface ConduitProviderProps {
  client: ConduitClient;
  children: React.ReactNode;
}

export function ConduitProvider({ client, children }: ConduitProviderProps): React.JSX.Element {
  return React.createElement(StreamFiProvider, { client }, children);
}

export function useConduitClient(customClient?: ConduitClient): ConduitClient {
  const contextClient = useContext(ConduitContext);
  const streamFiCtx = useContext(StreamFiContext);
  const client = customClient ?? contextClient ?? streamFiCtx?.client;

  if (!client) {
    throw new Error(
      'ConduitClient not found. Wrap your component in <ConduitProvider client={client}> or pass client option.',
    );
  }

  return client;
}

export function useStreamFiContext(): StreamFiContextState {
  const ctx = useContext(StreamFiContext);
  if (!ctx) {
    throw new Error('useStreamFiContext must be used within a <StreamFiProvider>');
  }
  return ctx;
}

export function useStreamFiClient(): StreamFiContextState {
  const ctx = useContext(StreamFiContext);
  if (!ctx) {
    throw new Error(
      'useStreamFiClient must be used within a <StreamFiProvider>. Wrap your component tree with <StreamFiProvider> to provide a ConduitClient instance.',
    );
  }
  return ctx;
// ── StreamFiProvider (#1095) ─────────────────────────────────────────────────

/** Network used by {@link StreamFiProvider} when neither `client` nor `config.network` is given. */
export const DEFAULT_STREAMFI_NETWORK: Network = 'testnet';

/** Lifecycle of the wallet adapter attached by {@link StreamFiProvider}. */
export type WalletConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

/** localStorage key under which the last used wallet adapter id is remembered. */
export const LAST_ADAPTER_STORAGE_KEY = 'streamfi:last-adapter';

interface AdapterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function adapterStorage(): AdapterStorage | null {
  try {
    const globalWithWindow = globalThis as typeof globalThis & {
      window?: { localStorage?: AdapterStorage };
    };
    return globalWithWindow.window?.localStorage ?? null;
  } catch {
    return null;
  }
}

export interface StreamFiContextValue {
  /** The client every hook under the provider uses. */
  client: ConduitClient;
  /**
   * Network the provider was configured with. `undefined` when an existing
   * `client` was passed without `config.network`, since the client does not
   * expose its own configuration.
   */
  network: Network | undefined;
  /** Current wallet connection status. */
  connectionStatus: WalletConnectionStatus;
  /** Id of the connected adapter, when it came from the `adapters` map. */
  walletId: string | null;
  /** Last connection error, cleared on a successful connect/disconnect. */
  error: Error | null;
  /** Connect a wallet adapter by its id from the provider's `adapters` map. */
  connect: (walletId: string) => Promise<string>;
  /** Disconnect the current adapter and forget it for the next page load. */
  disconnect: () => Promise<void>;
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
  /**
   * Wallet adapters keyed by a stable id. The last connected id is persisted in
   * localStorage and re-attached on mount, so a page reload restores the
   * previous provider without a manual reconnect.
   */
  adapters?: Record<string, WalletAdapter>;
  /** Override {@link LAST_ADAPTER_STORAGE_KEY}. */
  adapterStorageKey?: string;
  /** Re-attach the remembered adapter on mount. Defaults to `true`. */
  autoReconnect?: boolean;
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
  adapters,
  adapterStorageKey,
  autoReconnect = true,
  children,
}: StreamFiProviderProps): React.JSX.Element {
  const network = config?.network ?? (client ? undefined : DEFAULT_STREAMFI_NETWORK);
  const storageKey = adapterStorageKey ?? LAST_ADAPTER_STORAGE_KEY;

  const resolved = useMemo(
    () =>
      client ??
      new ConduitClient({ ...config, network: config?.network ?? DEFAULT_STREAMFI_NETWORK }),
    // Rebuilt only when the caller swaps `client` or changes network, not on
    // every new `config` object identity (inline objects change each render).
    [client, config?.network],
  );

  const [connectionStatus, setConnectionStatus] = useState<WalletConnectionStatus>('disconnected');
  const [walletId, setWalletId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const adaptersRef = useRef(adapters);
  adaptersRef.current = adapters;

  /** Attach a wallet prop synchronously with the existing provider semantics. */
  useEffect(() => {
    if (!wallet) return;
    resolved.setWallet(wallet);
    const id = adaptersRef.current
      ? Object.keys(adaptersRef.current).find((key) => adaptersRef.current?.[key] === wallet)
      : undefined;
    if (id !== undefined) {
      adapterStorage()?.setItem(storageKey, id);
      setWalletId(id);
    }
    setConnectionStatus('connected');
    setError(null);
  }, [resolved, wallet, storageKey]);

  /** Restore the previous provider after a reload without prompting the user. */
  useEffect(() => {
    if (!autoReconnect || wallet || !adaptersRef.current) return;
    const storage = adapterStorage();
    const savedId = storage?.getItem(storageKey);
    if (!savedId) return;
    const adapter = adaptersRef.current[savedId];
    if (!adapter || adapter.isConnected?.() === false) {
      storage?.removeItem(storageKey);
      return;
    }

    let isMounted = true;
    setConnectionStatus('connecting');
    Promise.resolve(adapter.getPublicKey())
      .then(() => {
        if (!isMounted) return;
        resolved.setWallet(adapter);
        setWalletId(savedId);
        setConnectionStatus('connected');
        setError(null);
      })
      .catch((err: unknown) => {
        storage?.removeItem(storageKey);
        if (!isMounted) return;
        setConnectionStatus('error');
        setError(err instanceof Error ? err : new Error(String(err)));
      });

    return () => {
      isMounted = false;
    };
  }, [autoReconnect, wallet, resolved, storageKey]);

  const connect = useCallback(
    async (id: string): Promise<string> => {
      const adapter = adaptersRef.current?.[id];
      if (!adapter) {
        const e = new Error(`Unknown wallet "${id}"`);
        setConnectionStatus('error');
        setError(e);
        throw e;
      }
      setConnectionStatus('connecting');
      setError(null);
      try {
        const key = adapter.connect ? await adapter.connect() : await adapter.getPublicKey();
        resolved.setWallet(adapter);
        adapterStorage()?.setItem(storageKey, id);
        setWalletId(id);
        setConnectionStatus('connected');
        return key;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setConnectionStatus('error');
        setError(e);
        throw e;
      }
    },
    [resolved, storageKey],
  );

  const disconnect = useCallback(async (): Promise<void> => {
    const adapter = walletId ? adaptersRef.current?.[walletId] : undefined;
    adapterStorage()?.removeItem(storageKey);
    setWalletId(null);
    setConnectionStatus('disconnected');
    setError(null);
    try {
      await adapter?.disconnect?.();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setConnectionStatus('error');
      setError(e);
      throw e;
    }
  }, [walletId, storageKey]);

  const value = useMemo<StreamFiContextValue>(
    () => ({ client: resolved, network, connectionStatus, walletId, error, connect, disconnect }),
    [resolved, network, connectionStatus, walletId, error, connect, disconnect],
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
