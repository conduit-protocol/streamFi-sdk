import {
  createContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  ConduitClient,
  SUPPORTED_NETWORKS,
  UnsupportedChainError,
  clearServerCache,
  clearTokenDecimalsCache,
} from "@conduit-protocol/sdk";
import type { ConduitConfig, Network } from "@conduit-protocol/sdk";
// QueryClient is an optional peer dep — import type only to avoid hard runtime dep.
import type { QueryClient } from "@tanstack/react-query";

export interface RpcStatus {
  url: string;
  latencyMs: number;
  isHealthy: boolean;
}

export interface StreamFiContextValue {
  client: ConduitClient | null;
  isReady: boolean;
  error: Error | null;
  rpcStatus: RpcStatus;
  connect: (config: ConduitConfig) => void;
  disconnect: () => void;
  registerStreamListener?: (unsubscribe: () => void) => () => void;
  unsubscribeAll?: () => void;
  network: Network | null;
  setNetwork: (network: Network) => void;
  isSupportedNetwork: (network: string) => network is Network;
  availableNetworks: readonly Network[];
  /** The QueryClient passed via props, if any (#944). Hooks can read this to share the app's cache. */
  queryClient: QueryClient | undefined;
}

export type StreamFiContextState = StreamFiContextValue;

export const StreamFiContext = createContext<StreamFiContextValue | null>(null);

export interface StreamFiProviderProps {
  config?: ConduitConfig;
  defaultNetwork?: Network;
  children: ReactNode;
  /**
   * An existing TanStack QueryClient from the host application. When provided,
   * the SDK shares the app's cache instead of maintaining its own, preventing
   * duplicate cache entries and conflicting invalidations (#944).
   */
  queryClient?: QueryClient;
}

function checkVersionMismatch() {
  try {
    const sdkPackage = require("@conduit-protocol/sdk/package.json");
    const installedVersion = sdkPackage.version;

    const reactPackage = require("../../../package.json");
    const peerConstraint =
      reactPackage.peerDependencies["@conduit-protocol/sdk"];

    if (!peerConstraint) return;

    const installedMajor = parseInt(installedVersion.split(".")[0], 10);
    const constraintMajor = parseInt(peerConstraint.split(".")[0], 10);

    if (installedMajor !== constraintMajor) {
      console.warn(
        `⚠️  Version mismatch: @streamfi/react expects @conduit-protocol/sdk@${peerConstraint}, ` +
          `but @conduit-protocol/sdk@${installedVersion} is installed. ` +
          `This may cause runtime errors. Please ensure compatible versions are installed.`,
      );
    }
  } catch {
    // Silently ignore errors in version checking
  }
}

