import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';

const mockGetEvents = vi.hoisted(() => vi.fn());

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      // A plain class, not vi.fn().mockImplementation(() => ({...})) —
      // Vitest 4's spy wrapper no longer supports `new`-invoking an
      // arrow-function implementation and returning its object as the instance.
      Server: class {
        getEvents = mockGetEvents;
      },
    },
  };
});

describe('subscribeToStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetEvents.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls immediately on subscribe', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', {});
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(1));
    sub.unsubscribe();
  });

  it('filters by the given contract address', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM123', {});
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalled());
    expect(mockGetEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [{ type: 'contract', contractIds: ['CSTREAM123'] }],
      }),
    );
    sub.unsubscribe();
  });

  it('does not send startLedger on the first poll', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', {});
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalled());
    expect(mockGetEvents.mock.calls[0]?.[0]).not.toHaveProperty('startLedger');
    sub.unsubscribe();
  });

  it('uses the RPC cursor to continue polling when a ledger spans multiple pages', async () => {
    const { Address, Keypair } = await import('@stellar/stellar-sdk');
    const sender = Keypair.random().publicKey();
    const makeEvent = () => ({
      ledger: 100,
      topic: [xdr.ScVal.scvSymbol('clawback'), new Address(sender).toScVal()],
      value: xdr.ScVal.scvI128(
        new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('5000') }),
      ),
    });

    mockGetEvents.mockImplementation((params?: { cursor?: string }) => {
      if (params?.cursor === 'page-2') {
        return Promise.resolve({ events: [makeEvent()], latestLedger: 100 });
      }

      return Promise.resolve({
        events: Array.from({ length: 101 }, () => makeEvent()),
        cursor: 'page-2',
        latestLedger: 100,
      });
    });
    const { subscribeToStream } = await import('../events.js');

    const received: unknown[] = [];
    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', {
      pollInterval: 1000,
      onClawback: (event) => { received.push(event); },
    });
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(received).toHaveLength(101));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(received).toHaveLength(102));

    expect(mockGetEvents.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ cursor: 'page-2' }),
    );
    expect(mockGetEvents.mock.calls[1]?.[0]).not.toHaveProperty('startLedger');
    sub.unsubscribe();
  });

  it('dispatches a real event to the matching handler while polling', async () => {
    const { Address, Keypair } = await import('@stellar/stellar-sdk');
    const sender = Keypair.random().publicKey();
    mockGetEvents.mockResolvedValueOnce({
      events: [{
        ledger: 1,
        topic: [xdr.ScVal.scvSymbol('clawback'), new Address(sender).toScVal()],
        value: xdr.ScVal.scvI128(
          new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('5000') }),
        ),
      }],
    });
    const { subscribeToStream } = await import('../events.js');

    let received: unknown;
    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', {
      onClawback: (e) => { received = e; },
    });
    await vi.waitFor(() => expect(received).toBeDefined());
    expect(received).toEqual({ sender, amount: 5_000n });
    sub.unsubscribe();
  });

  it('swallows polling errors and keeps the subscription alive', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetEvents.mockRejectedValueOnce(new Error('rpc unavailable')).mockResolvedValue({ events: [] });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', { pollInterval: 1000 });
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(1));
    // createRpcServer()'s retry-wrapping Proxy adds an extra microtask hop
    // between the mock rejecting and poll()'s own catch/console.warn running,
    // so wait for it rather than asserting immediately.
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(2));

    sub.unsubscribe();
    warn.mockRestore();
  });

  it('unsubscribe stops further polling', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', { pollInterval: 1000 });
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(1));

    sub.unsubscribe();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockGetEvents).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe clears the pending poll timer immediately, not just on its next fire', async () => {
    // Regression test: unsubscribe() must actually clearTimeout() the scheduled
    // poll, not just flip a `stopped` flag that the timer's own callback checks
    // once it eventually fires. Leaving the timer pending keeps its closure
    // (server, handlers, startLedger) alive in the event loop for up to
    // `pollInterval` ms after the caller believed the subscription was torn down.
    mockGetEvents.mockResolvedValue({ events: [] });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', { pollInterval: 5000 });
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(1));

    // The next poll is scheduled and pending in the timer queue. createRpcServer()'s
    // retry-wrapping Proxy adds an extra microtask hop after the mock resolves before
    // poll() reaches its own setTimeout(), so wait for it rather than asserting immediately.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));

    sub.unsubscribe();

    // The pending timer must be gone immediately — not merely inert.
    expect(vi.getTimerCount()).toBe(0);
  });
});
