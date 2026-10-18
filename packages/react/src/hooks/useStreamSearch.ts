import { useMemo } from 'react';

/** Minimal shape searched by {@link useStreamSearch}; extra fields are preserved. */
export interface SearchableStream {
  id?: string | number | bigint;
  /** Stream contract address. */
  address?: string;
  sender?: string;
  recipient?: string;
  token?: string;
  /** Status label, e.g. `active`, `paused`, `cancelled`. */
  status?: string;
  memo?: string;
  note?: string;
  /** Transaction hash for the stream creation or event. */
  txHash?: string;
  metadata?: Record<string, unknown>;
}

export interface UseStreamSearchOptions<T extends SearchableStream> {
  /** Restrict matching to these status values (case-insensitive). Empty/undefined = any. */
  status?: string | string[];
  /** Fields to search. Default: id, address, sender, recipient, token, memo, note and string metadata values. */
  fields?: Array<keyof T | `metadata.${string}`>;
  /** Allow in-order gaps between query characters (e.g. `gab` matches `GABCDEF`). Default `true`. */
  fuzzy?: boolean;
  /** Cap on returned results. */
  limit?: number;
}

export interface UseStreamSearchResult<T> {
  results: T[];
  /** Number of matches before `limit` is applied. */
  total: number;
}

const DEFAULT_FIELDS = ['id', 'address', 'sender', 'recipient', 'token', 'memo', 'note', 'txHash'] as const;

/** True when every character of `needle` appears in `haystack` in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Fields holding hex transaction hashes. They match by substring only: hex
 * digits are a–f plus 0–9, so a fuzzy subsequence match would hit almost any
 * hash for a short query.
 */
const HASH_FIELDS = new Set<string>(['txHash']);

interface FieldValue {
  value: string;
  hash: boolean;
}

function fieldValues<T extends SearchableStream>(stream: T, fields?: UseStreamSearchOptions<T>['fields']): FieldValue[] {
  const out: FieldValue[] = [];
  const push = (v: unknown, hash = false) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') out.push({ value: String(v).toLowerCase(), hash });
  };
  if (!fields) {
    for (const f of DEFAULT_FIELDS) push(stream[f], HASH_FIELDS.has(f));
    if (stream.metadata) Object.values(stream.metadata).forEach((v) => push(v));
    return out;
  }
  for (const f of fields) {
    const key = String(f);
    if (key.startsWith('metadata.')) push(stream.metadata?.[key.slice('metadata.'.length)]);
    else push((stream as Record<string, unknown>)[key], HASH_FIELDS.has(key));
  }
  return out;
}

/**
 * Client-side search over an already-loaded stream list (#821): matches the
 * query against sender, recipient, contract address, memo/note and metadata
 * without refetching from the indexer.
 *
 * Whitespace-separated query terms must all match (AND). Each term matches a
 * field by substring, or, when `fuzzy` is on, by in-order subsequence.
 * Substring hits rank above fuzzy-only hits; input order is kept within a rank.
 */
function scoreMatch(term: string, value: string): number {
  const normalized = value.toLowerCase();
  const idx = normalized.indexOf(term);
  if (idx >= 0) {
    return idx + term.length * 0.01;
  }
  return Number.POSITIVE_INFINITY;
}

function fuzzyScore(term: string, value: string): number {
  return isSubsequence(term, value) ? term.length : Number.POSITIVE_INFINITY;
}

/**
 * Client-side search over an already-loaded stream list (#821).
 *
 * Matches the query against sender, recipient, contract address, memo, note, transaction hash,
 * and metadata without refetching from the indexer.
 *
 * Whitespace-separated query terms must all match (AND). Each term matches a field by
 * substring, or, when `fuzzy` is on, by in-order subsequence. Transaction hashes match by
 * substring only. Substring hits rank above fuzzy-only hits; input order is kept within a rank.
 *
 * @param streams - Already-loaded stream list to search
 * @param query - Whitespace-separated search terms (case-insensitive)
 * @param options.status - Optional status filter(s)
 * @param options.fields - Optional fields to search; default: id, address, sender, recipient, token, memo, note, txHash
 * @param options.fuzzy - Allow in-order gaps between query characters (default: true)
 * @param options.limit - Maximum results to return
 * @returns Search results and total count before limit is applied
 *
 * @example
 * ```typescript
 * // Search all default fields
 * const { results, total } = useStreamSearch(streams, 'GALICE USDC');
 *
 * // Find the stream created by a given transaction hash (substring match)
 * const byTx = useStreamSearch(streams, '1f9a3c', { fields: ['txHash'] });
 *
 * // Restrict search to specific fields
 * const bySender = useStreamSearch(streams, 'GALICE', {
 *   fields: ['sender'],
 * });
 * ```
 */
export function useStreamSearch<T extends SearchableStream>(
  streams: readonly T[],
  query: string,
  options: UseStreamSearchOptions<T> = {},
): UseStreamSearchResult<T> {
  const { status, fields, fuzzy = true, limit } = options;
  // Collapse array identity so inline `['active']` literals do not defeat memoisation.
  const statusKey = Array.isArray(status) ? status.join('\u0000') : status ?? '';
  const fieldsKey = fields ? fields.map(String).join('\u0000') : '';

  return useMemo(() => {
    const statuses = statusKey ? statusKey.split('\u0000').map((s) => s.toLowerCase()) : [];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    const scored: Array<{ stream: T; score: number }> = [];
    for (const stream of streams) {
      if (statuses.length > 0 && !statuses.includes((stream.status ?? '').toLowerCase())) continue;
      if (terms.length === 0) {
        scored.push({ stream, score: 0 });
        continue;
      }
      const values = fieldValues(stream, fields);
      let score = 0;
      let matched = true;
      for (const term of terms) {
        const substringScore = values.reduce((best, field) => Math.min(best, scoreMatch(term, field.value)), Number.POSITIVE_INFINITY);
        if (Number.isFinite(substringScore)) {
          score += substringScore;
          continue;
        }
        if (fuzzy) {
          const fuzzyMatchScore = values.reduce(
            (best, field) => (field.hash ? best : Math.min(best, fuzzyScore(term, field.value))),
            Number.POSITIVE_INFINITY,
          );
          if (Number.isFinite(fuzzyMatchScore)) {
            score += fuzzyMatchScore + 1000;
            continue;
          }
        }
        matched = false;
        break;
      }
      if (matched) scored.push({ stream, score });
    }

    scored.sort((a, b) => a.score - b.score);
    const all = scored.map((s) => s.stream);
    return { results: limit !== undefined ? all.slice(0, limit) : all, total: all.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams, query, statusKey, fieldsKey, fuzzy, limit]);
}
