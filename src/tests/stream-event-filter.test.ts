import { describe, it, expect } from 'vitest';
import { matchesStreamEventFilter, filterStreamEvents } from '../events.js';
import type { StreamHistoryEntry, StreamEventFilter } from '../events.js';

function base(kind: StreamHistoryEntry['kind'], event: StreamHistoryEntry['event']): StreamHistoryEntry {
  return {
    id: 'evt-1',
    ledger: 100,
    timestamp: '2026-01-01T00:00:00Z',
    txHash: 'txhash',
    kind,
    event,
  } as StreamHistoryEntry;
}

const createdBySender = base('created', {
  sender: 'GSENDER', recipient: 'GRECIPIENT',
  token: 'GTOKEN', depositAmount: 1n, ratePerSecond: 1n, startTime: 1n, endTime: 2n,
} as never);
const withdrawToRecipient = base('withdraw', {
  recipient: 'GRECIPIENT', amount: 1n, totalWithdrawn: 1n, remaining: 1n,
} as never);
const cancelBySender = base('cancel', {
  sender: 'GSENDER', refundAmount: 1n, withdrawnSoFar: 1n,
} as never);

describe('matchesStreamEventFilter', () => {
  it('empty filter matches everything', () => {
    const f: StreamEventFilter = {};
    expect(matchesStreamEventFilter(createdBySender, f)).toBe(true);
    expect(matchesStreamEventFilter(withdrawToRecipient, f)).toBe(true);
  });

  it('filters by recipient (matches withdraw + created)', () => {
    const f: StreamEventFilter = { recipient: 'GRECIPIENT' };
    expect(matchesStreamEventFilter(withdrawToRecipient, f)).toBe(true);
    expect(matchesStreamEventFilter(createdBySender, f)).toBe(true);
    expect(matchesStreamEventFilter(cancelBySender, f)).toBe(false);
  });

  it('filters by sender (matches created + cancel)', () => {
    const f: StreamEventFilter = { sender: 'GSENDER' };
    expect(matchesStreamEventFilter(createdBySender, f)).toBe(true);
    expect(matchesStreamEventFilter(cancelBySender, f)).toBe(true);
    expect(matchesStreamEventFilter(withdrawToRecipient, f)).toBe(false);
  });

  it('requires ALL set fields to match (AND semantics)', () => {
    const f: StreamEventFilter = { sender: 'GSENDER', recipient: 'GRECIPIENT' };
    expect(matchesStreamEventFilter(createdBySender, f)).toBe(true);
    expect(matchesStreamEventFilter(cancelBySender, f)).toBe(false); // no recipient field
  });

  it('streamId matches when present, drops when absent', () => {
    expect(matchesStreamEventFilter({ ...createdBySender, streamId: 'S42' } as unknown as StreamHistoryEntry, { streamId: 'S42' })).toBe(true);
    expect(matchesStreamEventFilter(createdBySender, { streamId: 'S42' })).toBe(false);
  });
});

describe('filterStreamEvents', () => {
  it('keeps only matching entries', () => {
    const all = [createdBySender, withdrawToRecipient, cancelBySender];
    const out = filterStreamEvents(all, { recipient: 'GRECIPIENT' });
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.kind === 'created' || e.kind === 'withdraw')).toBe(true);
  });

  it('returns empty when nothing matches', () => {
    expect(filterStreamEvents([cancelBySender], { recipient: 'NOBODY' })).toEqual([]);
  });
});
