import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, xdr } from '@stellar/stellar-sdk';
import { ConduitError, StreamErrorCode, StreamNotFoundError } from '../errors.js';
import {
  STREAM_FLAG_PAUSED,
  STREAM_FLAG_CANCELLED,
  STREAM_FLAG_CLAWBACK_ENABLED,
} from '../constants.js';
import type { ConduitConfig } from '../types/index.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockStreamAddress = vi.fn();
const mockStreamsBySender = vi.fn();
const mockStreamsByRecipient = vi.fn();
const mockStreamCount = vi.fn();
const mockSimulate = vi.fn();

vi.mock('../factory.js', () => ({
  // A plain class, not vi.fn().mockImplementation(() => ({...})) — Vitest 4's
  // spy wrapper no longer supports `new`-invoking an arrow-function
  // implementation and returning its object as the instance.
  FactoryModule: class {
    streamAddress      = mockStreamAddress;
    streamsBySender    = mockStreamsBySender;
    streamsByRecipient = mockStreamsByRecipient;
    streamCount        = mockStreamCount;
  },
}));

vi.mock('../soroban.js', async () => {
  const actual = await vi.importActual<typeof import('../soroban.js')>('../soroban.js');
  return {
    ...actual,
    buildContractCallTx: vi.fn().mockResolvedValue({ _stub: 'tx' }),
    catchNetworkError:   <T>(_label: string, promise: Promise<T>) => promise,
  };
});

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: class {
        simulateTransaction = mockSimulate;
      },
    },
  };
});

vi.mock('../events.js', () => ({
  subscribeToStream: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(withKeypair = true): ConduitConfig {
  return {
    network:        'testnet',
    factoryAddress: 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM',
    ...(withKeypair ? { keypair: Keypair.random() } : {}),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StreamsModule — keypair guard', () => {
  it('create() throws without keypair', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.create({
      recipient:       'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      token:           'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN3',
      depositAmount:   '1000',
      durationSeconds: 86400,
    })).rejects.toThrow('keypair');
  });

  it('withdraw() throws without keypair', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.withdraw(1n)).rejects.toThrow('keypair');
  });

  it('cancel() throws without keypair', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.cancel(1n)).rejects.toThrow('keypair');
  });

  it('pause() throws without keypair', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.pause(1n)).rejects.toThrow('keypair');
  });

  it('resume() throws without keypair', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.resume(1n)).rejects.toThrow('keypair');
  });

  it('topUp() throws without keypair', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.topUp(1n, 1000n)).rejects.toThrow('keypair');
  });

  it('topUpStream() throws without keypair', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.topUpStream('1', '1000')).rejects.toThrow('keypair');
  });

  it('clawback() throws without keypair', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.clawback(1n)).rejects.toThrow('keypair');
  });

  it('forceCancel() throws without keypair', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.forceCancel(1n)).rejects.toThrow('keypair');
  });

  it('transferRecipient() throws without keypair', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.transferRecipient(1n, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')).rejects.toThrow('keypair');
  });
});

describe('StreamsModule — amount validation (withdraw/topUp)', () => {
  it('withdraw() rejects an explicit zero amount client-side', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(true));
    await expect(sdk.withdraw(1n, 0n)).rejects.toThrow('Invalid amount: must be greater than zero');
  });

  it('withdraw() rejects a negative amount client-side', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(true));
    await expect(sdk.withdraw(1n, -5n)).rejects.toThrow('Invalid amount: must be greater than zero');
  });

  it('topUp() rejects a zero amount client-side', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(true));
    await expect(sdk.topUp(1n, 0n)).rejects.toThrow('Invalid amount: must be greater than zero');
  });

  it('topUp() rejects a negative amount client-side', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(true));
    await expect(sdk.topUp(1n, -1n)).rejects.toThrow('Invalid amount: must be greater than zero');
  });

  it('topUpStream() rejects a zero amount client-side', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(true));
    await expect(sdk.topUpStream('1', '0')).rejects.toThrow('Invalid amount: must be greater than zero');
  });

  it('batchWithdraw() reports an invalid amount as a per-item failure', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(true));
    const result = await sdk.batchWithdraw([{ streamId: 1n, amount: 0n }]);
    expect(result).toEqual([{
      streamId: 1n,
      success: false,
      error: 'Invalid amount: must be greater than zero',
    }]);
  });
});

