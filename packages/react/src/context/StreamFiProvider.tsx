import {
  createContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  type ReactNode,
} from "react";
import { ConduitClient } from "@conduit-protocol/sdk";
import type { ConduitConfig } from "@conduit-protocol/sdk";

export interface StreamFiContextValue {
  client: ConduitClient | null;
  isReady: boolean;
  error: Error | null;
  connect: (config: ConduitConfig) => void;
  disconnect: () => void;
}

export const StreamFiContext = createContext<StreamFiContextValue | null>(null);

export interface StreamFiProviderProps {
  config?: ConduitConfig;
  children: ReactNode;
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

export function StreamFiProvider({ config, children }: StreamFiProviderProps) {
  const [state, setState] = useState<{
    client: ConduitClient | null;
    error: Error | null;
  }>(() => {
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

  // Check for version mismatches on mount
  useEffect(() => {
    checkVersionMismatch();
  }, []);

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
    setState({ client: null, error: null });
  }, []);

  const value = useMemo<StreamFiContextValue>(
    () => ({
      client: state.client,
      isReady: state.client !== null,
      error: state.error,
      connect,
      disconnect,
    }),
    [state.client, state.error, connect, disconnect],
  );

  return (
    <StreamFiContext.Provider value={value}>
      {children}
    </StreamFiContext.Provider>
  );
}
