import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Account, Contract, Keypair, Memo, SorobanDataBuilder, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

const simulateTransaction = vi.fn();
const getAccount = vi.fn();

vi.mock('../soroban.js', async (orig) => {
  const actual = await orig<typeof import('../soroban.js')>();
  return {
    ...actual,
    createRpcServer: () => ({ simulateTransaction, getAccount }),
    // The real helper calls its module-internal createRpcServer, which a mock
    // export cannot intercept, so rebuild the same transaction locally.
    buildContractCallTx: async (
      _rpc: string, passphrase: string, caller: string, contractId: string,
      method: string, args: xdr.ScVal[], fee: string, memo?: Memo,
    ) => {
      const b = new TransactionBuilder(await getAccount(caller), { fee, networkPassphrase: passphrase })
        .addOperation(new Contract(contractId).call(method, ...args));
      if (memo) b.addMemo(memo);
      return b.setTimeout(30).build();
    },
  };
});

import { StreamBuilder } from '../builder.js';

const SENDER = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();
const FACTORY = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const TOKEN = FACTORY;

function builder() {
  return new StreamBuilder()
    .token(TOKEN).sender(SENDER).recipient(RECIPIENT)
    .amount(1000).ratePerSecond(1).startTime(Math.floor(Date.now() / 1000) + 100);
}

beforeEach(() => {
  simulateTransaction.mockReset();
  getAccount.mockReset().mockResolvedValue(new Account(SENDER, '1'));
});

describe('StreamBuilder.withMemo (#849)', () => {
  it('accepts a string and a Memo, and is chainable', () => {
    const b = builder();
    expect(b.withMemo('deposit-42')).toBe(b);
    expect(b.getMemo()?.value).toBe('deposit-42');
    b.withMemo(Memo.id('77'));
    expect(b.getMemo()?.type).toBe('id');
  });

  it('rejects memos over 28 bytes', () => {
    expect(() => builder().withMemo('x'.repeat(29))).toThrow(/memo/);
  });

  it('rejects non-memo values', () => {
    expect(() => builder().withMemo(5 as unknown as string)).toThrow(/memo/);
  });

  it('attaches the memo to the built transaction', async () => {
    const tx = await builder().withMemo('route-9').buildTransaction({ factoryId: FACTORY });
    expect(tx.memo.value?.toString()).toBe('route-9');
  });

  it('leaves the transaction memo-less by default and survives clone/reset', async () => {
    const tx = await builder().buildTransaction({ factoryId: FACTORY });
    expect(tx.memo.type).toBe('none');
    const b = builder().withMemo('a');
    expect(b.clone().getMemo()?.value).toBe('a');
    expect(b.reset().getMemo()).toBeUndefined();
  });
});

describe('StreamBuilder.simulate (#820)', () => {
  it('returns the resource breakdown without signing or sending', async () => {
    const data = new SorobanDataBuilder()
      .setResources(1234, 56, 78);
    simulateTransaction.mockResolvedValue({
      id: '1', latestLedger: 1, events: [], _parsed: true,
      minResourceFee: '4321',
      transactionData: data,
      result: { auth: [], retval: xdr.ScVal.scvVoid() },
    });
    const sim = await builder().withMemo('m').simulate({ factoryId: FACTORY });
    expect(sim.minResourceFee).toBe(4321n);
    expect(sim.cpuInstructions).toBe(1234);
    expect(sim.readBytes).toBe(56);
    expect(sim.writeBytes).toBe(78);
    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    expect(simulateTransaction.mock.calls[0]![0].memo.value.toString()).toBe('m');
  });

  it('throws on a simulation error', async () => {
    simulateTransaction.mockResolvedValue({ id: '1', latestLedger: 1, error: 'HostError: boom', events: [], _parsed: true });
    await expect(builder().simulate({ factoryId: FACTORY })).rejects.toThrow(/Simulation failed: HostError: boom/);
  });

  it('validates the builder before any network call', async () => {
    await expect(new StreamBuilder().simulate({ factoryId: FACTORY })).rejects.toThrow();
    expect(simulateTransaction).not.toHaveBeenCalled();
  });
});
