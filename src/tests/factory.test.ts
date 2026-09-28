import { describe, it, expect, vi, beforeEach } from 'vitest';
import { xdr as _xdr } from '@stellar/stellar-sdk';
import type { ConduitConfig } from '../types/index.js';
import { Networks } from '@stellar/stellar-sdk';

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

// ── Mock Address so G-addresses and C-addresses are accepted without strkey validation ─────────

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');

  class MockAddress {
    constructor(private readonly addr: string) {}
    toScVal() { return actual.xdr.ScVal.scvVoid(); }
    toScAddress() {
      // Return a mock ScAddress - generate a deterministic dummy ID from the address string
      // so different addresses produce different predicted contract addresses
      const hash = actual.hash(Buffer.from(this.addr));
      const dummyContractId = hash.subarray(0, 32);
      if (this.addr.startsWith('C')) {
        return actual.xdr.ScAddress.scAddressTypeContract(dummyContractId);
      } else {
        const dummyAccountId = hash.subarray(0, 32);
        return actual.xdr.ScAddress.scAddressTypeAccount(
          actual.xdr.PublicKey.publicKeyTypeEd25519(dummyAccountId),
        );
      }
    }
    toString() { return this.addr; }
    static fromScVal(_v: unknown) { return new MockAddress(''); }
    static fromString(s: string)  { return new MockAddress(s); }
  }

  return { ...actual, Address: MockAddress };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const FACTORY_ADDR   = 'CD6OFYBVE56UP6SEX6U6V2URNXY6D5HTQJXXM6AQWTYYTFEKTJV33VOW';
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

describe('FactoryModule — factoryPaused()', () => {
  it('returns true when factory is paused', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvBool(true));

    const paused = await new FactoryModule(cfg()).factoryPaused();
    expect(paused).toBe(true);
  });

  it('returns false when factory is not paused', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvBool(false));

    const paused = await new FactoryModule(cfg()).factoryPaused();
    expect(paused).toBe(false);
  });

  it('throws a clear error when response is not a bool', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(makeU32ScVal(1));

    await expect(new FactoryModule(cfg()).factoryPaused()).rejects.toThrow(
      /Expected a bool ScVal, got "scvU32"/,
    );
  });
});

