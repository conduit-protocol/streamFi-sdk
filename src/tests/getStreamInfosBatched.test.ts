import { describe, it, expect, vi, beforeEach } from 'vitest';
import { xdr, Address, Keypair, nativeToScVal } from '@stellar/stellar-sdk';

const getLedgerEntries = vi.fn();
const simulateTransaction = vi.fn();

vi.mock('../soroban.js', async (orig) => {
  const actual = await orig<typeof import('../soroban.js')>();
  return {
    ...actual,
    createRpcServer: () => ({ getLedgerEntries, simulateTransaction }),
  };
});

import { StreamsModule } from '../streams.js';

const FACTORY = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

/** Deterministic fake stream contract addresses. */
function streamAddr(i: number): string {
  return Address.contract(Buffer.alloc(32, i)).toString();
}

/** Build the `DataKey::Config` StreamInfo map the contract stores. */
function configMap(i: number): xdr.ScVal {
  const sender = Address.fromString(Keypair.random().publicKey());
  const fields: Array<[string, xdr.ScVal]> = [
    ['sender', sender.toScVal()],
    ['recipient', sender.toScVal()],
    ['token', sender.toScVal()],
    ['rate_per_second', nativeToScVal(BigInt(100 * i), { type: 'i128' })],
    ['start_time', nativeToScVal(1_700_000_000n, { type: 'u64' })],
    ['end_time', nativeToScVal(1_700_003_600n, { type: 'u64' })],
    ['withdrawn', nativeToScVal(BigInt(i), { type: 'i128' })],
    ['paused_at', nativeToScVal(0n, { type: 'u64' })],
    ['flags', nativeToScVal(0, { type: 'u32' })],
  ];
  return xdr.ScVal.scvMap(
    fields.map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })),
  );
}

function instanceEntry(addr: string, i: number): xdr.LedgerEntryData {
  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 7)),
    storage: [
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('Config'), val: configMap(i) }),
    ],
  });
  return xdr.LedgerEntryData.contractData({
    contract: Address.fromString(addr).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(instance),
  } as never);
}

function addressEntry(addr: string, id: bigint) {
  // `LedgerEntryResult.val` is a LedgerEntryData whose contractData arm holds
  // the stored ScVal — the same shape the RPC returns.
  return {
    key: xdr.LedgerKey.contractData({
      contract: Address.fromString(FACTORY).toScAddress(),
      key: xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('StreamAddr'),
        nativeToScVal(id, { type: 'u64' }),
      ]),
      durability: xdr.ContractDataDurability.persistent(),
    } as never),
    val: xdr.LedgerEntryData.contractData({
      contract: Address.fromString(FACTORY).toScAddress(),
      key: xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('StreamAddr'),
        nativeToScVal(id, { type: 'u64' }),
      ]),
      durability: xdr.ContractDataDurability.persistent(),
      val: Address.fromString(addr).toScVal(),
    } as never),
  };
}

function makeModule(): StreamsModule {
  return new StreamsModule({
    network: 'testnet',
    rpcUrl: 'https://rpc.example.com',
    networkPassphrase: 'Test SDF Network ; September 2015',
    factoryAddress: FACTORY,
  } as never);
}

describe('#904 getStreamInfosBatched', () => {
  beforeEach(() => {
    getLedgerEntries.mockReset();
    simulateTransaction.mockReset();
  });

  it('reads N streams with 2 RPC calls, not N simulations', async () => {
    const ids = [1n, 2n, 3n, 4n, 5n];
    const addrs = ids.map((_, i) => streamAddr(i + 1));

    getLedgerEntries
      .mockResolvedValueOnce({
        entries: ids.map((id, i) => addressEntry(addrs[i]!, id)),
        latestLedger: 1,
      })
      .mockResolvedValueOnce({
        entries: addrs.map((a, i) => ({ key: xdr.LedgerKey.contractData({
          contract: Address.fromString(a).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        } as never), val: instanceEntry(a, i + 1) })),
        latestLedger: 1,
      });

    const mod = makeModule();
    const { results, failures } = await mod.getStreamInfosBatched(ids);

    expect(failures).toEqual([]);
    expect(results).toHaveLength(5);
    // The whole point of the issue: no per-stream simulation.
    expect(simulateTransaction).not.toHaveBeenCalled();
    expect(getLedgerEntries).toHaveBeenCalledTimes(2);

    // First call carries one key per stream (address index).
    expect(getLedgerEntries.mock.calls[0]).toHaveLength(5);
    // Second call carries one key per stream (instance state).
    expect(getLedgerEntries.mock.calls[1]).toHaveLength(5);
  });

  it('parses the same StreamInfo shape as the per-stream path', async () => {
    const addr = streamAddr(9);
    getLedgerEntries
      .mockResolvedValueOnce({ entries: [addressEntry(addr, 9n)], latestLedger: 1 })
      .mockResolvedValueOnce({ entries: [{ key: xdr.LedgerKey.contractData({
        contract: Address.fromString(addr).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      } as never), val: instanceEntry(addr, 9) }], latestLedger: 1 });

    const { results } = await makeModule().getStreamInfosBatched([9n]);
    const info = results[0]!;
    expect(info.id).toBe(9n);
    expect(info.address).toBe(addr);
    expect(info.ratePerSecond).toBe(900n); // 100 * 9
    expect(info.withdrawn).toBe(9n);
    expect(info.startTime).toBe(1_700_000_000);
    expect(info.endTime).toBe(1_700_003_600);
    expect(info.paused).toBe(false);
    expect(info.cancelled).toBe(false);
  });

  it('reports missing streams in failures instead of throwing', async () => {
    const addr = streamAddr(1);
    // Only id 1 resolves; id 2 has no address entry.
    getLedgerEntries
      .mockResolvedValueOnce({ entries: [addressEntry(addr, 1n)], latestLedger: 1 })
      .mockResolvedValueOnce({ entries: [{ key: xdr.LedgerKey.contractData({
        contract: Address.fromString(addr).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      } as never), val: instanceEntry(addr, 1) }], latestLedger: 1 });

    const { results, failures } = await makeModule().getStreamInfosBatched([1n, 2n]);
    expect(results.map((r) => r.id)).toEqual([1n]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.id).toBe(2n);
    expect(failures[0]!.error).toMatch(/not found/i);
  });

  it('collapses duplicate ids into one key each', async () => {
    const addr = streamAddr(4);
    getLedgerEntries
      .mockResolvedValueOnce({ entries: [addressEntry(addr, 4n)], latestLedger: 1 })
      .mockResolvedValueOnce({ entries: [{ key: xdr.LedgerKey.contractData({
        contract: Address.fromString(addr).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      } as never), val: instanceEntry(addr, 4) }], latestLedger: 1 });

    const { results } = await makeModule().getStreamInfosBatched([4n, 4n, '4']);
    expect(results).toHaveLength(1);
    expect(getLedgerEntries.mock.calls[0]).toHaveLength(1);
  });

  it('returns empty for an empty id list without touching the network', async () => {
    const { results, failures } = await makeModule().getStreamInfosBatched([]);
    expect(results).toEqual([]);
    expect(failures).toEqual([]);
    expect(getLedgerEntries).not.toHaveBeenCalled();
  });

  it('honours an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      makeModule().getStreamInfosBatched([1n], {}, ac.signal),
    ).rejects.toThrow(/Aborted/);
    expect(getLedgerEntries).not.toHaveBeenCalled();
  });
});
