import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { ConduitError, StreamErrorCode } from '../errors.js';
import type { ConduitConfig } from '../types/index.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockStreamAddress = vi.fn();
const mockStreamsBySender = vi.fn();
const mockStreamsByRecipient = vi.fn();
const mockStreamCount = vi.fn();

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

  it('clawback() throws without keypair', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.clawback(1n)).rejects.toThrow('keypair');
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
});

describe('StreamsModule — _resolveAddr via get()', () => {
  beforeEach(() => {
    mockStreamAddress.mockReset();
  });

  it('throws ConduitError(StreamNotFound) when stream address is null', async () => {
    mockStreamAddress.mockResolvedValue(null);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));

    const err = await sdk.get(99n).catch(e => e);
    expect(err).toBeInstanceOf(ConduitError);
    expect((err as ConduitError).contract).toBe('stream');
    expect((err as ConduitError).code).toBe(StreamErrorCode.StreamNotFound);
  });
});

describe('StreamsModule — list()', () => {
  beforeEach(() => {
    mockStreamsBySender.mockReset();
    mockStreamsByRecipient.mockReset();
  });

  it('returns empty array when factory has no streams', async () => {
    mockStreamsBySender.mockResolvedValue([]);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    const result = await sdk.list({ sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' });
    expect(result).toEqual([]);
  });

  it('calls streamsBySender when sender is given', async () => {
    mockStreamsBySender.mockResolvedValue([]);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await sdk.list({ sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', limit: 5 });
    expect(mockStreamsBySender).toHaveBeenCalledWith(
      'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', 0, 5,
    );
  });

  it('calls streamsByRecipient when recipient is given', async () => {
    mockStreamsByRecipient.mockResolvedValue([]);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await sdk.list({ recipient: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', offset: 10, limit: 10 });
    expect(mockStreamsByRecipient).toHaveBeenCalledWith(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 10, 10,
    );
  });

  it('uses default offset=0 limit=20', async () => {
    mockStreamsBySender.mockResolvedValue([]);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await sdk.list({ sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN' });
    expect(mockStreamsBySender).toHaveBeenCalledWith(
      expect.any(String), 0, 20,
    );
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
});

describe('StreamsModule — subscribeAsync()', () => {
  it('throws when stream address is not found', async () => {
    mockStreamAddress.mockResolvedValue(null);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.subscribeAsync(42n, {})).rejects.toThrow('not found');
  });
});
