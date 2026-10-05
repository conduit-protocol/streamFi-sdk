/**
 * Tests for #785 — `GovernorModule.getConfig()` TTL cache.
 *
 * `getConfig()` re-simulates the `config` contract call on every invocation
 * with no caching, unlike `FactoryModule`'s address cache or `soroban.ts`'s
 * token-decimals cache. Protocol parameters change rarely, so a dashboard
 * polling `getConfig()` on an interval pays a full simulation round trip
 * for data that is almost always unchanged.
 *
 * These tests describe behaviour that does not exist on `main` — they fail
 * there because every call re-simulates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Address, Keypair, StrKey, xdr as _xdr } from '@stellar/stellar-sdk';
import type { ConduitConfig } from '../types/index.js';

// ── Hoist mocks so they can be referenced inside vi.mock() factories ──────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

const GOVERNOR_ADDR = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
const FEE_RECIPIENT  = Keypair.random().publicKey();
const FACTORY_ADDR   = StrKey.encodeContract(Buffer.alloc(32, 9));

function cfg(extra: Partial<ConduitConfig> = {}): ConduitConfig {
  return {
    network:         'testnet',
    governorAddress: GOVERNOR_ADDR,
    rpcUrl:          'https://soroban-testnet.stellar.org',
    ...extra,
  };
}

function scvMap(entries: Record<string, _xdr.ScVal>): _xdr.ScVal {
  return _xdr.ScVal.scvMap(
    Object.entries(entries).map(([k, v]) =>
      new _xdr.ScMapEntry({ key: _xdr.ScVal.scvSymbol(k), val: v }),
    ),
  );
}

function u64(n: bigint) { return _xdr.ScVal.scvU64(_xdr.Uint64.fromString(n.toString())); }
function u32(n: number)  { return _xdr.ScVal.scvU32(n); }

function i128(n: bigint) {
  const lo = n & 0xffffffffffffffffn;
  const hi = n >> 64n;
  return _xdr.ScVal.scvI128(
    new _xdr.Int128Parts({
      hi:  _xdr.Int64.fromString(hi.toString()),
      lo:  _xdr.Uint64.fromString(lo.toString()),
    }),
  );
}

/** A full, representative protocol config response. */
function configScVal(feeBps = 30) {
  return scvMap({
    fee_bps:              u32(feeBps),
    fee_recipient:        new Address(FEE_RECIPIENT).toScVal(),
    min_duration_seconds: u64(3_600n),
    max_duration_seconds: u64(31_536_000n),
    max_rate_per_second:  i128(1_000_000_000_000_000n),
    factory_address:      new Address(FACTORY_ADDR).toScVal(),
  });
}

beforeEach(() => {
  mockBuildTx.mockReset().mockResolvedValue({ _stub: 'tx' });
  mockSimulate.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GovernorModule.getConfig() TTL cache (#785)', () => {
  it('serves repeated calls within the TTL from cache (one simulation total)', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate.mockResolvedValue(configScVal());

    const mod = new GovernorModule(cfg());
    const first  = await mod.getConfig();
    const second = await mod.getConfig();
    const third  = await mod.getConfig();

    expect(first.feeBps).toBe(30);
    expect(second.feeBps).toBe(30);
    expect(third.feeBps).toBe(30);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it('re-simulates once the TTL has expired and returns the new value', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate.mockResolvedValueOnce(configScVal(30)).mockResolvedValueOnce(configScVal(50));
    const mod = new GovernorModule(cfg({ governorConfigCacheTtlMs: 1_000 }));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const before = await mod.getConfig();
      expect(before.feeBps).toBe(30);

      // Still inside the TTL: the cached value wins even though the chain has
      // already moved on.
      vi.setSystemTime(500);
      expect((await mod.getConfig()).feeBps).toBe(30);
      expect(mockSimulate).toHaveBeenCalledTimes(1);

      // Past the TTL: a fresh simulation picks up the new parameter.
      vi.setSystemTime(1_500);
      expect((await mod.getConfig()).feeBps).toBe(50);
      expect(mockSimulate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours a custom governorConfigCacheTtlMs', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate.mockResolvedValue(configScVal());

    const mod = new GovernorModule(cfg({ governorConfigCacheTtlMs: 60_000 }));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      await mod.getConfig();
      vi.setSystemTime(59_000);
      await mod.getConfig();
      expect(mockSimulate).toHaveBeenCalledTimes(1);
      vi.setSystemTime(61_000);
      await mod.getConfig();
      expect(mockSimulate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-simulates on every call when the TTL is 0 (caching disabled)', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate.mockResolvedValue(configScVal());

    const mod = new GovernorModule(cfg({ governorConfigCacheTtlMs: 0 }));
    await mod.getConfig();
    await mod.getConfig();
    await mod.getConfig();

    expect(mockSimulate).toHaveBeenCalledTimes(3);
  });

  it('coalesces concurrent misses into a single simulation', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve(configScVal()), 10)),
    );

    const mod = new GovernorModule(cfg());
    const results = await Promise.all([mod.getConfig(), mod.getConfig(), mod.getConfig()]);

    for (const r of results) expect(r.feeBps).toBe(30);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed simulation, so the next call retries', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate
      .mockRejectedValueOnce(new Error('rpc unavailable'))
      .mockResolvedValue(configScVal());

    const mod = new GovernorModule(cfg());
    await expect(mod.getConfig()).rejects.toThrow('rpc unavailable');
    const retried = await mod.getConfig();

    expect(retried.feeBps).toBe(30);
    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });

  it('rejects every concurrent caller when the shared simulation fails', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate.mockImplementation(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('rpc unavailable')), 5)),
    );

    const mod = new GovernorModule(cfg());
    const results = await Promise.allSettled([mod.getConfig(), mod.getConfig()]);

    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it('clearConfigCache() forces the next call to re-simulate', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate.mockResolvedValue(configScVal());

    const mod = new GovernorModule(cfg());
    await mod.getConfig();
    mod.clearConfigCache();
    await mod.getConfig();

    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });

  it('hands each caller its own object, so mutating a result cannot corrupt the cache', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate.mockResolvedValue(configScVal());

    const mod = new GovernorModule(cfg());
    const first = await mod.getConfig();
    const second = await mod.getConfig();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);

    // A caller scribbling on a result must not change what the next caller
    // sees — otherwise one component's local edit silently rewrites the
    // protocol config for every other consumer in the process.
    first.feeBps = 999;
    first.minDurationSeconds = 1;

    const third = await mod.getConfig();
    expect(third.feeBps).toBe(30);
    expect(third.minDurationSeconds).toBe(3_600);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it('still throws the missing-governorAddress error before touching the network', async () => {
    const { GovernorModule } = await import('../governor.js');
    const mod = new GovernorModule({ network: 'testnet', rpcUrl: 'https://soroban-testnet.stellar.org' });

    await expect(mod.getConfig()).rejects.toThrow(/governorAddress is required/);
    expect(mockSimulate).not.toHaveBeenCalled();
  });

  it('rejects an already-aborted signal before consulting or populating the cache', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate.mockResolvedValue(configScVal());
    const mod = new GovernorModule(cfg());
    await mod.getConfig();

    const controller = new AbortController();
    controller.abort();
    await expect(mod.getConfig(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    // Still one simulation: the abort neither served a value nor poisoned
    // the cache with a rejected one.
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it('keeps caches separate per module instance', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate.mockResolvedValue(configScVal());

    await new GovernorModule(cfg()).getConfig();
    await new GovernorModule(cfg()).getConfig();

    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });
});
