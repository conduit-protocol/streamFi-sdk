import { describe, it, expect, vi } from 'vitest';
import { UnsupportedChainError, SUPPORTED_NETWORKS } from '../errors.js';

// ── Mock out the sub-modules so ConduitClient can be constructed without a
//    real Stellar RPC connection. ────────────────────────────────────────────

vi.mock('../streams.js',  () => ({ StreamsModule:  class {} }));
vi.mock('../factory.js',  () => ({ FactoryModule:  class {} }));
vi.mock('../governor.js', () => ({ GovernorModule: class {} }));

import { ConduitClient } from '../client.js';

// ── UnsupportedChainError unit tests ─────────────────────────────────────────

describe('UnsupportedChainError', () => {
  it('is an instance of Error', () => {
    const err = new UnsupportedChainError('ropsten');
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of UnsupportedChainError', () => {
    const err = new UnsupportedChainError('ropsten');
    expect(err).toBeInstanceOf(UnsupportedChainError);
  });

  it('has the correct name', () => {
    const err = new UnsupportedChainError('ropsten');
    expect(err.name).toBe('UnsupportedChainError');
  });

  it('stores the provided (bad) network value', () => {
    const err = new UnsupportedChainError('ropsten');
    expect(err.providedNetwork).toBe('ropsten');
  });

  it('exposes the list of supported networks', () => {
    const err = new UnsupportedChainError('ropsten');
    expect(err.supportedNetworks).toEqual(SUPPORTED_NETWORKS);
  });

  it('message includes the bad network name', () => {
    const err = new UnsupportedChainError('ropsten');
    expect(err.message).toContain('ropsten');
  });

  it('message names every supported network', () => {
    const err = new UnsupportedChainError('unknown-net');
    for (const net of SUPPORTED_NETWORKS) {
      expect(err.message).toContain(net);
    }
  });

  it('supports different unsupported network names', () => {
    const cases = ['ethereum', 'polygon', 'ropsten', '', '0x1', 'MAINNET'];
    for (const net of cases) {
      const err = new UnsupportedChainError(net);
      expect(err.providedNetwork).toBe(net);
      expect(err.message).toContain(net === '' ? "''" : net);
    }
  });
});

// ── SUPPORTED_NETWORKS constant ───────────────────────────────────────────────

describe('SUPPORTED_NETWORKS', () => {
  it('contains mainnet, testnet, and local', () => {
    expect(SUPPORTED_NETWORKS).toContain('mainnet');
    expect(SUPPORTED_NETWORKS).toContain('testnet');
    expect(SUPPORTED_NETWORKS).toContain('local');
  });

  it('has exactly three entries', () => {
    expect(SUPPORTED_NETWORKS).toHaveLength(3);
  });
});

// ── ConduitClient constructor validation ─────────────────────────────────────

describe('ConduitClient — network validation', () => {
  it('does NOT throw for "mainnet"', () => {
    expect(() => new ConduitClient({ network: 'mainnet' })).not.toThrow();
  });

  it('does NOT throw for "testnet"', () => {
    expect(() => new ConduitClient({ network: 'testnet' })).not.toThrow();
  });

  it('does NOT throw for "local"', () => {
    expect(() => new ConduitClient({ network: 'local' })).not.toThrow();
  });

  it('throws UnsupportedChainError for an unknown network string', () => {
    expect(() => new ConduitClient({ network: 'ropsten' as never }))
      .toThrow(UnsupportedChainError);
  });

  it('throws synchronously — before any async work', () => {
    // The constructor must be synchronous; if it throws we get it immediately.
    let thrown: unknown;
    try {
      new ConduitClient({ network: 'ethereum' as never });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnsupportedChainError);
  });

  it('error message includes the bad network name', () => {
    expect(() => new ConduitClient({ network: 'polygon' as never }))
      .toThrow(/polygon/i);
  });

  it('error message lists all supported networks', () => {
    let caught: UnsupportedChainError | undefined;
    try {
      new ConduitClient({ network: 'futurenet' as never });
    } catch (err) {
      caught = err as UnsupportedChainError;
    }
    expect(caught).toBeInstanceOf(UnsupportedChainError);
    for (const net of SUPPORTED_NETWORKS) {
      expect(caught!.message).toContain(net);
    }
  });

  it('throws for an empty string network', () => {
    expect(() => new ConduitClient({ network: '' as never }))
      .toThrow(UnsupportedChainError);
  });

  it('throws for a numeric network value coerced to string', () => {
    expect(() => new ConduitClient({ network: 1 as never }))
      .toThrow(UnsupportedChainError);
  });

  it('stores providedNetwork on the thrown error', () => {
    let caught: UnsupportedChainError | undefined;
    try {
      new ConduitClient({ network: 'devnet' as never });
    } catch (err) {
      caught = err as UnsupportedChainError;
    }
    expect(caught?.providedNetwork).toBe('devnet');
  });
});
