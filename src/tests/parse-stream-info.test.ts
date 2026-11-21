/**
 * Unit tests for parseStreamInfo (exercised directly and via StreamsModule.get()).
 *
 * parseStreamInfo is exercised directly and driven through get() by controlling the
 * simulated ScVal map returned for the 'info' contract call.
 *
 * Regression coverage for #521 and contract schema verification for #595:
 * The on-chain Soroban contract (contracts/stream/src/storage.rs) stores
 * StreamInfo with flags packed into `flags: u32` rather than standalone
 * boolean fields. These tests verify the parser strictly adheres to the
 * contract schema and round-trips correctly without model drift.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Address, Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import type { StreamInfo } from '../types/index.js';

// ── Mocks ───────────────────────────────────────────────────────────────────

const { mockStreamAddress, mockSimulate } = vi.hoisted(() => ({
  mockStreamAddress: vi.fn(),
  mockSimulate:      vi.fn(),
}));

vi.mock('../factory.js', () => ({
  FactoryModule: class {
    streamAddress = mockStreamAddress;
  },
}));

vi.mock('../soroban.js', async () => {
  const actual = await vi.importActual<typeof import('../soroban.js')>('../soroban.js');
  return {
    ...actual,
    buildContractCallTx: vi.fn().mockResolvedValue({ _stub: 'tx' }),
    catchNetworkError:   <T>(_label: string, promise: Promise<T>) => promise,
  };
});

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: class {
        simulateTransaction = mockSimulate;
      },
      assembleTransaction: vi.fn(),
    },
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const FACTORY_ADDR = StrKey.encodeContract(Buffer.alloc(32, 1));
const STREAM_ADDR  = StrKey.encodeContract(Buffer.alloc(32, 2));
const TOKEN_ADDR   = StrKey.encodeContract(Buffer.alloc(32, 3));
const SENDER       = Keypair.random().publicKey();
const RECIPIENT    = Keypair.random().publicKey();

/** Build an xdr.ScVal scvMap from a plain object of key → ScVal. */
function scvMap(entries: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(entries).map(
      ([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v }),
    ),
  );
}

function u64Scv(n: bigint): xdr.ScVal {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(n.toString()));
}

function u32Scv(n: number): xdr.ScVal {
  return xdr.ScVal.scvU32(n);
}

// Bit-flags packed into the on-chain `StreamInfo::flags: u32`
// (contracts/stream/src/storage.rs). `paused` / `cancelled` /
// `clawbackEnabled` are NOT standalone struct fields — parseStreamInfo
// derives them by masking `flags`.
const FLAG_PAUSED           = 1;
const FLAG_CLAWBACK_ENABLED = 1 << 1;
const FLAG_CANCELLED        = 1 << 2;

function i128Scv(n: bigint): xdr.ScVal {
  const lo = n & 0xffffffffffffffffn;
  const hi = n >> 64n;
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString(hi.toString()),
      lo: xdr.Uint64.fromString(lo.toString()),
    }),
  );
}

function simSuccess(retval: xdr.ScVal) {
  return { result: { retval }, transactionData: {} };
}

/** Minimal valid stream map with all required fields. Extra fields can be spread in. */
function baseStreamMap(extra: Record<string, xdr.ScVal> = {}): xdr.ScVal {
  return scvMap({
    sender:           new Address(SENDER).toScVal(),
    recipient:        new Address(RECIPIENT).toScVal(),
    token:            new Address(TOKEN_ADDR).toScVal(),
    rate_per_second:  i128Scv(100n),
    start_time:       u64Scv(1_000_000n),
    end_time:         u64Scv(1_004_000n),
    withdrawn:        i128Scv(0n),
    flags:            u32Scv(0),
    paused_at:        u64Scv(0n),
    ...extra,
  });
}

