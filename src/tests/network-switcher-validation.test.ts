/**
 * Regression tests for #157 — Network Switcher bypasses validation.
 *
 * Before this fix, three bypass paths existed:
 *
 * 1. `ConduitClient.setWallet()` accepted any wallet adapter at runtime with
 *    no network cross-check, so a WalletConnect wallet already connected to
 *    `stellar:pubnet` (mainnet) could silently be attached to a client
 *    configured for `testnet` — invalid payloads would then be sent to the
 *    wrong network's smart contracts.
 *
 * 2. `WalletConnectAdapter` accepted an arbitrary `chainId` string (CAIP-2
 *    format) at construction time with no validation.  Any unsupported or
 *    EVM chain ID was stored and later sent verbatim in RPC requests.
 *
 * 3. `FactoryModule` and `GovernorModule` could be constructed directly,
 *    bypassing the `UnsupportedChainError` guard that only lived inside
 *    `ConduitClient`.
 *
 * All three paths are now validated.  These tests document and lock in that
 * behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnsupportedChainError } from '../errors.js';
import { WalletConnectAdapter } from '../adapters/walletconnect.js';

// ── Mock soroban so FactoryModule / GovernorModule can be imported without
//    a real Stellar SDK network stack ─────────────────────────────────────────

vi.mock('../soroban.js', () => ({
  buildContractCallTx: vi.fn().mockResolvedValue({ _stub: 'tx' }),
  simulateReadOnly:    vi.fn(),
  createRpcServer: vi.fn(() => ({ getLatestLedger: vi.fn() })),
  registerRpcEndpointGroup: vi.fn((urls: string[]) => urls),
  resolveRpcEndpoint: (url: string) => url,
  resolveFee:  () => '100',
  scValToU64:  (v: { u64: () => { toString: () => string } }) => BigInt(v.u64().toString()),
  scValToI128: () => 0n,
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
  DEFAULT_HORIZON: {
    testnet:  'https://horizon-testnet.stellar.org',
    mainnet:  'https://horizon.stellar.org',
    local:    'http://localhost:8000',
  },
}));

// ── Mock Address so G-addresses pass StrKey validation in factory/governor ────

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  class MockAddress {
    constructor(private readonly addr: string) {}
    toScVal() { return actual.xdr.ScVal.scvVoid(); }
    toString() { return this.addr; }
    static fromScVal() { return new MockAddress(''); }
    static fromString(s: string) { return new MockAddress(s); }
  }
  return { ...actual, Address: MockAddress };
});

const FACTORY_ADDR = 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM';

// ── 1. ConduitClient constructor — existing guard, confirmed unbroken ─────────

describe('ConduitClient — constructor network validation', () => {
  beforeEach(() => vi.resetModules());

  it('throws UnsupportedChainError for a completely unknown network', async () => {
    const { ConduitClient } = await import('../client.js');
    expect(() => new ConduitClient({ network: 'ropsten' as never, factoryAddress: FACTORY_ADDR }))
      .toThrow(/Unsupported network/);
  });

  it('includes the bad network name in the error message', async () => {
    const { ConduitClient } = await import('../client.js');
    try {
      new ConduitClient({ network: 'ropsten' as never, factoryAddress: FACTORY_ADDR });
    } catch (err) {
      // `vi.resetModules()` in `beforeEach` gives `client.js` (and its
      // internal `errors.js` import) a fresh module instance per test, so
      // `err` is a structurally-identical but not `===`/instanceof-equal
      // UnsupportedChainError to the one imported statically above — assert
      // on `.name` instead of identity.
      expect((err as Error).name).toBe('UnsupportedChainError');
      expect((err as UnsupportedChainError).providedNetwork).toBe('ropsten');
      expect((err as UnsupportedChainError).supportedNetworks).toContain('testnet');
    }
  });

  it('accepts all three valid networks without throwing', async () => {
    const { ConduitClient } = await import('../client.js');
    for (const network of ['mainnet', 'testnet', 'local'] as const) {
      expect(() => new ConduitClient({ network, factoryAddress: FACTORY_ADDR })).not.toThrow();
    }
  });
});

// ── 2. ConduitClient.setWallet() — cross-chain wallet mismatch (was bypass) ──

describe('ConduitClient.setWallet() — network cross-validation (#157)', () => {
  beforeEach(() => vi.resetModules());

  it('rejects a WalletConnect wallet on mainnet when the client is configured for testnet', async () => {
    const { ConduitClient } = await import('../client.js');
    const client = new ConduitClient({ network: 'testnet', factoryAddress: FACTORY_ADDR });

    // WalletConnectAdapter exposes chainId on the instance, which is what
    // assertWalletNetworkMatch reads via the `chainId` property check.
    const mainnetWallet = new WalletConnectAdapter({ chainId: 'stellar:pubnet' });

    expect(() => client.setWallet(mainnetWallet)).toThrow(/Unsupported network/);
  });

  it('rejects a testnet wallet when the client is configured for mainnet', async () => {
    const { ConduitClient } = await import('../client.js');
    const client = new ConduitClient({ network: 'mainnet', factoryAddress: FACTORY_ADDR });
    const testnetWallet = new WalletConnectAdapter({ chainId: 'stellar:testnet' });
    expect(() => client.setWallet(testnetWallet)).toThrow(/Unsupported network/);
  });

  it('accepts a matching mainnet wallet on a mainnet client', async () => {
    const { ConduitClient } = await import('../client.js');
    const client = new ConduitClient({ network: 'mainnet', factoryAddress: FACTORY_ADDR });
    const mainnetWallet = new WalletConnectAdapter({ chainId: 'stellar:pubnet' });
    expect(() => client.setWallet(mainnetWallet)).not.toThrow();
  });

  it('accepts a matching testnet wallet on a testnet client', async () => {
    const { ConduitClient } = await import('../client.js');
    const client = new ConduitClient({ network: 'testnet', factoryAddress: FACTORY_ADDR });
    const testnetWallet = new WalletConnectAdapter({ chainId: 'stellar:testnet' });
    expect(() => client.setWallet(testnetWallet)).not.toThrow();
  });

  it('accepts a KeypairWalletAdapter (no chainId) on any network — chain-agnostic adapters are always allowed', async () => {
    const { ConduitClient } = await import('../client.js');
    const { KeypairWalletAdapter } = await import('../adapters/keypair.js');
    const { Keypair } = await import('@stellar/stellar-sdk');
    const client = new ConduitClient({ network: 'testnet', factoryAddress: FACTORY_ADDR });
    const keypairWallet = new KeypairWalletAdapter(Keypair.random());
    expect(() => client.setWallet(keypairWallet)).not.toThrow();
  });

  it('error message contains both the wallet chain and the expected network', async () => {
    const { ConduitClient } = await import('../client.js');
    const client = new ConduitClient({ network: 'testnet', factoryAddress: FACTORY_ADDR });
    const mainnetWallet = new WalletConnectAdapter({ chainId: 'stellar:pubnet' });
    try {
      client.setWallet(mainnetWallet);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).name).toBe('UnsupportedChainError');
      // The error message must mention the mismatch so it's actionable
      expect((err as UnsupportedChainError).message).toMatch(/mainnet/i);
      expect((err as UnsupportedChainError).message).toMatch(/testnet/i);
    }
  });
});

// ── 3. WalletConnectAdapter constructor — CAIP-2 chain validation (was bypass) ─

describe('WalletConnectAdapter constructor — chainId validation (#157)', () => {
  it('rejects an EVM chain ID (e.g. eip155:1 — Ethereum mainnet)', () => {
    expect(() => new WalletConnectAdapter({ chainId: 'eip155:1' })).toThrow(
      /unsupported chainId/i,
    );
  });

  it('rejects a completely unknown chain string', () => {
    expect(() => new WalletConnectAdapter({ chainId: 'stellar:unknown' })).toThrow(
      /unsupported chainId/i,
    );
  });

  it('rejects an empty string chain ID', () => {
    expect(() => new WalletConnectAdapter({ chainId: '' })).toThrow(/unsupported chainId/i);
  });

  it('rejects a numeric-style chain ID (EVM convention)', () => {
    expect(() => new WalletConnectAdapter({ chainId: '137' })).toThrow(/unsupported chainId/i);
  });

  it('accepts stellar:pubnet', () => {
    expect(() => new WalletConnectAdapter({ chainId: 'stellar:pubnet' })).not.toThrow();
  });

  it('accepts stellar:testnet', () => {
    expect(() => new WalletConnectAdapter({ chainId: 'stellar:testnet' })).not.toThrow();
  });

  it('accepts stellar:local', () => {
    expect(() => new WalletConnectAdapter({ chainId: 'stellar:local' })).not.toThrow();
  });

  it('defaults to stellar:pubnet when no chainId is provided', () => {
    // Should not throw; defaults are always valid
    expect(() => new WalletConnectAdapter()).not.toThrow();
  });

  it('error message lists the supported chains', () => {
    try {
      new WalletConnectAdapter({ chainId: 'eip155:1' });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/stellar:pubnet/);
      expect((err as Error).message).toMatch(/stellar:testnet/);
    }
  });
});

// ── 4. FactoryModule direct construction — network guard (was bypass) ─────────

describe('FactoryModule — direct construction network validation (#157)', () => {
  beforeEach(() => vi.resetModules());

  it('throws UnsupportedChainError when constructed directly with an invalid network', async () => {
    const { FactoryModule } = await import('../factory.js');
    expect(() => new FactoryModule({ network: 'ropsten' as never, factoryAddress: FACTORY_ADDR }))
      .toThrow(/Unsupported network/);
  });

  it('does not throw for valid networks when constructed directly', async () => {
    const { FactoryModule } = await import('../factory.js');
    for (const network of ['mainnet', 'testnet', 'local'] as const) {
      expect(() => new FactoryModule({ network, factoryAddress: FACTORY_ADDR })).not.toThrow();
    }
  });
});

// ── 5. GovernorModule direct construction — network guard (was bypass) ────────

describe('GovernorModule — direct construction network validation (#157)', () => {
  beforeEach(() => vi.resetModules());

  it('throws UnsupportedChainError when constructed directly with an invalid network', async () => {
    const { GovernorModule } = await import('../governor.js');
    expect(() => new GovernorModule({ network: 'ropsten' as never }))
      .toThrow(/Unsupported network/);
  });

  it('does not throw for valid networks when constructed directly', async () => {
    const { GovernorModule } = await import('../governor.js');
    for (const network of ['mainnet', 'testnet', 'local'] as const) {
      expect(() => new GovernorModule({ network })).not.toThrow();
    }
  });
});

// ── 6. ConduitClient constructor with wallet — chain pre-validation ───────────

describe('ConduitClient constructor — wallet chain pre-validation (#157)', () => {
  beforeEach(() => vi.resetModules());

  it('rejects a mainnet WalletConnect wallet when constructing a testnet client', async () => {
    const { ConduitClient } = await import('../client.js');
    const mainnetWallet = new WalletConnectAdapter({ chainId: 'stellar:pubnet' });
    expect(() => new ConduitClient({
      network: 'testnet',
      factoryAddress: FACTORY_ADDR,
      wallet: mainnetWallet,
    })).toThrow(/Unsupported network/);
  });

  it('accepts a matching wallet at construction time', async () => {
    const { ConduitClient } = await import('../client.js');
    const testnetWallet = new WalletConnectAdapter({ chainId: 'stellar:testnet' });
    expect(() => new ConduitClient({
      network: 'testnet',
      factoryAddress: FACTORY_ADDR,
      wallet: testnetWallet,
    })).not.toThrow();
  });
});