describe('StreamsModule — transferRecipient() validation', () => {
  it('rejects an empty recipient address client-side', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(true));
    await expect(sdk.transferRecipient(1n, '')).rejects.toThrow('Invalid recipient address: must be a non-empty string');
  });

  it('rejects a whitespace-only recipient address client-side', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(true));
    await expect(sdk.transferRecipient(1n, '   ')).rejects.toThrow('Invalid recipient address: must be a non-empty string');
  });
});

describe('StreamsModule — create() param validation', () => {
  it('throws when neither durationSeconds nor ratePerSecond is given', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(true));
    await expect(sdk.create({
      recipient:     'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      token:         'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN3',
      depositAmount: '100',
    })).rejects.toThrow(/durationSeconds|ratePerSecond/);
  });

  it('throws when durationSeconds is below MIN_STREAM_DURATION_SECONDS', async () => {
    const { StreamsModule } = await import('../streams.js');
    const { MIN_STREAM_DURATION_SECONDS } = await import('../constants.js');
    const sdk = new StreamsModule(makeConfig(true));
    await expect(sdk.create({
      recipient:       'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      token:           'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN3',
      depositAmount:   '100',
      durationSeconds: MIN_STREAM_DURATION_SECONDS - 1,
    })).rejects.toThrow(/durationSeconds.*at least.*3600/);
  });
});

describe('StreamsModule — _resolveAddr via get()', () => {
  beforeEach(() => {
    mockStreamAddress.mockReset();
  });

  it('throws StreamNotFoundError when stream address is null', async () => {
    mockStreamAddress.mockResolvedValue(null);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));

    const err = await sdk.get(99n).catch(e => e);
    expect(err).toBeInstanceOf(StreamNotFoundError);
    expect((err as StreamNotFoundError).streamId).toBe(99n);
    expect((err as ConduitError).contract).toBe('stream');
    expect((err as ConduitError).code).toBe(StreamErrorCode.StreamNotFound);
  });
});

describe('StreamsModule — not-found read errors', () => {
  beforeEach(() => {
    mockStreamAddress.mockReset().mockResolvedValue(null);
  });

  it('withdrawable() throws StreamNotFoundError for an unknown stream', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));

    const err = await sdk.withdrawable(404n).catch(e => e);
    expect(err).toBeInstanceOf(StreamNotFoundError);
    expect((err as StreamNotFoundError).streamId).toBe(404n);
  });

  it('streamedTotal() throws StreamNotFoundError for an unknown stream', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));

    const err = await sdk.streamedTotal(405n).catch(e => e);
    expect(err).toBeInstanceOf(StreamNotFoundError);
    expect((err as StreamNotFoundError).streamId).toBe(405n);
  });
});

