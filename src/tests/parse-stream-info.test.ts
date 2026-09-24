/**
 * Unit tests for parseStreamInfo (exercised via StreamsModule.get()).
 *
 * parseStreamInfo is private; we drive it through get() by controlling the
 * simulated ScVal map returned for the 'info' contract call.
 *
 * Regression coverage for #521: stream.paused must be true when the contract
 * returns scvBool(true) for the 'paused' key — not silently collapsed to false
 * by a missing key-presence guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Address, Keypair, StrKey, xdr } from '@stellar/stellar-sdk';

// ── Mocks ─────────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────────────

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
    mockSimulate.mockResolvedValue(simSuccess(baseStreamMap({
      flags: u32Scv(FLAG_PAUSED | FLAG_CLAWBACK_ENABLED),
    })));
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({ network: 'testnet', factoryAddress: FACTORY_ADDR, keypair: Keypair.random() });

    const info = await sdk.get(1n);
    expect(info.paused).toBe(true);
    expect(info.clawbackEnabled).toBe(true);
    expect(info.cancelled).toBe(false);
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

