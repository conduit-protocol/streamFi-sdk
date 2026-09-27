/**
 * Framework-agnostic state model for the Transaction History view.
 *
 * ## Why this module exists (#136 / #103)
 *
 * The Transaction History component crashed immediately on render because its
 * state hook read variables that were never initialised:
 *
 * ```ts
 * // BROKEN — `transactions` and `filters` are `undefined` on first render
 * const [state, setState] = useState<HistoryState>();
 * ...
 * state.transactions.map(...)          // TypeError: Cannot read properties of
 *                                      // undefined (reading 'map')
 * ```
 *
 * Two distinct undefined-variable hazards were involved:
 *
 * 1. **Undefined initial state.** `useState()` / `useReducer(reducer)` invoked
 *    without an initial value yields `undefined` on the very first render, so
 *    every property access in the render body throws before the data ever
 *    arrives from the indexer.
 * 2. **Undefined payloads from the network.** Even with an initial value, the
 *    GraphQL response may be `undefined` (in-flight, aborted by the 15s
 *    timeout, or an `errorPolicy: 'all'` partial response), and individual
 *    records may be missing `amount`, `counterparty`, `status`, etc.
 *
 * Both classes of failure are eliminated here rather than in the React layer:
 * the state shape is *always* fully populated, every reducer transition is
 * total (unknown actions return the previous state unchanged), and every
 * selector is defensive about `null` / `undefined` / wrong-typed input. The
 * React component is then a thin, crash-proof projection of this state.
 *
 * Keeping the logic outside the component also makes it testable in the SDK's
 * Node-based vitest suite — `examples/dashboard` has no test runner and the
 * root package has no React dependency (see the note on the reverted
 * `token-selector-rendering.test.ts` in #159).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle status of a single transaction row. */
export type TransactionStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

/** Direction of value flow relative to the connected wallet. */
export type TransactionDirection = 'IN' | 'OUT' | 'UNKNOWN';

/** Transaction kinds surfaced by the indexer. */
export type TransactionKind =
  | 'CREATE'
  | 'WITHDRAW'
  | 'PAUSE'
  | 'RESUME'
  | 'CANCEL'
  | 'TOP_UP'
  | 'UNKNOWN';

/**
 * A normalised transaction record. Every field is non-optional: normalisation
 * substitutes safe defaults so the render layer never has to null-check.
 */
export interface TransactionRecord {
  id: string;
  hash: string;
  streamId: string;
  kind: TransactionKind;
  direction: TransactionDirection;
  status: TransactionStatus;
  /** Amount in stroops, kept as a string to avoid precision loss. */
  amount: string;
  asset: string;
  counterparty: string;
  /** Unix epoch milliseconds. `0` when the indexer omitted a timestamp. */
  timestamp: number;
}

/** User-controlled filters applied client-side to the fetched page. */
export interface TransactionFilters {
  status: TransactionStatus | 'ALL';
  kind: TransactionKind | 'ALL';
  direction: TransactionDirection | 'ALL';
  /** Free-text match against hash, stream id, counterparty and asset. */
  search: string;
}

/** Complete Transaction History state. Never `undefined`, never partial. */
export interface TransactionHistoryState {
  transactions: TransactionRecord[];
  filters: TransactionFilters;
  page: number;
  pageSize: number;
  loading: boolean;
  /** Human-readable error message, or `null` when there is no error. */
  error: string | null;
  /** Epoch ms of the last successful load; `0` before the first success. */
  lastUpdated: number;
}

