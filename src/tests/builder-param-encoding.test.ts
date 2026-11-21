/**
 * Regression tests for #497: `paramToScVal` used to force every integer
 * `number` to `i64` and every `bigint` to `i128`, so u64 contract parameters
 * (`create_stream`'s `start_time`/`end_time`, stream IDs) encoded with the
 * wrong ScVal type and were rejected contract-side.
 *
 * These tests assert the end-to-end ScVal types that actually land in the
 * built transaction XDR:
 * - `execute()`'s `create_stream` path builds ABI-exact positional args
 *   (i128 amounts, u64 times, bool clawback).
 * - `executeAsync()`'s params map honors per-field `types` hints (u64 IDs).
 * - Pre-encoded `xdr.ScVal`s in `args` pass through untouched.
 */

import { describe, it, expect } from 'vitest';
import { Networks, Transaction, TransactionBuilder, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { ConduitBatcher } from '../builder.js';

const CONTRACT_ID = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SOURCE = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
const RECIPIENT = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA';

const CONTEXT = {
  contractId: CONTRACT_ID,
  sourceAccount: SOURCE,
  network: 'testnet' as const,
  sequence: '1',
};

/** Decode the invoke-contract args back out of a built transaction. */
function decodeArgs(envelope: string): xdr.ScVal[] {
  const tx = TransactionBuilder.fromXDR(envelope, Networks.TESTNET);
  if (!(tx instanceof Transaction)) throw new Error('Expected a plain transaction');
  const op = tx.operations[0] as { type: string; func: import('@stellar/stellar-sdk').xdr.HostFunction };
  expect(op.type).toBe('invokeHostFunction');
  return op.func.invokeContract().args();
}

describe('ConduitBatcher params-path ScVal encoding (#497)', () => {
  it('execute() builds ABI-exact create_stream args: i128 amounts, u64 times', () => {
    const result = new ConduitBatcher().execute(
      [
        {
          token: CONTRACT_ID,
          sender: SOURCE,
          recipient: RECIPIENT,
          amount: 1000n,
          ratePerSecond: 10,
        },
      ],
      { context: CONTEXT },
    );

    expect(result.success).toBe(true);
    const args = decodeArgs(result.xdr);
    expect(args).toHaveLength(8);
    expect(args.map(a => a.switch().name)).toEqual([
      'scvAddress', // sender
      'scvAddress', // recipient
      'scvAddress', // token
      'scvI128',    // deposit_amount
      'scvI128',    // rate_per_sec
      'scvU64',     // start_time
      'scvU64',     // end_time
      'scvBool',    // clawback_enabled
    ]);
    expect(scValToNative(args[3]!)).toBe(1000n);
    expect(scValToNative(args[4]!)).toBe(10n);
  });

  it('execute() honors startTime/endTime/clawbackEnabled from the stream object', () => {
    const start = Math.floor(Date.now() / 1000);
    const end = start + 3600;

    const result = new ConduitBatcher().execute(
      [
        {
          token: CONTRACT_ID,
          sender: SOURCE,
          recipient: RECIPIENT,
          amount: 1000n,
          ratePerSecond: 10,
          startTime: start,
          endTime: end,
          clawbackEnabled: true,
        },
      ],
      { context: CONTEXT },
    );

    expect(result.success).toBe(true);
    const args = decodeArgs(result.xdr);
    expect(args[5]!.switch().name).toBe('scvU64');
    expect(args[6]!.switch().name).toBe('scvU64');
    expect(Number(scValToNative(args[5]!))).toBe(start);
    expect(Number(scValToNative(args[6]!))).toBe(end);
    expect(scValToNative(args[7]!)).toBe(true);
  });

  it('execute() keeps encoding a bigint amount as i128 after serialisation', () => {
    const result = new ConduitBatcher().execute(
      [
        {
          token: CONTRACT_ID,
          sender: SOURCE,
          recipient: RECIPIENT,
          amount: 9007199254740993n,
          ratePerSecond: 10n,
        },
      ],
      { context: CONTEXT },
    );

    expect(result.success).toBe(true);
    const args = decodeArgs(result.xdr);
    expect(args[3]!.switch().name).toBe('scvI128');
    expect(scValToNative(args[3]!)).toBe(9007199254740993n);
  });

  it('executeAsync() params map encodes a u64 stream ID with a per-field type hint', async () => {
    const result = await new ConduitBatcher().executeAsync(
      [
        {
          method: 'withdraw',
          params: { streamId: 1n },
          types: { streamId: 'u64' },
        },
      ],
      { context: CONTEXT },
    );

    expect(result.success).toBe(true);
    const args = decodeArgs(result.xdr);
    expect(args).toHaveLength(1);
    expect(args[0]!.switch().name).toBe('scvMap');
    const entry = args[0]!.map()![0]!;
    expect(entry.key().sym().toString()).toBe('streamId');
    expect(entry.val().switch().name).toBe('scvU64');
    expect(scValToNative(entry.val())).toBe(1n);
  });

  it('executeAsync() passes pre-encoded u64 ScVals in args through unchanged', async () => {
    const streamIdScVal = nativeToScVal(42n, { type: 'u64' });
    const result = await new ConduitBatcher().executeAsync(
      [{ method: 'withdraw', params: {}, args: [streamIdScVal] }],
      { context: CONTEXT },
    );

    expect(result.success).toBe(true);
    const args = decodeArgs(result.xdr);
    expect(args).toHaveLength(1);
    // The ScVal survives the encode→XDR→decode round-trip with its u64 type
    // intact (instance identity is not preserved through serialisation).
    expect(args[0]!.switch().name).toBe('scvU64');
    expect(scValToNative(args[0]!)).toBe(42n);
  });
});
