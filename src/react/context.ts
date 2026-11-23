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
}
