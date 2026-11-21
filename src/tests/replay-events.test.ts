import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, Address, xdr } from '@stellar/stellar-sdk';

const getEvents = vi.fn();
const getLatestLedger = vi.fn();
vi.mock('../soroban.js', async (orig) => ({
  ...(await orig<typeof import('../soroban.js')>()),
  createRpcServer: () => ({
    getLatestLedger,
    getEvents,
  }),
}));

import { replayEvents } from '../events.js';

function clawbackAtLedger(ledger: number, sender: string, id = `evt-${ledger}`) {
  return {
    id,
    ledger,
    topic: [xdr.ScVal.scvSymbol('clawback'), new Address(sender).toScVal()],
    value: xdr.ScVal.scvI128(
      new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('1') }),
    ),
  };
}

describe('replayEvents', () => {
  beforeEach(() => {
    getEvents.mockReset();
    getLatestLedger.mockReset();
  });

  it('dispatches every event within [fromLedger, toLedger] in order', async () => {
    const sender = Keypair.random().publicKey();
    getEvents.mockResolvedValueOnce({
      events: [clawbackAtLedger(10, sender), clawbackAtLedger(12, sender)],
    });

    const received: number[] = [];
    const result = await replayEvents('http://rpc', 'CSTREAM', {
      onClawback: () => { received.push(received.length); },
    }, 5, { toLedger: 20 });

    expect(getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 5 }));
    expect(received).toHaveLength(2);
    expect(result).toEqual({ dispatched: 2, lastLedger: 12 });
  });

  it('defaults toLedger to the chain latest ledger when omitted', async () => {
    getLatestLedger.mockResolvedValueOnce({ sequence: 42 });
    getEvents.mockResolvedValueOnce({ events: [] });

    await replayEvents('http://rpc', 'CSTREAM', {}, 1);

    expect(getLatestLedger).toHaveBeenCalledTimes(1);
  });

  it('stops once an event past toLedger is seen, without requesting another page', async () => {
    const sender = Keypair.random().publicKey();
    getEvents.mockResolvedValueOnce({
      events: [clawbackAtLedger(5, sender), clawbackAtLedger(25, sender)],
      cursor: 'cursor-1',
    });

    const received: number[] = [];
    const result = await replayEvents('http://rpc', 'CSTREAM', {
      onClawback: () => { received.push(1); },
    }, 1, { toLedger: 20 });

    expect(received).toHaveLength(1);
    expect(result.lastLedger).toBe(5);
    expect(getEvents).toHaveBeenCalledTimes(1);
  });

  it('pages through getEvents using the response cursor until exhausted', async () => {
    const sender = Keypair.random().publicKey();
    getEvents
      .mockResolvedValueOnce({ events: [clawbackAtLedger(1, sender)], cursor: 'c1' })
      .mockResolvedValueOnce({ events: [clawbackAtLedger(2, sender)], cursor: undefined });

    const received: number[] = [];
    const result = await replayEvents('http://rpc', 'CSTREAM', {
      onClawback: () => { received.push(1); },
    }, 1, { toLedger: 20, pageSize: 1 });

    expect(getEvents).toHaveBeenCalledTimes(2);
    expect(getEvents).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'c1' }));
    expect(received).toHaveLength(2);
    expect(result.dispatched).toBe(2);
  });

  it('deduplicates an event id seen across overlapping pages', async () => {
    const sender = Keypair.random().publicKey();
    getEvents
      .mockResolvedValueOnce({ events: [clawbackAtLedger(1, sender, 'dup')], cursor: 'c1' })
      .mockResolvedValueOnce({ events: [clawbackAtLedger(1, sender, 'dup')], cursor: undefined });

    const received: number[] = [];
    const result = await replayEvents('http://rpc', 'CSTREAM', {
      onClawback: () => { received.push(1); },
    }, 1, { toLedger: 20, pageSize: 1 });

    expect(received).toHaveLength(1);
    expect(result.dispatched).toBe(1);
  });

  it('throws when fromLedger is not a positive integer', async () => {
    await expect(replayEvents('http://rpc', 'CSTREAM', {}, 0)).rejects.toThrow(/fromLedger/);
    await expect(replayEvents('http://rpc', 'CSTREAM', {}, -5)).rejects.toThrow(/fromLedger/);
  });

  it('throws when toLedger is less than fromLedger', async () => {
    await expect(replayEvents('http://rpc', 'CSTREAM', {}, 10, { toLedger: 5 })).rejects.toThrow(/toLedger/);
  });

  it('throws when maxPages is exceeded before reaching toLedger', async () => {
    const sender = Keypair.random().publicKey();
    // A full page every time (length === pageSize) with a cursor keeps the
    // paginator going indefinitely, so the maxPages cutoff is what stops it.
    getEvents.mockResolvedValue({ events: [clawbackAtLedger(1, sender)], cursor: 'always-more' });

    await expect(
      replayEvents('http://rpc', 'CSTREAM', {}, 1, { toLedger: 1000, pageSize: 1, maxPages: 2 }),
    ).rejects.toThrow(/maxPages/);
  });
});
