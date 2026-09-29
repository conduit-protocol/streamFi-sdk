import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';

const mockGetEvents = vi.hoisted(() => vi.fn());
const mockGetLatestLedger = vi.hoisted(() => vi.fn());

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
        getLatestLedger = mockGetLatestLedger;
      },
    },
  };
});

describe('subscribeToStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetEvents.mockReset();
    mockGetLatestLedger.mockReset();
    mockGetLatestLedger.mockResolvedValue({ id: 'ledger-x', sequence: 100, protocolVersion: '20' });
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

  it('seeds startLedger from getLatestLedger before the first poll', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    mockGetLatestLedger.mockResolvedValue({ id: 'l', sequence: 4242, protocolVersion: 22 });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', {});
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalled());
    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
    expect(mockGetEvents.mock.calls[0]?.[0]).toHaveProperty('startLedger', 4242);
    sub.unsubscribe();
  });

  it('does not re-fetch getLatestLedger on later polls once a cursor is established', async () => {
    mockGetEvents.mockResolvedValue({ events: [], cursor: 'page-2', latestLedger: 100 });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', { pollInterval: 1000 });
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(2));

    expect(mockGetLatestLedger).toHaveBeenCalledTimes(1);
    sub.unsubscribe();
  });

  it('retries seeding startLedger on the next poll if getLatestLedger itself fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetLatestLedger
      .mockRejectedValueOnce(new Error('rpc unavailable'))
      .mockResolvedValue({ id: 'ledger-x', sequence: 200, protocolVersion: '20' });
    mockGetEvents.mockResolvedValue({ events: [] });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', { pollInterval: 1000 });
    await vi.waitFor(() => expect(mockGetLatestLedger).toHaveBeenCalledTimes(1));
    // The failed seed must not have reached getEvents at all.
    expect(mockGetEvents).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(mockGetLatestLedger).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(1));
    expect(mockGetEvents.mock.calls[0]?.[0]).toHaveProperty('startLedger', 200);

    sub.unsubscribe();
    warn.mockRestore();
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
    expect(received).toEqual({ sender, amount: 5_000n, sequence: undefined });
    sub.unsubscribe();
  });

  it('fires onGap when two dispatched events have a non-contiguous sequence (#505)', async () => {
    const { Address, Keypair, nativeToScVal } = await import('@stellar/stellar-sdk');
    const sender = Keypair.random().publicKey();
    const clawbackAt = (seq: number) => ({
      ledger: 1,
      topic: [
        xdr.ScVal.scvSymbol('clawback'),
        new Address(sender).toScVal(),
        nativeToScVal(BigInt(seq), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvI128(
        new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('1') }),
      ),
    });
    mockGetEvents.mockResolvedValueOnce({
      events: [clawbackAt(1), clawbackAt(2), clawbackAt(5)],
    });
    const { subscribeToStream } = await import('../events.js');

    const gaps: Array<{ expected: bigint; actual: bigint }> = [];
    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', {
      onClawback: () => {},
      onGap: (gap) => { gaps.push(gap); },
    });
    await vi.waitFor(() => expect(gaps).toHaveLength(1));
    expect(gaps[0]).toEqual({ expected: 3n, actual: 5n });
    sub.unsubscribe();
  });

  it('isolates a throwing handler so later events in the batch are still delivered (#809)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { Address, Keypair, nativeToScVal } = await import('@stellar/stellar-sdk');
    const sender = Keypair.random().publicKey();
    const clawbackAt = (seq: number) => ({
      ledger: 1,
      topic: [
        xdr.ScVal.scvSymbol('clawback'),
        new Address(sender).toScVal(),
        nativeToScVal(BigInt(seq), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvI128(
        new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('1') }),
      ),
    });
    mockGetEvents.mockResolvedValueOnce({ events: [clawbackAt(1), clawbackAt(2), clawbackAt(3)] });
    const { subscribeToStream } = await import('../events.js');

    const seen: bigint[] = [];
    const gaps: unknown[] = [];
    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', {
      onClawback: (e) => {
        seen.push(e.sequence as bigint);
        if (e.sequence === 2n) throw new Error('consumer bug');
      },
      onGap: (gap) => { gaps.push(gap); },
    });

    await vi.waitFor(() => expect(seen).toEqual([1n, 2n, 3n]));
    expect(warn).toHaveBeenCalledWith(
      '[conduit-sdk] event handler error:',
      expect.objectContaining({ message: 'consumer bug' }),
    );
    // The throwing handler's event still counts for sequence tracking.
    expect(gaps).toHaveLength(0);
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

  it('surfaces polling errors through onError', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pollingError = new Error('rpc unavailable');
    const onError = vi.fn();
    mockGetEvents.mockRejectedValueOnce(pollingError).mockResolvedValue({ events: [] });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', {
      onError,
      pollInterval: 1000,
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(pollingError));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(2));

    sub.unsubscribe();
    warn.mockRestore();
  });

  it('normalizes non-Error polling failures before calling onError', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onError = vi.fn();
    mockGetEvents.mockRejectedValueOnce('rpc unavailable');
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    expect(onError.mock.calls[0]?.[0]).toEqual(new Error('rpc unavailable'));
    sub.unsubscribe();
    warn.mockRestore();
  });

  it('keeps polling when onError itself throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetEvents.mockRejectedValueOnce(new Error('rpc unavailable')).mockResolvedValue({ events: [] });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', {
      onError: () => { throw new Error('consumer handler failed'); },
      pollInterval: 1000,
    });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));

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

  // ── Backoff and failure cutoff (#485) ────────────────────────────────────
  // Previously poll() rescheduled at a fixed pollInterval no matter how many
  // consecutive failures had occurred, and never stopped — a permanently
  // broken RPC endpoint spun forever.

  it('doubles the retry delay after each consecutive failure (exponential backoff)', async () => {
    // Cumulative simulated delay here is 1s + 2s + 4s = 7s of fake-timer
    // advancement inside vi.waitFor's own polling loop, which takes longer
    // in real wall-clock time than the default 5000ms test timeout.
    // Measured via each call's Date.now() rather than by advancing the fake
    // clock in small fixed steps and asserting "not yet called" in between:
    // vi.waitFor() itself nudges the fake clock forward in its own polling
    // increments while waiting for the *first* call, which would otherwise
    // eat into a tightly-budgeted manual advance and produce a flaky
    // off-by-a-few-ms result. Comparing recorded timestamps sidesteps that.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const callTimes: number[] = [];
    mockGetEvents.mockImplementation(() => {
      callTimes.push(Date.now());
      return Promise.reject(new Error('rpc unavailable'));
    });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', {
      pollInterval: 1000,
      maxConsecutiveFailures: 100,
    });
    await vi.waitFor(() => expect(callTimes.length).toBeGreaterThanOrEqual(4), { timeout: 10_000 });

    expect(callTimes[1]! - callTimes[0]!).toBe(1000); // delay after 1 consecutive failure
    expect(callTimes[2]! - callTimes[1]!).toBe(2000); // delay after 2 consecutive failures
    expect(callTimes[3]! - callTimes[2]!).toBe(4000); // delay after 3 consecutive failures

    sub.unsubscribe();
    warn.mockRestore();
  }, 15_000);

  it('resets the backoff delay after a successful poll', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const callTimes: number[] = [];
    let call = 0;
    mockGetEvents.mockImplementation(() => {
      callTimes.push(Date.now());
      call++;
      // fail, succeed, fail, succeed, succeed, ...
      return call === 1 || call === 3
        ? Promise.reject(new Error('rpc unavailable'))
        : Promise.resolve({ events: [] });
    });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', { pollInterval: 1000 });
    await vi.waitFor(() => expect(callTimes.length).toBeGreaterThanOrEqual(4), { timeout: 10_000 });

    expect(callTimes[1]! - callTimes[0]!).toBe(1000); // after 1 failure: 1x pollInterval
    expect(callTimes[2]! - callTimes[1]!).toBe(1000); // after a success: back to plain pollInterval
    // A single failure right after a reset must delay by pollInterval again,
    // not continue the earlier backoff sequence (which would be 2x here).
    expect(callTimes[3]! - callTimes[2]!).toBe(1000);

    sub.unsubscribe();
    warn.mockRestore();
  }, 15_000);

  it('caps the backoff delay at maxBackoffMs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const callTimes: number[] = [];
    mockGetEvents.mockImplementation(() => {
      callTimes.push(Date.now());
      return Promise.reject(new Error('rpc unavailable'));
    });
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', {
      pollInterval: 1000,
      maxBackoffMs: 2500,
      maxConsecutiveFailures: 100,
    });
    await vi.waitFor(() => expect(callTimes.length).toBeGreaterThanOrEqual(4), { timeout: 10_000 });

    expect(callTimes[1]! - callTimes[0]!).toBe(1000); // min(1000, 2500)
    expect(callTimes[2]! - callTimes[1]!).toBe(2000); // min(2000, 2500)
    expect(callTimes[3]! - callTimes[2]!).toBe(2500); // min(4000, 2500) — capped

    sub.unsubscribe();
    warn.mockRestore();
  }, 15_000);

  it('stops polling after maxConsecutiveFailures consecutive failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onError = vi.fn();
    mockGetEvents.mockRejectedValue(new Error('rpc unavailable'));
    const { subscribeToStream } = await import('../events.js');

    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', {
      pollInterval: 1000,
      maxConsecutiveFailures: 3,
      onError,
    });

    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(1)); // failure 1
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(2)); // failure 2
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(3)); // failure 3 — cutoff hit

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(3));
    // No further poll should be scheduled once the cutoff is hit.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockGetEvents).toHaveBeenCalledTimes(3);

    sub.unsubscribe();
    warn.mockRestore();
  });

  it('replays missed events by sequence on reconnect (#623)', async () => {
    const { Address, Keypair, nativeToScVal } = await import('@stellar/stellar-sdk');
    const sender = Keypair.random().publicKey();
    const clawbackAt = (seq: number) => ({
      ledger: 1,
      topic: [
        xdr.ScVal.scvSymbol('clawback'),
        new Address(sender).toScVal(),
        nativeToScVal(BigInt(seq), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvI128(
        new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString(String(seq)) }),
      ),
    });

    // First poll sees sequence 1 and 3, creating a gap at 2.
    mockGetEvents
      .mockResolvedValueOnce({ events: [clawbackAt(1), clawbackAt(3)] })
      .mockResolvedValueOnce({ events: [clawbackAt(2)] });

    const { subscribeToStream } = await import('../events.js');

    const received: number[] = [];
    const sub = subscribeToStream('http://localhost:8000', 'CSTREAM', {
      onClawback: (event) => { received.push(Number(event.sequence)); },
    });

    await vi.waitFor(() => expect(received).toContain(1));
    await vi.waitFor(() => expect(received).toContain(3));
    // The backfill poll should eventually dispatch the missed sequence 2.
    await vi.waitFor(() => expect(received).toContain(2), { timeout: 3000 });
    expect(received).toEqual([1, 3, 2]);

    sub.unsubscribe();
  });
});

