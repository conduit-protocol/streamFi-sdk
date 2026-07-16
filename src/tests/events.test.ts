import { describe, it, expect } from 'vitest';
import { Keypair, Address, xdr, nativeToScVal } from '@stellar/stellar-sdk';
import { dispatchEvent } from '../events.js';
import type {
  StreamEventHandlers,
  WithdrawEvent,
  CancelEvent,
  PauseEvent,
  ResumeEvent,
  TopUpEvent,
  ClawbackEvent,
} from '../types/index.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

const actorAddress = Keypair.random().publicKey();

function topic(name: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(name);
}

function actorTopic(): xdr.ScVal {
  return new Address(actorAddress).toScVal();
}

function i128(val: bigint): xdr.ScVal {
  return nativeToScVal(val, { type: 'i128' });
}

function u64(val: bigint | number): xdr.ScVal {
  return nativeToScVal(BigInt(val), { type: 'u64' });
}

function tuple(...fields: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(fields);
}

function makeEvent(topicName: string, value: xdr.ScVal): Parameters<typeof dispatchEvent>[0] {
  return {
    topic: [topic(topicName), actorTopic()],
    value,
  } as Parameters<typeof dispatchEvent>[0];
}

// ── withdrawn: (amount, total_withdrawn, remaining) ───────────────────────────

describe('dispatchEvent — withdrawn', () => {
  it('decodes all three i128 tuple fields, not zeros', () => {
    const event = makeEvent('withdrawn', tuple(i128(10_000n), i128(25_000n), i128(75_000n)));
    let received: WithdrawEvent | undefined;
    const handlers: StreamEventHandlers = { onWithdraw: (e) => { received = e; } };

    dispatchEvent(event, handlers);

    expect(received).toEqual({
      recipient:      actorAddress,
      amount:         10_000n,
      totalWithdrawn: 25_000n,
      remaining:      75_000n,
    });
  });
});

// ── cancelled: (refund_amount, withdrawn_so_far) ──────────────────────────────

describe('dispatchEvent — cancelled', () => {
  it('decodes both i128 tuple fields', () => {
    const event = makeEvent('cancelled', tuple(i128(180_000n), i128(60_000n)));
    let received: CancelEvent | undefined;
    const handlers: StreamEventHandlers = { onCancel: (e) => { received = e; } };

    dispatchEvent(event, handlers);

    expect(received).toEqual({
      sender:         actorAddress,
      refundAmount:   180_000n,
      withdrawnSoFar: 60_000n,
    });
  });
});

// ── paused: (paused_at: u64, withdrawable: i128) ──────────────────────────────

describe('dispatchEvent — paused', () => {
  it('decodes the u64 timestamp and i128 withdrawable amount', () => {
    const event = makeEvent('paused', tuple(u64(1_700_000_000), i128(5_000n)));
    let received: PauseEvent | undefined;
    const handlers: StreamEventHandlers = { onPause: (e) => { received = e; } };

    dispatchEvent(event, handlers);

    expect(received).toEqual({
      sender:       actorAddress,
      pausedAt:     1_700_000_000,
      withdrawable: 5_000n,
    });
  });
});

// ── resumed: resumed_at: u64 (bare scalar, not a tuple) ───────────────────────

describe('dispatchEvent — resumed', () => {
  it('decodes the bare u64 scalar', () => {
    const event = makeEvent('resumed', u64(1_700_003_600));
    let received: ResumeEvent | undefined;
    const handlers: StreamEventHandlers = { onResume: (e) => { received = e; } };

    dispatchEvent(event, handlers);

    expect(received).toEqual({ sender: actorAddress, resumedAt: 1_700_003_600 });
  });
});

// ── topped_up: (amount, new_balance) ──────────────────────────────────────────

describe('dispatchEvent — topped_up', () => {
  it('decodes both i128 tuple fields', () => {
    const event = makeEvent('topped_up', tuple(i128(50_000n), i128(150_000n)));
    let received: TopUpEvent | undefined;
    const handlers: StreamEventHandlers = { onTopUp: (e) => { received = e; } };

    dispatchEvent(event, handlers);

    expect(received).toEqual({ sender: actorAddress, amount: 50_000n, newBalance: 150_000n });
  });
});

// ── clawback: amount: i128 (bare scalar, not a tuple) ─────────────────────────

describe('dispatchEvent — clawback', () => {
  it('decodes the bare i128 scalar', () => {
    const event = makeEvent('clawback', i128(300_000n));
    let received: ClawbackEvent | undefined;
    const handlers: StreamEventHandlers = { onClawback: (e) => { received = e; } };

    dispatchEvent(event, handlers);

    expect(received).toEqual({ sender: actorAddress, amount: 300_000n });
  });
});

// ── Robustness ─────────────────────────────────────────────────────────────

describe('dispatchEvent — edge cases', () => {
  it('does not throw for an unrecognized topic', () => {
    const event = makeEvent('unknown_topic', i128(1n));
    expect(() => dispatchEvent(event, {})).not.toThrow();
  });

  it('does not call a handler that was not registered', () => {
    const event = makeEvent('withdrawn', tuple(i128(1n), i128(1n), i128(1n)));
    expect(() => dispatchEvent(event, {})).not.toThrow();
  });

  it('does not throw when topics array is empty', () => {
    const event = {
      topic: [],
      value: i128(1n),
    } as unknown as Parameters<typeof dispatchEvent>[0];
    expect(() => dispatchEvent(event, { onWithdraw: () => { throw new Error('should not fire'); } })).not.toThrow();
  });
});
