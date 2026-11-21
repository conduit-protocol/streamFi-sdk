import { describe, it, expect } from 'vitest';
import {
  createMockEventStream,
  createMockEventStreamPage,
  DEFAULT_MOCK_EVENT_LIFECYCLE,
} from '../mock-indexer.js';

describe('createMockEventStream (#965)', () => {
  it('generates the default lifecycle in order', () => {
    const entries = createMockEventStream();
    expect(entries.map((e) => e.kind)).toEqual([...DEFAULT_MOCK_EVENT_LIFECYCLE]);
  });

  it('is fully deterministic across calls', () => {
    const a = createMockEventStream();
    const b = createMockEventStream();
    expect(a).toEqual(b);
  });

  it('assigns strictly increasing sequence numbers', () => {
    const entries = createMockEventStream();
    const sequences = entries.map((e) => e.event.sequence);
    expect(sequences).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
  });

  it('assigns strictly increasing ledgers and timestamps', () => {
    const entries = createMockEventStream({ startLedger: 500, startTimestamp: 0 });
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.ledger).toBeGreaterThan(entries[i - 1]!.ledger);
      expect(Date.parse(entries[i]!.timestamp)).toBeGreaterThan(Date.parse(entries[i - 1]!.timestamp));
    }
    expect(entries[0]!.ledger).toBe(500);
  });

  it('respects a custom kinds list', () => {
    const entries = createMockEventStream({ kinds: ['created', 'clawback'] });
    expect(entries.map((e) => e.kind)).toEqual(['created', 'clawback']);
  });

  it('keeps created/withdraw/top_up balances internally consistent', () => {
    const depositAmount = 10_000_000n;
    const entries = createMockEventStream({ depositAmount });
    const created = entries.find((e) => e.kind === 'created');
    const topUp = entries.find((e) => e.kind === 'top_up');
    const withdraws = entries.filter((e) => e.kind === 'withdraw');
    const cancel = entries.find((e) => e.kind === 'cancel');

    expect(created?.event.depositAmount).toBe(depositAmount);
    if (topUp?.kind === 'top_up' && withdraws[0]?.kind === 'withdraw') {
      const totalWithdrawnAfterFirst = withdraws[0].event.totalWithdrawn;
      expect(topUp.event.newBalance - totalWithdrawnAfterFirst).toBe(withdraws[0].event.remaining);
    }
    if (cancel?.kind === 'cancel' && withdraws[1]?.kind === 'withdraw') {
      expect(cancel.event.withdrawnSoFar).toBe(withdraws[1].event.totalWithdrawn);
    }
  });

  it('uses custom sender/recipient/token overrides', () => {
    const [created] = createMockEventStream({
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'USDC',
      kinds: ['created'],
    });
    expect(created?.kind).toBe('created');
    if (created?.kind === 'created') {
      expect(created.event.sender).toBe('GSENDER');
      expect(created.event.recipient).toBe('GRECIPIENT');
      expect(created.event.token).toBe('USDC');
    }
  });
});

describe('createMockEventStreamPage (#965)', () => {
  it('wraps entries with an undefined nextCursor', () => {
    const page = createMockEventStreamPage();
    expect(page.nextCursor).toBeUndefined();
    expect(page.entries).toEqual(createMockEventStream());
  });
});