describe('StreamsModule — get() flag decoding', () => {
  const STREAM_ADDR = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

  const scvMap = (entries: Record<string, xdr.ScVal>): xdr.ScVal =>
    xdr.ScVal.scvMap(
      Object.entries(entries).map(
        ([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v }),
      ),
    );
  const u32 = (n: number) => xdr.ScVal.scvU32(n);
  const u64 = (n: bigint) => xdr.ScVal.scvU64(xdr.Uint64.fromString(n.toString()));

  const infoWith = (flags: number, pausedAt = 0n): xdr.ScVal =>
    scvMap({ flags: u32(flags), paused_at: u64(pausedAt) });

  beforeEach(() => {
    mockStreamAddress.mockReset().mockResolvedValue(STREAM_ADDR);
    mockSimulate.mockReset();
  });

  async function getInfo(retval: xdr.ScVal) {
    mockSimulate.mockResolvedValue({ result: { retval } });
    const { StreamsModule } = await import('../streams.js');
    return new StreamsModule(makeConfig(false)).get(1n);
  }

  it('reports every flag false when flags = 0', async () => {
    const info = await getInfo(infoWith(0));
    expect(info.paused).toBe(false);
    expect(info.cancelled).toBe(false);
    expect(info.clawbackEnabled).toBe(false);
  });

  it('decodes FLAG_PAUSED (bit 0)', async () => {
    const info = await getInfo(infoWith(STREAM_FLAG_PAUSED, 1_700_000_000n));
    expect(info.paused).toBe(true);
    expect(info.pausedAt).toBe(1_700_000_000);
    expect(info.cancelled).toBe(false);
    expect(info.clawbackEnabled).toBe(false);
  });

  it('decodes FLAG_CLAWBACK_ENABLED (bit 1)', async () => {
    const info = await getInfo(infoWith(STREAM_FLAG_CLAWBACK_ENABLED));
    expect(info.clawbackEnabled).toBe(true);
    expect(info.paused).toBe(false);
    expect(info.cancelled).toBe(false);
  });

  it('decodes FLAG_CANCELLED (bit 2)', async () => {
    const info = await getInfo(infoWith(STREAM_FLAG_CANCELLED));
    expect(info.cancelled).toBe(true);
    expect(info.paused).toBe(false);
    expect(info.clawbackEnabled).toBe(false);
  });

  it('decodes several flags packed together', async () => {
    const info = await getInfo(
      infoWith(STREAM_FLAG_PAUSED | STREAM_FLAG_CANCELLED | STREAM_FLAG_CLAWBACK_ENABLED),
    );
    expect(info.paused).toBe(true);
    expect(info.cancelled).toBe(true);
    expect(info.clawbackEnabled).toBe(true);
  });

  it('defaults every flag to false when the contract omits `flags`', async () => {
    const info = await getInfo(scvMap({ paused_at: u64(0n) }));
    expect(info.paused).toBe(false);
    expect(info.cancelled).toBe(false);
    expect(info.clawbackEnabled).toBe(false);
  });
});

