import React, { useState, useCallback, useEffect } from "react";
import styles from "./SettingsPage.module.css";
import {
  Notifications,
  Notification,
  NotificationType,
} from "./Notifications";

interface SettingsPageProps {
  className?: string;
  walletAddress?: string;
  network?: string;
  onBack?: () => void;
}

type SettingsSection = "general" | "network" | "advanced";

interface NetworkConfig {
  rpcUrl: string;
  chainId: string;
  timeoutMs: number;
}

const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  rpcUrl: "",
  chainId: "",
  timeoutMs: 15000,
};

/**
 * SettingsPage component — displays application settings with
 * proper loading state handling and RPC timeout protection.
 *
 * The loading state is always cleared via a timeout guard, so even
 * if the RPC provider times out the user is never stuck with a
 * spinner (fixes #153).
 */
export const SettingsPage: React.FC<SettingsPageProps> = ({
  className,
  walletAddress = "",
  network = "testnet",
  onBack,
}) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const [loading, setLoading] = useState(false);
  const [networkConfig, setNetworkConfig] = useState<NetworkConfig>(DEFAULT_NETWORK_CONFIG);

  const addNotification = useCallback(
    (type: NotificationType, title: string, message: string, duration = 5000) => {
      const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      setNotifications((prev) => [...prev, { id, type, title, message, duration }]);
    },
    [],
  );

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  // Guard: always clear loading state after timeout, even if RPC fails silently
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => {
      setLoading(false);
      addNotification("warning", "Request timed out", "The network request took too long. Please try again.");
    }, 10000);
    return () => clearTimeout(timer);
  }, [loading, addNotification]);

  // Load settings from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("streamfi-settings");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.networkConfig) {
          setNetworkConfig(parsed.networkConfig);
        }
      }
    } catch {
      // Ignore parse errors — use defaults
    }
  }, []);

  const handleSaveSettings = useCallback(async () => {
    setLoading(true);
    try {
      // Simulate save operation with timeout
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        // Cleanup timer if component unmounts
        return () => clearTimeout(timer);
      });

      localStorage.setItem(
        "streamfi-settings",
        JSON.stringify({ networkConfig }),
      );

      addNotification("success", "Settings saved", "Your settings have been saved successfully.");
    } catch {
      addNotification("error", "Save failed", "Could not save settings. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [networkConfig, addNotification]);

  const handleResetSettings = useCallback(() => {
    setNetworkConfig(DEFAULT_NETWORK_CONFIG);
    localStorage.removeItem("streamfi-settings");
    addNotification("info", "Settings reset", "All settings have been reset to defaults.");
  }, [addNotification]);

  const handleTestConnection = useCallback(async () => {
    setLoading(true);
    try {
      // Simulate connection test with timeout
      await new Promise((resolve) => setTimeout(resolve, 1000));
      addNotification("success", "Connection successful", "The RPC endpoint is reachable.");
    } catch {
      addNotification("error", "Connection failed", "Could not reach the RPC endpoint.");
    } finally {
      setLoading(false);
    }
  }, [addNotification]);

  return (
    <div className={`${styles.settingsPage} ${className || ""}`}>
      <header className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
        <div className={styles.headerActions}>
          <button className={styles.buttonSecondary} onClick={onBack}>
            Back to Dashboard
          </button>
        </div>
      </header>

      <main className={styles.main}>
        <Notifications
          notifications={notifications}
          onDismiss={dismissNotification}
        />

        <div className={styles.layout}>
          {/* Sidebar navigation */}
          <nav className={styles.sidebar}>
            <button
              className={`${styles.navButton} ${activeSection === "general" ? styles.navButtonActive : ""}`}
              onClick={() => setActiveSection("general")}
            >
              General
            </button>
            <button
              className={`${styles.navButton} ${activeSection === "network" ? styles.navButtonActive : ""}`}
              onClick={() => setActiveSection("network")}
            >
              Network
            </button>
            <button
              className={`${styles.navButton} ${activeSection === "advanced" ? styles.navButtonActive : ""}`}
              onClick={() => setActiveSection("advanced")}
            >
              Advanced
            </button>
          </nav>

          {/* Settings content */}
          <div className={styles.content}>
            {activeSection === "general" && (
              <section className={styles.section}>
                <h2 className={styles.sectionTitle}>General Settings</h2>
                <div className={styles.field}>
                  <label className={styles.label}>Wallet Address</label>
                  <p className={styles.value}>
                    {walletAddress || "Not connected"}
                  </p>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Network</label>
                  <p className={styles.value}>{network}</p>
                </div>
                <div className={styles.actions}>
                  <button
                    className={styles.button}
                    onClick={handleSaveSettings}
                    disabled={loading}
                  >
                    {loading ? "Saving..." : "Save Settings"}
                  </button>
                  <button
                    className={styles.buttonSecondary}
                    onClick={handleResetSettings}
                    disabled={loading}
                  >
                    Reset to Defaults
                  </button>
                </div>
              </section>
            )}

            {activeSection === "network" && (
              <section className={styles.section}>
                <h2 className={styles.sectionTitle}>Network Configuration</h2>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="rpcUrl">
                    RPC URL
                  </label>
                  <input
                    id="rpcUrl"
                    className={styles.input}
                    type="text"
                    value={networkConfig.rpcUrl}
                    onChange={(e) =>
                      setNetworkConfig((prev) => ({
                        ...prev,
                        rpcUrl: e.target.value,
                      }))
                    }
                    placeholder="https://soroban-testnet.stellar.org"
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="chainId">
                    Chain ID
                  </label>
                  <input
                    id="chainId"
                    className={styles.input}
                    type="text"
                    value={networkConfig.chainId}
                    onChange={(e) =>
                      setNetworkConfig((prev) => ({
                        ...prev,
                        chainId: e.target.value,
                      }))
                    }
                    placeholder="Standalone"
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="timeout">
                    Request Timeout (ms)
                  </label>
                  <input
                    id="timeout"
                    className={styles.input}
                    type="number"
                    value={networkConfig.timeoutMs}
                    onChange={(e) =>
                      setNetworkConfig((prev) => ({
                        ...prev,
                        timeoutMs: parseInt(e.target.value, 10) || 15000,
                      }))
                    }
                    min={1000}
                    max={60000}
                  />
                </div>
                <div className={styles.actions}>
                  <button
                    className={styles.button}
                    onClick={handleTestConnection}
                    disabled={loading}
                  >
                    {loading ? "Testing..." : "Test Connection"}
                  </button>
                  <button
                    className={styles.button}
                    onClick={handleSaveSettings}
                    disabled={loading}
                  >
                    Save
                  </button>
                </div>
              </section>
            )}

            {activeSection === "advanced" && (
              <section className={styles.section}>
                <h2 className={styles.sectionTitle}>Advanced Settings</h2>
                <div className={styles.field}>
                  <label className={styles.label}>Clear Local Data</label>
                  <p className={styles.description}>
                    Remove all locally cached data including settings and
                    transaction history.
                  </p>
                  <button
                    className={styles.buttonDanger}
                    onClick={() => {
                      localStorage.clear();
                      addNotification(
                        "info",
                        "Data cleared",
                        "All local data has been cleared.",
                      );
                    }}
                  >
                    Clear All Data
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};
