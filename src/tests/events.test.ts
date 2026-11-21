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
  StreamCliffReachedEvent,
  StreamTopUpExtendedEvent,
  ClawbackEvent,
  CreatedEvent,
  ForceCancelEvent,
  RecipientTransferEvent,
  OperatorSetEvent,
  OperatorRevokedEvent,
} from '../types/index.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

const actorAddress = Keypair.random().publicKey();
const otherAddress = Keypair.random().publicKey();

function topic(name: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(name);
}

function address(addr: string): xdr.ScVal {
  return new Address(addr).toScVal();
}

function actorTopic(): xdr.ScVal {
  return new Address(actorAddress).toScVal();
}

function sequenceTopic(seq: bigint | number): xdr.ScVal {
  return nativeToScVal(BigInt(seq), { type: 'u64' });
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

function makeEvent(
  topicName: string,
  value:     xdr.ScVal,
  seq:       bigint | number = 0,
): Parameters<typeof dispatchEvent>[0] {
  return {
    topic: [topic(topicName), actorTopic(), sequenceTopic(seq)],
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
      sequence:       0n,
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
      sequence:       0n,
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
      sequence:     0n,
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

    expect(received).toEqual({ sender: actorAddress, resumedAt: 1_700_003_600, sequence: 0n });
  });
});

// ── topped_up: (amount, new_balance) ──────────────────────────────────────────

describe('dispatchEvent — topped_up', () => {
  it('decodes both i128 tuple fields', () => {
    const event = makeEvent('topped_up', tuple(i128(50_000n), i128(150_000n)));
    let received: TopUpEvent | undefined;
    const handlers: StreamEventHandlers = { onTopUp: (e) => { received = e; } };

    dispatchEvent(event, handlers);

    expect(received).toEqual({ sender: actorAddress, amount: 50_000n, newBalance: 150_000n, sequence: 0n });
  });
});

describe('dispatchEvent — cliff_reached and top_up_extended', () => {
  it('decodes the cliff recipient, timestamp, and unlock amount', () => {
    let received: StreamCliffReachedEvent | undefined;
    dispatchEvent(
      {
        topic: [topic('StreamCliffReached'), actorTopic()],
        value: tuple(u64(1_700_000_000), i128(25_000n)),
      } as Parameters<typeof dispatchEvent>[0],
      { onStreamCliffReached: (event) => { received = event; } },
    );
    expect(received).toEqual({
      recipient: actorAddress,
      timestamp: 1_700_000_000,
      unlockAmount: 25_000n,
    });
  });

  it('decodes the extended top-up amount, balance, and end time', () => {
    let received: StreamTopUpExtendedEvent | undefined;
    dispatchEvent(
      makeEvent(
        'StreamTopUpExtended',
        tuple(u64(1_700_000_000), u64(1_700_100_000), i128(50_000n), i128(150_000n)),
      ),
      { onStreamTopUpExtended: (event) => { received = event; } },
    );
    expect(received).toEqual({
      sender: actorAddress,
      oldEndTime: 1_700_000_000,
      newEndTime: 1_700_100_000,
      addedAmount: 50_000n,
      newTotalDeposit: 150_000n,
      sequence: 0n,
    });
  });
});

// ── clawback: amount: i128 (bare scalar, not a tuple) ─────────────────────────

describe('dispatchEvent — clawback', () => {
  it('decodes the bare i128 scalar', () => {
    const event = makeEvent('clawback', i128(300_000n));
    let received: ClawbackEvent | undefined;
    const handlers: StreamEventHandlers = { onClawback: (e) => { received = e; } };

    dispatchEvent(event, handlers);

    expect(received).toEqual({ sender: actorAddress, amount: 300_000n, sequence: 0n });
  });
});

// ── created: (recipient, token, deposit_amount, rate_per_second, start_time, end_time) ──

