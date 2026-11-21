import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZERO_ADDR } from '../constants.js';
import type { ConduitConfig } from '../types/index.js';
import type { WalletAdapter } from '../adapters/types.js';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockBuildTx, mockSimulate } = vi.hoisted(() => ({
  mockBuildTx:  vi.fn().mockResolvedValue({ _stub: 'tx' }),
  mockSimulate: vi.fn(),
}));

vi.mock('../soroban.js', async () => {
  const actual = await vi.importActual<typeof import('../soroban.js')>('../soroban.js');
  return {
    ...actual,
    buildContractCallTx: mockBuildTx,
    simulateReadOnly:    mockSimulate,
    scValToU64: (v: { u64: () => { toString: () => string } }) => BigInt(v.u64().toString()),
    scValToI128: () => 0n,
  };
});

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  class MockAddress {
    constructor(private readonly addr: string) {}
    toScVal() { return actual.xdr.ScVal.scvVoid(); }
    toString() { return this.addr; }
    static fromScVal() { return new MockAddress('CADDRESS'); }
    static fromString(s: string) { return new MockAddress(s); }
  }
  return {
    ...actual,
    Address: MockAddress,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: class {
        simulateTransaction = mockSimulate;
      },
    },
  };
});

const FACTORY_ADDR = 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM';
const REAL_PUBKEY   = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const REAL_PUBKEY_2 = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function cfg(extra: Partial<ConduitConfig> = {}): ConduitConfig {
  return {
    network: 'testnet',
    factoryAddress: FACTORY_ADDR,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    ...extra,
  };
}

describe('#562 — StreamsModule._resolveCallerAddress does not cache null / ZERO_ADDR', () => {
  beforeEach(() => {
    mockBuildTx.mockReset().mockResolvedValue({ _stub: 'tx' });
    mockSimulate.mockReset();
  });

  it('re-resolves on next call if previous attempt returned null (e.g. wallet locked)', async () => {
    const { StreamsModule } = await import('../streams.js');

    const getPublicKey = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(REAL_PUBKEY);

    const wallet: WalletAdapter = {
      getPublicKey,
      signTransaction: vi.fn(),
    };

    const streams = new StreamsModule(cfg({ wallet }));

    // 1st call: wallet locked/returns null -> fallback ZERO_ADDR, NOT cached
    const addr1 = await (streams as unknown as { _resolveCallerAddress(): Promise<string> })._resolveCallerAddress();
    expect(addr1).toBe(ZERO_ADDR);
    expect(getPublicKey).toHaveBeenCalledTimes(1);

    // 2nd call: wallet unlocked -> returns REAL_PUBKEY, IS cached
    const addr2 = await (streams as unknown as { _resolveCallerAddress(): Promise<string> })._resolveCallerAddress();
    expect(addr2).toBe(REAL_PUBKEY);
    expect(getPublicKey).toHaveBeenCalledTimes(2);

    // 3rd call: should use cached REAL_PUBKEY without calling getPublicKey again
    const addr3 = await (streams as unknown as { _resolveCallerAddress(): Promise<string> })._resolveCallerAddress();
    expect(addr3).toBe(REAL_PUBKEY);
    expect(getPublicKey).toHaveBeenCalledTimes(2);
  });

  it('does not cache ZERO_ADDR if getPublicKey explicitly returns ZERO_ADDR', async () => {
    const { StreamsModule } = await import('../streams.js');

    const getPublicKey = vi.fn()
      .mockResolvedValueOnce(ZERO_ADDR)
      .mockResolvedValueOnce(REAL_PUBKEY);

    const wallet: WalletAdapter = {
      getPublicKey,
      signTransaction: vi.fn(),
    };

    const streams = new StreamsModule(cfg({ wallet }));

    const addr1 = await (streams as unknown as { _resolveCallerAddress(): Promise<string> })._resolveCallerAddress();
    expect(addr1).toBe(ZERO_ADDR);
    expect(getPublicKey).toHaveBeenCalledTimes(1);

    const addr2 = await (streams as unknown as { _resolveCallerAddress(): Promise<string> })._resolveCallerAddress();
    expect(addr2).toBe(REAL_PUBKEY);
    expect(getPublicKey).toHaveBeenCalledTimes(2);
  });

  it('re-resolves on read simulation when wallet unlocks after first call', async () => {
    const { StreamsModule } = await import('../streams.js');

    const getPublicKey = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(REAL_PUBKEY);

    const wallet: WalletAdapter = {
      getPublicKey,
      signTransaction: vi.fn(),
    };

    const streams = new StreamsModule(cfg({ wallet }));
    vi.spyOn(streams as any, '_resolveAddr').mockResolvedValue('CSTREAM_CONTRACT');
    vi.spyOn(streams as any, '_simulateTx').mockResolvedValue({
      switch: () => ({ name: 'scvI128' }),
      i128: () => ({ lo: () => 0, hi: () => 0 }),
    } as any);

    // 1st read call when wallet is locked: uses ZERO_ADDR for simulation source
    await streams.withdrawable(1n);
    expect(mockBuildTx.mock.calls[0]![2]).toBe(ZERO_ADDR);

    // 2nd read call after wallet is unlocked: uses REAL_PUBKEY for simulation source
    await streams.withdrawable(1n);
    expect(mockBuildTx.mock.calls[1]![2]).toBe(REAL_PUBKEY);
  });
});

describe('#562 — FactoryModule._resolveCallerAddress does not cache null / ZERO_ADDR', () => {
  beforeEach(() => {
    mockBuildTx.mockReset().mockResolvedValue({ _stub: 'tx' });
    mockSimulate.mockReset();
  });

  it('re-resolves on next call if previous attempt returned null (e.g. wallet locked)', async () => {
    const { FactoryModule } = await import('../factory.js');

    const getPublicKey = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(REAL_PUBKEY_2);

    const wallet: WalletAdapter = {
      getPublicKey,
      signTransaction: vi.fn(),
    };

    const factory = new FactoryModule(cfg({ wallet }));

    // 1st call: wallet returns null -> returns ZERO_ADDR, NOT cached
    const addr1 = await (factory as unknown as { _resolveCallerAddress(): Promise<string> })._resolveCallerAddress();
    expect(addr1).toBe(ZERO_ADDR);
    expect(getPublicKey).toHaveBeenCalledTimes(1);

    // 2nd call: wallet returns REAL_PUBKEY_2 -> returns REAL_PUBKEY_2, IS cached
    const addr2 = await (factory as unknown as { _resolveCallerAddress(): Promise<string> })._resolveCallerAddress();
    expect(addr2).toBe(REAL_PUBKEY_2);
    expect(getPublicKey).toHaveBeenCalledTimes(2);

    // 3rd call: uses cached REAL_PUBKEY_2
    const addr3 = await (factory as unknown as { _resolveCallerAddress(): Promise<string> })._resolveCallerAddress();
    expect(addr3).toBe(REAL_PUBKEY_2);
    expect(getPublicKey).toHaveBeenCalledTimes(2);
  });
});
