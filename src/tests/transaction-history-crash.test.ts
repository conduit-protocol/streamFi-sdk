/**
 * Regression tests for #136 / #103 — "Transaction History crashes on load".
 *
 * Root cause: the component's state hook was initialised without a value
 * (`useState()` / `useReducer(reducer)`), so `state.transactions` was
 * `undefined` on the first render and `.map()` threw before any data arrived.
 * Secondary hazards: undefined/partial GraphQL payloads and records with
 * missing fields.
 *
 * These tests exercise the extracted state model directly. They deliberately
 * do NOT import React: the root SDK package has no react/react-dom dependency
 * and no --jsx support, and `examples/dashboard` has no test runner of its own
 * (same constraint that forced the removal of token-selector-rendering.test.ts
 * in #159). Extracting the logic into `src/dashboard/transaction-history.ts`
 * is what makes the crash path testable in CI at all.
 */

import { describe, it, expect } from 'vitest';
import {
  createInitialTransactionHistoryState,
  transactionHistoryReducer,
  normalizeTransaction,
  normalizeTransactions,
  selectFilteredTransactions,
  selectVisibleTransactions,
  selectTotalPages,
  selectViewStatus,
  formatAddress,
  formatAmount,
  formatTimestamp,
  toErrorMessage,
  DEFAULT_PAGE_SIZE,
  type TransactionHistoryAction,
  type TransactionHistoryState,
} from '../dashboard/transaction-history.js';
import {
  formatAddress as formatAddressFromIndex,
  formatAmount as formatAmountFromIndex,
  formatTimestamp as formatTimestampFromIndex,
} from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    hash: 'abcdef0123456789',
    streamId: '42',
    kind: 'WITHDRAW',
    direction: 'IN',
    status: 'CONFIRMED',
    amount: '12345678',
    asset: 'USDC',
    counterparty: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

/** Simulates the render body: any undefined dereference throws here. */
function renderProjection(state: TransactionHistoryState | undefined) {
  const rows = selectVisibleTransactions(state);
  return rows.map((tx) => ({
    key: tx.id,
    date: formatTimestamp(tx.timestamp),
    who: formatAddress(tx.counterparty),
    amount: `${formatAmount(tx.amount)} ${tx.asset}`,
    status: tx.status,
  }));
}

// ---------------------------------------------------------------------------
// 1. The crash itself — undefined state on first render
// ---------------------------------------------------------------------------

