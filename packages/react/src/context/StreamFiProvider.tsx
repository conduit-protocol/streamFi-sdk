import {
  createContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
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

export interface StreamFiContextValue {
  client: ConduitClient | null;
  isReady: boolean;
  error: Error | null;
  connect: (config: ConduitConfig) => void;
  disconnect: () => void;
  network: Network | null;
  setNetwork: (network: Network) => void;
  isSupportedNetwork: (network: string) => network is Network;
  availableNetworks: readonly Network[];
  /** The QueryClient passed via props, if any (#944). Hooks can read this to share the app's cache. */
  queryClient: QueryClient | undefined;
}

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
    // Get the version of @conduit-protocol/sdk that's actually installed
    const sdkPackage = require("@conduit-protocol/sdk/package.json");
    const installedVersion = sdkPackage.version;

    // Get the peerDependencies from @streamfi/react's package.json
    // The peerDependencies constraint is stored in our own package.json
    const reactPackage = require("../../../package.json");
    const peerConstraint =
      reactPackage.peerDependencies["@conduit-protocol/sdk"];

    if (!peerConstraint) return; // No peer dependency specified, skip check

    // Simple semver check: if installed major version doesn't match the peer constraint's major version
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
    // (e.g., if package.json files aren't accessible in some environments)
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
    setCurrentConfig(undefined);
    setCurrentNetwork(null);
    setState({ client: null, error: null });
  }, []);

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
      connect,
      disconnect,
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
