import React, { useState, useCallback } from "react";
import styles from "./ProfilePage.module.css";
import {
  Notifications,
  Notification,
  NotificationType,
} from "./Notifications";

interface Activity {
  id: string;
  type: "create" | "withdraw" | "pause" | "resume";
  title: string;
  timestamp: string;
}

interface ProfilePageProps {
  className?: string;
  walletAddress?: string;
  network?: string;
  onBack?: () => void;
}

/**
 * ProfilePage component — displays user profile information with
 * proper CSS Modules flexbox layouts that work in both development
 * and production builds.
 */
export const ProfilePage: React.FC<ProfilePageProps> = ({
  className,
  walletAddress = "",
  network: _network,
  onBack,
}) => {
  // Notification state
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

  // Mock activity data
  const [activities] = useState<Activity[]>([
    {
      id: "1",
      type: "create",
      title: "Created stream #1234",
      timestamp: "2 hours ago",
    },
    {
      id: "2",
      type: "withdraw",
      title: "Withdrew 100 XLM from stream #1234",
      timestamp: "1 day ago",
    },
    {
      id: "3",
      type: "pause",
      title: "Paused stream #1233",
      timestamp: "3 days ago",
    },
    {
      id: "4",
      type: "resume",
      title: "Resumed stream #1232",
      timestamp: "1 week ago",
    },
  ]);

  const handleEditProfile = () => {
    addNotification("info", "Edit Profile", "Profile editing coming soon!");
  };

  const handleCopyAddress = () => {
    if (walletAddress && navigator.clipboard) {
      navigator.clipboard.writeText(walletAddress).then(() => {
        addNotification("success", "Address copied", "Wallet address copied to clipboard.");
      }).catch(() => {
        addNotification("error", "Copy failed", "Could not copy address to clipboard.");
      });
    }
  };

  const getActivityIcon = (type: Activity["type"]) => {
    switch (type) {
      case "create":
        return "+";
      case "withdraw":
        return "↓";
      case "pause":
        return "⏸";
      case "resume":
        return "▶";
      default:
        return "•";
    }
  };

  const getActivityIconClass = (type: Activity["type"]) => {
    switch (type) {
      case "create":
        return styles.iconCreate;
      case "withdraw":
        return styles.iconWithdraw;
      case "pause":
        return styles.iconPause;
      case "resume":
        return styles.iconResume;
      default:
        return "";
    }
  };

  // Generate initials from wallet address
  const getInitials = (address: string) => {
    if (!address) return "?";
    return address.slice(2, 4).toUpperCase();
  };

  // Truncate wallet address for display
  const truncateAddress = (address: string) => {
    if (!address) return "Not connected";
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  return (
    <div className={`${styles.profilePage} ${className || ""}`}>
      <header className={styles.header}>
        <h1 className={styles.title}>Profile</h1>
        <div className={styles.headerActions}>
          <button className={styles.buttonSecondary} onClick={onBack}>
            Back to Dashboard
          </button>
          <button className={styles.button} onClick={handleEditProfile}>
            Edit Profile
          </button>
        </div>
      </header>

      <main className={styles.main}>
        {/* Profile card */}
        <div className={styles.profileCard}>
          <div className={styles.avatar}>{getInitials(walletAddress)}</div>
          <div className={styles.profileInfo}>
            <h2 className={styles.displayName}>StreamFi User</h2>
            <p className={styles.walletAddress} onClick={handleCopyAddress} title="Click to copy">
              {truncateAddress(walletAddress)}
            </p>
          </div>
        </div>

        {/* Notification stack */}
        <Notifications
          notifications={notifications}
          onDismiss={dismissNotification}
        />

        {/* Stats section */}
        <section className={styles.statsSection}>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Active Streams</span>
            <span className={styles.statValue}>3</span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Total Earned</span>
            <span className={styles.statValue}>$1,250</span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Total Withdrawn</span>
            <span className={styles.statValue}>$800</span>
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Member Since</span>
            <span className={styles.statValue}>Jan 2026</span>
          </div>
        </section>

        {/* Activity section */}
        <section className={styles.activitySection}>
          <h2 className={styles.sectionTitle}>Recent Activity</h2>
          <div className={styles.activityList}>
            {activities.length === 0 ? (
              <div className={styles.emptyState}>No activity yet</div>
            ) : (
              activities.map((activity) => (
                <div key={activity.id} className={styles.activityItem}>
                  <div className={`${styles.activityIcon} ${getActivityIconClass(activity.type)}`}>
                    {getActivityIcon(activity.type)}
                  </div>
                  <div className={styles.activityContent}>
                    <p className={styles.activityTitle}>{activity.title}</p>
                    <p className={styles.activityTime}>{activity.timestamp}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
};