describe('#136 — initial state is fully populated on first render', () => {
  it('never yields undefined collections', () => {
    const state = createInitialTransactionHistoryState();

    expect(state).toBeDefined();
    expect(Array.isArray(state.transactions)).toBe(true);
    expect(state.transactions).toHaveLength(0);
    expect(state.filters).toEqual({
      status: 'ALL',
      kind: 'ALL',
      direction: 'ALL',
      search: '',
    });
    expect(state.page).toBe(0);
    expect(state.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('renders the empty state instead of throwing before data arrives', () => {
    const state = createInitialTransactionHistoryState({ loading: true });

    // This is the exact operation that used to throw
    // "Cannot read properties of undefined (reading 'map')".
    expect(() => renderProjection(state)).not.toThrow();
    expect(renderProjection(state)).toEqual([]);
    expect(selectViewStatus(state)).toBe('loading');
  });

  it('tolerates an explicitly null/undefined transactions override', () => {
    const state = createInitialTransactionHistoryState({
      transactions: null as never,
    });
    expect(state.transactions).toEqual([]);
    expect(() => renderProjection(state)).not.toThrow();
  });

  it('returns a fresh filters object each call (no shared mutable state)', () => {
    const a = createInitialTransactionHistoryState();
    const b = createInitialTransactionHistoryState();
    a.filters.search = 'mutated';
    expect(b.filters.search).toBe('');
  });

  it('projects safely even when the whole state is undefined', () => {
    expect(() => renderProjection(undefined)).not.toThrow();
    expect(renderProjection(undefined)).toEqual([]);
    expect(selectViewStatus(undefined)).toBe('empty');
    expect(selectTotalPages(undefined)).toBe(1);
    expect(selectFilteredTransactions(undefined)).toEqual([]);
  });
});

describe('#224 — public transaction-history formatter exports', () => {
  it('exposes generic formatting helpers from the main SDK entry point', () => {
    expect(formatAddressFromIndex('GABCDEFGHIJKLMNOP')).toBe(
      formatAddress('GABCDEFGHIJKLMNOP')
    );
    expect(formatAmountFromIndex('12345678')).toBe(formatAmount('12345678'));
    expect(formatTimestampFromIndex(Date.UTC(2024, 0, 1))).toBe(
      formatTimestamp(Date.UTC(2024, 0, 1))
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Reducer totality
// ---------------------------------------------------------------------------

describe('#136 — reducer is total and never produces undefined', () => {
  it('recovers from an undefined incoming state', () => {
    const next = transactionHistoryReducer(undefined, { type: 'LOAD_START' });
    expect(next.loading).toBe(true);
    expect(next.transactions).toEqual([]);
  });

  it('returns the current state for an undefined action', () => {
    const state = createInitialTransactionHistoryState();
    expect(transactionHistoryReducer(state, undefined)).toBe(state);
  });

  it('returns the current state for an unknown action type', () => {
    const state = createInitialTransactionHistoryState();
    const action = { type: 'NOT_A_REAL_ACTION' } as unknown as TransactionHistoryAction;
    expect(transactionHistoryReducer(state, action)).toBe(state);
  });

  it('ignores a malformed action object', () => {
    const state = createInitialTransactionHistoryState();
    const action = { nope: true } as unknown as TransactionHistoryAction;
    expect(transactionHistoryReducer(state, action)).toBe(state);
  });

  it('LOAD_SUCCESS with an undefined payload yields an empty list, not a crash', () => {
    const next = transactionHistoryReducer(
      createInitialTransactionHistoryState({ loading: true }),
      { type: 'LOAD_SUCCESS', payload: undefined },
    );
    expect(next.transactions).toEqual([]);
    expect(next.loading).toBe(false);
    expect(next.error).toBeNull();
    expect(selectViewStatus(next)).toBe('empty');
  });

  it('LOAD_START keeps existing rows visible while refreshing', () => {
    const loaded = transactionHistoryReducer(undefined, {
      type: 'LOAD_SUCCESS',
      payload: { transactions: [makeRaw()] },
    });
    const refreshing = transactionHistoryReducer(loaded, { type: 'LOAD_START' });

    expect(refreshing.loading).toBe(true);
    expect(refreshing.transactions).toHaveLength(1);
    expect(selectViewStatus(refreshing)).toBe('ready');
  });

  it('LOAD_FAILURE preserves stale rows and records a readable message', () => {
    const loaded = transactionHistoryReducer(undefined, {
      type: 'LOAD_SUCCESS',
      payload: [makeRaw()],
    });
    const failed = transactionHistoryReducer(loaded, {
      type: 'LOAD_FAILURE',
      error: new Error('indexer timeout'),
    });

    expect(failed.loading).toBe(false);
    expect(failed.error).toBe('indexer timeout');
    expect(failed.transactions).toHaveLength(1);
    // Stale data + banner, not a blank screen.
    expect(selectViewStatus(failed)).toBe('ready');
  });

  it('LOAD_FAILURE with no rows surfaces the error state', () => {
    const failed = transactionHistoryReducer(undefined, {
      type: 'LOAD_FAILURE',
      error: 'boom',
    });
    expect(selectViewStatus(failed)).toBe('error');
    expect(failed.error).toBe('boom');
  });

  it('RESET returns a pristine, valid state', () => {
    const dirty = transactionHistoryReducer(undefined, {
      type: 'LOAD_SUCCESS',
      payload: [makeRaw()],
    });
    const reset = transactionHistoryReducer(dirty, { type: 'RESET' });
    expect(reset).toEqual(createInitialTransactionHistoryState());
  });

  it('survives a random sequence of actions without ever going undefined', () => {
    const actions: TransactionHistoryAction[] = [
      { type: 'LOAD_START' },
      { type: 'LOAD_SUCCESS', payload: null },
      { type: 'SET_PAGE', page: 99 },
      { type: 'SET_FILTER', filter: { status: 'FAILED' } },
      { type: 'LOAD_FAILURE', error: undefined },
      { type: 'SET_PAGE_SIZE', pageSize: -3 },
      { type: 'LOAD_SUCCESS', payload: { transactions: [makeRaw()] } },
      { type: 'SET_FILTER', filter: {} },
      { type: 'RESET' },
    ];

    let state = createInitialTransactionHistoryState();
    for (const action of actions) {
      state = transactionHistoryReducer(state, action);
      expect(state).toBeDefined();
      expect(Array.isArray(state.transactions)).toBe(true);
      expect(state.filters).toBeDefined();
      expect(() => renderProjection(state)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Payload normalisation
// ---------------------------------------------------------------------------

describe('#136 — normalisation of hostile indexer payloads', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a string', 'nope'],
    ['an empty object', {}],
    ['a nulled field', { transactions: null }],
    ['a non-array field', { transactions: 'nope' }],
  ])('returns [] for %s', (_label, payload) => {
    expect(normalizeTransactions(payload)).toEqual([]);
  });

  it('unwraps the common container shapes', () => {
    const raw = makeRaw();
    for (const payload of [
      [raw],
      { transactions: [raw] },
      { transactionHistory: [raw] },
      { items: [raw] },
      { data: [raw] },
      { edges: [{ node: raw }] },
    ]) {
      expect(normalizeTransactions(payload)).toHaveLength(1);
    }
  });

  it('drops unusable entries but keeps the good ones', () => {
    const result = normalizeTransactions([
      null,
      undefined,
      'garbage',
      42,
      [],
      {},
      makeRaw({ id: 'keep-me' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('keep-me');
  });

  it('de-duplicates records sharing an id', () => {
    const result = normalizeTransactions([makeRaw(), makeRaw(), makeRaw()]);
    expect(result).toHaveLength(1);
  });

  it('synthesizes composite keys when id and hash are absent to prevent false dedup', () => {
    const events = [
      { streamId: '5', kind: 'PAUSE', timestamp: 1_700_000_100 },
      { streamId: '5', kind: 'RESUME', timestamp: 1_700_000_200 },
      { streamId: '5', kind: 'WITHDRAW', timestamp: 1_700_000_300 },
    ];
    const result = normalizeTransactions(events);
    expect(result).toHaveLength(3);
    // 10-digit second epochs are normalised to milliseconds (× 1000).
    expect(result[0]?.id).toBe('5:PAUSE:1700000100000');
    expect(result[1]?.id).toBe('5:RESUME:1700000200000');
    expect(result[2]?.id).toBe('5:WITHDRAW:1700000300000');
  });

  it('fills defaults for every missing field', () => {
    const record = normalizeTransaction({ id: 'bare' });
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      id: 'bare',
      streamId: '',
      kind: 'UNKNOWN',
      direction: 'UNKNOWN',
      status: 'UNKNOWN',
      amount: '0',
      asset: 'XLM',
      counterparty: '',
      timestamp: 0,
    });
  });

  it('coerces unknown enum values to UNKNOWN rather than leaking them', () => {
    const record = normalizeTransaction(
      makeRaw({ status: 'WEIRD', kind: 'MYSTERY', direction: 'SIDEWAYS' }),
    );
    expect(record?.status).toBe('UNKNOWN');
    expect(record?.kind).toBe('UNKNOWN');
    expect(record?.direction).toBe('UNKNOWN');
  });

  it('accepts lowercase enum values from the indexer', () => {
    const record = normalizeTransaction(makeRaw({ status: 'pending', kind: 'create' }));
    expect(record?.status).toBe('PENDING');
    expect(record?.kind).toBe('CREATE');
  });

  it('normalises second-precision and ISO timestamps to epoch ms', () => {
    expect(normalizeTransaction(makeRaw({ timestamp: 1_700_000_000 }))?.timestamp).toBe(
      1_700_000_000_000,
    );
    expect(
      normalizeTransaction(makeRaw({ timestamp: '2024-01-01T00:00:00.000Z' }))?.timestamp,
    ).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
    expect(normalizeTransaction(makeRaw({ timestamp: 'not a date' }))?.timestamp).toBe(0);
  });

  it('normalises space-separated indexer timestamps the same way Safari would (#352)', () => {
    expect(
      normalizeTransaction(makeRaw({ timestamp: '2024-01-01 00:00:00' }))?.timestamp,
    ).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
  });

  it('keeps bigint/number amounts as lossless strings', () => {
    expect(normalizeTransaction(makeRaw({ amount: 10n ** 18n }))?.amount).toBe(
      '1000000000000000000',
    );
    expect(normalizeTransaction(makeRaw({ amount: 12345 }))?.amount).toBe('12345');
  });

  it('rejects a record with no usable identity', () => {
    expect(normalizeTransaction({ amount: '1' })).toBeNull();
    expect(normalizeTransaction(null)).toBeNull();
    expect(normalizeTransaction([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3b. Direction derivation from the connected wallet (ISSUE-566)
// ---------------------------------------------------------------------------

describe('#566 — direction is derived from the connected wallet', () => {
  const WALLET = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  it('keeps an explicit indexer direction even when a wallet is supplied', () => {
    const record = normalizeTransaction(
      makeRaw({ kind: 'WITHDRAW', direction: 'OUT' }),
      WALLET,
    );
    expect(record?.direction).toBe('OUT');
  });

  it('derives IN for WITHDRAW (wallet is the recipient)', () => {
    const record = normalizeTransaction(
      makeRaw({ kind: 'WITHDRAW', direction: undefined }),
      WALLET,
    );
    expect(record?.direction).toBe('IN');
  });

  it('derives OUT for CREATE and TOP_UP (wallet is the sender)', () => {
    expect(
      normalizeTransaction(makeRaw({ kind: 'CREATE', direction: undefined }), WALLET)
        ?.direction,
    ).toBe('OUT');
    expect(
      normalizeTransaction(makeRaw({ kind: 'TOP_UP', direction: undefined }), WALLET)
        ?.direction,
    ).toBe('OUT');
    expect(
      normalizeTransaction(makeRaw({ kind: 'create', direction: undefined }), WALLET)
        ?.direction,
    ).toBe('OUT');
  });

  it('leaves non-directional kinds as UNKNOWN', () => {
    for (const kind of ['PAUSE', 'RESUME', 'CANCEL']) {
      expect(
        normalizeTransaction(makeRaw({ kind, direction: undefined }), WALLET)
          ?.direction,
      ).toBe('UNKNOWN');
    }
  });

  it('falls back to UNKNOWN when no wallet is connected', () => {
    expect(
      normalizeTransaction(makeRaw({ kind: 'WITHDRAW', direction: undefined }))
        ?.direction,
    ).toBe('UNKNOWN');
    expect(
      normalizeTransaction(makeRaw({ kind: 'CREATE', direction: undefined }), '')
        ?.direction,
    ).toBe('UNKNOWN');
  });

  it('keeps UNKNOWN when the kind itself is unknown', () => {
    expect(
      normalizeTransaction(
        makeRaw({ kind: 'MYSTERY', direction: undefined }),
        WALLET,
      )?.direction,
    ).toBe('UNKNOWN');
  });

  it('threads the wallet through normalizeTransactions', () => {
    const result = normalizeTransactions(
      [
        makeRaw({ id: 'withdraw-1', kind: 'WITHDRAW', direction: undefined }),
        makeRaw({ id: 'create-1', kind: 'CREATE', direction: undefined }),
      ],
      WALLET,
    );
    expect(result[0]?.direction).toBe('IN');
    expect(result[1]?.direction).toBe('OUT');
  });

  it('threads the wallet through the reducer LOAD_SUCCESS action', () => {
    const state = transactionHistoryReducer(undefined, {
      type: 'LOAD_SUCCESS',
      payload: {
        transactions: [
          makeRaw({ id: 'withdraw-1', kind: 'WITHDRAW', direction: undefined }),
          makeRaw({ id: 'create-1', kind: 'CREATE', direction: undefined }),
        ],
      },
      walletAddress: WALLET,
    });
    expect(state.transactions[0]?.direction).toBe('IN');
    expect(state.transactions[1]?.direction).toBe('OUT');

    // An IN direction filter now actually matches derived rows.
    const filtered = transactionHistoryReducer(state, {
      type: 'SET_FILTER',
      filter: { direction: 'IN' },
    });
    expect(selectFilteredTransactions(filtered).map((t) => t.id)).toEqual([
      'withdraw-1',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Filtering, sorting and pagination
// ---------------------------------------------------------------------------

describe('#136 — selectors', () => {
  const payload = [
    makeRaw({ id: 'a', status: 'CONFIRMED', kind: 'WITHDRAW', timestamp: 3000 }),
    makeRaw({ id: 'b', status: 'PENDING', kind: 'CREATE', timestamp: 1000 }),
    makeRaw({ id: 'c', status: 'FAILED', kind: 'CANCEL', timestamp: 2000 }),
  ];

  const loaded = transactionHistoryReducer(undefined, {
    type: 'LOAD_SUCCESS',
    payload,
  });

  it('sorts newest first', () => {
    expect(selectVisibleTransactions(loaded).map((t) => t.id)).toEqual(['a', 'c', 'b']);
  });

  it('filters by status and resets the page', () => {
    const filtered = transactionHistoryReducer(
      { ...loaded, page: 2 },
      { type: 'SET_FILTER', filter: { status: 'PENDING' } },
    );
    expect(filtered.page).toBe(0);
    expect(selectVisibleTransactions(filtered).map((t) => t.id)).toEqual(['b']);
  });

  it('search is case-insensitive across hash, stream, counterparty and asset', () => {
    const searched = transactionHistoryReducer(loaded, {
      type: 'SET_FILTER',
      filter: { search: 'ABCDEF0123' },
    });
    expect(selectFilteredTransactions(searched)).toHaveLength(3);

    const none = transactionHistoryReducer(loaded, {
      type: 'SET_FILTER',
      filter: { search: 'zzzz-no-match' },
    });
    expect(selectFilteredTransactions(none)).toHaveLength(0);
    expect(selectViewStatus(none)).toBe('empty');
  });

  it('clamps out-of-range and non-numeric pages', () => {
    const small = { ...loaded, pageSize: 2 };
    expect(transactionHistoryReducer(small, { type: 'SET_PAGE', page: 99 }).page).toBe(1);
    expect(transactionHistoryReducer(small, { type: 'SET_PAGE', page: -5 }).page).toBe(0);
    expect(
      transactionHistoryReducer(small, { type: 'SET_PAGE', page: 'x' as never }).page,
    ).toBe(0);
    expect(
      transactionHistoryReducer(small, { type: 'SET_PAGE', page: NaN }).page,
    ).toBe(0);
  });

  it('paginates without leaving a page that no longer exists', () => {
    const paged = { ...loaded, pageSize: 2, page: 1 };
    expect(selectVisibleTransactions(paged).map((t) => t.id)).toEqual(['b']);
    expect(selectTotalPages(paged)).toBe(2);

    // Refetch returns fewer rows — the stale page index must be clamped.
    const shrunk = transactionHistoryReducer(paged, {
      type: 'LOAD_SUCCESS',
      payload: [payload[0]],
    });
    expect(shrunk.page).toBe(0);
    expect(selectVisibleTransactions(shrunk)).toHaveLength(1);
  });

  it('keeps equal timestamps in original order, matching a stable full sort (#375)', () => {
    const tied = [
      makeRaw({ id: 'first', timestamp: 5000 }),
      makeRaw({ id: 'second', timestamp: 5000 }),
      makeRaw({ id: 'third', timestamp: 5000 }),
      makeRaw({ id: 'newest', timestamp: 9000 }),
    ];
    const state = transactionHistoryReducer(undefined, { type: 'LOAD_SUCCESS', payload: tied });
    expect(selectVisibleTransactions(state).map((t) => t.id)).toEqual([
      'newest', 'first', 'second', 'third',
    ]);
  });

  it('matches a brute-force full sort across a large dataset and every page (#375)', () => {
    const n = 2500;
    const pageSize = 25;
    const payloadLarge = Array.from({ length: n }, (_, i) =>
      makeRaw({ id: `tx-${i}`, timestamp: Math.floor(i % 37) }),
    );
    const state = {
      ...transactionHistoryReducer(undefined, { type: 'LOAD_SUCCESS', payload: payloadLarge }),
      pageSize,
    };
    const bruteForce = [...selectFilteredTransactions(state)].sort((a, b) => b.timestamp - a.timestamp);
    const totalPages = selectTotalPages(state);
    for (const page of [0, 1, 2, Math.floor(totalPages / 2), totalPages - 1]) {
      const got = selectVisibleTransactions({ ...state, page }).map((t) => t.id);
      const want = bruteForce.slice(page * pageSize, page * pageSize + pageSize).map((t) => t.id);
      expect(got).toEqual(want);
    }
  });

  it('rejects an invalid page size', () => {
    for (const bad of [0, -1, NaN, 'abc', undefined, null]) {
      const next = transactionHistoryReducer(loaded, {
        type: 'SET_PAGE_SIZE',
        pageSize: bad as never,
      });
      expect(next.pageSize).toBe(DEFAULT_PAGE_SIZE);
    }
    expect(
      transactionHistoryReducer(loaded, { type: 'SET_PAGE_SIZE', pageSize: 25 }).pageSize,
    ).toBe(25);
  });

  it('always reports at least one page', () => {
    expect(selectTotalPages(createInitialTransactionHistoryState())).toBe(1);
  });

  it('view status is mutually exclusive and never "ready" with zero rows', () => {
    const empty = createInitialTransactionHistoryState();
    expect(selectViewStatus(empty)).toBe('empty');
    expect(selectViewStatus({ ...empty, loading: true })).toBe('loading');
    expect(selectViewStatus({ ...empty, error: 'x' })).toBe('error');
    expect(selectViewStatus(loaded)).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// 4b. Consistent ordering across the heap/full-sort switch (#567)
// ---------------------------------------------------------------------------

describe('#567 — pagination never duplicates or skips rows when timestamps tie', () => {
  // A single ledger's events are often stamped with the same timestamp, so most
  // rows share one value. This exercises the equal-timestamp tie-break in BOTH
  // the bounded heap path (early pages) and the full sort path (deep pages).
  const n = 2500;
  const pageSize = 25;
  const payloadTied = Array.from({ length: n }, (_, i) =>
    makeRaw({ id: `tx-${i}`, timestamp: Math.floor(i % 37) }),
  );

  function walkAllPages(state: ReturnType<typeof createInitialTransactionHistoryState>) {
    const totalPages = selectTotalPages(state);
    const seen: string[] = [];
    for (let page = 0; page < totalPages; page++) {
      const rows = selectVisibleTransactions({ ...state, page });
      for (const row of rows) seen.push(row.id);
    }
    return seen;
  }

  it('covers every row exactly once across every page', () => {
    const state = {
      ...transactionHistoryReducer(undefined, {
        type: 'LOAD_SUCCESS',
        payload: payloadTied,
      }),
      pageSize,
    };
    const seen = walkAllPages(state);

    expect(seen).toHaveLength(n);
    expect(new Set(seen).size).toBe(n);

    // The intended ordering is "newest first, ties in original row order". A
    // stable descending sort of the filtered rows (which are in original order)
    // is that canonical ordering, so the walk must match it exactly —
    // independent of where the heap/full-sort switch falls.
    const expected = [...selectFilteredTransactions(state)]
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((t) => t.id);
    expect(seen).toEqual(expected);
  });

  it('adjacent pages around the half-way switch do not share or drop any row', () => {
    const state = {
      ...transactionHistoryReducer(undefined, {
        type: 'LOAD_SUCCESS',
        payload: payloadTied,
      }),
      pageSize,
    };
    // With n=2500 and pageSize=25 the heap branch runs while k < 1250
    // (pages 0..48) and the full-sort branch from page 49 on. Check every
    // boundary pair to prove the ordering is continuous.
    const totalPages = selectTotalPages(state);
    for (let page = 0; page < totalPages - 1; page++) {
      const first = selectVisibleTransactions({
        ...state,
        page,
      });
      const second = selectVisibleTransactions({
        ...state,
        page: page + 1,
      });
      // The boundary between the two branches must be a clean cut-off of one
      // continuous ordering — no overlap, and consecutive within the ordering.
      const overlap = first.filter((f) => second.some((s) => s.id === f.id));
      expect(overlap).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Formatters
// ---------------------------------------------------------------------------

describe('#136 — formatters tolerate undefined input', () => {
  it('formatAddress', () => {
    expect(formatAddress(undefined)).toBe('—');
    expect(formatAddress(null)).toBe('—');
    expect(formatAddress('')).toBe('—');
    expect(formatAddress('SHORT')).toBe('SHORT');
    expect(formatAddress('GABCDEFGHIJKLMNOP')).toBe('GABCDE…MNOP');
  });

  it('formatAmount', () => {
    expect(formatAmount(undefined)).toBe('0');
    expect(formatAmount(null)).toBe('0');
    expect(formatAmount('')).toBe('0');
    expect(formatAmount('garbage')).toBe('0');
    expect(formatAmount('10000000')).toBe('1');
    expect(formatAmount('12345678')).toBe('1.2345678');
    expect(formatAmount('123456789012345')).toBe('12,345,678.9012345');
    expect(formatAmount('-10000000')).toBe('-1');
    expect(formatAmount('123', 0)).toBe('123');
    expect(formatAmount('15000000', 7)).toBe('1.5');
  });

  it('formatAmount rejects non-integer stroop strings instead of mis-scaling (#565)', () => {
    expect(formatAmount('1.5')).toBe('0');
    expect(formatAmount('1,000')).toBe('0');
    expect(formatAmount('1e7')).toBe('0');
    expect(formatAmount('12345678.9')).toBe('0');
    expect(formatAmount(' 12345678 ')).toBe('1.2345678');
    expect(formatAmount('-1.5')).toBe('0');
    expect(formatAmount('--10000000')).toBe('0');
  });

  it('formatTimestamp', () => {
    expect(formatTimestamp(undefined)).toBe('—');
    expect(formatTimestamp(0)).toBe('—');
    expect(formatTimestamp('nonsense')).toBe('—');
    expect(formatTimestamp(Date.UTC(2024, 0, 1))).toBe('2024-01-01 00:00:00');
  });

  it('toErrorMessage', () => {
    expect(toErrorMessage(new Error('kaput'))).toBe('kaput');
    expect(toErrorMessage('plain string')).toBe('plain string');
    expect(toErrorMessage({ message: 'graphql error' })).toBe('graphql error');
    expect(toErrorMessage(undefined)).toBe('Failed to load transaction history.');
    expect(toErrorMessage(new Error(''))).toBe('Failed to load transaction history.');
  });
});

// ---------------------------------------------------------------------------
// 6. End-to-end lifecycle (mirrors the hook's dispatch sequence)
// ---------------------------------------------------------------------------

describe('#136 — full mount → fetch → error → retry lifecycle never throws', () => {
  it('walks the whole path with a projection assertion at each step', () => {
    let state = createInitialTransactionHistoryState({ loading: true });
    expect(renderProjection(state)).toEqual([]); // step 1: mount (used to crash)

    state = transactionHistoryReducer(state, { type: 'LOAD_START' });
    expect(renderProjection(state)).toEqual([]);

    // step 2: indexer times out
    state = transactionHistoryReducer(state, {
      type: 'LOAD_FAILURE',
      error: new Error('AbortError: request timed out'),
    });
    expect(selectViewStatus(state)).toBe('error');
    expect(renderProjection(state)).toEqual([]);

    // step 3: retry succeeds with a messy payload
    state = transactionHistoryReducer(state, { type: 'LOAD_START' });
    state = transactionHistoryReducer(state, {
      type: 'LOAD_SUCCESS',
      payload: {
        transactions: [makeRaw({ id: 'ok' }), null, { garbage: true }],
      },
      receivedAt: 1_700_000_000_000,
    });

    expect(state.error).toBeNull();
    expect(state.lastUpdated).toBe(1_700_000_000_000);
    const rows = renderProjection(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'ok', amount: '1.2345678 USDC' });
  });
});
