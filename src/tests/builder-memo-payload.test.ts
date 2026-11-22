import { describe, it, expect } from 'vitest';
import { Keypair, Memo, StrKey, xdr } from '@stellar/stellar-sdk';
import { StreamBuilder } from '../builder.js';

const SENDER = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 3));

function builder(): StreamBuilder {
  return new StreamBuilder()
    .token(TOKEN)
    .sender(SENDER)
    .recipient(RECIPIENT)
    .amount(1000)
    .ratePerSecond(1)
    .startTime(Math.floor(Date.now() / 1000) + 100);
}

describe('StreamBuilder.build() memo payload (#1170)', () => {
  it('omits the memo field when no memo was set', () => {
    const payload = builder().build();
    expect('memo' in payload).toBe(false);
  });

  it('serializes a text memo as base64 Memo XDR', () => {
    const payload = builder().withMemo('INV-1042').build();
    expect(typeof payload.memo).toBe('string');

    const decoded = xdr.Memo.fromXDR(payload.memo as string, 'base64');
    expect(decoded.switch().name).toBe('memoText');
    expect(decoded.text().toString()).toBe('INV-1042');
  });

  it('serializes a hash memo passed as a stellar-sdk Memo', () => {
    const payload = builder().withMemo(Memo.hash(Buffer.alloc(32, 7).toString('hex'))).build();
    const decoded = xdr.Memo.fromXDR(payload.memo as string, 'base64');
    expect(decoded.switch().name).toBe('memoHash');
  });

  it('round-trips: decoding the payload memo and re-encoding yields the same base64', () => {
    const payload = builder().withMemo('employee-7731').build();
    const encoded = payload.memo as string;
    const reEncoded = Memo.fromXDRObject(xdr.Memo.fromXDR(encoded, 'base64'))
      .toXDRObject()
      .toXDR('base64');
    expect(reEncoded).toBe(encoded);
  });

  it('keeps the memo payload JSON-safe', () => {
    const payload = builder().withMemo('INV-1').build();
    const parsed = JSON.parse(JSON.stringify(payload)) as { memo?: string };
    expect(parsed.memo).toBe(payload.memo);
  });
});

describe('StreamBuilder.build() memo payload — edge cases (#1170)', () => {
  it('rejects an over-long text memo and leaves no memo in the payload', () => {
    const b = builder();
    expect(() => b.withMemo('x'.repeat(29))).toThrow();
    expect('memo' in b.build()).toBe(false);
  });

  it('serializes an id memo with its numeric value intact', () => {
    const payload = builder().withMemo(Memo.id('9007199254740993')).build();
    const decoded = xdr.Memo.fromXDR(payload.memo as string, 'base64');
    expect(decoded.switch().name).toBe('memoId');
    expect(decoded.id().toString()).toBe('9007199254740993');
  });

  it('does not change the payload when the memo is replaced with a new one', () => {
    const b = builder().withMemo('first');
    const first = b.build().memo;
    b.withMemo('second');
    expect(b.build().memo).not.toBe(first);
  });
});
