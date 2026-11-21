import React from 'react';
import styles from './TransactionHistory.module.css';
import { useTransactionHistory } from '../hooks/useTransactionHistory';
import {
  formatAddress,
  formatAmount,
  formatTimestamp,
  type TransactionStatus,
} from '../../../../src/dashboard/transaction-history';

export interface TransactionHistoryProps {
  /** Wallet whose history is shown. Empty string renders the empty state. */
  walletAddress?: string;
  /** Maximum number of records to request from the indexer. */
  limit?: number;
  className?: string;
}

const STATUS_OPTIONS: Array<TransactionStatus | 'ALL'> = [
  'ALL',
  'PENDING',
  'CONFIRMED',
  'FAILED',
  'CANCELLED',
];

function statusClass(status: TransactionStatus): string {
  switch (status) {
    case 'CONFIRMED':
      return styles.badgeConfirmed;
    case 'PENDING':
      return styles.badgePending;
    case 'FAILED':
      return styles.badgeFailed;
    case 'CANCELLED':
      return styles.badgeCancelled;
    default:
      return styles.badgeUnknown;
  }
}

/**
 * Transaction History view — fixes #136 / #103 ("crashes immediately upon
 * rendering due to an undefined variable in the state hook").
 *
 * The component is a pure projection of `useTransactionHistory`, which is
 * seeded with a fully-populated initial state. There is no property access on
 * a possibly-undefined value anywhere in this render body:
 *
 * - `transactions` is always an array (never `undefined.map`).
 * - `status` picks exactly one of loading / error / empty / ready, so the
 *   table body is only reached when there is at least one row.
 * - Every cell value goes through a formatter that tolerates `null`,
 *   `undefined` and wrong-typed input.
 * - Errors degrade to an inline retry banner, and stale rows stay on screen,
 *   rather than tearing down the tree.
 */
export const TransactionHistory: React.FC<TransactionHistoryProps> = ({
  walletAddress = '',
  limit = 50,
  className,
}) => {
  const { state, transactions, status, totalPages, setFilter, setPage, refresh } =
    useTransactionHistory(walletAddress, limit);

  const { filters, page, loading, error } = state;

  return (
    <section
      className={`${styles.container} ${className ?? ''}`}
      aria-labelledby="transaction-history-heading"
    >
      <header className={styles.header}>
        <h2 id="transaction-history-heading" className={styles.title}>
          Transaction History
        </h2>

        <div className={styles.controls}>
          <input
            type="search"
            className={styles.search}
            aria-label="Search transactions"
            placeholder="Search hash, stream or address…"
            value={filters.search}
            onChange={(e) => setFilter({ search: e.target.value })}
          />

          <select
            className={styles.select}
            aria-label="Filter by status"
            value={filters.status}
            onChange={(e) =>
              setFilter({ status: e.target.value as TransactionStatus | 'ALL' })
            }
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === 'ALL' ? 'All statuses' : option}
              </option>
            ))}
          </select>

          <button
            type="button"
            className={styles.button}
            onClick={refresh}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {/* Non-fatal error while stale rows are still on screen. */}
      {error !== null && status === 'ready' && (
        <div className={styles.errorBanner} role="alert">
          <span>Showing cached results — {error}</span>
          <button type="button" className={styles.linkButton} onClick={refresh}>
            Retry
          </button>
        </div>
      )}

      {status === 'loading' && (
        <div className={styles.stateBlock} role="status" aria-live="polite">
          Loading transaction history…
        </div>
      )}

      {status === 'error' && (
        <div className={styles.stateBlock} role="alert">
          <p className={styles.stateTitle}>Couldn’t load transaction history</p>
          <p className={styles.stateBody}>{error}</p>
          <button type="button" className={styles.button} onClick={refresh}>
            Try again
          </button>
        </div>
      )}

      {status === 'empty' && (
        <div className={styles.stateBlock}>
          <p className={styles.stateTitle}>No transactions yet</p>
          <p className={styles.stateBody}>
            {walletAddress
              ? 'Transactions will appear here once this wallet has stream activity.'
              : 'Connect a wallet to view its transaction history.'}
          </p>
        </div>
      )}

      {status === 'ready' && (
        <>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Type</th>
                  <th scope="col">Stream</th>
                  <th scope="col">Counterparty</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Status</th>
                  <th scope="col">Hash</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={tx.id}>
                    <td>{formatTimestamp(tx.timestamp)}</td>
                    <td>{tx.kind}</td>
                    <td>{tx.streamId ? `#${tx.streamId}` : '—'}</td>
                    <td title={tx.counterparty}>
                      {formatAddress(tx.counterparty)}
                    </td>
                    <td className={styles.amountCell}>
                      {tx.direction === 'OUT' ? '−' : tx.direction === 'IN' ? '+' : ''}
                      {formatAmount(tx.amount)} {tx.asset}
                    </td>
                    <td>
                      <span className={`${styles.badge} ${statusClass(tx.status)}`}>
                        {tx.status}
                      </span>
                    </td>
                    <td title={tx.hash}>{formatAddress(tx.hash, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <nav className={styles.pagination} aria-label="Transaction history pages">
              <button
                type="button"
                className={styles.button}
                onClick={() => setPage(page - 1)}
                disabled={page <= 0}
              >
                Previous
              </button>
              <span className={styles.pageInfo}>
                Page {page + 1} of {totalPages}
              </span>
              <button
                type="button"
                className={styles.button}
                onClick={() => setPage(page + 1)}
                disabled={page >= totalPages - 1}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
};