export type TransactionHistoryAction =
  | { type: 'LOAD_START' }
  | {
      type: 'LOAD_SUCCESS';
      payload: unknown;
      receivedAt?: number;
      /**
       * Address of the connected wallet. Used to derive the viewer-relative
       * `direction` of each row, since most indexers never emit one.
       */
      walletAddress?: string;
    }
  | { type: 'LOAD_FAILURE'; error: unknown }
  | { type: 'SET_FILTER'; filter: Partial<TransactionFilters> }
  | { type: 'SET_PAGE'; page: unknown }
  | { type: 'SET_PAGE_SIZE'; pageSize: unknown }
  | { type: 'RESET' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 10;

export const INITIAL_TRANSACTION_FILTERS: Readonly<TransactionFilters> =
  Object.freeze({
    status: 'ALL',
    kind: 'ALL',
    direction: 'ALL',
    search: '',
  });

/**
 * The single source of truth for the initial state.
 *
 * Passing this to `useReducer` (or `useState`) is what prevents the
 * first-render crash: `state.transactions` is an array from the very first
 * paint, before any network response exists.
 */
export function createInitialTransactionHistoryState(
  overrides: Partial<TransactionHistoryState> = {},
): TransactionHistoryState {
  const base: TransactionHistoryState = {
    transactions: [],
    filters: { ...INITIAL_TRANSACTION_FILTERS },
    page: 0,
    pageSize: DEFAULT_PAGE_SIZE,
    loading: false,
    error: null,
    lastUpdated: 0,
  };

  const merged: TransactionHistoryState = {
    ...base,
    ...overrides,
    // Guard the two nested/array members against explicit `null` overrides.
    transactions: Array.isArray(overrides.transactions)
      ? overrides.transactions
      : base.transactions,
    filters: { ...base.filters, ...(overrides.filters ?? {}) },
  };

  return merged;
}

const VALID_STATUSES: readonly TransactionStatus[] = [
  'PENDING',
  'CONFIRMED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN',
];

const VALID_KINDS: readonly TransactionKind[] = [
  'CREATE',
  'WITHDRAW',
  'PAUSE',
  'RESUME',
  'CANCEL',
  'TOP_UP',
  'UNKNOWN',
];

const VALID_DIRECTIONS: readonly TransactionDirection[] = [
  'IN',
  'OUT',
  'UNKNOWN',
];

// ---------------------------------------------------------------------------
// Coercion helpers — all total functions, never throw
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return fallback;
}

const SPACE_SEPARATED_DATETIME = /^(\d{4}-\d{2}-\d{2})[ ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

function toIso8601(value: string): string {
  const match = value.match(SPACE_SEPARATED_DATETIME);
  return match ? match[1] + 'T' + match[2] + 'Z' : value;
}

function asTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Indexers emit seconds for `createdAt`; normalise to milliseconds.
    // Use digit count to disambiguate: 10 digits ⇒ seconds, 13 digits ⇒ ms.
    // This avoids the pre-2001 ms misclassification of the old < 1e12 check.
    const abs = Math.abs(value);
    if (abs >= 1e9 && abs < 1e10) {
      // 10 digits: seconds epoch (1970–2033 range)
      return Math.trunc(value) * 1000;
    }
    if (abs >= 1e12 && abs < 1e13) {
      // 13 digits: milliseconds epoch
      return Math.trunc(value);
    }
    // Ambiguous digit count (e.g. 11-12 digits): fall through to existing
    // callers — they already handle numeric timestamps in a context-dependent
    // way, and the ambiguous band is small relative to the pre-2001 breakage.
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim();
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return asTimestamp(numeric);
    const parsed = Date.parse(toIso8601(trimmed));
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? 0 : time;
  }
  return 0;
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof value !== 'string') return fallback;
  const upper = value.trim().toUpperCase();
  return (allowed as readonly string[]).includes(upper) ? (upper as T) : fallback;
}

