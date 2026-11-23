import { describe, it, expect } from 'vitest';
import { Keypair, Address, xdr, nativeToScVal } from '@stellar/stellar-sdk';
import { parseStreamEvent } from '../events.js';
import type { StreamEvent } from '../events.js';

// ── Fixture helpers (mirrors events.test.ts) ──────────────────────────────────

const actorAddress = Keypair.random().publicKey();

function topic(name: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(name);
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
function makeEvent(topicName: string, value: xdr.ScVal, seq: bigint | number = 0) {
  return { topic: [topic(topicName), actorTopic(), sequenceTopic(seq)], value } as unknown as Parameters<typeof parseStreamEvent>[0];
}

describe('parseStreamEvent — discriminated union', () => {
  it('parses a created event with the typed payload', () => {
    const recipient = Keypair.random().publicKey();
    const raw = makeEvent('created', tuple(
      new Address(recipient).toScVal(),
      new Address(Keypair.random().publicKey()).toScVal(),
      i128(1_000_000n), i128(100n), u64(1_000), u64(2_000),
    ));
    const ev = parseStreamEvent(raw) as Extract<StreamEvent, { kind: 'created' }>;
    expect(ev.kind).toBe('created');
    expect(ev.event.sender).toBe(actorAddress);
    expect(ev.event.recipient).toBe(recipient);
    expect(ev.event.depositAmount).toBe(1_000_000n);
  });

  it('parses a withdrawn event', () => {
    const raw = makeEvent('withdrawn', tuple(i128(10_000n), i128(25_000n), i128(75_000n)), 7);
    const ev = parseStreamEvent(raw);
    expect(ev?.kind).toBe('withdrawn');
    expect(ev).toMatchObject({ kind: 'withdrawn', event: { amount: 10_000n, sequence: 7n } });
  });

  it('parses a cancelled event', () => {
    const raw = makeEvent('cancelled', tuple(i128(180_000n), i128(60_000n)));
    const ev = parseStreamEvent(raw);
    expect(ev?.kind).toBe('cancelled');
  });

  it('returns null for an unrecognised topic', () => {
    const raw = makeEvent('not_a_stream_event', tuple(i128(1n)));
    expect(parseStreamEvent(raw)).toBeNull();
  });

  it('returns null for an empty topic list', () => {
    const raw = { topic: [], value: i128(1n) } as unknown as Parameters<typeof parseStreamEvent>[0];
    expect(parseStreamEvent(raw)).toBeNull();
  });

  it('covers every discriminated member without throwing', () => {
    const cases: Array<[string, xdr.ScVal]> = [
      ['created', tuple(new Address(actorAddress).toScVal(), new Address(actorAddress).toScVal(), i128(1n), i128(1n), u64(1), u64(2))],
      ['withdrawn', tuple(i128(1n), i128(1n), i128(1n))],
      ['topped_up', tuple(i128(1n), i128(1n))],
      ['paused', tuple(u64(1), i128(1n))],
      ['resumed', u64(1)],
      ['cancelled', tuple(i128(1n), i128(1n))],
      ['clawback', i128(1n)],
      ['force_cxl', tuple(i128(1n), i128(1n))],
      ['xfer_rec', new Address(actorAddress).toScVal()],
      ['set_op', new Address(actorAddress).toScVal()],
      ['rm_op', new Address(actorAddress).toScVal()],
    ];
    for (const [name, value] of cases) {
      const ev = parseStreamEvent(makeEvent(name, value));
      expect(ev).not.toBeNull();
      expect(typeof (ev as StreamEvent).kind).toBe('string');
    }
  });
});
