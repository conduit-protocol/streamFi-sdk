import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConduitConfig } from '../types/index.js';

const mockStreamsBySender = vi.fn();
const mockStreamCount = vi.fn();
const mockStreamAddress = vi.fn().mockResolvedValue('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526');
const mockSimulate = vi.fn();

vi.mock('../factory.js', () => ({
  FactoryModule: class {
    streamAddress      = mockStreamAddress;
    streamsBySender    = mockStreamsBySender;
    streamsByRecipient = vi.fn();
    streamCount        = mockStreamCount;
  },
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: class { simulateTransaction = mockSimulate; },
    },
  };
});

vi.mock('../soroban.js', async () => {
  const actual = await vi.importActual<typeof import('../soroban.js')>('../soroban.js');
  return { ...actual, buildContractCallTx: vi.fn().mockResolvedValue({ _stub: 'tx' }) };
});

function makeConfig(): ConduitConfig {
  return { network: 'testnet', factoryAddress: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526' };
}

describe('StreamsModule.list — cursor pagination', () => {
  beforeEach(async () => {
    mockStreamsBySender.mockReset().mockResolvedValue([]);
    mockStreamCount.mockReset().mockResolvedValue(0n);
    const { xdr } = await import('@stellar/stellar-sdk');
    mockSimulate.mockReset().mockResolvedValue({
      result: { retval: xdr.ScVal.scvMap([]) },
    });
  });

  it('decodes a cursor into the correct offset instead of ignoring it', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const cursor = Buffer.from('40', 'utf8').toString('base64');

    await sdk.list({ sender: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H', cursor, limit: 20 });

    expect(mockStreamsBySender).toHaveBeenCalledWith(
      'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H', 40, 20,
    );
  });

  it('returns a nextCursor when there are more results', async () => {
    // hasNextPage is derived from a full page being returned (ids.length ===
    // limit), not from the unrelated global streamCount() — see #179/#183.
    mockStreamsBySender.mockResolvedValue(Array.from({ length: 20 }, (_, i) => BigInt(i + 1)));

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const result = await sdk.list({ sender: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H', limit: 20 });

    expect(result.hasNextPage).toBe(true);
    expect(result.nextCursor).toBeDefined();
    expect(Buffer.from(result.nextCursor!, 'base64').toString('utf8')).toBe('20');
  });

  it('omits nextCursor on the last page', async () => {
    mockStreamsBySender.mockResolvedValue([1n]);
    mockStreamCount.mockResolvedValue(1n);

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const result = await sdk.list({ sender: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H' });

    expect(result.hasNextPage).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  it('cursor takes precedence over an explicit offset if both are somehow given', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());
    const cursor = Buffer.from('40', 'utf8').toString('base64');

    await sdk.list({ sender: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H', cursor, offset: 999 });

    expect(mockStreamsBySender).toHaveBeenCalledWith(
      'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H', 40, 20,
    );
  });

  it('throws a clear error for a malformed cursor instead of silently defaulting to page 1', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    await expect(
      sdk.list({ sender: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H', cursor: 'not-a-valid-cursor!!' })
    ).rejects.toThrow(/invalid cursor/i);
  });
});