import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  BatchStreamCreationPayload,
  BatchWithdrawPayload,
  BatchWithdrawItem,
  StreamConfig,
} from '../types/index.js';

// Compile-time helpers: assigning an invalid object to a typed parameter makes
// the compiler reject the call, which `@ts-expect-error` asserts.
function acceptCreation(_payload: BatchStreamCreationPayload): void {}
function acceptWithdraw(_payload: BatchWithdrawPayload): void {}

describe('batch payload types', () => {
  it('requires recipient, token and depositAmount for a batch creation payload', () => {
    expectTypeOf<BatchStreamCreationPayload['recipient']>().toEqualTypeOf<string>();
    expectTypeOf<BatchStreamCreationPayload['token']>().toEqualTypeOf<string>();
    expectTypeOf<BatchStreamCreationPayload['depositAmount']>().toEqualTypeOf<string>();

    // @ts-expect-error recipient is required
    acceptCreation({ token: 'native', depositAmount: '100' });

    // @ts-expect-error depositAmount must be a string
    acceptCreation({ recipient: 'GABC', token: 'native', depositAmount: 100 });

    // A complete payload is accepted.
    acceptCreation({ recipient: 'GABC', token: 'native', depositAmount: '100' });
    expect(true).toBe(true);
  });

  it('requires a streamId for a batch withdraw payload', () => {
    expectTypeOf<BatchWithdrawPayload['streamId']>().toEqualTypeOf<bigint | string>();
    expectTypeOf<BatchWithdrawPayload['amount']>().toEqualTypeOf<bigint | undefined>();

    // @ts-expect-error streamId is required
    acceptWithdraw({ amount: 1n });

    acceptWithdraw({ streamId: 1n, amount: 2n });
    expect(true).toBe(true);
  });

  it('keeps the legacy item alias assignable to the payload type', () => {
    const item: BatchWithdrawItem = { streamId: 1n, amount: 2n };
    const payload: BatchWithdrawPayload = item;
    expect(payload.streamId).toBe(1n);
  });

  it('keeps StreamConfig assignable to the batch creation payload', () => {
    const config: StreamConfig = {
      recipient: 'GABC',
      token: 'native',
      depositAmount: '100',
    };
    const payload: BatchStreamCreationPayload = config;
    expect(payload.recipient).toBe('GABC');
  });
});
