/**
 * Regression tests for issues #570 and #568.
 *
 * - #570 `FactoryModule` — the read-simulation source address is resolved
 *   from the configured `wallet` adapter (matching `StreamsModule`), not
 *   pinned to `keypair ?? ZERO_ADDR` at construction.
 * - #568 `FactoryModule.streamAddress` — a `null` (not-found) result is
 *   cached for a short TTL so a polled `list()` page does not re-issue a
 *   `stream_address` simulation for every missing id on every refresh.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConduitConfig } from '../types/index.js';
import type { WalletAdapter } from '../adapters/types.js';

// ── Hoisted mocks (same pattern as src/tests/factory.test.ts) ────────────────

const { mockBuildTx, mockSimulate } = vi.hoisted(() => ({
  mockBuildTx:  vi.fn().mockResolvedValue({ _stub: 'tx' }),
  mockSimulate: vi.fn(),
}));

vi.mock('../soroban.js', () => ({
  buildContractCallTx: mockBuildTx,
  simulateReadOnly:    mockSimulate,
  scValToU64: (v: { u64: () => { toString: () => string } }) => BigInt(v.u64().toString()),
  scValToU32: (v: { u32: () => number }) => v.u32(),
  scValToI128: () => 0n,
  NETWORK_PASSPHRASE: {
    testnet: 'Test SDF Network ; September 2015',
    mainnet: 'Public Global Stellar Network ; September 2015',
    local:   'Standalone Network ; February 2017',
  },
  DEFAULT_RPC: {
    testnet: 'https://soroban-testnet.stellar.org',
    mainnet: 'https://mainnet.sorobanrpc.com',
    local:   'http://localhost:8000/soroban/rpc',
  },
  DEFAULT_HORIZON: {
    testnet:  'https://horizon-testnet.stellar.org',
    mainnet:  'https://horizon.stellar.org',
    local:    'http://localhost:8000',
  },
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  class MockAddress {
    constructor(private readonly addr: string) {}
    toScVal() { return actual.xdr.ScVal.scvVoid(); }
    toString() { return this.addr; }
    static fromScVal() { return new MockAddress('CADDRESS'); }
    static fromString(s: string) { return new MockAddress(s); }
  }
  return { ...actual, Address: MockAddress };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const FACTORY_ADDR = 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM';
const WALLET_ADDR  = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const WALLET2_ADDR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function cfg(extra: Partial<ConduitConfig> = {}): ConduitConfig {
  return { network: 'testnet', factoryAddress: FACTORY_ADDR, rpcUrl: 'https://soroban-testnet.stellar.org', ...extra };
}

function stubWallet(pubkey: string): WalletAdapter & { getPublicKey: ReturnType<typeof vi.fn> } {
  return {
    getPublicKey: vi.fn().mockResolvedValue(pubkey),
    signTransaction: vi.fn((tx: unknown) => Promise.resolve(tx as never)),
  };
}

function u64ScVal(n: bigint) {
  return { switch: () => ({ name: 'scvU64' }), u64: () => ({ toString: () => n.toString() }) };
}
function voidScVal() {
  return { switch: () => ({ name: 'scvVoid' }) };
}

beforeEach(() => {
  mockBuildTx.mockReset().mockResolvedValue({ _stub: 'tx' });
  mockSimulate.mockReset();
});

// ── #570 ────────────────────────────────────────────────────────────────────

describe('#570 — FactoryModule resolves the caller from a configured wallet adapter', () => {
  it('uses the wallet public key as the read-simulation source, not ZERO_ADDR', async () => {
    const { FactoryModule } = await import('../factory.js');
    const wallet = stubWallet(WALLET_ADDR);
    mockSimulate.mockResolvedValueOnce(u64ScVal(0n));

    await new FactoryModule(cfg({ wallet })).streamCount();

    expect(wallet.getPublicKey).toHaveBeenCalled();
    expect(mockBuildTx.mock.calls[0]![2]).toBe(WALLET_ADDR);
  });

  it('re-resolves after setWallet()', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValue(u64ScVal(0n));

    const factory = new FactoryModule(cfg({ wallet: stubWallet(WALLET_ADDR) }));
    await factory.streamCount();
    factory.setWallet(stubWallet(WALLET2_ADDR));
    await factory.streamCount();

    expect(mockBuildTx.mock.calls[0]![2]).toBe(WALLET_ADDR);
    expect(mockBuildTx.mock.calls[1]![2]).toBe(WALLET2_ADDR);
  });

  it('falls back to ZERO_ADDR when nothing is configured (unchanged behaviour)', async () => {
    const { FactoryModule } = await import('../factory.js');
    const { ZERO_ADDR } = await import('../constants.js');
    mockSimulate.mockResolvedValueOnce(u64ScVal(0n));

    await new FactoryModule(cfg()).streamCount();

    expect(mockBuildTx.mock.calls[0]![2]).toBe(ZERO_ADDR);
  });
});

// ── #568 ────────────────────────────────────────────────────────────────────

describe('#568 — FactoryModule.streamAddress caches a not-found result', () => {
  it('does not re-hit the network for an id that resolved to null', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValue(voidScVal());

    const factory = new FactoryModule(cfg());
    expect(await factory.streamAddress(999n)).toBeNull();
    expect(await factory.streamAddress(999n)).toBeNull();

    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it('clearAddressCache() drops the negative entry so it is re-resolved', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValue(voidScVal());

    const factory = new FactoryModule(cfg());
    await factory.streamAddress(1n);
    factory.clearAddressCache();
    await factory.streamAddress(1n);

    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });

  it('still caches a resolved address for the module lifetime', async () => {
    const { FactoryModule } = await import('../factory.js');
    mockSimulate.mockResolvedValueOnce({ switch: () => ({ name: 'scvAddress' }) });

    const factory = new FactoryModule(cfg());
    const a = await factory.streamAddress(7n);
    const b = await factory.streamAddress(7n);

    expect(a).toBe('CADDRESS');
    expect(b).toBe('CADDRESS');
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });
});
