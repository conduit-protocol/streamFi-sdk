import { describe, it, expect, vi } from 'vitest';
import type { ConduitConfig } from '../types/index.js';

// ── Mock Soroban RPC ──────────────────────────────────────────────────────────

const mockSimulate = vi.fn();
const mockGetAccount = vi.fn().mockResolvedValue({
  accountId: () => 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  sequenceNumber: () => '1',
  incrementSequenceNumber: vi.fn(),
});

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');

  const MockServer = vi.fn().mockImplementation(() => ({
    getAccount:          mockGetAccount,
    simulateTransaction: mockSimulate,
  }));

  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: MockServer,
      Api:    actual.SorobanRpc.Api,
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function cfg(): ConduitConfig {
  return {
    network:        'testnet',
    factoryAddress: 'CFACTORY000000000000000000000000000000000000000000000000',
    rpcUrl:         'https://soroban-testnet.stellar.org',
  };
}

function makeU64ScVal(n: bigint) {
  const { xdr } = require('@stellar/stellar-sdk');
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(n.toString()));
}

function makeU32ScVal(n: number) {
  const { xdr } = require('@stellar/stellar-sdk');
  return xdr.ScVal.scvU32(n);
}

function makeVoidScVal() {
  const { xdr } = require('@stellar/stellar-sdk');
  return xdr.ScVal.scvVoid();
}

function makeVecScVal(items: unknown[]) {
  const { xdr } = require('@stellar/stellar-sdk');
  return xdr.ScVal.scvVec(items);
}

function mockSimSuccess(retval: unknown) {
  mockSimulate.mockResolvedValue({
    result: { retval },
    error:  undefined,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FactoryModule — streamCount()', () => {
  it('returns bigint parsed from u64 scval', async () => {
    const { FactoryModule } = await import('../factory.js');
    const factory = new FactoryModule(cfg());
    const retval  = makeU64ScVal(42n);
    mockSimSuccess(retval);

    const count = await factory.streamCount();
    expect(count).toBe(42n);
  });

  it('returns 0n when contract has no streams', async () => {
    const { FactoryModule } = await import('../factory.js');
    const factory = new FactoryModule(cfg());
    mockSimSuccess(makeU64ScVal(0n));

    const count = await factory.streamCount();
    expect(count).toBe(0n);
  });
});

describe('FactoryModule — streamAddress()', () => {
  it('returns null when contract returns void (stream not found)', async () => {
    const { FactoryModule } = await import('../factory.js');
    const factory = new FactoryModule(cfg());
    mockSimSuccess(makeVoidScVal());

    const addr = await factory.streamAddress(999n);
    expect(addr).toBeNull();
  });
});

describe('FactoryModule — protocolFeeBps()', () => {
  it('returns fee as a number', async () => {
    const { FactoryModule } = await import('../factory.js');
    const factory = new FactoryModule(cfg());
    mockSimSuccess(makeU32ScVal(30));

    const fee = await factory.protocolFeeBps();
    expect(fee).toBe(30);
    expect(typeof fee).toBe('number');
  });

  it('handles zero fee', async () => {
    const { FactoryModule } = await import('../factory.js');
    const factory = new FactoryModule(cfg());
    mockSimSuccess(makeU32ScVal(0));

    const fee = await factory.protocolFeeBps();
    expect(fee).toBe(0);
  });
});

describe('FactoryModule — streamsBySender() / streamsByRecipient()', () => {
  it('returns empty array when no streams exist', async () => {
    const { FactoryModule } = await import('../factory.js');
    const factory = new FactoryModule(cfg());
    const { xdr } = await import('@stellar/stellar-sdk');
    mockSimSuccess(xdr.ScVal.scvVec([]));

    const ids = await factory.streamsBySender('GSENDER000000000000000000000000000000000000000000000000000');
    expect(ids).toEqual([]);
  });

  it('returns bigint array of stream IDs', async () => {
    const { FactoryModule } = await import('../factory.js');
    const factory = new FactoryModule(cfg());
    const { xdr } = await import('@stellar/stellar-sdk');

    const vec = xdr.ScVal.scvVec([
      xdr.ScVal.scvU64(xdr.Uint64.fromString('0')),
      xdr.ScVal.scvU64(xdr.Uint64.fromString('1')),
      xdr.ScVal.scvU64(xdr.Uint64.fromString('7')),
    ]);
    mockSimSuccess(vec);

    const ids = await factory.streamsBySender('GSENDER000000000000000000000000000000000000000000000000000');
    expect(ids).toEqual([0n, 1n, 7n]);
  });

  it('streamsByRecipient parses identically to streamsBySender', async () => {
    const { FactoryModule } = await import('../factory.js');
    const factory = new FactoryModule(cfg());
    const { xdr } = await import('@stellar/stellar-sdk');

    const vec = xdr.ScVal.scvVec([
      xdr.ScVal.scvU64(xdr.Uint64.fromString('3')),
    ]);
    mockSimSuccess(vec);

    const ids = await factory.streamsByRecipient('GRECIPIENT00000000000000000000000000000000000000000000000');
    expect(ids).toEqual([3n]);
  });
});
