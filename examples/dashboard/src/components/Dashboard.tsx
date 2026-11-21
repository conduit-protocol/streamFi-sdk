import React, { useState, useCallback } from "react";
import styles from "./Dashboard.module.css";
import { ErrorBoundary } from "./ErrorBoundary";
import { TransactionHistory } from "./TransactionHistory";
import {
  Notifications,
  Notification,
  NotificationType,
} from "./Notifications";
import {
  useDashboardStats,
  useRecentStreams,
  useWithdrawStream,
  useCreateStream,
} from "../hooks/useDashboardData";

interface DashboardProps {
  className?: string;
  walletAddress?: string;
  /** Currently active network. Changes to this prop trigger a full Apollo
   *  cache reset via useNetworkSwitch (fixes #156). */
  network?: string;
  /** Callback to navigate to the Profile page. */
  onNavigateProfile?: () => void;
  /** Callback to navigate to the Settings page. */
  onNavigateSettings?: () => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  className,
  walletAddress = "",
  network: _network,
  onNavigateProfile,
  onNavigateSettings,
}) => {
  const {
    data: statsData,
    loading: statsLoading,
    error: statsError,
  } = useDashboardStats(walletAddress);
  const {
    data: streamsData,
    loading: streamsLoading,
    error: streamsError,
    refetch,
  } = useRecentStreams(walletAddress);
  const { withdraw, loading: withdrawLoading } =
    useWithdrawStream(walletAddress);
  const { createStream, loading: createLoading } =
    useCreateStream(walletAddress);

  // Notification state — surfaces errors and success messages.
  const [notifications, setNotifications] = useState<Notification[]>([]);

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

  const stats = statsData?.dashboardStats;
  const streams = streamsData?.streams ?? [];

  const handleWithdraw = async (streamId: string) => {
    try {
      await withdraw({ variables: { streamId } });
      addNotification("success", "Withdrawal initiated", "Your withdrawal request has been submitted.");
    } catch (err) {
      addNotification(
        "error",
        "Withdrawal failed",
        err instanceof Error ? err.message : "Withdraw failed. Please try again.",
      );
    }
  };

  const handleCreateStream = async () => {
    try {
      // Replace `{ input: {} }` with real form data when the Create Stream
      // form is wired up. The hook already handles cache invalidation.
      const input = {};

      // Client-side validation to prevent invalid payloads
      if (!input || Object.keys(input).length === 0) {
        throw new Error("Stream creation form is not yet implemented. Please provide valid stream parameters.");
      }

      // Validate required fields when form is implemented
      const requiredFields = ['recipient', 'token', 'depositAmount'];
      for (const field of requiredFields) {
        if (!(field in input) || !input[field as keyof typeof input]) {
          throw new Error(`Missing required field: ${field}`);
        }
      }

      await createStream({ variables: { input } });
    } catch (err) {
      addNotification(
        "error",
        "Create stream failed",
        err instanceof Error ? err.message : "Failed to create stream. Please try again.",
      );
    }
  };

  const handleRefresh = () => {
    refetch();
  };

  // Surface query-level errors as notifications (no duplicates)
  const hasQueryErrorNotification = notifications.some(
    (n) => n.title === "Failed to load data",
  );
  React.useEffect(() => {
    if ((statsError || streamsError) && !hasQueryErrorNotification) {
      addNotification(
        "error",
        "Failed to load data",
        "There was a problem fetching dashboard data. Click Refresh to try again.",
        0,
      );
    }
  }, [statsError, streamsError, addNotification, hasQueryErrorNotification]);

  return (
    <div className={`${styles.dashboard} ${className || ""}`}>
      <header className={styles.header}>
        <h1 className={styles.title}>StreamFi Dashboard</h1>
        <div className={styles.headerActions}>
          <button
            className={styles.buttonSecondary}
            onClick={handleRefresh}
            disabled={streamsLoading}
          >
            {streamsLoading ? "Refreshing..." : "Refresh"}
          </button>
          <button
            className={styles.button}
            onClick={handleCreateStream}
            disabled={createLoading}
          >
            {createLoading ? "Creating..." : "New Stream"}
          </button>
          <button className={styles.buttonSecondary} onClick={onNavigateProfile}>Profile</button>
          <button className={styles.buttonSecondary} onClick={onNavigateSettings}>Settings</button>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.statsSection}>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Active Streams</span>
            <span className={styles.statValue}>
              {statsLoading
                ? "..."
                : statsError
                  ? "--"
                  : (stats?.activeStreams ?? 0)}
            </span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Total Volume</span>
            <span className={styles.statValue}>
              {statsLoading
                ? "..."
                : statsError
                  ? "--"
                  : `$${stats?.totalVolume ?? "0"}`}
            </span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Pending</span>
            <span className={styles.statValue}>
              {statsLoading
                ? "..."
                : statsError
                  ? "--"
                  : (stats?.pendingStreams ?? 0)}
            </span>
          </div>
        </section>

        {/* Notification stack */}
        <Notifications
          notifications={notifications}
          onDismiss={dismissNotification}
        />

        {/* Query-level errors — now surfaced via Notifications */}

        <section className={styles.contentSection}>
          <div className={styles.tableContainer}>
            <h2 className={styles.sectionTitle}>Recent Streams</h2>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Stream ID</th>
                    <th>Recipient</th>
                    <th>Rate</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {streamsLoading ? (
                    <tr>
                      <td colSpan={5} className={styles.loadingCell}>
                        Loading streams...
                      </td>
                    </tr>
                  ) : streams.length === 0 ? (
                    <tr>
                      <td colSpan={5} className={styles.loadingCell}>
                        No streams found
                      </td>
                    </tr>
                  ) : (
                    streams.map((stream) => (
                      <tr key={stream.id ?? stream.streamId ?? Math.random()}>
                        <td>#{stream.streamId ?? "—"}</td>
                        <td>
                          {(stream.recipient ?? "").length > 12
                            ? `${(stream.recipient ?? "").slice(0, 6)}...${(stream.recipient ?? "").slice(-4)}`
                            : (stream.recipient ?? "—")}
                        </td>
                        <td>{stream.ratePerSecond ?? "0"} stroops/s</td>
                        <td>
                          <span
                            className={
                              stream.status === "ACTIVE"
                                ? styles.badgeActive
                                : styles.badgePaused
                            }
                          >
                            {stream.status ?? "UNKNOWN"}
                          </span>
                        </td>
                        <td>
                          <button
                            className={styles.buttonSmall}
                            onClick={() => stream.id && handleWithdraw(stream.id)}
                            disabled={withdrawLoading}
                          >
                            Withdraw
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <aside className={styles.sidebar}>
            <div className={styles.sidebarCard}>
              <h3>Quick Actions</h3>
              <button
                className={styles.button}
                onClick={handleCreateStream}
                disabled={createLoading}
              >
                {createLoading ? "Creating..." : "Create Stream"}
              </button>
              <button
                className={styles.button}
                onClick={handleRefresh}
                disabled={streamsLoading}
              >
                Withdraw
              </button>
            </div>
          </aside>
        </section>

        {/* Transaction History — wrapped in an error boundary so a render
            failure here can never take down the whole dashboard (#136). */}
        <ErrorBoundary label="Transaction History">
          <TransactionHistory walletAddress={walletAddress} />
        </ErrorBoundary>
      </main>
    </div>
  );
};