describe('subscribeToStreams', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetEvents.mockReset();
    mockGetLatestLedger.mockReset();
    mockGetLatestLedger.mockResolvedValue({ id: 'ledger-x', sequence: 100, protocolVersion: '20' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls each address independently', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const { subscribeToStreams } = await import('../events.js');

    const sub = subscribeToStreams('http://localhost:8000', ['CSTREAM1', 'CSTREAM2', 'CSTREAM3'], {});
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(3));

    const contractIds = mockGetEvents.mock.calls.map(
      (call) => (call[0] as { filters: Array<{ contractIds: string[] }> }).filters[0]!.contractIds[0],
    );
    expect(contractIds.sort()).toEqual(['CSTREAM1', 'CSTREAM2', 'CSTREAM3']);

    sub.unsubscribe();
  });

  it('shares the same handlers across every address', async () => {
    mockGetEvents.mockResolvedValue({ events: [] });
    const { subscribeToStreams } = await import('../events.js');
    const onError = vi.fn();

    const sub = subscribeToStreams('http://localhost:8000', ['CSTREAM1', 'CSTREAM2'], { onError });
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(2));

    sub.unsubscribe();
  });

  it('unsubscribe() tears down every underlying subscription', async () => {
    mockGetEvents.mockResolvedValue({ events: [], cursor: 'page-2', latestLedger: 100 });
    const { subscribeToStreams } = await import('../events.js');

    const sub = subscribeToStreams(
      'http://localhost:8000',
      ['CSTREAM1', 'CSTREAM2'],
      { pollInterval: 1000 },
    );
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(2));

    sub.unsubscribe();

    // No further polling from either address after unsubscribe.
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockGetEvents).toHaveBeenCalledTimes(2);
  });

  it('returns a working, no-op subscription for an empty address list', async () => {
    const { subscribeToStreams } = await import('../events.js');

    const sub = subscribeToStreams('http://localhost:8000', [], {});
    expect(mockGetEvents).not.toHaveBeenCalled();
    expect(() => sub.unsubscribe()).not.toThrow();
  });

  it('one address failing to poll does not stop the others', async () => {
    mockGetEvents
      .mockRejectedValueOnce(new Error('rpc down for this address'))
      .mockResolvedValue({ events: [] });
    const { subscribeToStreams } = await import('../events.js');
    const onError = vi.fn();

    const sub = subscribeToStreams('http://localhost:8000', ['CBAD', 'CGOOD'], { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mockGetEvents).toHaveBeenCalledTimes(2));

    sub.unsubscribe();
  });
});
