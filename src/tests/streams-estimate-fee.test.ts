import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import type { ConduitConfig } from '../types/index.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockSimulate, mockGetTokenDecimals } = vi.hoisted(() => ({
  mockSimulate:         vi.fn(),
  mockGetTokenDecimals: vi.fn().mockResolvedValue(7),
}));

vi.mock('../factory.js', () => ({
  // A plain class, not vi.fn().mockImplementation(() => ({...})) — Vitest 4's
  // spy wrapper no longer supports `new`-invoking an arrow-function
  // implementation and returning its object as the instance.
  FactoryModule: class {
    streamAddress = vi.fn();
  },
}));

vi.mock('../soroban.js', async () => {
  const actual = await vi.importActual<typeof import('../soroban.js')>('../soroban.js');
  return {
    ...actual,
    buildContractCallTx: vi.fn().mockResolvedValue({ _stub: 'tx' }),
    getTokenDecimals:    mockGetTokenDecimals,
    getTokenDecimalsCached: mockGetTokenDecimals,
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
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const FACTORY_ADDR = StrKey.encodeContract(Buffer.alloc(32, 1));
const TOKEN        = StrKey.encodeContract(Buffer.alloc(32, 3));
const SENDER       = Keypair.random().publicKey();
const RECIPIENT    = Keypair.random().publicKey();

function makeConfig(overrides: Partial<ConduitConfig> = {}): ConduitConfig {
  return {
    network:        'testnet',
    factoryAddress: FACTORY_ADDR,
    keypair:        Keypair.random(),
    ...overrides,
  };
}

/** Successful simulation carrying fee fields — no 'error' key, so isSimulationError is false. */
function simSuccessWithFee(minResourceFee: string, cpuInsns: number) {
  return { minResourceFee, cost: { cpuInsns, memBytes: 100 } };
}

beforeEach(() => {
  mockSimulate.mockReset();
  mockGetTokenDecimals.mockReset().mockResolvedValue(7);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StreamsModule.estimateFee() — bigint stroops convention', () => {
  it('returns every FeeEstimate field as bigint', async () => {
    mockSimulate.mockResolvedValue(simSuccessWithFee('250000', 1234567));

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const est = await sdk.estimateFee({
      type:           'create',
      sender:         SENDER,
      recipient:      RECIPIENT,
      token:          TOKEN,
      depositAmount:  '1000',
      durationSeconds: 3600,
      ratePerSecond:  '1',
    });

    expect(typeof est.totalFee).toBe('bigint');
    expect(typeof est.resourceFee).toBe('bigint');
    expect(typeof est.baseFee).toBe('bigint');
    expect(typeof est.instructions).toBe('bigint');

    // BASE_FEE is '100' stroops in @stellar/stellar-sdk.
    expect(est.resourceFee).toBe(250000n);
    expect(est.baseFee).toBe(100n);
    expect(est.totalFee).toBe(250100n);
    expect(est.instructions).toBe(1234567n);
  });

  it('preserves precision for resource fees beyond Number.MAX_SAFE_INTEGER', async () => {
    // 9_007_199_254_740_993 > Number.MAX_SAFE_INTEGER — a Number would round
    // it to 9_007_199_254_740_992, losing the exact stroops value.
    const large = '9007199254740993';
    mockSimulate.mockResolvedValue(simSuccessWithFee(large, 100));

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const est = await sdk.estimateFee({
      type:           'create',
      sender:         SENDER,
      recipient:      RECIPIENT,
      token:          TOKEN,
      depositAmount:  '1000',
      durationSeconds: 3600,
      ratePerSecond:  '1',
    });

    expect(est.resourceFee).toBe(9007199254740993n);
    expect(est.totalFee).toBe(9007199254740993n + 100n);
  });

  it('falls back to the SDK resource-fee estimate when the simulation lacks fee fields', async () => {
    // A successful simulation without minResourceFee/fee — the same shape
    // estimateRequiredFee() handles elsewhere with DEFAULT_RESOURCE_FEE_ESTIMATE.
    mockSimulate.mockResolvedValue({ result: {}, transactionData: {} });

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const est = await sdk.estimateFee({
      type:           'create',
      sender:         SENDER,
      recipient:      RECIPIENT,
      token:          TOKEN,
      depositAmount:  '1000',
      durationSeconds: 3600,
      ratePerSecond:  '1',
    });

    expect(est.resourceFee).toBe(1000000n); // DEFAULT_RESOURCE_FEE_ESTIMATE
    expect(est.baseFee).toBe(100n);
    expect(est.totalFee).toBe(1000100n);
  });
});
