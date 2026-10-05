/**
 * Tests for #784 — `ConduitClient.setWallet()` wallet propagation.
 *
 * `ConduitClient.setWallet()`'s "Wallet propagation contract" doc block
 * claimed `FactoryModule` "does not hold a wallet reference and is
 * unaffected by setWallet()". It does hold one, and does implement
 * `setWallet()`, with async caller-address resolution. A dApp calling
 * `client.setWallet(newWallet)` therefore left `client.factory`'s simulated
 * caller address pinned to whatever it resolved before — the doc described
 * an intentional design that the module's own code contradicted.
 *
 * These tests describe behaviour that does not exist on `main` — on main
 * the factory's simulated source stays on the first wallet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConduitConfig } from '../types/index.js';
import type { WalletAdapter } from '../adapters/types.js';

// ── Hoisted mocks (same pattern as src/tests/bug-fixes-570-568.test.ts) ──────

const { mockBuildTx, mockSimulate } = vi.hoisted(() => ({
  mockBuildTx:  vi.fn(),
  mockSimulate: vi.fn(),
}));

vi.mock('../soroban.js', () => ({
  buildContractCallTx: mockBuildTx,
  simulateReadOnly:    mockSimulate,
  scValToU64: (v: { u64: () => { toString: () => string } }) => BigInt(v.u64().toString()),
  scValToU32: (v: { u32: () => number }) => v.u32(),
  scValToI128: () => 0n,
  resolveFee: () => '100',
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
  catchNetworkError: (label: string, fn: () => unknown) => fn(),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const FACTORY_ADDR = 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM';
const WALLET1_ADDR = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const WALLET2_ADDR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function cfg(extra: Partial<ConduitConfig> = {}): ConduitConfig {
  return { network: 'testnet', factoryAddress: FACTORY_ADDR, rpcUrl: 'https://soroban-testnet.stellar.org', ...extra };
}

function stubWallet(pubkey: string): WalletAdapter {
  return {
    getPublicKey:      vi.fn().mockResolvedValue(pubkey),
    signTransaction:  vi.fn((tx: unknown) => Promise.resolve(tx as never)),
  };
}

function u64ScVal(n: bigint) {
  return { switch: () => ({ name: 'scvU64' }), u64: () => ({ toString: () => n.toString() }) };
}

beforeEach(() => {
  mockBuildTx.mockReset().mockResolvedValue({ _stub: 'tx' });
  mockSimulate.mockReset().mockResolvedValue(u64ScVal(0n));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ConduitClient.setWallet() — factory propagation (#784)', () => {
  it('re-resolves the factory read-simulation source on an already-constructed factory', async () => {
    const { ConduitClient } = await import('../client.js');
    const client = new ConduitClient(cfg({ wallet: stubWallet(WALLET1_ADDR) }));

    // Force construction, then resolve once so the caller address is cached.
    await client.factory.streamCount();
    client.setWallet(stubWallet(WALLET2_ADDR));
    await client.factory.streamCount();

    expect(mockBuildTx.mock.calls[0]![2]).toBe(WALLET1_ADDR);
    expect(mockBuildTx.mock.calls[1]![2]).toBe(WALLET2_ADDR);
  });

  it('applies a wallet set before the factory is ever constructed', async () => {
    const { ConduitClient } = await import('../client.js');
    const client = new ConduitClient(cfg());

    client.setWallet(stubWallet(WALLET2_ADDR));
    // The lazily constructed factory must pick the new wallet up from
    // `config`, not from a stale construction-time snapshot.
    await client.factory.streamCount();

    expect(mockBuildTx.mock.calls[0]![2]).toBe(WALLET2_ADDR);
  });

  it('still propagates to StreamsModule', async () => {
    const { ConduitClient } = await import('../client.js');
    const client = new ConduitClient(cfg({ wallet: stubWallet(WALLET1_ADDR) }));
    const spy = vi.spyOn(client.streams, 'setWallet');

    client.setWallet(stubWallet(WALLET2_ADDR));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rejects a cross-network wallet before propagating to any module', async () => {
    const { ConduitClient } = await import('../client.js');
    const client = new ConduitClient(cfg());
    const before = mockBuildTx.mock.calls.length;
    const mainnetWallet: WalletAdapter = {
      getPublicKey:     vi.fn().mockResolvedValue(WALLET1_ADDR),
      signTransaction: vi.fn((tx: unknown) => Promise.resolve(tx as never)),
      chainId:         'stellar:mainnet',
    };

    expect(() => client.setWallet(mainnetWallet)).toThrow(/Unsupported network/);
    await client.factory.streamCount();

    // The rejected wallet never reached the factory: the source is still
    // the ZERO_ADDR fallback, and the client config is unchanged.
    const { ZERO_ADDR } = await import('../constants.js');
    expect(mockBuildTx.mock.calls.length).toBe(before + 1);
    expect(mockBuildTx.mock.calls[before]![2]).toBe(ZERO_ADDR);
  });
});
