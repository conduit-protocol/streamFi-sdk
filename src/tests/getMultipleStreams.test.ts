import { describe, it, expect, vi, beforeEach } from 'vitest';
import { xdr, Address, nativeToScVal, StrKey } from '@stellar/stellar-sdk';
import { ConduitClient } from '../client.js';
import { createRpcServer } from '../soroban.js';

vi.mock('../soroban.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../soroban.js')>();
  return { ...actual, createRpcServer: vi.fn() };
});

const FACTORY = 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM';
const STREAM_A = 'CAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADLYV';
const STREAM_B = 'CABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBWO';

/**
 * Build the `StreamInfo` map a DripStream stores under `DataKey::Config`.
 * Field names and order come from `parseStreamInfo` in src/streams.ts.
 */
function streamInfoMap(address: string, id: bigint) {
  const map = new Map<string, xdr.ScVal>();
  map.set('sender', Address.fromString(address).toScVal());
  map.set('recipient', Address.fromString(address).toScVal());
  map.set('token', Address.fromString(address).toScVal());
  map.set('rate_per_second', nativeToScVal(100n, { type: 'i128' }));
  map.set('start_time', nativeToScVal(1_700_000_000n, { type: 'u64' }));
  map.set('end_time', nativeToScVal(1_700_100_000n, { type: 'u64' }));
  map.set('withdrawn', nativeToScVal(0n, { type: 'i128' }));
  map.set('deposited', nativeToScVal(1000n, { type: 'i128' }));
  map.set('cancelled', xdr.ScVal.scvBool(false));
  map.set('stream_id', nativeToScVal(id, { type: 'u64' }));
  return xdr.ScVal.scvMap(
    [...map.entries()].map(
      ([k, v]) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(k),
          val: v,
        }),
    ),
  );
}

/** A contract-instance ledger entry carrying `Config`, as the RPC returns it. */
function instanceEntry(address: string, id: bigint) {
  const contract = Address.fromString(address).toScAddress();
  return {
    key: xdr.LedgerKey.contractData({
      contract,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    } as never),
    val: xdr.LedgerEntryData.contractData({
      contract,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(
            xdr.Hash.fromXDR(Buffer.alloc(32)),
          ),
          storage: [
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol('Config'),
              val: streamInfoMap(address, id),
            }),
          ],
        }),
      ),
    } as never),
  };
}

describe('FactoryModule.getMultipleStreams (#904)', () => {
  let client: ConduitClient;
  let getLedgerEntries: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ConduitClient({ network: 'testnet', factoryAddress: FACTORY });
    getLedgerEntries = vi.fn();
    // Mock the module-level RPC factory so the test never touches the network.
    vi.mocked(createRpcServer).mockReturnValue({ getLedgerEntries } as never);
  });

  it('reads N addresses with one RPC call, not N', async () => {
    getLedgerEntries.mockResolvedValue({
      entries: [instanceEntry(STREAM_A, 1n), instanceEntry(STREAM_B, 2n)],
      latestLedger: 1,
    });

    const out = await client.factory.getMultipleStreams([STREAM_A, STREAM_B]);

    // One call carrying both keys — this is the whole point of the issue.
    expect(getLedgerEntries).toHaveBeenCalledTimes(1);
    expect(getLedgerEntries.mock.calls[0]).toHaveLength(2);
    expect(out).toHaveLength(2);
  });

  it('never simulates a contract call', async () => {
    getLedgerEntries.mockResolvedValue({ entries: [], latestLedger: 1 });
    const simulate = vi.spyOn(client.streams, 'withdrawable');

    await client.factory.getMultipleStreams([STREAM_A]);

    expect(simulate).not.toHaveBeenCalled();
  });

  it('collapses duplicate addresses into one key', async () => {
    getLedgerEntries.mockResolvedValue({
      entries: [instanceEntry(STREAM_A, 1n)],
      latestLedger: 1,
    });

    const out = await client.factory.getMultipleStreams([
      STREAM_A,
      STREAM_A,
      ` ${STREAM_A} `,
    ]);

    expect(getLedgerEntries.mock.calls[0]).toHaveLength(1);
    expect(out).toHaveLength(1);
  });

  it('makes no call for an empty list', async () => {
    const out = await client.factory.getMultipleStreams([]);
    expect(out).toEqual([]);
    expect(getLedgerEntries).not.toHaveBeenCalled();
  });

  it('omits addresses with no ledger entry instead of throwing', async () => {
    // RPC omits keys it has no entry for.
    getLedgerEntries.mockResolvedValue({
      entries: [instanceEntry(STREAM_A, 1n)],
      latestLedger: 1,
    });

    const out = await client.factory.getMultipleStreams([STREAM_A, STREAM_B]);

    expect(out).toHaveLength(1);
    expect(out[0]!.address).toBe(STREAM_A);
  });

  it('honours an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      client.factory.getMultipleStreams([STREAM_A], ac.signal),
    ).rejects.toThrow(/abort/i);
    expect(getLedgerEntries).not.toHaveBeenCalled();
  });
});