describe('StreamsModule — list()', () => {
  beforeEach(() => {
    mockStreamsBySender.mockReset();
    mockStreamsByRecipient.mockReset();
    mockStreamCount.mockReset().mockResolvedValue(0n);
    mockStreamAddress.mockReset();
    mockSimulate.mockReset();
  });

  it('returns empty PaginatedStreams when factory has no streams', async () => {
    mockStreamsBySender.mockResolvedValue([]);
    mockStreamCount.mockResolvedValue(0n);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    const result = await sdk.list({ sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' });
    expect(result.streams).toEqual([]);
    expect(result.hasNextPage).toBe(false);
    expect(result.totalCount).toBe(0n);
    expect(result.offset).toBe(0);
    expect(result.limit).toBe(20);
  });

  it('calls streamsBySender when sender is given', async () => {
    mockStreamsBySender.mockResolvedValue([]);
    mockStreamCount.mockResolvedValue(0n);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await sdk.list({ sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', limit: 5 });
    expect(mockStreamsBySender).toHaveBeenCalledWith(
      'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', 0, 5,
    );
  });

  it('calls streamsByRecipient when recipient is given', async () => {
    mockStreamsByRecipient.mockResolvedValue([]);
    mockStreamCount.mockResolvedValue(0n);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await sdk.list({ recipient: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', offset: 10, limit: 10 });
    expect(mockStreamsByRecipient).toHaveBeenCalledWith(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 10, 10,
    );
  });

  it('uses default offset=0 limit=20', async () => {
    mockStreamsBySender.mockResolvedValue([]);
    mockStreamCount.mockResolvedValue(0n);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await sdk.list({ sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' });
    expect(mockStreamsBySender).toHaveBeenCalledWith(
      expect.any(String), 0, 20,
    );
  });

  it('returns hasNextPage=true when the filtered sender page is full', async () => {
    mockStreamsBySender.mockResolvedValue([1n, 2n, 3n]);
    mockStreamCount.mockResolvedValue(50n);
    // Mock get() to return minimal valid StreamInfo
    mockStreamAddress.mockResolvedValue('CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM');
    mockSimulate.mockResolvedValue({ result: { retval: xdr.ScVal.scvMap([]) } });
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    const result = await sdk.list({
      sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      offset: 0,
      limit: 3,
    });
    expect(result.hasNextPage).toBe(true);
    expect(result.totalCount).toBe(3n);
    expect(result.streams).toHaveLength(3);
    expect(mockStreamCount).not.toHaveBeenCalled();
  });

  it('returns hasNextPage=false when a filtered sender page is not full', async () => {
    mockStreamsBySender.mockResolvedValue([1n, 2n]);
    mockStreamCount.mockResolvedValue(5000n);
    mockStreamAddress.mockResolvedValue('CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM');
    mockSimulate.mockResolvedValue({ result: { retval: xdr.ScVal.scvMap([]) } });
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    const result = await sdk.list({
      sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      offset: 10,
      limit: 20,
    });
    expect(result.hasNextPage).toBe(false);
    expect(result.totalCount).toBe(12n);
    expect(mockStreamCount).not.toHaveBeenCalled();
  });

  it('does not use the global streamCount for recipient-filtered pagination', async () => {
    mockStreamsByRecipient.mockResolvedValue([5n]);
    mockStreamCount.mockResolvedValue(5000n);
    mockStreamAddress.mockResolvedValue('CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM');
    mockSimulate.mockResolvedValue({ result: { retval: xdr.ScVal.scvMap([]) } });
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    const result = await sdk.list({
      recipient: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      offset: 20,
      limit: 20,
    });
    expect(result.hasNextPage).toBe(false);
    expect(result.totalCount).toBe(21n);
    expect(mockStreamCount).not.toHaveBeenCalled();
  });

  it('queries both sender and recipient filters when both are given, merging from offset 0 (#507)', async () => {
    mockStreamsBySender.mockResolvedValue([]);
    mockStreamsByRecipient.mockResolvedValue([]);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await sdk.list({
      sender:    'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      recipient: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      offset: 5,
      limit: 10,
    });
    // Both sub-indices are fetched from offset 0 through offset+limit so
    // they can be merged into one honest, ordered window before slicing
    // out this page — see #507.
    expect(mockStreamsBySender).toHaveBeenCalledWith(
      'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', 0, 16,
    );
    expect(mockStreamsByRecipient).toHaveBeenCalledWith(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 0, 16,
    );
  });

  it('returns the de-duplicated union when both sender and recipient are given', async () => {
    mockStreamsBySender.mockResolvedValue([1n, 2n]);
    mockStreamsByRecipient.mockResolvedValue([2n, 3n]);
    mockStreamAddress.mockResolvedValue('CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM');
    mockSimulate.mockResolvedValue({ result: { retval: xdr.ScVal.scvMap([]) } });
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    const result = await sdk.list({
      sender:    'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      recipient: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      offset: 0,
      limit: 20,
    });
    // Stream 2 appears in both pages and must not be duplicated.
    expect(result.streams.map(s => s.id)).toEqual([1n, 2n, 3n]);
    expect(result.hasNextPage).toBe(false);
  });

  it('caps the union page at `limit` and reports hasNextPage honestly (#507)', async () => {
    // 5 sender streams + 5 disjoint recipient streams = 10 total, but the
    // caller only asked for a page of 3.
    mockStreamsBySender.mockResolvedValue([1n, 2n, 3n, 4n, 5n]);
    mockStreamsByRecipient.mockResolvedValue([6n, 7n, 8n, 9n, 10n]);
    mockStreamAddress.mockResolvedValue('CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM');
    mockSimulate.mockResolvedValue({ result: { retval: xdr.ScVal.scvMap([]) } });
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    const result = await sdk.list({
      sender:    'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      recipient: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      offset: 0,
      limit: 3,
    });
    expect(result.streams).toHaveLength(3);
    expect(result.streams.map(s => s.id)).toEqual([1n, 2n, 3n]);
    expect(result.hasNextPage).toBe(true);
  });
});

describe('StreamsModule — subscribe()', () => {
  it('returns a subscription with unsubscribe function synchronously', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    const sub = sdk.subscribe(1n, {});
    expect(sub).toHaveProperty('unsubscribe');
    expect(typeof sub.unsubscribe).toBe('function');
    sub.unsubscribe(); // should not throw
  });

  it('calling unsubscribe before async resolve sets stopped flag', async () => {
    mockStreamAddress.mockResolvedValue('CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM');
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    const sub = sdk.subscribe(1n, {});
    // Unsubscribe immediately — should not throw even before async resolves
    expect(() => sub.unsubscribe()).not.toThrow();
  });

  it('surfaces subscribeAsync failures through onError', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockStreamAddress.mockResolvedValue(null);

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    const onError = vi.fn();

    const sub = sdk.subscribe(42n, { onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));

    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]![0].message).toContain('Stream 42 not found');
    expect(warn).toHaveBeenCalledWith(
      '[conduit-sdk] subscribe error:',
      onError.mock.calls[0]![0],
    );

    sub.unsubscribe();
    warn.mockRestore();
  });
});

describe('StreamsModule — subscribeAsync()', () => {
  const STREAM_ADDR = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

  it('throws when stream address is not found', async () => {
    mockStreamAddress.mockResolvedValue(null);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.subscribeAsync(42n, {})).rejects.toThrow('not found');
  });

  it('passes the resolved rpcUrl (network default) to subscribeToStream, never undefined', async () => {
    mockStreamAddress.mockResolvedValue(STREAM_ADDR);
    const { subscribeToStream } = await import('../events.js');
    const spy = vi.mocked(subscribeToStream);
    spy.mockClear();

    const { StreamsModule } = await import('../streams.js');
    // makeConfig() sets no rpcUrl → constructor falls back to DEFAULT_RPC.testnet
    await new StreamsModule(makeConfig(false)).subscribeAsync(1n, {});

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe('https://soroban-testnet.stellar.org');
  });

  it('honours an explicit rpcUrl override', async () => {
    mockStreamAddress.mockResolvedValue(STREAM_ADDR);
    const { subscribeToStream } = await import('../events.js');
    const spy = vi.mocked(subscribeToStream);
    spy.mockClear();

    const { StreamsModule } = await import('../streams.js');
    await new StreamsModule({ ...makeConfig(false), rpcUrl: 'https://my-node.example' })
      .subscribeAsync(1n, {});

    expect(spy.mock.calls[0]![0]).toBe('https://my-node.example');
  });
});

describe('StreamsModule — caller address caching', () => {
  it('caches the caller address across multiple calls', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const addr1 = await (sdk as any)._resolveCallerAddress();
    const addr2 = await (sdk as any)._resolveCallerAddress();
    expect(addr1).toBe(addr2);
  });

  it('invalidates the cached caller address when setWallet is called', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const addr1 = await (sdk as any)._resolveCallerAddress();
    sdk.setWallet({
      getPublicKey: vi.fn().mockResolvedValue('GNEWADDR123456789012345678901234567890123456789012345678901'),
      signTransaction: vi.fn(),
    } as unknown as import('../adapters/types.js').WalletAdapter);
    const addr2 = await (sdk as any)._resolveCallerAddress();
    expect(addr1).not.toBe(addr2);
  });
});

describe('StreamsModule — server caching', () => {
  it('caches the SorobanRpc.Server instance across calls', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const server1 = (sdk as any)._server();
    const server2 = (sdk as any)._server();
    expect(server1).toBe(server2);
  });
});

describe('StreamsModule.getStreamInfos', () => {
  it('returns results and failures for a mixed fan-out', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));

    const goodInfo = { id: 1n, address: 'C_GOOD' } as unknown as import('../types/index.js').StreamInfo;
    vi.spyOn(sdk, 'get').mockImplementation(async (id) => {
      if (id === 1n || id === '1') return goodInfo;
      throw new Error('not found');
    });

    const result = await sdk.getStreamInfos([1n, 2n, '3'], { maxConcurrency: 2 });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toBe(goodInfo);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.map(f => ({ id: f.id, error: f.error }))).toEqual([
      { id: 2n, error: 'not found' },
      { id: 3n, error: 'not found' },
    ]);
  });

  it('preserves input order', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    vi.spyOn(sdk, 'get').mockImplementation(async (id) => ({
      id: BigInt(id),
      address: 'C_' + String(id),
    } as unknown as import('../types/index.js').StreamInfo));

    const result = await sdk.getStreamInfos([5n, 4n, 3n]);
    expect(result.results.map(i => i.id)).toEqual([5n, 4n, 3n]);
  });
});
