import { useCallback, useMemo, useReducer, useRef } from 'react';
import {
  type TransactionHistoryState,
  type TransactionHistoryAction,
  type TransactionFilters,
  type TransactionRecord,
  type TransactionStatus,
  type TransactionKind,
  type TransactionDirection,
  createInitialTransactionHistoryState,
  transactionHistoryReducer,
  selectFilteredTransactions,
  selectVisibleTransactions,
  selectTotalPages,
  selectViewStatus,
} from '../../src/dashboard/transaction-history.js';

export interface UseTransactionHistoryOptions {
  /** Wallet address used to derive transaction direction. */
  walletAddress?: string;
  /** Rows per page (default 10). */
  pageSize?: number;
  /** External transactions array to feed into the reducer. */
  transactions?: TransactionRecord[];
}

export interface UseTransactionHistoryResult {
  state: TransactionHistoryState;
  visibleTransactions: TransactionRecord[];
  filteredTransactions: TransactionRecord[];
  totalPages: number;
  viewStatus: 'empty' | 'loading' | 'error' | 'ready';
  setFilter: (filter: Partial<TransactionFilters>) => void;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  loadSuccess: (data: unknown) => void;
  loadStart: () => void;
  loadFailure: (error: unknown) => void;
  reset: () => void;
}

/**
 * #768 — Hook wrapping the framework-agnostic transaction-history reducer
 * and selectors, wiring `useReducer` + selector calls into a single
 * ergonomic API.
 */
export function useTransactionHistory(
  options: UseTransactionHistoryOptions = {},
): UseTransactionHistoryResult {
  const { walletAddress, pageSize = 10, transactions } = options;

  const [state, dispatch] = useReducer(
    transactionHistoryReducer,
    createInitialTransactionHistoryState({ pageSize }),
  );

  const prevTransactionsRef = useRef(transactions);

  // Feed external transactions into the reducer when they change.
  if (transactions !== prevTransactionsRef.current) {
    prevTransactionsRef.current = transactions;
    if (transactions) {
      dispatch({
        type: 'LOAD_SUCCESS',
        payload: transactions,
        walletAddress,
      });
    }
  }

  const filteredTransactions = useMemo(
    () => selectFilteredTransactions(state),
    [state],
  );

  const visibleTransactions = useMemo(
    () => selectVisibleTransactions(state),
    [state],
  );

  const totalPages = useMemo(() => selectTotalPages(state), [state]);
  const viewStatus = useMemo(() => selectViewStatus(state), [state]);

  const setFilter = useCallback(
    (filter: Partial<TransactionFilters>) =>
      dispatch({ type: 'SET_FILTER', filter }),
    [],
  );

  const setPage = useCallback(
    (page: number) => dispatch({ type: 'SET_PAGE', page }),
    [],
  );

  const setPageSize = useCallback(
    (size: number) => dispatch({ type: 'SET_PAGE_SIZE', pageSize: size }),
    [],
  );

  const loadSuccess = useCallback(
    (data: unknown) =>
      dispatch({ type: 'LOAD_SUCCESS', payload: data, walletAddress }),
    [walletAddress],
  );

  const loadStart = useCallback(
    () => dispatch({ type: 'LOAD_START' }),
    [],
  );

  const loadFailure = useCallback(
    (error: unknown) => dispatch({ type: 'LOAD_FAILURE', error }),
    [],
  );

  const reset = useCallback(() => dispatch({ type: 'RESET' }), []);

  return {
    state,
    visibleTransactions,
    filteredTransactions,
    totalPages,
    viewStatus,
    setFilter,
    setPage,
    setPageSize,
    loadSuccess,
    loadStart,
    loadFailure,
    reset,
  };
}

export type {
  TransactionHistoryState,
  TransactionFilters,
  TransactionRecord,
  TransactionStatus,
  TransactionKind,
  TransactionDirection,
};