describe('dispatchEvent — created', () => {
  it('decodes the address and numeric tuple fields (#506)', () => {
    const event = makeEvent(
      'created',
      tuple(address(otherAddress), address(otherAddress), i128(1_000_000n), i128(10n), u64(1_700_000_000), u64(1_700_100_000)),
    );
    let received: CreatedEvent | undefined;
    const handlers: StreamEventHandlers = { onCreated: (e) => { received = e; } };

    dispatchEvent(event, handlers);

    expect(received).toEqual({
      sender:        actorAddress,
      recipient:     otherAddress,
      token:         otherAddress,
      depositAmount: 1_000_000n,
      ratePerSecond: 10n,
      startTime:     1_700_000_000,
      endTime:       1_700_100_000,
      sequence:      0n,
    });
  });

  it('does not call onCreated when the handler is not registered', () => {
    const event = makeEvent('created', tuple(address(otherAddress), address(otherAddress), i128(1n), i128(1n), u64(1), u64(2)));
    expect(() => dispatchEvent(event, {})).not.toThrow();
  });
});

// ── force_cxl: (payout_amount, refund_amount) ────────────────────────────────

describe('dispatchEvent — force_cxl', () => {
  it('decodes both i128 tuple fields, attributing the actor as the recipient (#506)', () => {
    const event = makeEvent('force_cxl', tuple(i128(50_000n), i128(25_000n)));
    let received: ForceCancelEvent | undefined;
    const handlers: StreamEventHandlers = { onForceCancel: (e) => { received = e; } };

    dispatchEvent(event, handlers);

    expect(received).toEqual({
      recipient:    actorAddress,
      payoutAmount: 50_000n,
      refundAmount: 25_000n,
      sequence:     0n,
    });
  });
});

// ── xfer_rec: new_recipient: address (bare scalar) ───────────────────────────

describe('dispatchEvent — xfer_rec', () => {
  it('decodes the new recipient address, attributing the actor as the previous recipient (#506)', () => {
    const event = makeEvent('xfer_rec', address(otherAddress));
    let received: RecipientTransferEvent | undefined;
    const handlers: StreamEventHandlers = { onRecipientTransfer: (e) => { received = e; } };

    dispatchEvent(event, handlers);

    expect(received).toEqual({
      previousRecipient: actorAddress,
      newRecipient:      otherAddress,
      sequence:           0n,
    });
  });
});

// ── set_op / rm_op: operator: address (bare scalar) ──────────────────────────

describe('dispatchEvent — set_op', () => {
  it('decodes the delegated operator address (#506)', () => {
    const event = makeEvent('set_op', address(otherAddress));
    let received: OperatorSetEvent | undefined;
    const handlers: StreamEventHandlers = { onOperatorSet: (e) => { received = e; } };

    dispatchEvent(event, handlers);

    expect(received).toEqual({ sender: actorAddress, operator: otherAddress, sequence: 0n });
  });
});

describe('dispatchEvent — rm_op', () => {
  it('decodes the revoked operator address (#506)', () => {
    const event = makeEvent('rm_op', address(otherAddress));
    let received: OperatorRevokedEvent | undefined;
    const handlers: StreamEventHandlers = { onOperatorRevoke: (e) => { received = e; } };

    dispatchEvent(event, handlers);

    expect(received).toEqual({ sender: actorAddress, operator: otherAddress, sequence: 0n });
  });
});

// ── Robustness ─────────────────────────────────────────────────────────────

describe('dispatchEvent — sequence (topics[2])', () => {
  it('parses topics[2] as the event sequence and returns it', () => {
    const event = makeEvent('clawback', i128(1n), 42n);
    let received: ClawbackEvent | undefined;
    const handlers: StreamEventHandlers = { onClawback: (e) => { received = e; } };

    const returned = dispatchEvent(event, handlers);

    expect(received?.sequence).toBe(42n);
    expect(returned).toBe(42n);
  });

  it('returns undefined when there are no topics at all', () => {
    const event = { topic: [], value: i128(1n) } as unknown as Parameters<typeof dispatchEvent>[0];
    expect(dispatchEvent(event, {})).toBeUndefined();
  });
});

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
