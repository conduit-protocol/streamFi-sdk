import { describe, it, expect, vi } from 'vitest';
import { StreamsModule } from '../streams.js';

describe('StreamsModule.getStreamsBatch', () => {
  it('deduplicates IDs and reads them in bounded chunks', async () => {
    const streams = new StreamsModule({
      network: 'testnet',
      factoryAddress: 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM',
    });
    const spy = vi.spyOn(streams, 'getStreamInfos').mockImplementation(async (ids) => ({
      results: ids.map((id) => ({ id } as never)),
      failures: [],
    }));

    const out = await streams.getStreamsBatch([1n, '2', 1n, 3n, 4n, 5n], { chunkSize: 2 });

    expect(spy.mock.calls.map((c) => c[0])).toEqual([[1n, 2n], [3n, 4n], [5n]]);
    expect(out.results).toHaveLength(5);
    expect(out.failures).toEqual([]);
  });

  it('forwards the per-chunk concurrency limit', async () => {
    const streams = new StreamsModule({
      network: 'testnet',
      factoryAddress: 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM',
    });
    const spy = vi.spyOn(streams, 'getStreamInfos').mockImplementation(async (ids) => ({
      results: ids.map((id) => ({ id } as never)),
      failures: [],
    }));

    await streams.getStreamsBatch([1n, 2n], { maxConcurrency: 3 });

    expect(spy).toHaveBeenCalledWith([1n, 2n], { maxConcurrency: 3 });
  });
});
