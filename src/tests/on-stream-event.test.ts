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

import { onStreamEvent } from '../events.js';

describe('onStreamEvent', () => {
  describe("'Cancelled'", () => {
    beforeEach(() => { vi.useFakeTimers(); getEvents.mockReset(); });
    afterEach(() => vi.useRealTimers());

    it('decodes a real on-chain cancelled event', async () => {
      const sender = Keypair.random().publicKey();
      getEvents.mockResolvedValueOnce({
        events: [{
          ledger: 1,
          topic: [xdr.ScVal.scvSymbol('cancelled'), new Address(sender).toScVal()],
          value: xdr.ScVal.scvVec([
            xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('10') })),
            xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('5') })),
          ]),
        }],
      });

      let received: unknown;
      const sub = onStreamEvent('http://rpc', 'CSTREAM', 'Cancelled', (event) => { received = event; });

      await vi.waitFor(() => expect(received).toBeDefined());
      expect(received).toEqual({ sender, refundAmount: 10n, withdrawnSoFar: 5n, sequence: undefined });
      sub.unsubscribe();
    });

    it('does not fire for unrelated event types', async () => {
      const sender = Keypair.random().publicKey();
      getEvents.mockResolvedValue({
        events: [{
          ledger: 1,
          topic: [
            xdr.ScVal.scvSymbol('clawback'),
            new Address(sender).toScVal(),
          ],
          value: nativeToScVal(1n, { type: 'i128' }),
        }],
      });

      const callback = vi.fn();
      const sub = onStreamEvent('http://rpc', 'CSTREAM', 'Cancelled', callback);
      await vi.waitFor(() => expect(getEvents).toHaveBeenCalled());
      expect(callback).not.toHaveBeenCalled();
      sub.unsubscribe();
    });
  });

  describe("'CliffReached'", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => vi.useRealTimers());

    it('fires once the wall clock reaches cliffTime', async () => {
      const now = Math.floor(Date.now() / 1000);
      const callback = vi.fn();
      const sub = onStreamEvent('http://rpc', 'CSTREAM', 'CliffReached', callback, {
        cliffTime: now + 10,
        pollInterval: 1000,
      });

      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(11_000);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({ cliffTime: now + 10 });
      sub.unsubscribe();
    });

    it('fires immediately when cliffTime has already passed', async () => {
      const now = Math.floor(Date.now() / 1000);
      const callback = vi.fn();
      const sub = onStreamEvent('http://rpc', 'CSTREAM', 'CliffReached', callback, {
        cliffTime: now - 10,
      });

      expect(callback).toHaveBeenCalledTimes(1);
      sub.unsubscribe();
    });

    it('does not fire again after unsubscribe', async () => {
      const now = Math.floor(Date.now() / 1000);
      const callback = vi.fn();
      const sub = onStreamEvent('http://rpc', 'CSTREAM', 'CliffReached', callback, {
        cliffTime: now + 10,
        pollInterval: 1000,
      });

      sub.unsubscribe();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(callback).not.toHaveBeenCalled();
    });

    it('throws when cliffTime is missing', () => {
      expect(() =>
        // @ts-expect-error — intentionally omitting required options to test the runtime guard
        onStreamEvent('http://rpc', 'CSTREAM', 'CliffReached', vi.fn()),
      ).toThrow(/cliffTime/);
    });
  });
});