export function StreamFiProvider({
  config,
  defaultNetwork,
  children,
  queryClient,
}: StreamFiProviderProps) {
  const customFetch = rpcHeaders && Object.keys(rpcHeaders).length > 0
    ? makeHeaderFetch(rpcHeaders)
    : undefined;
  const [currentConfig, setCurrentConfig] = useState<ConduitConfig | undefined>(
    () => config ?? (defaultNetwork ? { network: defaultNetwork } : undefined),
  );
  const [network, setCurrentNetwork] = useState<Network | null>(
    () => config?.network ?? defaultNetwork ?? null,
  );
  const [state, setState] = useState<{
    client: ConduitClient | null;
    error: Error | null;
  }>(() => {
    const initialConfig =
      config ?? (defaultNetwork ? { network: defaultNetwork } : undefined);
    if (initialConfig) {
      try {
        return { client: new ConduitClient({ ...initialConfig, ...(customFetch ? { customFetch } : {}) }), error: null };
      } catch (err: unknown) {
        return {
          client: null,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
    return { client: null, error: null };
  });

  // Check for version mismatches on mount
  useEffect(() => {
    checkVersionMismatch();
  }, []);

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
        console.warn("[StreamFiProvider] Error unsubscribing stream listener:", err);
      }
    });
    activeListenersRef.current.clear();
    state.client?.clearAddressCache?.();
  }, [state.client]);

  // Clean up all active listeners on unmount
  useEffect(() => {
    return () => {
      unsubscribeAll();
    };
  }, [unsubscribeAll]);

  // Track active wallet for disconnect detection (Issue 3 / #1156)
  const currentWallet = (state.client as any)?.config?.wallet ?? config?.wallet;
  const prevWalletRef = useRef<any>(currentWallet);
  const prevConnectedRef = useRef<boolean>(
    typeof currentWallet?.isConnected === "function"
      ? currentWallet.isConnected()
      : Boolean(currentWallet),
  );

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

    if (typeof currentWallet.on === "function") {
      currentWallet.on("disconnect", handleDisconnect);
      currentWallet.on("disconnected", handleDisconnect);
      currentWallet.on("accountsChanged", (accounts: unknown[]) => {
        if (!accounts || accounts.length === 0) {
          handleDisconnect();
        }
      });
    }

    let intervalId: any;
    if (typeof currentWallet.isConnected === "function") {
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
      if (typeof currentWallet.off === "function") {
        currentWallet.off("disconnect", handleDisconnect);
        currentWallet.off("disconnected", handleDisconnect);
      }
    };
  }, [currentWallet, unsubscribeAll]);

  // Network latency & RPC node status indicator (Issue 2 / #1155)
  const [rpcStatus, setRpcStatus] = useState<RpcStatus>(() => ({
    url: (state.client as any)?.config?.rpcUrl ?? config?.rpcUrl ?? "",
    latencyMs: 0,
    isHealthy: false,
  }));

  useEffect(() => {
    const url =
      (state.client as any)?.config?.rpcUrl ??
      config?.rpcUrl ??
      (state.client?.rpcServer as any)?.serverURL?.toString?.() ??
      "";

    if (!state.client) {
      setRpcStatus({ url, latencyMs: 0, isHealthy: false });
      return;
    }

    let isMounted = true;
    const measureRpc = async () => {
      const start = Date.now();
      try {
        if (state.client?.rpcServer && typeof state.client.rpcServer.getLatestLedger === "function") {
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
      const newClient = new ConduitClient({ ...cfg, ...(customFetch ? { customFetch } : {}) });
      setCurrentConfig(cfg);
      setCurrentNetwork(cfg.network);
      setState({ client: newClient, error: null });
    } catch (err: unknown) {
      setCurrentConfig(cfg);
      setCurrentNetwork(cfg.network);
      setState({
        client: null,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }, []);

  const disconnect = useCallback(() => {
    unsubscribeAll();
    setCurrentConfig(undefined);
    setCurrentNetwork(null);
    setState({ client: null, error: null });
  }, [unsubscribeAll]);

  const isSupportedNetwork = useCallback((net: string): net is Network => {
    return (SUPPORTED_NETWORKS as readonly string[]).includes(net);
  }, []);

  const availableNetworks = SUPPORTED_NETWORKS;

  const setNetwork = useCallback(
    (nextNetwork: Network) => {
      if (!isSupportedNetwork(nextNetwork)) {
        throw new UnsupportedChainError(nextNetwork);
      }

      setCurrentNetwork(nextNetwork);

      // Invalidate SDK-level server and token decimal caches on network toggle
      try {
        clearServerCache();
        clearTokenDecimalsCache();
      } catch {
        // Safe fallback if caches cannot be cleared
      }

      const baseConfig = { ...(currentConfig ?? { network: nextNetwork }) };
      if (
        baseConfig.network !== nextNetwork &&
        baseConfig.rpcUrl &&
        (baseConfig.rpcUrl.includes("testnet") ||
          baseConfig.rpcUrl.includes("mainnet") ||
          baseConfig.rpcUrl.includes("localhost") ||
          baseConfig.rpcUrl.includes("127.0.0.1"))
      ) {
        delete baseConfig.rpcUrl;
      }
      const nextConfig: ConduitConfig = {
        ...baseConfig,
        network: nextNetwork,
      };

      setCurrentConfig(nextConfig);

      try {
        const newClient = new ConduitClient({ ...nextConfig, ...(customFetch ? { customFetch } : {}) });
        setState({ client: newClient, error: null });
      } catch (err: unknown) {
        setState({
          client: null,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    },
    [currentConfig, isSupportedNetwork],
  );

  const value = useMemo<StreamFiContextValue>(
    () => ({
      client: state.client,
      isReady: state.client !== null,
      error: state.error,
      rpcStatus,
      connect,
      disconnect,
      registerStreamListener,
      unsubscribeAll,
    }),
    [state.client, state.error, rpcStatus, connect, disconnect, registerStreamListener, unsubscribeAll],
      network,
      setNetwork,
      isSupportedNetwork,
      availableNetworks,
      queryClient,
    }),
    [
      state.client,
      state.error,
      connect,
      disconnect,
      network,
      setNetwork,
      isSupportedNetwork,
      availableNetworks,
      queryClient,
    ],
  );

  return (
    <StreamFiContext.Provider value={value}>
      {children}
    </StreamFiContext.Provider>
  );
}
