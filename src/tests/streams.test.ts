import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Keypair, xdr, SorobanRpc } from '@stellar/stellar-sdk';
import { ConduitError, ErrorCode } from '../errors.js';
import type { ConduitConfig, StreamInfo } from '../types/index.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockStreamAddress = vi.fn();
const mockStreamsBySender = vi.fn();
const mockStreamsByRecipient = vi.fn();
const mockStreamCount = vi.fn();

vi.mock('../factory.js', () => ({
  FactoryModule: vi.fn().mockImplementation(() => ({
    streamAddress:       mockStreamAddress,
    streamsBySender:     mockStreamsBySender,
    streamsByRecipient:  mockStreamsByRecipient,
    streamCount:         mockStreamCount,
  })),
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
    factoryAddress: 'CFACTORY000000000000000000000000000000000000000000000000',
    ...(withKeypair ? { keypair: Keypair.random() } : {}),
  };
}

function makeStreamInfo(overrides: Partial<StreamInfo> = {}): StreamInfo {
  const now = Math.floor(Date.now() / 1000);
  return {
    id:              1n,
    address:         'CSTREAM0000000000000000000000000000000000000000000000000',
    sender:          'GSENDER000000000000000000000000000000000000000000000000000',
    recipient:       'GRECIPIENT00000000000000000000000000000000000000000000000',
    token:           'CTOKEN00000000000000000000000000000000000000000000000000',
    ratePerSecond:   100n,
    startTime:       now - 3600,
    endTime:         now + 3600,
    withdrawn:       0n,
    paused:          false,
    pausedAt:        0,
    cancelled:       false,
    clawbackEnabled: false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StreamsModule — keypair guard', () => {
  it('create() throws without keypair', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await expect(sdk.create({
      recipient:       'GRECIPIENT00000000000000000000000000000000000000000000000',
      token:           'CTOKEN00000000000000000000000000000000000000000000000000',
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
      recipient:     'GRECIPIENT00000000000000000000000000000000000000000000000',
      token:         'CTOKEN00000000000000000000000000000000000000000000000000',
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
    expect((err as ConduitError).code).toBe(ErrorCode.StreamNotFound);
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
    const result = await sdk.list({ sender: 'GSENDER000000000000000000000000000000000000000000000000000' });
    expect(result).toEqual([]);
  });

  it('calls streamsBySender when sender is given', async () => {
    mockStreamsBySender.mockResolvedValue([]);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await sdk.list({ sender: 'GSENDER000000000000000000000000000000000000000000000000000', limit: 5 });
    expect(mockStreamsBySender).toHaveBeenCalledWith(
      'GSENDER000000000000000000000000000000000000000000000000000', 0, 5,
    );
  });

  it('calls streamsByRecipient when recipient is given', async () => {
    mockStreamsByRecipient.mockResolvedValue([]);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await sdk.list({ recipient: 'GRECIPIENT00000000000000000000000000000000000000000000000', offset: 10, limit: 10 });
    expect(mockStreamsByRecipient).toHaveBeenCalledWith(
      'GRECIPIENT00000000000000000000000000000000000000000000000', 10, 10,
    );
  });

  it('uses default offset=0 limit=20', async () => {
    mockStreamsBySender.mockResolvedValue([]);
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig(false));
    await sdk.list({ sender: 'GSENDER000000000000000000000000000000000000000000000000000' });
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
    mockStreamAddress.mockResolvedValue('CSTREAM0000000000000000000000000000000000000000000000000');
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