beforeEach(() => {
  mockStreamAddress.mockReset().mockResolvedValue(STREAM_ADDR);
  mockSimulate.mockReset();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('parseStreamInfo — flags (#521)', () => {
  it('sets paused=false when the paused bit is clear', async () => {
    mockSimulate.mockResolvedValue(simSuccess(baseStreamMap({ flags: u32Scv(0) })));
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({ network: 'testnet', factoryAddress: FACTORY_ADDR, keypair: Keypair.random() });

    const info = await sdk.get(1n);
    expect(info.paused).toBe(false);
  });

  it('sets paused=true when the paused bit is set (#521)', async () => {
    const pausedAt = 1_002_000n;
    mockSimulate.mockResolvedValue(simSuccess(baseStreamMap({
      flags:     u32Scv(FLAG_PAUSED),
      paused_at: u64Scv(pausedAt),
    })));
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({ network: 'testnet', factoryAddress: FACTORY_ADDR, keypair: Keypair.random() });

    const info = await sdk.get(1n);
    expect(info.paused).toBe(true);
    expect(info.pausedAt).toBe(Number(pausedAt));
  });

  it('defaults paused=false when the flags key is absent from the map', async () => {
    const { flags: _omit, ...rest } = {
      sender:           new Address(SENDER).toScVal(),
      recipient:        new Address(RECIPIENT).toScVal(),
      token:            new Address(TOKEN_ADDR).toScVal(),
      rate_per_second:  i128Scv(100n),
      start_time:       u64Scv(1_000_000n),
      end_time:         u64Scv(1_004_000n),
      withdrawn:        i128Scv(0n),
      flags:            u32Scv(0), // will be omitted
      paused_at:        u64Scv(0n),
    };
    mockSimulate.mockResolvedValue(simSuccess(scvMap(rest)));
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({ network: 'testnet', factoryAddress: FACTORY_ADDR, keypair: Keypair.random() });

    const info = await sdk.get(1n);
    expect(info.paused).toBe(false);
  });

  it('sets cancelled=true when the cancelled bit is set', async () => {
    mockSimulate.mockResolvedValue(simSuccess(baseStreamMap({ flags: u32Scv(FLAG_CANCELLED) })));
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({ network: 'testnet', factoryAddress: FACTORY_ADDR, keypair: Keypair.random() });

    const info = await sdk.get(1n);
    expect(info.cancelled).toBe(true);
  });

  it('sets clawbackEnabled=true when the clawback bit is set', async () => {
    mockSimulate.mockResolvedValue(simSuccess(baseStreamMap({ flags: u32Scv(FLAG_CLAWBACK_ENABLED) })));
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({ network: 'testnet', factoryAddress: FACTORY_ADDR, keypair: Keypair.random() });

    const info = await sdk.get(1n);
    expect(info.clawbackEnabled).toBe(true);
  });

  it('derives multiple flags from a combined bitmask', async () => {
    mockSimulate.mockResolvedValue(simSuccess(baseStreamMap({ flags: u32Scv(FLAG_PAUSED | FLAG_CLAWBACK_ENABLED) })));
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({ network: 'testnet', factoryAddress: FACTORY_ADDR, keypair: Keypair.random() });

    const info = await sdk.get(1n);
    expect(info.paused).toBe(true);
    expect(info.clawbackEnabled).toBe(true);
    expect(info.cancelled).toBe(false);
  });
});

describe('parseStreamInfo — contract schema validation and flags: u32 round-trip (#595)', () => {
  interface ContractStreamParams {
    sender?: string;
    recipient?: string;
    token?: string;
    ratePerSecond?: bigint;
    startTime?: bigint;
    endTime?: bigint;
    withdrawn?: bigint;
    flags?: number;
    pausedAt?: bigint;
    keyType?: 'symbol' | 'string';
    extraFields?: Record<string, xdr.ScVal>;
  }

  function buildContractStreamInfoScVal(params: ContractStreamParams = {}): xdr.ScVal {
    const entries: Record<string, xdr.ScVal> = {
      sender: new Address(params.sender ?? SENDER).toScVal(),
      recipient: new Address(params.recipient ?? RECIPIENT).toScVal(),
      token: new Address(params.token ?? TOKEN_ADDR).toScVal(),
      rate_per_second: i128Scv(params.ratePerSecond ?? 100n),
      start_time: u64Scv(params.startTime ?? 1_000_000n),
      end_time: u64Scv(params.endTime ?? 1_004_000n),
      withdrawn: i128Scv(params.withdrawn ?? 0n),
      flags: u32Scv(params.flags ?? 0),
      paused_at: u64Scv(params.pausedAt ?? 0n),
      ...(params.extraFields ?? {}),
    };

    const keyFn = params.keyType === 'string'
      ? (k: string) => xdr.ScVal.scvString(k)
      : (k: string) => xdr.ScVal.scvSymbol(k);

    return xdr.ScVal.scvMap(
      Object.entries(entries).map(
        ([k, v]) => new xdr.ScMapEntry({ key: keyFn(k), val: v }),
      ),
    );
  }

  it('round-trips the canonical contract StreamInfo ScVal map through parseStreamInfo', async () => {
    const { parseStreamInfo } = await import('../streams.js');

    const canonicalMap = buildContractStreamInfoScVal({
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN_ADDR,
      ratePerSecond: 12_500_000n,
      startTime: 1_700_000_000n,
      endTime: 1_700_100_000n,
      withdrawn: 3_000_000n,
      flags: FLAG_CLAWBACK_ENABLED,
      pausedAt: 0n,
    });

    const info = parseStreamInfo(42n, STREAM_ADDR, canonicalMap);

    expect(info.id).toBe(42n);
    expect(info.address).toBe(STREAM_ADDR);
    expect(info.sender).toBe(SENDER);
    expect(info.recipient).toBe(RECIPIENT);
    expect(info.token).toBe(TOKEN_ADDR);
    expect(info.ratePerSecond).toBe(12_500_000n);
    expect(info.startTime).toBe(1_700_000_000);
    expect(info.endTime).toBe(1_700_100_000);
    expect(info.withdrawn).toBe(3_000_000n);
    expect(info.paused).toBe(false);
    expect(info.cancelled).toBe(false);
    expect(info.clawbackEnabled).toBe(true);
    expect(info.pausedAt).toBe(0);
  });

  it('prevents model drift: ignores standalone bool fields in favor of contract flags: u32', async () => {
    const { parseStreamInfo } = await import('../streams.js');

    // Standalone boolean keys present with true, but flags = 0
    const driftMap1 = buildContractStreamInfoScVal({
      flags: 0,
      extraFields: {
        paused: xdr.ScVal.scvBool(true),
        cancelled: xdr.ScVal.scvBool(true),
        clawback_enabled: xdr.ScVal.scvBool(true),
      },
    });

    const parsed1 = parseStreamInfo(1n, STREAM_ADDR, driftMap1);
    expect(parsed1.paused).toBe(false);
    expect(parsed1.cancelled).toBe(false);
    expect(parsed1.clawbackEnabled).toBe(false);

    // Standalone boolean keys present with false, but flags has bits set
    const driftMap2 = buildContractStreamInfoScVal({
      flags: FLAG_PAUSED | FLAG_CANCELLED | FLAG_CLAWBACK_ENABLED,
      extraFields: {
        paused: xdr.ScVal.scvBool(false),
        cancelled: xdr.ScVal.scvBool(false),
        clawback_enabled: xdr.ScVal.scvBool(false),
      },
    });

    const parsed2 = parseStreamInfo(1n, STREAM_ADDR, driftMap2);
    expect(parsed2.paused).toBe(true);
    expect(parsed2.cancelled).toBe(true);
    expect(parsed2.clawbackEnabled).toBe(true);
  });

  it('correctly decodes all permutations of contract flags: u32 bitmask', async () => {
    const { parseStreamInfo } = await import('../streams.js');

    const flagTestCases = [
      { flags: 0, paused: false, cancelled: false, clawbackEnabled: false },
      { flags: FLAG_PAUSED, paused: true, cancelled: false, clawbackEnabled: false },
      { flags: FLAG_CLAWBACK_ENABLED, paused: false, cancelled: false, clawbackEnabled: true },
      { flags: FLAG_CANCELLED, paused: false, cancelled: true, clawbackEnabled: false },
      { flags: FLAG_PAUSED | FLAG_CLAWBACK_ENABLED, paused: true, cancelled: false, clawbackEnabled: true },
      { flags: FLAG_PAUSED | FLAG_CANCELLED, paused: true, cancelled: true, clawbackEnabled: false },
      { flags: FLAG_CLAWBACK_ENABLED | FLAG_CANCELLED, paused: false, cancelled: true, clawbackEnabled: true },
      { flags: FLAG_PAUSED | FLAG_CLAWBACK_ENABLED | FLAG_CANCELLED, paused: true, cancelled: true, clawbackEnabled: true },
      // Unrelated higher-order bits do not flip known flags
      { flags: 1 << 5, paused: false, cancelled: false, clawbackEnabled: false },
      { flags: (1 << 5) | FLAG_PAUSED, paused: true, cancelled: false, clawbackEnabled: false },
    ];

    for (const { flags, paused, cancelled, clawbackEnabled } of flagTestCases) {
      const map = buildContractStreamInfoScVal({ flags });
      const parsed = parseStreamInfo(10n, STREAM_ADDR, map);
      expect(parsed.paused).toBe(paused);
      expect(parsed.cancelled).toBe(cancelled);
      expect(parsed.clawbackEnabled).toBe(clawbackEnabled);
    }
  });

  it('preserves 128-bit integer precision for rate_per_second and withdrawn from contract schema', async () => {
    const { parseStreamInfo } = await import('../streams.js');

    const largeRate = 18_446_744_073_709_551_615_000n;
    const largeWithdrawn = (1n << 127n) - 1n; // max signed i128
    const map = buildContractStreamInfoScVal({
      ratePerSecond: largeRate,
      withdrawn: largeWithdrawn,
    });

    const parsed = parseStreamInfo(1n, STREAM_ADDR, map);
    expect(parsed.ratePerSecond).toBe(largeRate);
    expect(parsed.withdrawn).toBe(largeWithdrawn);
  });

  it('supports contract ScVal maps with string keys identically to symbol keys', async () => {
    const { parseStreamInfo } = await import('../streams.js');

    const symMap = buildContractStreamInfoScVal({
      flags: FLAG_PAUSED | FLAG_CLAWBACK_ENABLED,
      keyType: 'symbol',
    });
    const strMap = buildContractStreamInfoScVal({
      flags: FLAG_PAUSED | FLAG_CLAWBACK_ENABLED,
      keyType: 'string',
    });

    const symInfo = parseStreamInfo(5n, STREAM_ADDR, symMap);
    const strInfo = parseStreamInfo(5n, STREAM_ADDR, strMap);

    expect(strInfo.paused).toBe(symInfo.paused);
    expect(strInfo.cancelled).toBe(symInfo.cancelled);
    expect(strInfo.clawbackEnabled).toBe(symInfo.clawbackEnabled);
    expect(strInfo.sender).toBe(symInfo.sender);
    expect(strInfo.token).toBe(symInfo.token);
  });

  it('serializes cleanly to JSON via .toJSON() without bigint errors', async () => {
    const { parseStreamInfo } = await import('../streams.js');

    const map = buildContractStreamInfoScVal({
      ratePerSecond: 100n,
      flags: FLAG_PAUSED,
    });
    const info = parseStreamInfo(1n, STREAM_ADDR, map) as StreamInfo & { toJSON(): Record<string, unknown> };

    const json = info.toJSON();
    expect(typeof json).toBe('object');
    expect(json.ratePerSecond).toBe('100');
    expect(json.paused).toBe(true);
    expect(json.cancelled).toBe(false);
  });

  it('round-trips contract StreamInfo end-to-end via StreamsModule.get()', async () => {
    const contractMap = buildContractStreamInfoScVal({
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN_ADDR,
      ratePerSecond: 50n,
      startTime: 1_600_000_000n,
      endTime: 1_600_500_000n,
      withdrawn: 10n,
      flags: FLAG_CANCELLED,
      pausedAt: 0n,
    });

    mockSimulate.mockResolvedValue(simSuccess(contractMap));
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({ network: 'testnet', factoryAddress: FACTORY_ADDR, keypair: Keypair.random() });

    const info = await sdk.get(100n);
    expect(info.id).toBe(100n);
    expect(info.address).toBe(STREAM_ADDR);
    expect(info.sender).toBe(SENDER);
    expect(info.recipient).toBe(RECIPIENT);
    expect(info.token).toBe(TOKEN_ADDR);
    expect(info.ratePerSecond).toBe(50n);
    expect(info.startTime).toBe(1_600_000_000);
    expect(info.endTime).toBe(1_600_500_000);
    expect(info.withdrawn).toBe(10n);
    expect(info.cancelled).toBe(true);
    expect(info.paused).toBe(false);
    expect(info.clawbackEnabled).toBe(false);
  });
});

describe('parseStreamInfo — malformed flags (#617)', () => {
  it('falls back to flags=0 when flags is a non-U32 ScVal (bool)', async () => {
    mockSimulate.mockResolvedValue(simSuccess(baseStreamMap({
      flags: xdr.ScVal.scvBool(true),
    })));
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({ network: 'testnet', factoryAddress: FACTORY_ADDR, keypair: Keypair.random() });

    const info = await sdk.get(1n);
    expect(info.paused).toBe(false);
    expect(info.cancelled).toBe(false);
    expect(info.clawbackEnabled).toBe(false);
  });

  it('falls back to flags=0 when flags is a non-U32 ScVal (string)', async () => {
    mockSimulate.mockResolvedValue(simSuccess(baseStreamMap({
      flags: xdr.ScVal.scvString('not-a-u32'),
    })));
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({ network: 'testnet', factoryAddress: FACTORY_ADDR, keypair: Keypair.random() });

    const info = await sdk.get(1n);
    expect(info.paused).toBe(false);
    expect(info.cancelled).toBe(false);
    expect(info.clawbackEnabled).toBe(false);
  });

  it('falls back to flags=0 when flags is a non-U32 ScVal (i128)', async () => {
    mockSimulate.mockResolvedValue(simSuccess(baseStreamMap({
      flags: i128Scv(42n),
    })));
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({ network: 'testnet', factoryAddress: FACTORY_ADDR, keypair: Keypair.random() });

    const info = await sdk.get(1n);
    expect(info.paused).toBe(false);
    expect(info.cancelled).toBe(false);
    expect(info.clawbackEnabled).toBe(false);
  });
});
