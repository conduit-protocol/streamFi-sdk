import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, Address, xdr, nativeToScVal } from '@stellar/stellar-sdk';

const { getEvents, getLatestLedger } = vi.hoisted(() => ({
  getEvents: vi.fn(),
  getLatestLedger: vi.fn(),
}));

vi.mock('../soroban.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../soroban.js')>()),
  createRpcServer: () => ({ getEvents, getLatestLedger }),
}));

import { getStreamHistory, DEFAULT_HISTORY_LOOKBACK_LEDGERS } from '../events.js';

const STREAM = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
const actor = new Address(Keypair.random().publicKey()).toScVal();
const i128 = (v: bigint) => nativeToScVal(v, { type: 'i128' });

function ev(n: number, name: string, value: xdr.ScVal) {
  return {
    id: `ev-${n}`, ledger: 1000 + n, ledgerClosedAt: `2026-01-01T00:00:0${n}Z`,
    txHash: `tx-${n}`, pagingToken: `pt-${n}`,
    topic: [xdr.ScVal.scvSymbol(name), actor, nativeToScVal(BigInt(n), { type: 'u64' })],
    value,
  };
}
const withdraw = (n: number) => ev(n, 'withdrawn', xdr.ScVal.scvVec([i128(5n), i128(5n), i128(95n)]));
const topUp    = (n: number) => ev(n, 'topped_up', xdr.ScVal.scvVec([i128(50n), i128(150n)]));

describe('getStreamHistory (#863)', () => {
  beforeEach(() => {
    getEvents.mockReset();
    getLatestLedger.mockReset().mockResolvedValue({ sequence: 500_000 });
  });

  it('decodes withdrawals and top-ups with ledger metadata', async () => {
    getEvents.mockResolvedValue({ latestLedger: 1, events: [withdraw(1), topUp(2)] });
    const page = await getStreamHistory('https://rpc', STREAM, { limit: 10 });

    expect(page.entries.map((e) => e.kind)).toEqual(['withdraw', 'top_up']);
    expect(page.entries[0]).toMatchObject({ id: 'ev-1', ledger: 1001, txHash: 'tx-1', timestamp: '2026-01-01T00:00:01Z' });
    const first = page.entries[0]!;
    if (first.kind === 'withdraw') expect(first.event.remaining).toBe(95n);
    const second = page.entries[1]!;
    if (second.kind === 'top_up') expect(second.event.newBalance).toBe(150n);
  });

  it('starts from a lookback window on the first page and a cursor afterwards', async () => {
    getEvents.mockResolvedValue({ latestLedger: 1, events: [] });
    await getStreamHistory('https://rpc', STREAM);
    expect(getEvents.mock.calls[0]![0]).toMatchObject({
      startLedger: 500_000 - DEFAULT_HISTORY_LOOKBACK_LEDGERS,
      filters: [{ type: 'contract', contractIds: [STREAM] }],
    });

    await getStreamHistory('https://rpc', STREAM, { cursor: 'abc', limit: 5 });
    const second = getEvents.mock.calls[1]![0];
    expect(second).toMatchObject({ cursor: 'abc', limit: 5 });
    expect(second.startLedger).toBeUndefined();
  });

  it('returns a nextCursor only when the page is full', async () => {
    getEvents.mockResolvedValueOnce({ latestLedger: 1, events: [withdraw(1), withdraw(2)] });
    expect((await getStreamHistory('https://rpc', STREAM, { limit: 2 })).nextCursor).toBe('pt-2');

    getEvents.mockResolvedValueOnce({ latestLedger: 1, events: [withdraw(3)] });
    expect((await getStreamHistory('https://rpc', STREAM, { limit: 2 })).nextCursor).toBeUndefined();
  });

  it('prefers the cursor the RPC returns', async () => {
    getEvents.mockResolvedValue({ latestLedger: 1, cursor: 'rpc-cursor', events: [withdraw(1)] });
    expect((await getStreamHistory('https://rpc', STREAM, { limit: 1 })).nextCursor).toBe('rpc-cursor');
  });

  it('skips undecodable events instead of failing the page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = ev(1, 'withdrawn', xdr.ScVal.scvBool(true));
    (bad as { topic: unknown[] }).topic = [xdr.ScVal.scvSymbol('withdrawn'), xdr.ScVal.scvBool(true), xdr.ScVal.scvBool(true)];
    getEvents.mockResolvedValue({ latestLedger: 1, events: [bad, topUp(2)] });
    const page = await getStreamHistory('https://rpc', STREAM, { limit: 10 });
    expect(page.entries.map((e) => e.kind)).toEqual(['top_up']);
    warn.mockRestore();
  });

  it('rejects an out-of-range limit', async () => {
    await expect(getStreamHistory('https://rpc', STREAM, { limit: 0 })).rejects.toThrow(/limit/);
    await expect(getStreamHistory('https://rpc', STREAM, { limit: 201 })).rejects.toThrow(/limit/);
  });
});
