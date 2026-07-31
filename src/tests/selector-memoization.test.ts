import { describe, it, expect } from 'vitest';

import {
  createInitialTransactionHistoryState,
  transactionHistoryReducer,
  selectFilteredTransactions,
  selectVisibleTransactions,
  selectTotalPages,
  selectViewStatus,
  type TransactionRecord,
  type TransactionHistoryState,
} from '../dashboard/transaction-history.js';

/**
 * Covers the selector memoisation added in #408 — the WeakMap cache keyed on
 * the identity of `state.transactions` plus a filter signature.
 *
 * The existing suite in `transaction-history-crash.test.ts` covers ordering,
 * pagination and view status. What it does not pin down is the *caching
 * contract* itself: when the cache must hit, when it must miss, and that a hit
 * never serves a projection built under different filters. Those are the
 * invariants that make the memoisation safe, so they are asserted directly
 * here — a regression in them is silent otherwise.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function record(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: 'id-0',
    hash: 'HASH0',
    streamId: '0',
    kind: 'CREATE',
    direction: 'IN',
    status: 'CONFIRMED',
    amount: '10000000',
    asset: 'XLM',
    counterparty: 'GAAA',
    timestamp: 1_000,
    ...overrides,
  };
}

function makeRows(count: number): TransactionRecord[] {
  return Array.from({ length: count }, (_, i) =>
    record({
      id: `id-${i}`,
      hash: `HASH${i}`,
      streamId: String(i),
      counterparty: `GADDR${i}`,
      kind: i % 2 === 0 ? 'CREATE' : 'WITHDRAW',
      direction: i % 3 === 0 ? 'OUT' : 'IN',
      status: i % 5 === 0 ? 'PENDING' : 'CONFIRMED',
      // Deliberately unsorted so the ranking path is exercised.
      timestamp: (count - i) * 1_000,
    }),
  );
}

function stateWith(
  overrides: Partial<TransactionHistoryState> = {},
): TransactionHistoryState {
  return createInitialTransactionHistoryState(overrides);
}

const ALL_FILTERS = {
  status: 'ALL',
  kind: 'ALL',
  direction: 'ALL',
} as const;

// ---------------------------------------------------------------------------
// Cache hits and misses
// ---------------------------------------------------------------------------

describe('selector cache — when it must hit', () => {
  it('returns the identical array for repeated calls on the same state', () => {
    const state = stateWith({ transactions: makeRows(50) });
    expect(selectFilteredTransactions(state)).toBe(selectFilteredTransactions(state));
  });

  it('hits across a paging-only state change, since paging reuses the rows array', () => {
    const rows = makeRows(50);
    const first = stateWith({ transactions: rows, page: 0 });
    const second = stateWith({ transactions: rows, page: 2 });
    expect(selectFilteredTransactions(first)).toBe(selectFilteredTransactions(second));
  });

  it('hits across a page-size-only change', () => {
    const rows = makeRows(50);
    expect(selectFilteredTransactions(stateWith({ transactions: rows, pageSize: 10 }))).toBe(
      selectFilteredTransactions(stateWith({ transactions: rows, pageSize: 25 })),
    );
  });

  it('hits when SET_PAGE moves through the reducer', () => {
    const loaded = transactionHistoryReducer(createInitialTransactionHistoryState(), {
      type: 'LOAD_SUCCESS',
      payload: { transactions: makeRows(40) },
    });
    const paged = transactionHistoryReducer(loaded, { type: 'SET_PAGE', page: 2 });

    expect(paged.transactions).toBe(loaded.transactions);
    expect(selectFilteredTransactions(paged)).toBe(selectFilteredTransactions(loaded));
  });

  it('shares one projection between all four selectors in a render', () => {
    const state = stateWith({ transactions: makeRows(30), pageSize: 10 });
    const filtered = selectFilteredTransactions(state);

    // The other selectors must agree with the projection they share.
    expect(selectTotalPages(state)).toBe(Math.ceil(filtered.length / 10));
    expect(selectViewStatus(state)).toBe('ready');
    expect(selectVisibleTransactions(state)).toHaveLength(10);
    expect(selectFilteredTransactions(state)).toBe(filtered);
  });
});

describe('selector cache — when it must miss', () => {
  it('misses when a new rows array arrives with identical content', () => {
    const a = selectFilteredTransactions(stateWith({ transactions: makeRows(5) }));
    const b = selectFilteredTransactions(stateWith({ transactions: makeRows(5) }));
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
  });

  it('misses when a filter value changes on the same rows array', () => {
    const rows = makeRows(20);
    const all = selectFilteredTransactions(stateWith({ transactions: rows }));
    const narrowed = selectFilteredTransactions(
      stateWith({ transactions: rows, filters: { ...ALL_FILTERS, kind: 'CREATE', search: '' } }),
    );

    expect(narrowed).not.toBe(all);
    expect(narrowed.length).toBeLessThan(all.length);
    expect(narrowed.every((tx) => tx.kind === 'CREATE')).toBe(true);
  });

  it('misses when only the search term changes', () => {
    const rows = makeRows(20);
    const one = selectFilteredTransactions(
      stateWith({ transactions: rows, filters: { ...ALL_FILTERS, search: 'HASH1' } }),
    );
    const two = selectFilteredTransactions(
      stateWith({ transactions: rows, filters: { ...ALL_FILTERS, search: 'HASH2' } }),
    );
    expect(two).not.toBe(one);
  });

  it('does not confuse two filters that differ only in which field is set', () => {
    const rows = makeRows(30);
    const byKind = selectFilteredTransactions(
      stateWith({ transactions: rows, filters: { ...ALL_FILTERS, kind: 'CREATE', search: '' } }),
    );
    const byDirection = selectFilteredTransactions(
      stateWith({ transactions: rows, filters: { ...ALL_FILTERS, direction: 'OUT', search: '' } }),
    );

    expect(byKind).not.toBe(byDirection);
    expect(byKind.every((tx) => tx.kind === 'CREATE')).toBe(true);
    expect(byDirection.every((tx) => tx.direction === 'OUT')).toBe(true);
  });

  it('re-filters after a SET_FILTER action rather than serving the stale projection', () => {
    let state = transactionHistoryReducer(createInitialTransactionHistoryState(), {
      type: 'LOAD_SUCCESS',
      payload: { transactions: makeRows(12) },
    });
    const before = selectFilteredTransactions(state);

    state = transactionHistoryReducer(state, { type: 'SET_FILTER', filter: { kind: 'CREATE' } });
    const after = selectFilteredTransactions(state);

    expect(after).not.toBe(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((tx) => tx.kind === 'CREATE')).toBe(true);
  });

  it('a search term containing spaces cannot collide with another filter combination', () => {
    const rows = [
      record({ id: 'spaced', hash: 'ALL ALL x' }),
      record({ id: 'plain', hash: 'ZZZ' }),
    ];
    const spacedSearch = selectFilteredTransactions(
      stateWith({ transactions: rows, filters: { ...ALL_FILTERS, search: 'ALL ALL x' } }),
    );
    const noSearch = selectFilteredTransactions(
      stateWith({ transactions: rows, filters: { ...ALL_FILTERS, search: '' } }),
    );

    expect(spacedSearch.map((tx) => tx.id)).toEqual(['spaced']);
    expect(noSearch).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Filtering behaviour the cache has to preserve
// ---------------------------------------------------------------------------

describe('filter predicate', () => {
  it('returns every row when no filter is active', () => {
    expect(selectFilteredTransactions(stateWith({ transactions: makeRows(25) }))).toHaveLength(25);
  });

  it('returns an empty array for undefined state', () => {
    expect(selectFilteredTransactions(undefined)).toEqual([]);
  });

  it('tolerates a non-array transactions field', () => {
    const broken = { transactions: null } as unknown as TransactionHistoryState;
    expect(selectFilteredTransactions(broken)).toEqual([]);
  });

  it('drops null holes in the rows array', () => {
    const rows = [record({ id: 'a' }), null, record({ id: 'b' })];
    const state = stateWith({ transactions: rows as unknown as TransactionRecord[] });
    expect(selectFilteredTransactions(state).map((tx) => tx.id)).toEqual(['a', 'b']);
  });

  it('applies status, kind and direction together', () => {
    const state = stateWith({
      transactions: makeRows(30),
      filters: { status: 'CONFIRMED', kind: 'WITHDRAW', direction: 'IN', search: '' },
    });
    const filtered = selectFilteredTransactions(state);

    expect(filtered.length).toBeGreaterThan(0);
    for (const tx of filtered) {
      expect(tx.status).toBe('CONFIRMED');
      expect(tx.kind).toBe('WITHDRAW');
      expect(tx.direction).toBe('IN');
    }
  });

  it('search is case-insensitive and trimmed', () => {
    const state = stateWith({
      transactions: [record({ id: 'hit', hash: 'ABCDEF' }), record({ id: 'miss', hash: 'ZZZZZZ' })],
      filters: { ...ALL_FILTERS, search: '   bcd  ' },
    });
    expect(selectFilteredTransactions(state).map((tx) => tx.id)).toEqual(['hit']);
  });

  it('search matches hash, streamId, counterparty and asset', () => {
    const rows = [
      record({ id: 'h', hash: 'NEEDLE1', streamId: 'x', counterparty: 'x', asset: 'x' }),
      record({ id: 's', hash: 'x', streamId: 'needle2', counterparty: 'x', asset: 'x' }),
      record({ id: 'c', hash: 'x', streamId: 'x', counterparty: 'NEEDLE3', asset: 'x' }),
      record({ id: 'a', hash: 'x', streamId: 'x', counterparty: 'x', asset: 'needle4' }),
      record({ id: 'n', hash: 'x', streamId: 'x', counterparty: 'x', asset: 'x' }),
    ];

    for (const [needle, expected] of [
      ['needle1', 'h'],
      ['needle2', 's'],
      ['needle3', 'c'],
      ['needle4', 'a'],
    ] as const) {
      const state = stateWith({
        transactions: rows,
        filters: { ...ALL_FILTERS, search: needle },
      });
      expect(selectFilteredTransactions(state).map((tx) => tx.id)).toEqual([expected]);
    }
  });

  it('coerces non-string searchable fields instead of throwing', () => {
    const weird = record({
      hash: 42 as unknown as string,
      streamId: 7n as unknown as string,
      counterparty: null as unknown as string,
    });
    const state = stateWith({
      transactions: [weird],
      filters: { ...ALL_FILTERS, search: '42' },
    });
    expect(selectFilteredTransactions(state)).toHaveLength(1);
  });

  it('treats an explicitly undefined filter key the way the object spread does', () => {
    const state = {
      ...stateWith({ transactions: makeRows(4) }),
      filters: { status: undefined } as unknown as TransactionHistoryState['filters'],
    };
    // `status` is an own key, so it wins over the default and is not 'ALL'.
    expect(selectFilteredTransactions(state)).toEqual([]);
  });

  it('falls back to the defaults when filters is missing entirely', () => {
    const state = {
      ...stateWith({ transactions: makeRows(4) }),
      filters: undefined as unknown as TransactionHistoryState['filters'],
    };
    expect(selectFilteredTransactions(state)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Downstream selectors reading through the cache
// ---------------------------------------------------------------------------

describe('selectors reading the cached projection', () => {
  it('selectTotalPages agrees with the filtered count under an active filter', () => {
    const state = stateWith({
      transactions: makeRows(30),
      pageSize: 5,
      filters: { ...ALL_FILTERS, kind: 'CREATE', search: '' },
    });
    expect(selectTotalPages(state)).toBe(Math.ceil(selectFilteredTransactions(state).length / 5));
  });

  it('selectViewStatus reports empty when a filter excludes every row', () => {
    const state = stateWith({
      transactions: makeRows(10),
      filters: { ...ALL_FILTERS, search: 'nope' },
    });
    expect(selectViewStatus(state)).toBe('empty');
  });

  it('selectViewStatus prefers rows over loading and error flags', () => {
    const rows = makeRows(2);
    expect(selectViewStatus(stateWith({ loading: true, transactions: rows }))).toBe('ready');
    expect(selectViewStatus(stateWith({ error: 'boom', transactions: rows }))).toBe('ready');
  });

  it('selectVisibleTransactions hands back a fresh array the caller may mutate', () => {
    const state = stateWith({ transactions: makeRows(10), pageSize: 10 });
    const first = selectVisibleTransactions(state);
    first.length = 0;
    expect(selectVisibleTransactions(state)).toHaveLength(10);
  });

  it('consecutive pages are disjoint and stay in newest-first order', () => {
    const rows = makeRows(20);
    const p0 = selectVisibleTransactions(stateWith({ transactions: rows, page: 0, pageSize: 5 }));
    const p1 = selectVisibleTransactions(stateWith({ transactions: rows, page: 1, pageSize: 5 }));

    expect(p0).toHaveLength(5);
    expect(p1).toHaveLength(5);
    expect(p0.map((t) => t.id)).not.toEqual(p1.map((t) => t.id));
    expect(p0[4]!.timestamp).toBeGreaterThanOrEqual(p1[0]!.timestamp);
  });

  it('a filtered page still comes back newest-first', () => {
    const state = stateWith({
      transactions: makeRows(40),
      pageSize: 8,
      filters: { ...ALL_FILTERS, kind: 'WITHDRAW', search: '' },
    });
    const page = selectVisibleTransactions(state);

    expect(page.length).toBeGreaterThan(0);
    for (let i = 1; i < page.length; i++) {
      expect(page[i - 1]!.timestamp).toBeGreaterThanOrEqual(page[i]!.timestamp);
    }
    expect(page.every((tx) => tx.kind === 'WITHDRAW')).toBe(true);
  });

  it('RESET clears the projection', () => {
    let state = transactionHistoryReducer(createInitialTransactionHistoryState(), {
      type: 'LOAD_SUCCESS',
      payload: { transactions: makeRows(12) },
    });
    expect(selectFilteredTransactions(state)).toHaveLength(12);

    state = transactionHistoryReducer(state, { type: 'RESET' });
    expect(selectFilteredTransactions(state)).toEqual([]);
    expect(selectViewStatus(state)).toBe('empty');
  });
});
