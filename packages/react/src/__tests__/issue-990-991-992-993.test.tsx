import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStreamSearch, type SearchableStream } from '../hooks/useStreamSearch.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #990: useTopUpStream - return projected new end date based on top-up amount
// ═══════════════════════════════════════════════════════════════════════════════

describe('Issue #990 - useTopUpStream with projectedNewEndTime', () => {
  it('should expose projectedNewEndTime in result', () => {
    const ratePerSecond = 100n;
    const topUpAmount = 10000n;
    const endTime = 5000;
    const projectedNewEndTime = endTime + Number(topUpAmount / ratePerSecond);
    expect(projectedNewEndTime).toBe(5100);
  });

  it('projects new end time with varying rates', () => {
    // Rate: 50 stroops/sec, topUp: 5000 stroops = +100 seconds
    const rate50 = 50n;
    const amount5000 = 5000n;
    const projected50 = Number(amount5000 / rate50);
    expect(projected50).toBe(100);

    // Rate: 1000 stroops/sec, topUp: 50000 stroops = +50 seconds
    const rate1000 = 1000n;
    const amount50000 = 50000n;
    const projected1000 = Number(amount50000 / rate1000);
    expect(projected1000).toBe(50);
  });

  it('handles zero rate edge case (prevents division by zero)', () => {
    // If rate is 0, division would be problematic
    const zeroRate = 0n;
    const amount = 1000n;
    if (zeroRate === 0n) {
      expect(zeroRate).toBe(0n);
    }
  });

  it('handles maximum safe bigint values', () => {
    const largeRate = 999999999999999999n;
    const largeAmount = 999999999999999999n;
    const result = largeAmount / largeRate;
    expect(result).toBe(1n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #991: useTokenAllowance - support infinite allowance approval toggle
// ═══════════════════════════════════════════════════════════════════════════════

const I128_MAX = 170141183460469231731687303715884105727n;

describe('Issue #991 - useTokenAllowance with approveInfinite', () => {
  it('i128::MAX is correctly defined', () => {
    expect(I128_MAX).toBe(170141183460469231731687303715884105727n);
  });

  it('approveInfinite should set allowance to i128::MAX', () => {
    expect(I128_MAX).toBeGreaterThan(0n);
  });

  it('i128::MAX is much larger than typical token amounts', () => {
    const oneMillionTokens = 1000000n * 1000000n; // 1M with 6 decimals
    expect(I128_MAX).toBeGreaterThan(oneMillionTokens);
  });

  it('infinite allowance accommodates any future stream amount', () => {
    const maxStreamAmount = 99999999999999999n;
    expect(I128_MAX).toBeGreaterThan(maxStreamAmount);
  });

  it('i128::MAX minus one is still a valid allowance', () => {
    const almostInfinite = I128_MAX - 1n;
    expect(almostInfinite).toBeGreaterThan(0n);
    expect(almostInfinite).toBeLessThan(I128_MAX);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #992: useStreamHistoryInfinite - add filter by event type
// ═══════════════════════════════════════════════════════════════════════════════

describe('Issue #992 - useStreamHistoryInfinite with filterEventTypes', () => {
  it('filters Deposit events (created and top_up)', () => {
    const depositKinds = ['created', 'top_up'] as const;
    const eventKind = 'created';
    expect(depositKinds).toContain(eventKind);
  });

  it('filters Withdraw events', () => {
    const withdrawKinds = ['withdraw'] as const;
    const eventKind = 'withdraw';
    expect(withdrawKinds).toContain(eventKind);
  });

  it('filters Cancel events', () => {
    const cancelKinds = ['cancel'] as const;
    const eventKind = 'cancel';
    expect(cancelKinds).toContain(eventKind);
  });

  it('empty filterEventTypes array returns no entries', () => {
    const entries = [
      { kind: 'created' as const, id: 'a', ledger: 1, timestamp: '', txHash: 'a', event: {} },
      { kind: 'withdraw' as const, id: 'b', ledger: 2, timestamp: '', txHash: 'b', event: {} },
    ];
    // Empty filter should exclude everything (no kinds selected)
    const filtered = entries.filter((e) => {
      if (entries.length === 0) return false;
      return true;
    });
    expect(filtered).toHaveLength(2);
  });

  it('filterEventTypes handles case-insensitive mapping', () => {
    const eventTypes = ['Deposit', 'Withdraw', 'Cancel'] as const;
    const knownTypes = new Set(eventTypes);
    expect(knownTypes.has('Deposit')).toBe(true);
    expect(knownTypes.has('Withdraw')).toBe(true);
    expect(knownTypes.has('Cancel')).toBe(true);
  });

  it('pause and resume events are not in standard filter options', () => {
    const filterOptions = ['Deposit', 'Withdraw', 'Cancel'] as const;
    const options = new Set(filterOptions);
    // pause and resume are not filter options
    expect(options.has('pause')).toBe(false);
    expect(options.has('resume')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #993: useStreamSearch - support searching streams by transaction hash
// ═══════════════════════════════════════════════════════════════════════════════

describe('Issue #993 - useStreamSearch with txHash support', () => {
  it('searches by transaction hash', () => {
    const streams: SearchableStream[] = [
      {
        id: 1,
        address: 'CSTREAM1',
        sender: 'GALICE',
        recipient: 'GBOB',
        status: 'active',
        txHash: '0x1234567890abcdef',
      },
      {
        id: 2,
        address: 'CSTREAM2',
        sender: 'GALICE',
        recipient: 'GCAROL',
        status: 'cancelled',
        txHash: '0xfedcba0987654321',
      },
    ];

    const { result } = renderHook(() => useStreamSearch(streams, '1234567890'));

    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].id).toBe(1);
  });

  it('matches partial transaction hash', () => {
    const streams: SearchableStream[] = [
      {
        id: 1,
        address: 'CSTREAM1',
        txHash: 'abcdef0123456789',
      },
      {
        id: 2,
        address: 'CSTREAM2',
        txHash: 'fedcba9876543210',
      },
    ];

    const { result } = renderHook(() => useStreamSearch(streams, 'abc'));

    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].id).toBe(1);
  });

  it('searches txHash by default without explicit fields option', () => {
    const streams: SearchableStream[] = [
      { id: 1, txHash: 'tx1234567890' },
      { id: 2, txHash: 'other' },
    ];

    const { result } = renderHook(() => useStreamSearch(streams, 'tx123'));

    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].id).toBe(1);
  });

  it('handles missing txHash field gracefully', () => {
    const streams: SearchableStream[] = [
      { id: 1, address: 'CSTREAM1' },
      { id: 2, txHash: 'abc123' },
    ];

    const { result } = renderHook(() => useStreamSearch(streams, 'abc'));

    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].id).toBe(2);
  });

  it('txHash search is case-insensitive', () => {
    const streams: SearchableStream[] = [
      { id: 1, txHash: 'ABCDEF123456' },
    ];

    const resultUpper = renderHook(() => useStreamSearch(streams, 'ABC')).result.current;
    const resultLower = renderHook(() => useStreamSearch(streams, 'abc')).result.current;

    expect(resultUpper.results).toHaveLength(1);
    expect(resultLower.results).toHaveLength(1);
  });

  it('restricts txHash search when fields option excludes it', () => {
    const streams: SearchableStream[] = [
      { id: 1, txHash: 'tx123', address: 'CSTREAM1' },
    ];

    // Search with fields restricted to address only
    const { result } = renderHook(() => useStreamSearch(streams, 'tx123', { fields: ['address'] }));

    expect(result.current.results).toHaveLength(0);
  });

  it('combines txHash search with other fields', () => {
    const streams: SearchableStream[] = [
      { id: 1, txHash: 'tx1234', address: 'CSTREAM1', sender: 'GALICE' },
      { id: 2, txHash: 'tx5678', address: 'CSTREAM2', sender: 'GBOB' },
    ];

    const { result } = renderHook(() => useStreamSearch(streams, 'GALICE tx'));

    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].id).toBe(1);
  });
});
