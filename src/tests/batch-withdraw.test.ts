import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { StreamsModule } from '../streams.js';
import type { ConduitConfig } from '../types/index.js';

function makeConfig(): ConduitConfig {
  return { network: 'testnet', factoryAddress: 'CFACTORYPLACEHOLDER', keypair: Keypair.random() };
}

describe('StreamsModule.batchWithdraw()', () => {
  it('returns success results for all withdrawals when every call succeeds', async () => {
    const sdk = new StreamsModule(makeConfig());
    vi.spyOn(sdk, 'withdraw').mockImplementation(async (streamId) => `hash-${streamId}`);

    const results = await sdk.batchWithdraw([
      { streamId: 1n, amount: 100n },
      { streamId: 2n, amount: 200n },
    ]);

    expect(results).toEqual([
      { streamId: 1n, success: true, txHash: 'hash-1' },
      { streamId: 2n, success: true, txHash: 'hash-2' },
    ]);
  });

  it('reports per-item failures without rejecting the whole batch', async () => {
    const sdk = new StreamsModule(makeConfig());
    vi.spyOn(sdk, 'withdraw').mockImplementation(async (streamId) => {
      if (streamId === 2n) throw new Error('StreamNotFound');
      return 'hash-ok';
    });

    const results = await sdk.batchWithdraw([
      { streamId: 1n },
      { streamId: 2n },
      { streamId: 3n },
    ]);

    expect(results[0]).toEqual({ streamId: 1n, success: true, txHash: 'hash-ok' });
    expect(results[1]).toEqual({ streamId: 2n, success: false, error: 'StreamNotFound' });
    expect(results[2]).toEqual({ streamId: 3n, success: true, txHash: 'hash-ok' });
  });

  it('accepts string streamIds and normalises them to bigint in results', async () => {
    const sdk = new StreamsModule(makeConfig());
    vi.spyOn(sdk, 'withdraw').mockResolvedValue('hash-x');

    const results = await sdk.batchWithdraw([{ streamId: '42' }]);
    expect(results[0]!.streamId).toBe(42n);
  });

  it('passes the optional amount through to withdraw()', async () => {
    const sdk = new StreamsModule(makeConfig());
    const spy = vi.spyOn(sdk, 'withdraw').mockResolvedValue('hash');

    await sdk.batchWithdraw([{ streamId: 1n, amount: 555n }, { streamId: 2n }]);

    expect(spy).toHaveBeenNthCalledWith(1, 1n, 555n);
    expect(spy).toHaveBeenNthCalledWith(2, 2n, undefined);
  });

  it('throws before attempting withdrawals if no signer/keypair/wallet is configured', async () => {
    const sdk = new StreamsModule({ network: 'testnet', factoryAddress: 'CFACTORYPLACEHOLDER' });
    await expect(sdk.batchWithdraw([{ streamId: 1n }])).rejects.toThrow(
      /keypair, wallet adapter, or signer/,
    );
  });
});