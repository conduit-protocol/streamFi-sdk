/**
 * Tests for #783 — `FactoryModule.streamAddresses(ids[])`.
 *
 * `streamAddress(id)` costs one simulated RPC call per id, so rendering a
 * page of 50 streams from `streamsBySender()` costs 50 round trips on a cold
 * cache. `streamAddresses()` resolves a whole page in one call, sharing
 * `streamAddress()`'s cache, negative-cache TTL and abort semantics, and
 * bounding how many simulations are in flight at once.
 *
 * These tests describe behaviour that does not exist on `main` — they fail
 * there with "streamAddresses is not a function".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrKey, xdr as _xdr } from '@stellar/stellar-sdk';
import type { ConduitConfig } from '../types/index.js';

// ── Hoist mocks so they can be referenced inside vi.mock() factories ──────────

const { mockBuildTx, mockSimulate } = vi.hoisted(() => ({
  mockBuildTx:  vi.fn(),
  mockSimulate: vi.fn(),
}));

vi.mock('../soroban.js', () => ({
  buildContractCallTx: mockBuildTx,
  simulateReadOnly:    mockSimulate,
  scValToU64: (v: { u64: () => { toString: () => string } }) =>
    BigInt(v.u64().toString()),
  scValToI128: () => 0n,
  scValToU32: (v: { u32: () => number }) => v.u32(),
  NETWORK_PASSPHRASE: {
    testnet:  'Test SDF Network ; September 2015',
    mainnet:  'Public Global Stellar Network ; September 2015',
    local:    'Standalone Network ; February 2017',
  },
  DEFAULT_RPC: {
    testnet:  'https://soroban-testnet.stellar.org',
    mainnet:  'https://mainnet.sorobanrpc.com',
    local:    'http://localhost:8000/soroban/rpc',
  },
}));

// `Address.fromScVal` round-trips the real contract-id bytes so each id can
// resolve to its own distinct address (the upstream factory.test.ts mock
// returns a constant, which cannot distinguish one id's address from another's).
vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');

  class MockAddress {
    constructor(private readonly addr: string) {}
    toScVal() { return actual.xdr.ScVal.scvVoid(); }
    toString() { return this.addr; }
    static fromScVal(v: { address: () => { contractId: () => Buffer } }) {
      return new MockAddress(actual.StrKey.encodeContract(v.address().contractId()));
    }
    static fromString(s: string) { return new MockAddress(s); }
  }

  return { ...actual, Address: MockAddress };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const FACTORY_ADDR = 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM';

function cfg(extra: Partial<ConduitConfig> = {}): ConduitConfig {
  return {
    network:        'testnet',
    factoryAddress: FACTORY_ADDR,
    rpcUrl:         'https://soroban-testnet.stellar.org',
    ...extra,
  };
}

/** A distinct, valid contract address for each stream id used in the tests. */
function addressFor(id: bigint): string {
  // Zero-pad the decimal id into a 32-byte contract id, so every id used in
  // these tests maps to its own valid C-address without any Number() cast.
  return StrKey.encodeContract(Buffer.from(id.toString().padStart(64, '0'), 'hex'));
}

/** `Option<Address>` — a void ScVal is the contract's `None`. */
function voidScVal(): _xdr.ScVal {
  return _xdr.ScVal.scvVoid();
}

function addressScVal(id: bigint): _xdr.ScVal {
  return _xdr.ScVal.scvAddress(
    _xdr.ScAddress.scAddressTypeContract(StrKey.decodeContract(addressFor(id))),
  );
}

/**
 * Wire `buildContractCallTx` / `simulateReadOnly` so a `stream_address`
 * simulation resolves per id according to `resolver`, and record every id the
 * module actually sent to the network.
 */
function mockStreamAddress(resolver: (id: bigint) => _xdr.ScVal): {
  simulated: bigint[];
} {
  const simulated: bigint[] = [];
  mockBuildTx.mockImplementation(
    async (
      _rpc: string,
      _passphrase: string,
      _source: string,
      _contract: string,
      _fn: string,
      args?: _xdr.ScVal[],
    ) => {
      const id = BigInt(args![0]!.u64().toString());
      return { id };
    },
  );
  mockSimulate.mockImplementation(
    async (_rpc: string, _passphrase: string, tx: { id: bigint }) => {
      simulated.push(tx.id);
      return resolver(tx.id);
    },
  );
  return { simulated };
}

