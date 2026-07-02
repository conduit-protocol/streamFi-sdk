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
  scValToU64: (v: { u64: () => { toString: () => string } }) =>
    BigInt(v.u64().toString()),
  scValToI128: (_v: unknown) => 0n,
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
});

describe('FactoryModule — streamsBySender() / streamsByRecipient()', () => {
  it('returns empty array when no streams exist', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([]));

    const ids = await new FactoryModule(cfg()).streamsBySender(SENDER_ADDR);
    expect(ids).toEqual([]);
  });

  it('returns bigint array of stream IDs', async () => {
    const { FactoryModule } = await import('../factory.js');

    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([
      _xdr.ScVal.scvU64(_xdr.Uint64.fromString('0')),
      _xdr.ScVal.scvU64(_xdr.Uint64.fromString('1')),
      _xdr.ScVal.scvU64(_xdr.Uint64.fromString('7')),
    ]));

    const ids = await new FactoryModule(cfg()).streamsBySender(SENDER_ADDR);
    expect(ids).toEqual([0n, 1n, 7n]);
  });

  it('streamsByRecipient parses identically to streamsBySender', async () => {
    const { FactoryModule } = await import('../factory.js');

    mockSimulate.mockResolvedValueOnce(_xdr.ScVal.scvVec([
      _xdr.ScVal.scvU64(_xdr.Uint64.fromString('3')),
    ]));

    const ids = await new FactoryModule(cfg()).streamsByRecipient(RECIPIENT_ADDR);
    expect(ids).toEqual([3n]);
  });
});
