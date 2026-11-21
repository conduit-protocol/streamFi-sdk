import React, { useEffect, useCallback } from "react";
import styles from "./Notifications.module.css";

/**
 * Notification severity levels.
 */
export type NotificationType = "success" | "error" | "warning" | "info";

/**
 * A single notification item.
 */
export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  /** Auto-dismiss after this many ms. 0 = manual dismiss only. */
  duration?: number;
}

interface NotificationsProps {
  /** Array of active notifications to display. */
  notifications: Notification[];
  /** Callback fired when a notification is dismissed. */
  onDismiss: (id: string) => void;
  /** Optional CSS class for the outer container. */
  className?: string;
}

/**
 * Icon characters for each notification type.
 */
const ICONS: Record<NotificationType, string> = {
  success: "✓",
  error: "✕",
  warning: "!",
  info: "i",
};

/**
 * Notifications component — renders a stack of dismissible toast-style
 * notifications with proper CSS Modules flexbox layouts that work in
 * both development and production builds.
 */
export const Notifications: React.FC<NotificationsProps> = ({
  notifications,
  onDismiss,
  className,
}) => {
  const handleDismiss = useCallback(
    (id: string) => {
      onDismiss(id);
    },
    [onDismiss],
  );

  // Auto-dismiss notifications that have a duration set.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    for (const notification of notifications) {
      if (notification.duration && notification.duration > 0) {
        const timer = setTimeout(() => {
          handleDismiss(notification.id);
        }, notification.duration);
        timers.push(timer);
      }
    }

    return () => {
      timers.forEach(clearTimeout);
    };
  }, [notifications, handleDismiss]);

  if (notifications.length === 0) {
    return null;
  }

  return (
    <div
      className={`${styles.container} ${className || ""}`}
      role="log"
      aria-label="Notifications"
      aria-live="polite"
    >
      <div className={styles.list}>
        {notifications.map((notification) => (
          <div
            key={notification.id}
            className={`${styles.notification} ${styles[notification.type]}`}
            role="alert"
          >
            <div className={styles.icon} aria-hidden="true">
              {ICONS[notification.type]}
            </div>
            <div className={styles.content}>
              <h4 className={styles.title}>{notification.title}</h4>
              <p className={styles.message}>{notification.message}</p>
            </div>
            <button
              className={styles.closeButton}
              onClick={() => handleDismiss(notification.id)}
              aria-label={`Dismiss ${notification.type} notification`}
              type="button"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
