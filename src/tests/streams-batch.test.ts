import { describe, it, expect, vi } from 'vitest';
import { ConduitClient } from '../client.js';

describe('ConduitClient.getStreamsBatch', () => {
  it('dedupes ids and reads in chunks', async () => {
    const client = new ConduitClient({ network: 'testnet', factoryAddress: 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM' });
    const spy = vi.spyOn(client.streams, 'getStreamInfos').mockImplementation(async (ids) => ({
      results: ids.map((id) => ({ id }) as never),
      failures: [],
    }));
    const out = await client.getStreamsBatch([1n, '2', 1n, 3n, 4n, 5n], { chunkSize: 2 });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([[1n, 2n], [3n, 4n], [5n]]);
    expect(out.results).toHaveLength(5);
  });
});
