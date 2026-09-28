import { describe, it, expect, vi, beforeEach } from 'vitest';
import { xdr as _xdr } from '@stellar/stellar-sdk';
import type { ConduitConfig } from '../types/index.js';

// ── Hoist mocks so they can be referenced inside vi.mock() factories ──────────

const { mockBuildTx, mockSimulate } = vi.hoisted(() => ({
  mockBuildTx:  vi.fn().mockResolvedValue({ _stub: 'tx' }),
  mockSimulate: vi.fn(),
}));

// ── Mock soroban helpers — avoids real RPC calls and address validation ────────

vi.mock('../soroban.js', () => ({
  buildContractCallTx: mockBuildTx,
  simulateReadOnly:    mockSimulate,
  resolveFee:          () => '100',
  scValToU64: (v: { u64: () => { toString: () => string } }) =>
    BigInt(v.u64().toString()),
  scValToI128: (_v: unknown) => 0n,
  scValToU32: (v: { switch: () => { name: string }; u32: () => number }) => {
    if (v.switch().name !== 'scvU32') {
      throw new Error(`Expected a u32 ScVal, got "${v.switch().name}" instead.`);
    }
    return v.u32();
  },
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
  catchNetworkError: (label: string, fn: () => any) => fn(),
}));

// ── Mock Address so G-addresses are accepted without strkey validation ─────────

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');

  class MockAddress {
    constructor(private readonly addr: string) {}
    toScVal() { return actual.xdr.ScVal.scvVoid(); }
    toString() { return this.addr; }
    static fromScVal(_v: unknown) { return new MockAddress(''); }
    static fromString(s: string)  { return new MockAddress(s); }
  }

  return { ...actual, Address: MockAddress };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const FACTORY_ADDR   = 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM';
const SENDER_ADDR    = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const RECIPIENT_ADDR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function cfg(): ConduitConfig {
  return {
    network:        'testnet',
    factoryAddress: FACTORY_ADDR,
    rpcUrl:         'https://soroban-testnet.stellar.org',
  };
}

function makeU64ScVal(n: bigint) {
  return _xdr.ScVal.scvU64(_xdr.Uint64.fromString(n.toString()));
}

function makeU32ScVal(n: number) {
  return _xdr.ScVal.scvU32(n);
}

function makeVoidScVal() {
  return _xdr.ScVal.scvVoid();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockBuildTx.mockResolvedValue({ _stub: 'tx' });
  mockSimulate.mockReset();
});

describe('FactoryModule — construction', () => {
  it('throws immediately when factoryAddress is missing, not deep inside stellar-sdk later', async () => {
    const { FactoryModule } = await import('../factory.js');
    expect(() => new FactoryModule({ network: 'testnet' })).toThrow(/factoryAddress is required/);
  });
});

describe('FactoryModule — streamCount()', () => {
  it('returns bigint parsed from u64 scval', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU64ScVal(42n));

    const count = await new FactoryModule(cfg()).streamCount();
    expect(count).toBe(42n);
  });

  it('returns 0n when contract has no streams', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU64ScVal(0n));

    const count = await new FactoryModule(cfg()).streamCount();
    expect(count).toBe(0n);
  });
});

describe('FactoryModule — streamAddress()', () => {
  it('returns null when contract returns void (stream not found)', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeVoidScVal());

    const addr = await new FactoryModule(cfg()).streamAddress(999n);
    expect(addr).toBeNull();
  });

  it('caches a resolved address and does not re-hit the network on the next call', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU32ScVal(1)); // any non-void scval
    const factory = new FactoryModule(cfg());

    const first  = await factory.streamAddress(1n);
    const second = await factory.streamAddress(1n);

    expect(first).toBe(second);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it('caches per streamId — a different id still hits the network', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate
      .mockResolvedValueOnce(makeU32ScVal(1))
      .mockResolvedValueOnce(makeU32ScVal(1));
    const factory = new FactoryModule(cfg());

    await factory.streamAddress(1n);
    await factory.streamAddress(2n);

    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });

  it('accepts string and bigint streamId forms as the same cache key', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU32ScVal(1));
    const factory = new FactoryModule(cfg());

    await factory.streamAddress(5n);
    await factory.streamAddress('5');

    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it('caches a not-found (void) result only briefly, then re-resolves after clearAddressCache()', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate
      .mockResolvedValueOnce(makeVoidScVal())
      .mockResolvedValueOnce(makeU32ScVal(1));
    const factory = new FactoryModule(cfg());

    const first  = await factory.streamAddress(7n);
    // Within the short negative-cache TTL the null is served from cache — no
    // second RPC.
    const second = await factory.streamAddress(7n);
    // Dropping the cache forces a fresh resolution, which now finds the stream.
    factory.clearAddressCache();
    const third  = await factory.streamAddress(7n);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(third).not.toBeNull();
    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });

  it('clearAddressCache clears the cache and forces a network call on next resolution', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU32ScVal(1));
    const factory = new FactoryModule(cfg());

    await factory.streamAddress(1n);
    expect(mockSimulate).toHaveBeenCalledTimes(1);

    factory.clearAddressCache();

    mockSimulate.mockResolvedValueOnce(makeU32ScVal(1));
    await factory.streamAddress(1n);
    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });
});

