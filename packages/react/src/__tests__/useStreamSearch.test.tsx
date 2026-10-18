import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStreamSearch, type SearchableStream } from '../hooks/useStreamSearch.js';

const streams: SearchableStream[] = [
  { id: 1, address: 'CSTREAM1', sender: 'GALICE', recipient: 'GBOB', status: 'active', memo: 'Payroll March' },
  { id: 2, address: 'CSTREAM2', sender: 'GALICE', recipient: 'GCAROL', status: 'cancelled', note: 'bonus' },
  { id: 3, address: 'CSTREAM3', sender: 'GDAVE', recipient: 'GBOB', status: 'paused', metadata: { dept: 'Engineering' } },
];

const ids = (r: { results: SearchableStream[] }) => r.results.map((s) => s.id);

describe('useStreamSearch', () => {
  it('returns everything for an empty query', () => {
    const { result } = renderHook(() => useStreamSearch(streams, '  '));
    expect(result.current.total).toBe(3);
  });

  it('matches address, party, memo, note and metadata case-insensitively', () => {
    const q = (s: string) => ids(renderHook(() => useStreamSearch(streams, s)).result.current);
    expect(q('cstream2')).toEqual([2]);
    expect(q('gbob')).toEqual([1, 3]);
    expect(q('payroll')).toEqual([1]);
    expect(q('BONUS')).toEqual([2]);
    expect(q('engineer')).toEqual([3]);
  });

  it('requires every term to match', () => {
    const { result } = renderHook(() => useStreamSearch(streams, 'galice bonus'));
    expect(ids(result.current)).toEqual([2]);
  });

  it('fuzzy matches in-order subsequences, ranked after substring hits', () => {
    const { result } = renderHook(() => useStreamSearch(streams, 'gcrl'));
    expect(ids(result.current)).toEqual([2]);
    const off = renderHook(() => useStreamSearch(streams, 'gcrl', { fuzzy: false }));
    expect(off.result.current.total).toBe(0);
  });

  it('filters by status and applies limit with the pre-limit total', () => {
    const s = renderHook(() => useStreamSearch(streams, '', { status: ['ACTIVE', 'paused'] }));
    expect(ids(s.result.current)).toEqual([1, 3]);
    const l = renderHook(() => useStreamSearch(streams, 'g', { limit: 1 }));
    expect(l.result.current.results).toHaveLength(1);
    expect(l.result.current.total).toBe(3);
  });

  it('restricts to the requested fields', () => {
    const { result } = renderHook(() => useStreamSearch(streams, 'gbob', { fields: ['sender'] }));
    expect(result.current.total).toBe(0);
  });

  it('memoises on stable inputs', () => {
    const { result, rerender } = renderHook(() => useStreamSearch(streams, 'gbob', { status: ['active'] }));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('matches transaction hashes by substring', () => {
    const hashed: SearchableStream[] = [
      { id: 1, txHash: '1f9a3c77e0b2d4f6a8c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5' },
      { id: 2, txHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    ];
    const q = (s: string) => ids(renderHook(() => useStreamSearch(hashed, s)).result.current);
    expect(q('1f9a3c77')).toEqual([1]);
    expect(q('ADBEEF')).toEqual([2]);
  });

  it('does not fuzzy-match transaction hashes', () => {
    const hashed: SearchableStream[] = [
      { id: 1, txHash: '1f9a3c77e0b2d4f6a8c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5' },
    ];
    // Every character is an in-order subsequence of the hash, but not a substring.
    const result = renderHook(() => useStreamSearch(hashed, '1f9a3c77e0b2d4f6dbf')).result.current;
    expect(result.total).toBe(0);
  });
});
