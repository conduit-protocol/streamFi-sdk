import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { useQuery } from '@apollo/client';
import { GET_TRANSACTION_HISTORY } from '../lib/graphql-operations';
import {
  createInitialTransactionHistoryState,
  selectTotalPages,
  selectViewStatus,
  selectVisibleTransactions,
  transactionHistoryReducer,
  type TransactionFilters,
  type TransactionHistoryState,
  type TransactionRecord,
  type TransactionStatus,
  type TransactionKind,
  type TransactionDirection,
} from '../../../../src/dashboard/transaction-history';

export interface UseTransactionHistoryResult {
  /** Complete state — never `undefined`, even on the very first render. */
  state: TransactionHistoryState;
  /** Sorted + filtered + paginated rows for the current page. */
  transactions: TransactionRecord[];
  /** Mutually exclusive render branch. */
  status: 'loading' | 'error' | 'empty' | 'ready';
  totalPages: number;
  setFilter: (filter: Partial<TransactionFilters>) => void;
  setPage: (page: number) => void;
  refresh: () => void;
}

/**
 * Transaction History state hook — fixes #136 / #103.
 *
 * The previous implementation called `useState()` with no argument and then
 * dereferenced the result during render, so the component threw
 * `Cannot read properties of undefined` before the first paint.
 *
 * Here the reducer is seeded with `createInitialTransactionHistoryState()`,
 * which is a *fully populated* object (`transactions: []`, `filters: {...}`,
 * `error: null`). Every subsequent transition goes through
 * `transactionHistoryReducer`, which is total: unknown actions and undefined
 * payloads return a valid state rather than corrupting it.
 *
 * Apollo results are pushed into that reducer via an effect instead of being
 * read inline, so a `data` object that is `undefined` (in flight, aborted by
 * the 15s timeout link, or a partial `errorPolicy: 'all'` response) can never
 * reach the render body.
 */
export function useTransactionHistory(
  walletAddress: string,
  limit = 50,
): UseTransactionHistoryResult {
  // The initial value is the entire fix for the crash: state is valid from
  // render #1, before any network response exists.
  //
  // `loading` starts true only when a query will actually be issued. With no
  // wallet the query is skipped, so seeding `loading: true` would render a
  // spinner that only an effect could clear — wrong on the server and a
  // visible flash in the browser.
  const [state, dispatch] = useReducer(
    transactionHistoryReducer,
    undefined,
    () => createInitialTransactionHistoryState({ loading: Boolean(walletAddress) }),
  );

  const { data, loading, error, refetch } = useQuery(GET_TRANSACTION_HISTORY, {
    variables: { walletAddress, limit },
    // Skip entirely when there is no wallet — querying with an empty address
    // returns an indexer error that has nothing to do with the user.
    skip: !walletAddress,
    pollInterval: 30_000,
    // Surface network/timeout errors instead of hanging on loading (#158).
    errorPolicy: 'all',
    notifyOnNetworkStatusChange: true,
  });

  // No wallet connected: settle into a valid, non-loading empty state.
  useEffect(() => {
    if (!walletAddress) {
      dispatch({ type: 'LOAD_SUCCESS', payload: [], walletAddress });
    }
  }, [walletAddress]);

  useEffect(() => {
    if (loading) dispatch({ type: 'LOAD_START' });
  }, [loading]);

  useEffect(() => {
    if (loading) return;
    // `data` may legitimately be undefined here — normalizeTransactions
    // handles that and yields an empty array.
    if (data !== undefined) {
      dispatch({ type: 'LOAD_SUCCESS', payload: data, walletAddress });
    }
  }, [data, loading, walletAddress]);

  useEffect(() => {
    if (error) dispatch({ type: 'LOAD_FAILURE', error });
  }, [error]);

  const setFilter = useCallback((filter: Partial<TransactionFilters>) => {
    const VALID_STATUSES: TransactionStatus[] = ['PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED', 'UNKNOWN'];
    const VALID_KINDS: TransactionKind[] = ['CREATE', 'WITHDRAW', 'PAUSE', 'RESUME', 'CANCEL', 'TOP_UP', 'UNKNOWN'];
    const VALID_DIRECTIONS: TransactionDirection[] = ['IN', 'OUT', 'UNKNOWN'];

    const sanitized: Partial<TransactionFilters> = {};

    if (filter.status !== undefined) {
      sanitized.status = VALID_STATUSES.includes(filter.status) ? filter.status : 'ALL';
    }
    if (filter.kind !== undefined) {
      sanitized.kind = VALID_KINDS.includes(filter.kind) ? filter.kind : 'ALL';
    }
    if (filter.direction !== undefined) {
      sanitized.direction = VALID_DIRECTIONS.includes(filter.direction) ? filter.direction : 'ALL';
    }
    if (filter.search !== undefined && typeof filter.search === 'string') {
      sanitized.search = filter.search;
    }

    dispatch({ type: 'SET_FILTER', filter: sanitized });
  }, []);

  const setPage = useCallback((page: number) => {
    dispatch({ type: 'SET_PAGE', page });
  }, []);

  const refresh = useCallback(() => {
    dispatch({ type: 'LOAD_START' });
    // refetch() rejects on network failure; route it through the reducer so an
    // unhandled rejection can never bubble up and unmount the tree.
    refetch?.().catch((err: unknown) => {
      dispatch({ type: 'LOAD_FAILURE', error: err });
    });
  }, [refetch]);

  const transactions = useMemo(() => selectVisibleTransactions(state), [state]);
  const totalPages = useMemo(() => selectTotalPages(state), [state]);
  const status = useMemo(() => selectViewStatus(state), [state]);

  return { state, transactions, status, totalPages, setFilter, setPage, refresh };
}