/** Extracts a readable message from anything that was thrown or returned. */
export function toErrorMessage(
  error: unknown,
  fallback = 'Failed to load transaction history.',
): string {
  if (typeof error === 'string' && error.trim() !== '') return error;
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Direction derivation
// ---------------------------------------------------------------------------

/**
 * Derives the viewer-relative value direction from the transaction kind when
 * the indexer does not emit an explicit `direction` (most don't — direction
 * depends on which wallet is viewing the row, so it is not a property of the
 * on-chain event).
 *
 * The connected wallet is threaded in so we only guess when it actually
 * participates in the row, mirroring the ISSUE-566 guidance:
 *
 * - `WITHDRAW` — the wallet is the recipient → money flows **IN**.
 * - `CREATE` / `TOP_UP` — the wallet is the sender → money flows **OUT**.
 * - anything else (`PAUSE`, `RESUME`, `CANCEL`, `UNKNOWN`, …) → `UNKNOWN`.
 *
 * Returns `UNKNOWN` when there is no wallet (nothing to derive against) or
 * when the kind carries no directional meaning.
 */
function deriveTransactionDirection(
  kind: TransactionKind,
  walletAddress: string,
): TransactionDirection {
  if (walletAddress.trim() === '') return 'UNKNOWN';
  switch (kind) {
    case 'WITHDRAW':
      return 'IN';
    case 'CREATE':
    case 'TOP_UP':
      return 'OUT';
    default:
      return 'UNKNOWN';
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Turns one raw indexer record into a fully-populated `TransactionRecord`.
 * Returns `null` for values that cannot possibly be a record (`null`,
 * primitives, arrays) so the caller can drop them.
 *
 * An explicit indexer `direction` is trusted when present; otherwise the
 * `direction` is derived from the transaction `kind` relative to the connected
 * `walletAddress` (see `deriveTransactionDirection`), falling back to
 * `UNKNOWN`.
 */
export function normalizeTransaction(
  raw: unknown,
  walletAddress?: string,
): TransactionRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;

  const id = asString(record['id'] ?? record['hash']);
  const hash = asString(record['hash'] ?? record['txHash'] ?? record['id']);
  const streamId = asString(record['streamId'] ?? record['stream_id']);

  // A record with no identity at all is unusable — drop it rather than
  // rendering a row with an empty React key.
  if (id === '' && hash === '' && streamId === '') return null;

  const amountRaw = record['amount'] ?? record['value'];
  const kind = asEnum(record['kind'] ?? record['type'], VALID_KINDS, 'UNKNOWN');
  const explicitDirection = asEnum(
    record['direction'],
    VALID_DIRECTIONS,
    'UNKNOWN',
  );

  const timestamp = asTimestamp(record['timestamp'] ?? record['createdAt']);
  // When neither id nor hash is present, synthesise a composite key so
  // distinct events on the same stream aren't treated as duplicates.
  const synthesizedId =
    id !== '' ? id : hash !== '' ? hash : `${streamId}:${kind}:${timestamp}`;

  return {
    id: synthesizedId,
    hash,
    streamId: asString(record['streamId'] ?? record['stream_id']),
    kind,
    direction:
      explicitDirection !== 'UNKNOWN'
        ? explicitDirection
        : deriveTransactionDirection(kind, asString(walletAddress)),
    status: asEnum(record['status'], VALID_STATUSES, 'UNKNOWN'),
    amount: asString(amountRaw, '0'),
    asset: asString(record['asset'] ?? record['token'] ?? record['symbol'], 'XLM'),
    counterparty: asString(
      record['counterparty'] ?? record['recipient'] ?? record['sender'],
    ),
    timestamp,
  };
}

/**
 * Normalises a whole payload. Accepts the raw GraphQL `data` object, a bare
 * array, `null`, `undefined` or garbage — and always returns an array.
 *
 * When a `walletAddress` is provided it is forwarded to each row's
 * `normalizeTransaction` so viewer-relative `direction` can be derived for
 * indexers that do not emit it.
 */
export function normalizeTransactions(
  payload: unknown,
  walletAddress?: string,
): TransactionRecord[] {
  let list: unknown = payload;

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const container = payload as Record<string, unknown>;
    list =
      container['transactions'] ??
      container['transactionHistory'] ??
      container['streams'] ??
      container['items'] ??
      container['data'] ??
      // Support the relay-style `{ edges: [{ node }] }` shape.
      (Array.isArray(container['edges'])
        ? (container['edges'] as unknown[]).map((edge) =>
            edge && typeof edge === 'object'
              ? (edge as Record<string, unknown>)['node']
              : edge,
          )
        : undefined);
  }

  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();
  const normalized: TransactionRecord[] = [];

  for (const entry of list) {
    const record = normalizeTransaction(entry, walletAddress);
    if (record === null) continue;
    // De-duplicate on id so a refetch racing a poll cannot produce duplicate
    // React keys.
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    normalized.push(record);
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function clampPage(page: unknown, totalPages: number): number {
  const numeric = typeof page === 'number' ? page : Number(page);
  if (!Number.isFinite(numeric)) return 0;
  const floored = Math.trunc(numeric);
  if (floored < 0) return 0;
  const maxPage = Math.max(0, totalPages - 1);
  return floored > maxPage ? maxPage : floored;
}

/**
 * Total reducer: every action returns a complete state object, and an
 * unrecognised action (or an `undefined` state from a hot reload / persisted
 * store) falls back to a valid state instead of propagating `undefined`.
 */
export function transactionHistoryReducer(
  state: TransactionHistoryState | undefined,
  action: TransactionHistoryAction | undefined,
): TransactionHistoryState {
  const current = state ?? createInitialTransactionHistoryState();

  if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
    return current;
  }

  switch (action.type) {
    case 'LOAD_START':
      // Keep the existing rows visible while refreshing so the table does not
      // flash empty; clear the previous error.
      return { ...current, loading: true, error: null };

    case 'LOAD_SUCCESS': {
      const transactions = normalizeTransactions(
        action.payload,
        action.walletAddress,
      );
      const totalPages = Math.max(
        1,
        Math.ceil(transactions.length / Math.max(1, current.pageSize)),
      );
      return {
        ...current,
        transactions,
        loading: false,
        error: null,
        page: clampPage(current.page, totalPages),
        lastUpdated:
          typeof action.receivedAt === 'number' && Number.isFinite(action.receivedAt)
            ? action.receivedAt
            : Date.now(),
      };
    }

    case 'LOAD_FAILURE':
      // Preserve any previously loaded rows: a failed refresh should degrade
      // to "stale data + error banner", never to a crash or a blank screen.
      return {
        ...current,
        loading: false,
        error: toErrorMessage(action.error),
      };

    case 'SET_FILTER': {
      const raw = action.filter ?? {};
      const validated: Partial<TransactionFilters> = {};

      if (raw.status !== undefined) {
        validated.status = asEnum(raw.status, VALID_STATUSES, 'ALL') as TransactionStatus | 'ALL';
      }
      if (raw.kind !== undefined) {
        validated.kind = asEnum(raw.kind, VALID_KINDS, 'ALL') as TransactionKind | 'ALL';
      }
      if (raw.direction !== undefined) {
        validated.direction = asEnum(raw.direction, VALID_DIRECTIONS, 'ALL') as TransactionDirection | 'ALL';
      }
      if (raw.search !== undefined) {
        validated.search = asString(raw.search);
      }

      return {
        ...current,
        filters: { ...current.filters, ...validated },
        // Any filter change invalidates the current page offset.
        page: 0,
      };
    }

    case 'SET_PAGE': {
      const visible = selectFilteredTransactions(current);
      const totalPages = Math.max(
        1,
        Math.ceil(visible.length / Math.max(1, current.pageSize)),
      );
      return { ...current, page: clampPage(action.page, totalPages) };
    }

    case 'SET_PAGE_SIZE': {
      const numeric =
        typeof action.pageSize === 'number'
          ? action.pageSize
          : Number(action.pageSize);
      const pageSize =
        Number.isFinite(numeric) && numeric > 0
          ? Math.trunc(numeric)
          : DEFAULT_PAGE_SIZE;
      return { ...current, pageSize, page: 0 };
    }

    case 'RESET':
      return createInitialTransactionHistoryState();

    default:
      return current;
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Memoisation for the filter/sort pipeline (#43).
 *
 * A single dashboard render calls `selectViewStatus`, `selectTotalPages` and
 * `selectVisibleTransactions`, and the reducer calls the filter again on every
 * `SET_PAGE` — so the naive implementation walked the whole page of rows four
 * times per interaction and re-sorted it on every page step.
 *
 * The cache is keyed on the identity of `state.transactions` (not on the state
 * object) because pagination and page-size changes produce a *new state* that
 * reuses the *same* rows array — so paging through a loaded page is a filter
 * cache hit (`selectFilteredTransactions`/`entry.filtered`). A new indexer
 * payload allocates a new array via `normalizeTransactions`, which misses the
 * cache and recomputes; a filter change is caught by the signature check.
 * `WeakMap` keeps entries collectable as soon as the rows array is dropped.
 *
 * Ranking/pagination itself (`selectVisibleTransactions`) is NOT cached: it
 * runs a bounded top-k selection (see `topKByTimestampDesc` below) against
 * the cached filtered rows on every call, in O(n log k) rather than the full
 * O(n log n) sort this used to do — cheap enough that recomputing it per call
 * is the point, not a cost to avoid.
 *
 * This assumes records are treated as immutable, which holds throughout this
 * module: the reducer never mutates state and normalisation always allocates
 * fresh records. Mutating a record in place would serve a stale projection.
 */
interface SelectorCacheEntry {
  signature: string;
  filtered: TransactionRecord[];
}

const NO_TRANSACTIONS: readonly TransactionRecord[] = Object.freeze([]);

const selectorCache = new WeakMap<readonly TransactionRecord[], SelectorCacheEntry>();

function selectorEntry(
  state: TransactionHistoryState | undefined,
): SelectorCacheEntry {
  const transactions: readonly TransactionRecord[] = Array.isArray(state?.transactions)
    ? state.transactions
    : NO_TRANSACTIONS;
  const filters = { ...INITIAL_TRANSACTION_FILTERS, ...(state?.filters ?? {}) };
  const search = asString(filters.search).trim().toLowerCase();
  const signature = `${filters.status} ${filters.kind} ${filters.direction} ${search}`;

  const cached = selectorCache.get(transactions);
  if (cached !== undefined && cached.signature === signature) return cached;

  const filtered = transactions.filter((tx) => {
    if (!tx) return false;
    if (filters.status !== 'ALL' && tx.status !== filters.status) return false;
    if (filters.kind !== 'ALL' && tx.kind !== filters.kind) return false;
    if (filters.direction !== 'ALL' && tx.direction !== filters.direction) {
      return false;
    }
    if (search === '') return true;

    return [tx.hash, tx.streamId, tx.counterparty, tx.asset].some((field) =>
      asString(field).toLowerCase().includes(search),
    );
  });

  const entry: SelectorCacheEntry = { signature, filtered };
  selectorCache.set(transactions, entry);
  return entry;
}

/** Applies the active filters. Safe against a malformed/absent state. */
export function selectFilteredTransactions(
  state: TransactionHistoryState | undefined,
): TransactionRecord[] {
  return selectorEntry(state).filtered;
}

interface RankedTransaction {
  tx: TransactionRecord;
  idx: number; // breaks ties the same way a stable sort would
}

function isLowerPriority(a: RankedTransaction, b: RankedTransaction): boolean {
  if (a.tx.timestamp !== b.tx.timestamp) return a.tx.timestamp < b.tx.timestamp;
  return a.idx > b.idx;
}

function siftDown(heap: RankedTransaction[], i: number): void {
  const n = heap.length;
  for (;;) {
    const left = 2 * i + 1;
    const right = 2 * i + 2;
    let smallest = i;
    if (left < n && isLowerPriority(heap[left]!, heap[smallest]!)) {
      smallest = left;
    }
    if (right < n && isLowerPriority(heap[right]!, heap[smallest]!)) {
      smallest = right;
    }
    if (smallest === i) return;
    const tmp = heap[i]!;
    heap[i] = heap[smallest]!;
    heap[smallest] = tmp;
    i = smallest;
  }
}

/** Returns the `k` newest transactions, sorted newest-first, in O(n log k). */
function topKByTimestampDesc(transactions: TransactionRecord[], k: number): TransactionRecord[] {
  if (k <= 0 || transactions.length === 0) return [];

  const heap: RankedTransaction[] = [];
  for (let idx = 0; idx < transactions.length; idx++) {
    const candidate: RankedTransaction = { tx: transactions[idx]!, idx };
    if (heap.length < k) {
      heap.push(candidate);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (isLowerPriority(heap[parent]!, heap[i]!)) break;
        const tmp = heap[i]!;
        heap[i] = heap[parent]!;
        heap[parent] = tmp;
        i = parent;
      }
    } else if (isLowerPriority(heap[0]!, candidate)) {
      heap[0] = candidate;
      siftDown(heap, 0);
    }
  }

  return heap
    .sort((a, b) => (isLowerPriority(a, b) ? 1 : isLowerPriority(b, a) ? -1 : 0))
    .map((r) => r.tx);
}

/** Filtered rows, newest first, sliced to the current page. */
export function selectVisibleTransactions(
  state: TransactionHistoryState | undefined,
): TransactionRecord[] {
  const filtered = selectFilteredTransactions(state);

  const pageSize = Math.max(1, Math.trunc(state?.pageSize ?? DEFAULT_PAGE_SIZE));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = clampPage(state?.page ?? 0, totalPages);
  const start = page * pageSize;

  // Always use the same ordering (`topKByTimestampDesc`, which tie-breaks
  // equal timestamps on the original index via `isLowerPriority`) so that
  // paging through a dataset that shares timestamps never changes order
  // part-way and duplicates/skips rows across the page boundary (#567).
  // The function is O(n log k) and degrades to a full sort for deep pages,
  // so there is no cost to using it uniformly.
  const k = start + pageSize;
  const top = topKByTimestampDesc(filtered, k);
  return top.slice(start, start + pageSize);
}

/** Total number of pages for the current filters (always >= 1). */
export function selectTotalPages(
  state: TransactionHistoryState | undefined,
): number {
  const filtered = selectorEntry(state).filtered;
  const pageSize = Math.max(1, Math.trunc(state?.pageSize ?? DEFAULT_PAGE_SIZE));
  return Math.max(1, Math.ceil(filtered.length / pageSize));
}

/**
 * Which of the mutually exclusive UI states the view should render.
 * Centralised so the component cannot accidentally render a data table with
 * no data (the original crash path).
 */
export function selectViewStatus(
  state: TransactionHistoryState | undefined,
): 'loading' | 'error' | 'empty' | 'ready' {
  const current = state ?? createInitialTransactionHistoryState();
  const hasRows = selectFilteredTransactions(current).length > 0;

  if (current.loading && !hasRows) return 'loading';
  if (current.error !== null && !hasRows) return 'error';
  if (!hasRows) return 'empty';
  return 'ready';
}

// ---------------------------------------------------------------------------
// Display formatters
// ---------------------------------------------------------------------------

/** `GABC…WXYZ` — never throws on short, empty or non-string input. */
export function formatAddress(address: unknown, visible = 6): string {
  const value = asString(address);
  if (value === '') return '—';
  const head = Math.max(2, Math.trunc(visible));
  if (value.length <= head + 4 + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-4)}`;
}

/**
 * Stroops → decimal string. Falls back to `'0'` on unparseable input.
 *
 * `raw` must be a strict integer string (`/^-?\d+$/`) — fractional values
 * (`"1.5"`), grouped values (`"1,000"`), or any other non-digit characters
 * are rejected rather than stripped, since silently discarding a `.` or `,`
 * would mis-scale the amount instead of failing loudly.
 */
export function formatAmount(amount: unknown, decimals = 7): string {
  const raw = asString(amount, '0').trim();
  if (!/^-?\d+$/.test(raw)) return '0';

  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  if (digits === '') return '0';

  const places = Number.isFinite(decimals) ? Math.max(0, Math.trunc(decimals)) : 7;
  const padded = digits.padStart(places + 1, '0');
  // Strip leading zeros from the integer part (keep one) so a long all-zero
  // input like '00000000000' does not group into '0,000' (#618).
  const whole = (padded.slice(0, padded.length - places) || '0').replace(/^0+(?=\d)/, '');
  const fraction = places === 0 ? '' : padded.slice(padded.length - places);
  const trimmedFraction = fraction.replace(/0+$/, '');

  const formattedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // Never emit a signed zero ("-0"): a negative stroop value that scales to
  // nothing is just zero (#618).
  const isZero = formattedWhole === '0' && trimmedFraction === '';
  const sign = negative && !isZero ? '-' : '';

  return trimmedFraction === ''
    ? `${sign}${formattedWhole}`
    : `${sign}${formattedWhole}.${trimmedFraction}`;
}

/** ISO-ish timestamp for display; `'—'` when the indexer omitted one. */
export function formatTimestamp(timestamp: unknown): string {
  const ms = asTimestamp(timestamp);
  if (ms === 0) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

export interface ExportTransactionsOptions {
  /**
   * Whether to format stroop amounts using `formatAmount` (default: true).
   * When false, the raw stroop amount string is exported.
   */
  formatAmounts?: boolean;
  /**
   * Decimal places to pass to `formatAmount` when `formatAmounts` is true (default: 7).
   */
  decimals?: number;
  /**
   * Whether to format addresses using `formatAddress` (default: true).
   * Set to false to export full addresses.
   */
  formatAddresses?: boolean;
  /**
   * Number of visible head characters for `formatAddress` (default: 6).
   */
  visibleAddressChars?: number;
  /**
   * Whether to format timestamps using `formatTimestamp` (default: false).
   * When false, exports the numeric timestamp.
   */
  formatTimestamps?: boolean;
  /**
   * Whether to include the CSV header row (default: true).
   */
  includeHeader?: boolean;
  /**
   * Pretty-print JSON output (default: true).
   */
  pretty?: boolean;
}

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Exports a list of transaction records to a CSV string.
 *
 * Uses `formatAmount` and `formatAddress` for consistent formatting matching
 * the transaction history UI.
 */
export function exportTransactionsToCsv(
  transactions: TransactionRecord[],
  options?: ExportTransactionsOptions,
): string {
  const list = Array.isArray(transactions) ? transactions : [];
  const formatAmounts = options?.formatAmounts !== false;
  const decimals = options?.decimals ?? 7;
  const formatAddresses = options?.formatAddresses !== false;
  const visibleChars = options?.visibleAddressChars ?? 6;
  const formatTimestamps = options?.formatTimestamps === true;
  const includeHeader = options?.includeHeader !== false;

  const headers = [
    'id',
    'hash',
    'streamId',
    'kind',
    'direction',
    'status',
    'amount',
    'asset',
    'counterparty',
    'timestamp',
  ];

  const rows: string[] = [];
  if (includeHeader) {
    rows.push(headers.map(escapeCsvCell).join(','));
  }

  for (const tx of list) {
    if (!tx || typeof tx !== 'object') continue;
    const amountVal = formatAmounts ? formatAmount(tx.amount, decimals) : asString(tx.amount);
    const counterpartyVal = formatAddresses
      ? formatAddress(tx.counterparty, visibleChars)
      : asString(tx.counterparty);
    const timestampVal = formatTimestamps
      ? formatTimestamp(tx.timestamp)
      : asTimestamp(tx.timestamp);

    const row = [
      escapeCsvCell(tx.id),
      escapeCsvCell(tx.hash),
      escapeCsvCell(tx.streamId),
      escapeCsvCell(tx.kind),
      escapeCsvCell(tx.direction),
      escapeCsvCell(tx.status),
      escapeCsvCell(amountVal),
      escapeCsvCell(tx.asset),
      escapeCsvCell(counterpartyVal),
      escapeCsvCell(timestampVal),
    ];
    rows.push(row.join(','));
  }

  return rows.join('\n');
}

/** Filters transactions to those within the given date range (inclusive, epoch ms). */
export function filterByDateRange(
  history: TransactionRecord[],
  range: { from: number; to: number },
): TransactionRecord[] {
  const { from, to } = range;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];
  return history.filter((tx) => tx.timestamp >= from && tx.timestamp <= to);
}

/**
 * Splits a list of transactions into a page.
 * Returns an empty array when the page is out of bounds.
 */
export function paginateHistory(
  history: TransactionRecord[],
  options: { page: number; pageSize: number },
): TransactionRecord[] {
  const { page, pageSize } = options;
  const safePageSize = Math.max(1, Math.trunc(pageSize));
  const safePage = Math.max(0, Math.trunc(page));
  const start = safePage * safePageSize;
  if (start >= history.length) return [];
  return history.slice(start, start + safePageSize);
}

/**
 * Exports a list of transaction records to a JSON string.
 *
 * Formats fields consistently with the transaction history UI.
 */
export function exportTransactionsToJson(
  transactions: TransactionRecord[],
  options?: ExportTransactionsOptions | boolean,
): string {
  const opts = typeof options === 'boolean' ? { pretty: options } : (options ?? {});
  const list = Array.isArray(transactions) ? transactions : [];
  const formatAmounts = opts.formatAmounts !== false;
  const decimals = opts.decimals ?? 7;
  const formatAddresses = opts.formatAddresses !== false;
  const visibleChars = opts.visibleAddressChars ?? 6;
  const formatTimestamps = opts.formatTimestamps === true;
  const pretty = opts.pretty !== false;

  const exported = list
    .filter((tx) => tx && typeof tx === 'object')
    .map((tx) => ({
      id: asString(tx.id),
      hash: asString(tx.hash),
      streamId: asString(tx.streamId),
      kind: tx.kind,
      direction: tx.direction,
      status: tx.status,
      amount: formatAmounts ? formatAmount(tx.amount, decimals) : asString(tx.amount),
      asset: asString(tx.asset),
      counterparty: formatAddresses
        ? formatAddress(tx.counterparty, visibleChars)
        : asString(tx.counterparty),
      timestamp: formatTimestamps
        ? formatTimestamp(tx.timestamp)
        : asTimestamp(tx.timestamp),
    }));

  return pretty ? JSON.stringify(exported, null, 2) : JSON.stringify(exported);
}

