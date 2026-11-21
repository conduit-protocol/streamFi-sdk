import { describe, it, expect } from 'vitest';
import { filterByDateRange, paginateHistory } from '../dashboard/transaction-history.js';
import type { TransactionRecord } from '../dashboard/transaction-history.js';

function makeRecord(timestamp: number): TransactionRecord {
  return {
    id: `tx-${timestamp}`,
    hash: `hash-${timestamp}`,
    streamId: `stream-${timestamp}`,
    kind: 'CREATE',
    direction: 'OUT',
    status: 'CONFIRMED',
    amount: '100',
    asset: 'XLM',
    counterparty: 'GABC',
    timestamp,
  };
}

const records = [
  makeRecord(1000),
  makeRecord(2000),
  makeRecord(3000),
  makeRecord(4000),
  makeRecord(5000),
];

describe('filterByDateRange (#839)', () => {
  it('filters transactions within the date range', () => {
    const result = filterByDateRange(records, { from: 2000, to: 4000 });
    expect(result).toHaveLength(3);
    expect(result.map(r => r.timestamp)).toEqual([2000, 3000, 4000]);
  });

  it('returns empty when no transactions match', () => {
    const result = filterByDateRange(records, { from: 6000, to: 7000 });
    expect(result).toHaveLength(0);
  });

  it('returns empty when from > to', () => {
    const result = filterByDateRange(records, { from: 5000, to: 1000 });
    expect(result).toHaveLength(0);
  });

  it('handles empty input', () => {
    const result = filterByDateRange([], { from: 0, to: 1000 });
    expect(result).toHaveLength(0);
  });

  it('includes boundary timestamps', () => {
    const result = filterByDateRange(records, { from: 1000, to: 5000 });
    expect(result).toHaveLength(5);
  });
});

describe('paginateHistory (#839)', () => {
  it('returns the first page', () => {
    const result = paginateHistory(records, { page: 0, pageSize: 2 });
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('tx-1000');
    expect(result[1]!.id).toBe('tx-2000');
  });

  it('returns the second page', () => {
    const result = paginateHistory(records, { page: 1, pageSize: 2 });
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('tx-3000');
    expect(result[1]!.id).toBe('tx-4000');
  });

  it('returns empty when page is out of bounds', () => {
    const result = paginateHistory(records, { page: 10, pageSize: 2 });
    expect(result).toHaveLength(0);
  });

  it('handles pageSize larger than records', () => {
    const result = paginateHistory(records, { page: 0, pageSize: 100 });
    expect(result).toHaveLength(5);
  });

  it('handles empty records', () => {
    const result = paginateHistory([], { page: 0, pageSize: 10 });
    expect(result).toHaveLength(0);
  });
});
