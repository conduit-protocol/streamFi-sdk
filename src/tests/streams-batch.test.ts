import { describe, it, expect, vi } from 'vitest';
import { ConduitClient } from '../client.js';

const FACTORY = 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM';

describe('ConduitClient.getStreamsBatch', () => {
  it('dedupes ids and reads in chunks via the batched path', async () => {
    const client = new ConduitClient({ network: 'testnet', factoryAddress: FACTORY });
    // #904: `getStreamsBatch` now drives the ledger-entry batch reader, so a
    // chunk costs one RPC round trip instead of one simulation per stream.
    const spy = vi
      .spyOn(client.streams, 'getStreamInfosBatched')
      .mockImplementation(async (ids) => ({
        results: ids.map((id) => ({ id }) as never),
        failures: [],
      }));
    const out = await client.getStreamsBatch([1n, '2', 1n, 3n, 4n, 5n], { chunkSize: 2 });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([[1n, 2n], [3n, 4n], [5n]]);
    expect(out.results).toHaveLength(5);
  });

  it('does not fall back to per-stream simulation', async () => {
    const client = new ConduitClient({ network: 'testnet', factoryAddress: FACTORY });
    const batched = vi
      .spyOn(client.streams, 'getStreamInfosBatched')
      .mockImplementation(async (ids) => ({
        results: ids.map((id) => ({ id }) as never),
        failures: [],
      }));
    const perStream = vi.spyOn(client.streams, 'getStreamInfos');

    await client.getStreamsBatch([1n, 2n, 3n]);

    expect(batched).toHaveBeenCalled();
    expect(perStream).not.toHaveBeenCalled();
  });

  it('keeps per-id failures from the batch', async () => {
    const client = new ConduitClient({ network: 'testnet', factoryAddress: FACTORY });
    vi.spyOn(client.streams, 'getStreamInfosBatched').mockImplementation(
      (async (ids: bigint[]) => ({
        results: ids.slice(0, 1).map((id) => ({ id }) as never),
        failures: ids.slice(1).map((id) => ({ id, error: 'not found' })),
      })) as never,
    );

    const out = await client.getStreamsBatch([1n, 2n]);

    expect(out.results).toHaveLength(1);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]!.id).toBe(2n);
  });
});
