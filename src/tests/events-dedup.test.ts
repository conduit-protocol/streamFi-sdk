import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, Address, xdr, nativeToScVal } from '@stellar/stellar-sdk';

const getEvents = vi.fn();
vi.mock('../soroban.js', async (orig) => ({
  ...(await orig<typeof import('../soroban.js')>()),
  createRpcServer: () => ({
    getLatestLedger: async () => ({ sequence: 1 }),
    getEvents,
  }),
}));

import { subscribeToStream } from '../events.js';

function ev(id: string, seq: number) {
  return {
    id,
    topic: [
      xdr.ScVal.scvSymbol('resumed'),
      new Address(Keypair.random().publicKey()).toScVal(),
      nativeToScVal(BigInt(seq), { type: 'u64' }),
    ],
    value: nativeToScVal(1n, { type: 'u64' }),
  };
}

describe('subscribeToStream event deduplication', () => {
  beforeEach(() => { vi.useFakeTimers(); getEvents.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it('does not dispatch the same event id twice across overlapping polls', async () => {
    getEvents
      .mockResolvedValueOnce({ events: [ev('a', 1), ev('b', 2)], latestLedger: 2 })
      .mockResolvedValue({ events: [ev('b', 2), ev('c', 3)], latestLedger: 3 });
    const onResume = vi.fn();
    const sub = subscribeToStream('http://rpc', Keypair.random().publicKey(), { onResume, pollInterval: 10 });
    await vi.advanceTimersByTimeAsync(25);
    sub.unsubscribe();
    expect(onResume).toHaveBeenCalledTimes(3);
  });

  it('can be disabled with dedupWindowSize: 0', async () => {
    getEvents.mockResolvedValue({ events: [ev('a', 1)], latestLedger: 2 });
    const onResume = vi.fn();
    const sub = subscribeToStream('http://rpc', Keypair.random().publicKey(), { onResume, pollInterval: 10, dedupWindowSize: 0 });
    await vi.advanceTimersByTimeAsync(5);
    sub.unsubscribe();
    expect(onResume.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