describe('predictStreamAddress', () => {
  const FACTORY_ADDR = 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM';
  const TESTNET_PASSPHRASE = Networks.TESTNET;

  it('computes a deterministic contract address from factory, salt, and network', async () => {
    const { predictStreamAddress } = await import('../factory.js');
    const salt = Buffer.alloc(32);
    salt.writeBigUInt64BE(42n);

    const addr1 = predictStreamAddress({
      factoryAddress: FACTORY_ADDR,
      salt,
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    const addr2 = predictStreamAddress({
      factoryAddress: FACTORY_ADDR,
      salt,
      networkPassphrase: TESTNET_PASSPHRASE,
    });

    expect(addr1).toBe(addr2);
    expect(addr1).toMatch(/^C[A-Z0-9]+$/);
    expect(addr1.length).toBe(56); // StrKey contract address length
  });

  it('produces different addresses for different salts', async () => {
    const { predictStreamAddress } = await import('../factory.js');
    const salt1 = Buffer.alloc(32);
    salt1.writeBigUInt64BE(1n);
    const salt2 = Buffer.alloc(32);
    salt2.writeBigUInt64BE(2n);

    const addr1 = predictStreamAddress({
      factoryAddress: FACTORY_ADDR,
      salt: salt1,
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    const addr2 = predictStreamAddress({
      factoryAddress: FACTORY_ADDR,
      salt: salt2,
      networkPassphrase: TESTNET_PASSPHRASE,
    });

    expect(addr1).not.toBe(addr2);
  });

  it('produces different addresses for different networks', async () => {
    const { predictStreamAddress } = await import('../factory.js');
    const salt = Buffer.alloc(32);
    salt.writeBigUInt64BE(42n);

    const addrTestnet = predictStreamAddress({
      factoryAddress: FACTORY_ADDR,
      salt,
      networkPassphrase: Networks.TESTNET,
    });
    const addrMainnet = predictStreamAddress({
      factoryAddress: FACTORY_ADDR,
      salt,
      networkPassphrase: Networks.PUBLIC,
    });

    expect(addrTestnet).not.toBe(addrMainnet);
  });

  it('produces different addresses for different factory addresses', async () => {
    const { predictStreamAddress } = await import('../factory.js');
    const salt = Buffer.alloc(32);
    salt.writeBigUInt64BE(42n);

    const FACTORY_ADDR2 = 'CD6OFYBVE56UP6SEX6U6V2URNXY6D5HTQJXXM6AQWTYYTFEKTJV33VOX'; // different last char

    const addr1 = predictStreamAddress({
      factoryAddress: FACTORY_ADDR,
      salt,
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    const addr2 = predictStreamAddress({
      factoryAddress: FACTORY_ADDR2,
      salt,
      networkPassphrase: TESTNET_PASSPHRASE,
    });

    expect(addr1).not.toBe(addr2);
  });

  it('accepts salt as hex string', async () => {
    const { predictStreamAddress } = await import('../factory.js');
    const salt = Buffer.alloc(32);
    salt.writeBigUInt64BE(42n);
    const saltHex = salt.toString('hex');

    const addr1 = predictStreamAddress({
      factoryAddress: FACTORY_ADDR,
      salt,
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    const addr2 = predictStreamAddress({
      factoryAddress: FACTORY_ADDR,
      salt: saltHex,
      networkPassphrase: TESTNET_PASSPHRASE,
    });

    expect(addr1).toBe(addr2);
  });

  it('accepts salt as Uint8Array', async () => {
    const { predictStreamAddress } = await import('../factory.js');
    const salt = Buffer.alloc(32);
    salt.writeBigUInt64BE(42n);
    const saltUint8 = new Uint8Array(salt);

    const addr1 = predictStreamAddress({
      factoryAddress: FACTORY_ADDR,
      salt,
      networkPassphrase: TESTNET_PASSPHRASE,
    });
    const addr2 = predictStreamAddress({
      factoryAddress: FACTORY_ADDR,
      salt: saltUint8,
      networkPassphrase: TESTNET_PASSPHRASE,
    });

    expect(addr1).toBe(addr2);
  });

  it('throws when salt is not 32 bytes', async () => {
    const { predictStreamAddress } = await import('../factory.js');
    const shortSalt = Buffer.alloc(16);

    expect(() =>
      predictStreamAddress({
        factoryAddress: FACTORY_ADDR,
        salt: shortSalt,
        networkPassphrase: TESTNET_PASSPHRASE,
      }),
    ).toThrow(/Salt must be 32 bytes/);
  });
});

describe('streamIdToSalt', () => {
  it('converts a stream ID to a 32-byte salt', async () => {
    const { streamIdToSalt } = await import('../factory.js');
    const salt = streamIdToSalt(42n);

    expect(salt).toBeInstanceOf(Buffer);
    expect(salt.length).toBe(32);
    // Last 8 bytes should encode 42
    expect(salt.readBigUInt64BE(24)).toBe(42n);
  });

  it('works with number input', async () => {
    const { streamIdToSalt } = await import('../factory.js');
    const salt = streamIdToSalt(100);

    expect(salt.length).toBe(32);
    expect(salt.readBigUInt64BE(24)).toBe(100n);
  });

  it('produces different salts for different IDs', async () => {
    const { streamIdToSalt } = await import('../factory.js');
    const salt1 = streamIdToSalt(1n);
    const salt2 = streamIdToSalt(2n);

    expect(salt1).not.toEqual(salt2);
  });

  it('handles zero', async () => {
    const { streamIdToSalt } = await import('../factory.js');
    const salt = streamIdToSalt(0n);

    expect(salt.length).toBe(32);
    expect(salt.readBigUInt64BE(24)).toBe(0n);
  });

  it('handles large u64 values', async () => {
    const { streamIdToSalt } = await import('../factory.js');
    const maxU64 = 18446744073709551615n; // 2^64 - 1
    const salt = streamIdToSalt(maxU64);

    expect(salt.length).toBe(32);
    expect(salt.readBigUInt64BE(24)).toBe(maxU64);
  });
});
