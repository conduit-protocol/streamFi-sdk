import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, Address, xdr } from '@stellar/stellar-sdk';

const getEvents = vi.fn();
vi.mock('../soroban.js', async (orig) => ({
  ...(await orig<typeof import('../soroban.js')>()),
  createRpcServer: () => ({
    getLatestLedger: async () => ({ sequence: 1 }),
    getEvents,
  }),
}));

import { subscribeToStream } from '../events.js';

function clawbackAtLedger(ledger: number, sender: string) {
  return {
    ledger,
    topic: [xdr.ScVal.scvSymbol('clawback'), new Address(sender).toScVal()],
    value: xdr.ScVal.scvI128(
      new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('1') }),
    ),
  };
}

describe('subscribeToStream ledger gap detection (#964)', () => {
  beforeEach(() => { vi.useFakeTimers(); getEvents.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it('fires onLedgerGap and backfills the skipped ledger range when two dispatched events skip a ledger', async () => {
    const sender = Keypair.random().publicKey();

    getEvents
      // First poll: ledger 1, then a jump straight to ledger 5.
      .mockResolvedValueOnce({ events: [clawbackAtLedger(1, sender), clawbackAtLedger(5, sender)], latestLedger: 5 })
      // Backfill fetch for the gap, starting at the expected ledger.
      .mockResolvedValueOnce({ events: [clawbackAtLedger(3, sender)] })
      .mockResolvedValue({ events: [] });

    const gaps: Array<{ expected: number; actual: number }> = [];
    let clawbackCount = 0;
    const sub = subscribeToStream('http://rpc', 'CSTREAM', {
      onClawback: () => { clawbackCount += 1; },
      onLedgerGap: (gap) => { gaps.push(gap); },
      pollInterval: 1000,
    });

    await vi.waitFor(() => expect(gaps).toHaveLength(1));
    expect(gaps[0]).toEqual({ expected: 2, actual: 5 });

    // The backfill request should start exactly where the gap begins.
    await vi.waitFor(() => expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 2 }),
    ));

    // ledger 1, ledger 5 (first poll), then ledger 3 recovered by the backfill.
    await vi.waitFor(() => expect(clawbackCount).toBe(3));

    sub.unsubscribe();
  });

  it('does not fire onLedgerGap for a contiguous or repeated ledger sequence', async () => {
    const sender = Keypair.random().publicKey();
    getEvents.mockResolvedValueOnce({
      events: [clawbackAtLedger(1, sender), clawbackAtLedger(1, sender), clawbackAtLedger(2, sender)],
      latestLedger: 2,
    });

    const gaps: unknown[] = [];
    let clawbackCount = 0;
    const sub = subscribeToStream('http://rpc', 'CSTREAM', {
      onClawback: () => { clawbackCount += 1; },
      onLedgerGap: (gap) => gaps.push(gap),
      pollInterval: 1000,
    });

    await vi.waitFor(() => expect(clawbackCount).toBe(3));
    expect(gaps).toHaveLength(0);
    sub.unsubscribe();
  });
});