describe('FactoryModule — hasStream() (#794)', () => {
  it('returns true when the stream address resolves', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU32ScVal(1)); // any non-void scval

    const exists = await new FactoryModule(cfg()).hasStream(42n);
    expect(exists).toBe(true);
  });

  it('returns false when the contract returns void (stream not found)', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeVoidScVal());

    const exists = await new FactoryModule(cfg()).hasStream(999n);
    expect(exists).toBe(false);
  });

  it('shares the streamAddress cache instead of re-hitting the network', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU32ScVal(1));
    const factory = new FactoryModule(cfg());

    const address = await factory.streamAddress(5n);
    const exists = await factory.hasStream('5');
    const missing = await factory.hasStream(999n);
    mockSimulate.mockResolvedValueOnce(makeVoidScVal());
    const missingResolved = await factory.hasStream(999n);

    expect(address).not.toBeNull();
    expect(exists).toBe(true);
    expect(missing).toBe(false);
    expect(missingResolved).toBe(false);
    // Only three network hits total: id 5 resolved once, id 999 resolved
    // twice (first miss cached negatively with a TTL, second miss explicit).
    expect(mockSimulate).toHaveBeenCalledTimes(3);
  });

  it('propagates an already-aborted signal as AbortError without hitting the network', async () => {
    const { FactoryModule } = await import('../factory.js');
    const factory = new FactoryModule(cfg());
    const controller = new AbortController();
    controller.abort();

    await expect(factory.hasStream(1n, controller.signal)).rejects.toThrow('AbortError');
    expect(mockSimulate).not.toHaveBeenCalled();
  });
});

describe('FactoryModule — cache consolidation with StreamsModule', () => {
  it('StreamsModule exposes clearAddressCache that delegates to factory', async () => {
    const { StreamsModule } = await import('../streams.js');
    const config = cfg();
    const streams = new StreamsModule(config);

    // Verify the method exists and can be called
    expect(() => streams.clearAddressCache()).not.toThrow();
  });
});

describe('FactoryModule — protocolFeeBps()', () => {
  it('returns fee as a number', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU32ScVal(30));

    const fee = await new FactoryModule(cfg()).protocolFeeBps();
    expect(fee).toBe(30);
    expect(typeof fee).toBe('number');
  });

  it('handles zero fee', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU32ScVal(0));

    const fee = await new FactoryModule(cfg()).protocolFeeBps();
    expect(fee).toBe(0);
  });

  it('throws a clear typed error instead of a bare XDR error when the response is not a u32', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU64ScVal(30n));

    await expect(new FactoryModule(cfg()).protocolFeeBps()).rejects.toThrow(
      /Expected a u32 ScVal, got "scvU64"/,
    );
  });
});

describe('FactoryModule — streamCountBySender() / streamCountByRecipient()', () => {
  it('streamCountBySender returns bigint from u64 scval', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU64ScVal(15n));

    const count = await new FactoryModule(cfg()).streamCountBySender(SENDER_ADDR);
    expect(count).toBe(15n);
  });

  it('streamCountByRecipient returns bigint from u64 scval', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU64ScVal(8n));

    const count = await new FactoryModule(cfg()).streamCountByRecipient(RECIPIENT_ADDR);
    expect(count).toBe(8n);
  });
});

describe('FactoryModule — streamsBySender() / streamsByRecipient()', () => {
  it('returns empty array and hasMore=false when no streams exist', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([]));

    const res = await new FactoryModule(cfg()).streamsBySender(SENDER_ADDR);
    expect(res).toEqual({ ids: [], hasMore: false });
  });

  it('returns bigint array of stream IDs and hasMore metadata', async () => {
    const { FactoryModule } = await import('../factory.js');

    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([
      _xdr.ScVal.scvU64(_xdr.Uint64.fromString('0')),
      _xdr.ScVal.scvU64(_xdr.Uint64.fromString('1')),
      _xdr.ScVal.scvU64(_xdr.Uint64.fromString('7')),
    ]));

    const res = await new FactoryModule(cfg()).streamsBySender(SENDER_ADDR);
    expect(res.ids).toEqual([0n, 1n, 7n]);
    expect(res.hasMore).toBe(false);
  });

  it('computes hasMore=true when returned items count equals clamped limit', async () => {
    const { FactoryModule } = await import('../factory.js');

    const items = Array.from({ length: 2 }, (_, i) =>
      _xdr.ScVal.scvU64(_xdr.Uint64.fromString(i.toString())),
    );
    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec(items));

    const res = await new FactoryModule(cfg()).streamsBySender(SENDER_ADDR, 0, 2);
    expect(res.ids).toEqual([0n, 1n]);
    expect(res.hasMore).toBe(true);
  });

  it('streamsByRecipient parses identically to streamsBySender', async () => {
    const { FactoryModule } = await import('../factory.js');

    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([
      _xdr.ScVal.scvU64(_xdr.Uint64.fromString('3')),
    ]));

    const res = await new FactoryModule(cfg()).streamsByRecipient(RECIPIENT_ADDR);
    expect(res.ids).toEqual([3n]);
    expect(res.hasMore).toBe(false);
  });

  it('clamps a limit above 100 to 100 before it reaches the contract call', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([]));

    await new FactoryModule(cfg()).streamsBySender(SENDER_ADDR, 0, 100_000);

    const args = mockBuildTx.mock.calls.at(-1)![5] as _xdr.ScVal[];
    expect(args[2]!.u32()).toBe(100);
  });

  it('replaces a non-positive limit with the default rather than a bad u32 conversion', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([]));

    await new FactoryModule(cfg()).streamsByRecipient(RECIPIENT_ADDR, 0, -5);

    const args = mockBuildTx.mock.calls.at(-1)![5] as _xdr.ScVal[];
    expect(args[2]!.u32()).toBe(20); // DEFAULT_LIST_LIMIT
  });

  it('leaves an in-range limit untouched', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([]));

    await new FactoryModule(cfg()).streamsBySender(SENDER_ADDR, 0, 50);

    const args = mockBuildTx.mock.calls.at(-1)![5] as _xdr.ScVal[];
    expect(args[2]!.u32()).toBe(50);
  });
});
