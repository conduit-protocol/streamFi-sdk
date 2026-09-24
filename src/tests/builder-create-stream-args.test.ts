/**
 * Regression tests for #435: StreamBuilder + ConduitBatcher payload shape
 * must match the real create_stream ABI
 * (sender, recipient, token, deposit_amount: i128, rate_per_sec: i128,
 * start_time: u64, end_time: u64, clawback_enabled: bool) — not a camelCase
 * map with an i64 amount, as `build()` alone produces.
 */

import { describe, it, expect } from 'vitest';
import { Networks, Transaction, TransactionBuilder, scValToNative } from '@stellar/stellar-sdk';
import { StreamBuilder, ConduitBatcher } from '../builder.js';

const TOKEN = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SENDER = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
const RECIPIENT = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA';

const CONTEXT = {
  contractId: TOKEN,
  sourceAccount: SENDER,
  network: 'testnet' as const,
  sequence: '1',
};

function baseBuilder() {
  return new StreamBuilder()
    .token(TOKEN)
    .sender(SENDER)
    .recipient(RECIPIENT)
    .amount(1000)
    .ratePerSecond(10);
}

/** Decode the real invoke-contract args back out of a built transaction. */
function decodeArgs(envelope: string) {
  const tx = TransactionBuilder.fromXDR(envelope, Networks.TESTNET);
  if (!(tx instanceof Transaction)) throw new Error('Expected a plain transaction');
  const op = tx.operations[0] as { type: string; func: import('@stellar/stellar-sdk').xdr.HostFunction };
  expect(op.type).toBe('invokeHostFunction');
  const invoke = op.func.invokeContract();
  return { functionName: invoke.functionName().toString(), args: invoke.args() };
}

describe('StreamBuilder.toContractArgs()', () => {
  it('throws when ratePerSecond was never set — the contract has no way to derive it', () => {
    const builder = new StreamBuilder().token(TOKEN).sender(SENDER).recipient(RECIPIENT).amount(1000);
    expect(() => builder.toContractArgs()).toThrow('ratePerSecond is required');
  });

  it('throws the same missing-required-field error as build() when incomplete', () => {
    const builder = new StreamBuilder().token(TOKEN).sender(SENDER).ratePerSecond(10);
    expect(() => builder.toContractArgs()).toThrow('2 validation issue(s)');
  });

  it('produces exactly 8 args in create_stream ABI order and type', () => {
    const args = baseBuilder().toContractArgs();
    expect(args).toHaveLength(8);
    const switches = (args as import('@stellar/stellar-sdk').xdr.ScVal[]).map(a => a.switch().name);
    expect(switches).toEqual([
      'scvAddress', // sender
      'scvAddress', // recipient
      'scvAddress', // token
      'scvI128',    // deposit_amount
      'scvI128',    // rate_per_sec
      'scvU64',     // start_time
      'scvU64',     // end_time
      'scvBool',    // clawback_enabled
    ]);
  });

  it('defaults start_time to now, end_time to 0, and clawback to false when unset', () => {
    const before = Math.floor(Date.now() / 1000);
    const args = baseBuilder().toContractArgs() as import('@stellar/stellar-sdk').xdr.ScVal[];
    const after = Math.floor(Date.now() / 1000);

    const start = Number(scValToNative(args[5]!));
    const end = Number(scValToNative(args[6]!));
    const clawback = scValToNative(args[7]!);

    expect(start).toBeGreaterThanOrEqual(before);
    expect(start).toBeLessThanOrEqual(after);
    expect(end).toBe(0);
    expect(clawback).toBe(false);
  });

  it('honors explicit startTime, endTime, and clawbackEnabled', () => {
    const now = Math.floor(Date.now() / 1000);
    const args = baseBuilder()
      .startTime(now + 60)
      .endTime(now + 3600)
      .clawbackEnabled(true)
      .toContractArgs() as import('@stellar/stellar-sdk').xdr.ScVal[];

    expect(Number(scValToNative(args[5]!))).toBe(now + 60);
    expect(Number(scValToNative(args[6]!))).toBe(now + 3600);
    expect(scValToNative(args[7]!)).toBe(true);
  });

  it('encodes sender/recipient/token addresses in the correct positions', () => {
    const args = baseBuilder().toContractArgs() as import('@stellar/stellar-sdk').xdr.ScVal[];
    expect(scValToNative(args[0]!)).toBe(SENDER);
    expect(scValToNative(args[1]!)).toBe(RECIPIENT);
    expect(scValToNative(args[2]!)).toBe(TOKEN);
  });

  it('rejects a startTime in the past', () => {
    expect(() => baseBuilder().startTime(1)).toThrow('startTime cannot be in the past');
  });

  it('rejects a non-integer endTime', () => {
    expect(() => baseBuilder().endTime(1.5)).toThrow('endTime must be a non-negative integer');
  });

  it('rejects a non-boolean clawbackEnabled', () => {
    const builder = baseBuilder();
    expect(() => builder.clawbackEnabled('yes' as unknown as boolean)).toThrow('clawbackEnabled must be a boolean');
  });
});

describe('StreamBuilder.toBatchOperation() + ConduitBatcher', () => {
  it('builds a genuine create_stream invocation with the ABI-exact positional args', async () => {
    const operation = baseBuilder().toBatchOperation();
    expect(operation.method).toBe('create_stream');

    const batcher = new ConduitBatcher();
    const result = await batcher.executeAsync([operation], { context: CONTEXT });

    expect(result.success).toBe(true);
    const { functionName, args } = decodeArgs(result.xdr);
    expect(functionName).toBe('create_stream');
    expect(args).toHaveLength(8);
    expect(scValToNative(args[0]!)).toBe(SENDER);
    expect(scValToNative(args[1]!)).toBe(RECIPIENT);
    expect(scValToNative(args[2]!)).toBe(TOKEN);
    expect(scValToNative(args[3]!)).toBe(1000n);
    expect(scValToNative(args[4]!)).toBe(10n);
  });

  it('supports a custom method name for non-default contract calls', () => {
    const operation = baseBuilder().toBatchOperation('custom_create');
    expect(operation.method).toBe('custom_create');
  });
});