beforeEach(() => {
  mockBuildTx.mockReset();
  mockSimulate.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FactoryModule.streamAddresses() (#783)', () => {
  it('resolves every id in one call, keyed by decimal id string', async () => {
    const { FactoryModule } = await import('../factory.js');
    const { simulated } = mockStreamAddress(id => addressScVal(id));

    const map = await new FactoryModule(cfg()).streamAddresses([1n, 2n, 3n]);

    expect([...map.keys()]).toEqual(['1', '2', '3']);
    expect(map.get('1')).toBe(addressFor(1n));
    expect(map.get('2')).toBe(addressFor(2n));
    expect(map.get('3')).toBe(addressFor(3n));
    expect(simulated).toHaveLength(3);
  });

  it('reports a not-found id as null rather than dropping the key', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockStreamAddress(id => (id === 2n ? voidScVal() : addressScVal(id)));

    const map = await new FactoryModule(cfg()).streamAddresses([1n, 2n, 3n]);

    expect(map.get('2')).toBeNull();
    expect(map.has('2')).toBe(true);
    expect(map.size).toBe(3);
  });

  it('deduplicates repeated ids and collates string/bigint forms to one simulation', async () => {
    const { FactoryModule } = await import('../factory.js');
    const { simulated } = mockStreamAddress(id => addressScVal(id));

    const map = await new FactoryModule(cfg()).streamAddresses([7n, '7', 7n, 8n]);

    expect(map.size).toBe(2);
    expect(map.get('7')).toBe(addressFor(7n));
    expect(simulated).toEqual([7n, 8n]);
  });

  it('preserves first-seen input order regardless of resolution order', async () => {
    const { FactoryModule } = await import('../factory.js');
    // The first id resolves slowest, so a naive "push as answers arrive"
    // implementation would emit a different order than the input.
    mockBuildTx.mockImplementation(
      async (_r: string, _p: string, _s: string, _c: string, _f: string, args?: _xdr.ScVal[]) =>
        ({ id: BigInt(args![0]!.u64().toString()) }),
    );
    mockSimulate.mockImplementation(async (_r: string, _p: string, tx: { id: bigint }) => {
      await new Promise(resolve => setTimeout(resolve, tx.id === 1n ? 30 : 0));
      return addressScVal(tx.id);
    });

    const map = await new FactoryModule(cfg()).streamAddresses([1n, 2n, 3n]);

    expect([...map.keys()]).toEqual(['1', '2', '3']);
  });

  it('accepts an empty id list without touching the network', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockStreamAddress(id => addressScVal(id));

    const map = await new FactoryModule(cfg()).streamAddresses([]);

    expect(map.size).toBe(0);
    expect(mockSimulate).not.toHaveBeenCalled();
  });

  it('rejects with AbortError and skips the network when the signal is already aborted', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockStreamAddress(id => addressScVal(id));
    const controller = new AbortController();
    controller.abort();

    await expect(
      new FactoryModule(cfg()).streamAddresses([1n, 2n], controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockSimulate).not.toHaveBeenCalled();
  });

  it('rejects with AbortError when the signal aborts mid-flight', async () => {
    const { FactoryModule } = await import('../factory.js');
    const controller = new AbortController();
    mockBuildTx.mockImplementation(
      async (_r: string, _p: string, _s: string, _c: string, _f: string, args?: _xdr.ScVal[]) =>
        ({ id: BigInt(args![0]!.u64().toString()) }),
    );
    mockSimulate.mockImplementation(async (_r: string, _p: string, tx: { id: bigint }) => {
      if (tx.id === 1n) controller.abort();
      return addressScVal(tx.id);
    });

    // Serialised so the abort lands between two resolutions rather than
    // before all of them were already scheduled.
    await expect(
      new FactoryModule(cfg()).streamAddresses([1n, 2n, 3n], controller.signal, { maxConcurrency: 1 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('FactoryModule.streamAddresses() — cache sharing (#783)', () => {
  it('only simulates the cache-miss subset when some ids are already resolved', async () => {
    const { FactoryModule } = await import('../factory.js');
    const { simulated } = mockStreamAddress(id => addressScVal(id));
    const factory = new FactoryModule(cfg());

    await factory.streamAddress(1n);
    const map = await factory.streamAddresses([1n, 2n, 3n]);

    expect(map.get('1')).toBe(addressFor(1n));
    expect(simulated).toEqual([1n, 2n, 3n]);
  });

  it('reuses entries written by a previous streamAddresses() call', async () => {
    const { FactoryModule } = await import('../factory.js');
    const { simulated } = mockStreamAddress(id => addressScVal(id));
    const factory = new FactoryModule(cfg());

    await factory.streamAddresses([1n, 2n]);
    const map = await factory.streamAddresses([1n, 2n]);

    expect(map.size).toBe(2);
    expect(simulated).toHaveLength(2);
  });

  it('serves a negatively cached id from cache instead of re-simulating it', async () => {
    const { FactoryModule } = await import('../factory.js');
    const { simulated } = mockStreamAddress(() => voidScVal());
    const factory = new FactoryModule(cfg({ negativeCacheTtlMs: 60_000 }));

    const first = await factory.streamAddresses([999n]);
    const second = await factory.streamAddresses([999n, 998n]);

    expect(first.get('999')).toBeNull();
    expect(second.get('999')).toBeNull();
    // 999 came from the negative cache; only 998 hit the network.
    expect(simulated).toEqual([999n, 998n]);
  });

  it('re-simulates a not-found id once its negative-cache TTL has expired', async () => {
    const { FactoryModule } = await import('../factory.js');
    const { simulated } = mockStreamAddress(() => voidScVal());
    const factory = new FactoryModule(cfg({ negativeCacheTtlMs: 1 }));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      await factory.streamAddresses([999n]);
      vi.setSystemTime(5_000);
      await factory.streamAddresses([999n]);
    } finally {
      vi.useRealTimers();
    }

    expect(simulated).toEqual([999n, 999n]);
  });
});

describe('FactoryModule.streamAddresses() — bounded concurrency (#783)', () => {
  /** Record the high-water mark of concurrently in-flight simulations. */
  function trackConcurrency(delayMs: number): { peak: () => number } {
    let inFlight = 0;
    let peak = 0;
    mockBuildTx.mockImplementation(
      async (_r: string, _p: string, _s: string, _c: string, _f: string, args?: _xdr.ScVal[]) =>
        ({ id: BigInt(args![0]!.u64().toString()) }),
    );
    mockSimulate.mockImplementation(async (_r: string, _p: string, tx: { id: bigint }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      inFlight--;
      return addressScVal(tx.id);
    });
    return { peak: () => peak };
  }

  it('never has more than maxConcurrency simulations in flight', async () => {
    const { FactoryModule } = await import('../factory.js');
    const { peak } = trackConcurrency(5);
    const ids = Array.from({ length: 24 }, (_, i) => BigInt(i + 1));

    const map = await new FactoryModule(cfg()).streamAddresses(ids, undefined, { maxConcurrency: 3 });

    expect(map.size).toBe(24);
    expect(peak()).toBeLessThanOrEqual(3);
    expect(peak()).toBeGreaterThan(1);
  });

  it('still resolves every id when maxConcurrency is below 1', async () => {
    const { FactoryModule } = await import('../factory.js');
    const { peak } = trackConcurrency(1);

    const map = await new FactoryModule(cfg()).streamAddresses([1n, 2n, 3n], undefined, { maxConcurrency: 0 });

    expect(map.size).toBe(3);
    expect(peak()).toBe(1);
  });

  it('runs in parallel rather than sequentially at the default concurrency', async () => {
    const { FactoryModule } = await import('../factory.js');
    const { peak } = trackConcurrency(20);

    const map = await new FactoryModule(cfg()).streamAddresses([1n, 2n, 3n, 4n]);

    expect(map.size).toBe(4);
    expect(peak()).toBeGreaterThan(1);
  });
});

describe('FactoryModule.streamAddresses() — failure handling (#783)', () => {
  it('rejects when an individual resolution fails, and does not cache it as not-found', async () => {
    const { FactoryModule } = await import('../factory.js');
    const { simulated } = mockStreamAddress(id => {
      if (id === 2n) throw new Error('rpc unavailable');
      return addressScVal(id);
    });
    const factory = new FactoryModule(cfg());

    await expect(factory.streamAddresses([1n, 2n, 3n])).rejects.toThrow('rpc unavailable');

    // The failing id must not have poisoned the negative cache, so a retry
    // re-simulates it instead of serving a bogus `null` for the next TTL.
    mockStreamAddress(id => addressScVal(id));
    const retry = await factory.streamAddresses([2n]);
    expect(retry.get('2')).toBe(addressFor(2n));
    expect(simulated).toContain(2n);
  });

  it('keeps the ids that did resolve cached, so a retry only re-fetches the failure', async () => {
    const { FactoryModule } = await import('../factory.js');
    const failing = mockStreamAddress(id => {
      if (id === 2n) throw new Error('rpc unavailable');
      return addressScVal(id);
    });
    const factory = new FactoryModule(cfg());

    await expect(factory.streamAddresses([1n, 2n])).rejects.toThrow('rpc unavailable');
    expect(failing.simulated).toContain(1n);

    const retry = mockStreamAddress(id => addressScVal(id));
    await factory.streamAddresses([1n, 2n]);

    // Id 1 was cached before the throw, so only id 2 is re-simulated.
    expect(retry.simulated).toEqual([2n]);
  });
});
