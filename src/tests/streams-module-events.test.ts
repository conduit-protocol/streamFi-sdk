import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import type { ConduitConfig } from '../types/index.js';

const mockStreamAddress = vi.fn();

vi.mock('../factory.js', () => ({
  FactoryModule: class {
    streamAddress = mockStreamAddress;
  },
}));

const mockOnStreamEvent = vi.fn();
const mockReplayEvents = vi.fn();

vi.mock('../events.js', () => ({
  onStreamEvent: mockOnStreamEvent,
  replayEvents:  mockReplayEvents,
}));

const RPC_URL = 'http://localhost:8000';

function makeConfig(): ConduitConfig {
  return {
    network:        'testnet',
    factoryAddress: 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM',
    keypair:        Keypair.random(),
    rpcUrl:         RPC_URL,
  };
}

describe('StreamsModule.onStreamEvent', () => {
  it('resolves the stream address and delegates to events.onStreamEvent for Cancelled', async () => {
    mockStreamAddress.mockResolvedValue('CSTREAMADDR');
    const subscription = { unsubscribe: vi.fn() };
    mockOnStreamEvent.mockReturnValue(subscription);

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());
    const callback = vi.fn();

    const result = await sdk.onStreamEvent(1n, 'Cancelled', callback);

    expect(mockStreamAddress).toHaveBeenCalledWith(1n);
    expect(mockOnStreamEvent).toHaveBeenCalledWith(RPC_URL, 'CSTREAMADDR', 'Cancelled', callback);
    expect(result).toBe(subscription);
  });

  it('forwards cliffTime options for CliffReached', async () => {
    mockStreamAddress.mockResolvedValue('CSTREAMADDR');
    mockOnStreamEvent.mockReturnValue({ unsubscribe: vi.fn() });

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());
    const callback = vi.fn();

    await sdk.onStreamEvent(1n, 'CliffReached', callback, { cliffTime: 12345 });

    expect(mockOnStreamEvent).toHaveBeenCalledWith(
      RPC_URL, 'CSTREAMADDR', 'CliffReached', callback, { cliffTime: 12345 },
    );
  });

  it('rejects CliffReached without options', async () => {
    mockStreamAddress.mockResolvedValue('CSTREAMADDR');

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    // @ts-expect-error — intentionally omitting required options to test the runtime guard
    await expect(sdk.onStreamEvent(1n, 'CliffReached', vi.fn())).rejects.toThrow(/cliffTime/);
  });

  it('throws StreamNotFoundError-style error when the stream does not resolve', async () => {
    mockStreamAddress.mockResolvedValue(null);

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    await expect(sdk.onStreamEvent(99n, 'Cancelled', vi.fn())).rejects.toThrow();
  });
});

describe('StreamsModule.replayEvents', () => {
  it('resolves the stream address and delegates to events.replayEvents', async () => {
    mockStreamAddress.mockResolvedValue('CSTREAMADDR');
    const expected = { dispatched: 3, lastLedger: 42 };
    mockReplayEvents.mockResolvedValue(expected);

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());
    const handlers = { onClawback: vi.fn() };

    const result = await sdk.replayEvents(1n, handlers, 10, { toLedger: 50 });

    expect(mockStreamAddress).toHaveBeenCalledWith(1n);
    expect(mockReplayEvents).toHaveBeenCalledWith(RPC_URL, 'CSTREAMADDR', handlers, 10, { toLedger: 50 });
    expect(result).toBe(expected);
  });
});
