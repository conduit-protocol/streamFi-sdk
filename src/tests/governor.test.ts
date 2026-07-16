import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Address, Keypair, StrKey, xdr as _xdr } from '@stellar/stellar-sdk';
import type { ConduitConfig } from '../types/index.js';

// ── Hoist mocks so they can be referenced inside vi.mock() factories ──────────

const { mockBuildTx, mockSimulate } = vi.hoisted(() => ({
  mockBuildTx:  vi.fn().mockResolvedValue({ _stub: 'tx' }),
  mockSimulate: vi.fn(),
}));

vi.mock('../soroban.js', () => ({
  buildContractCallTx: mockBuildTx,
  simulateReadOnly:    mockSimulate,
  scValToU64: (v: { u64: () => { toString: () => string } }) =>
    BigInt(v.u64().toString()),
  scValToI128: (v: { i128: () => { hi: () => { toString: () => string }; lo: () => { toString: () => string } } }) => {
    const i128 = v.i128();
    return (BigInt(i128.hi().toString()) << 64n) | BigInt(i128.lo().toString());
  },
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
}));

// Real Address is used (not mocked) so fee_recipient and factory_address —
// two different address fields on the same GovernorConfig — decode to their
// actual distinct values rather than both resolving to whatever a mock
// hardcodes.

// ── Helpers ───────────────────────────────────────────────────────────────────

const GOVERNOR_ADDR = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
const FEE_RECIPIENT  = Keypair.random().publicKey();
const FACTORY_ADDR   = StrKey.encodeContract(Buffer.alloc(32, 9));

function cfg(withGovernorAddress = true): ConduitConfig {
  const base: ConduitConfig = {
    network: 'testnet',
    rpcUrl:  'https://soroban-testnet.stellar.org',
  };
  if (withGovernorAddress) {
    base.governorAddress = GOVERNOR_ADDR;
  }
  return base;
}

function scvMap(entries: Record<string, _xdr.ScVal>): _xdr.ScVal {
  return _xdr.ScVal.scvMap(
    Object.entries(entries).map(([k, v]) =>
      new _xdr.ScMapEntry({ key: _xdr.ScVal.scvSymbol(k), val: v }),
    ),
  );
}

function u64(n: bigint) {
  return _xdr.ScVal.scvU64(_xdr.Uint64.fromString(n.toString()));
}

function u32(n: number) {
  return _xdr.ScVal.scvU32(n);
}

function i128(n: bigint) {
  const lo = n & 0xffffffffffffffffn;
  const hi = n >> 64n;
  return _xdr.ScVal.scvI128(
    new _xdr.Int128Parts({
      hi: _xdr.Int64.fromString(hi.toString()),
      lo: _xdr.Uint64.fromString(lo.toString()),
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockBuildTx.mockResolvedValue({ _stub: 'tx' });
  mockSimulate.mockReset();
});

describe('GovernorModule — construction', () => {
  it('does not throw when governorAddress is missing (lazy check)', async () => {
    const { GovernorModule } = await import('../governor.js');
    expect(() => new GovernorModule(cfg(false))).not.toThrow();
  });

  it('getConfig() throws a clear error when governorAddress was never set', async () => {
    const { GovernorModule } = await import('../governor.js');
    const mod = new GovernorModule(cfg(false));
    await expect(mod.getConfig()).rejects.toThrow(/governorAddress is required/);
  });
});

describe('GovernorModule — getConfig()', () => {
  it('parses fee_bps, min_duration_seconds, and max_rate_per_second', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate.mockResolvedValueOnce(scvMap({
      fee_bps:              u32(30),
      fee_recipient:        new Address(FEE_RECIPIENT).toScVal(),
      min_duration_seconds: u64(3_600n),
      max_rate_per_second:  i128(1_000_000_000_000_000n),
      factory_address:      new Address(FACTORY_ADDR).toScVal(),
    }));

    const config = await new GovernorModule(cfg()).getConfig();
    expect(config.feeBps).toBe(30);
    expect(config.minDurationSeconds).toBe(3_600);
    expect(config.maxRatePerSecond).toBe(1_000_000_000_000_000n);
  });

  it('parses fee_recipient and factory_address as their own distinct addresses', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate.mockResolvedValueOnce(scvMap({
      fee_recipient:   new Address(FEE_RECIPIENT).toScVal(),
      factory_address: new Address(FACTORY_ADDR).toScVal(),
    }));

    const config = await new GovernorModule(cfg()).getConfig();
    expect(config.feeRecipient).toBe(FEE_RECIPIENT);
    expect(config.factoryAddress).toBe(FACTORY_ADDR);
    expect(config.feeRecipient).not.toBe(config.factoryAddress);
  });

  it('defaults missing fields to falsy/zero values rather than throwing', async () => {
    const { GovernorModule } = await import('../governor.js');
    mockSimulate.mockResolvedValueOnce(scvMap({}));

    const config = await new GovernorModule(cfg()).getConfig();
    expect(config.feeBps).toBe(0);
    expect(config.minDurationSeconds).toBe(0);
    expect(config.maxRatePerSecond).toBe(0n);
    expect(config.feeRecipient).toBe('');
    expect(config.factoryAddress).toBe('');
  });
});
