import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import { ConduitError } from '../errors.js';
import type { ConduitConfig } from '../types/index.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  mockStreamAddress,
  mockSimulate,
  mockSend,
  mockGetTransaction,
  mockAssemble,
  mockSign,
  mockGetTokenDecimals,
} = vi.hoisted(() => ({
  mockStreamAddress:    vi.fn(),
  mockSimulate:         vi.fn(),
  mockSend:             vi.fn(),
  mockGetTransaction:   vi.fn(),
  mockAssemble:         vi.fn(),
  mockSign:             vi.fn(),
  mockGetTokenDecimals: vi.fn().mockResolvedValue(7),
}));

vi.mock('../factory.js', () => ({
  // A plain class, not vi.fn().mockImplementation(() => ({...})) — Vitest 4's
  // spy wrapper no longer supports `new`-invoking an arrow-function
  // implementation and returning its object as the instance.
  FactoryModule: class {
    streamAddress = mockStreamAddress;
  },
}));

vi.mock('../soroban.js', async () => {
  const actual = await vi.importActual<typeof import('../soroban.js')>('../soroban.js');
  return {
    ...actual,
    buildContractCallTx: vi.fn().mockResolvedValue({ _stub: 'tx' }),
    getTokenDecimals:    mockGetTokenDecimals,
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
        sendTransaction     = mockSend;
        getTransaction      = mockGetTransaction;
      },
      assembleTransaction: mockAssemble,
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const FACTORY_ADDR  = StrKey.encodeContract(Buffer.alloc(32, 1));
const STREAM_ADDR   = StrKey.encodeContract(Buffer.alloc(32, 2));
const TOKEN         = StrKey.encodeContract(Buffer.alloc(32, 3));
const RECIPIENT     = Keypair.random().publicKey();

function makeConfig(): ConduitConfig {
  return {
    network:        'testnet',
    factoryAddress: FACTORY_ADDR,
    keypair:        Keypair.random(),
  };
}

function u64Scv(n: bigint) {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(n.toString()));
}

function i128Scv(n: bigint) {
  const lo = n & 0xffffffffffffffffn;
  const hi = n >> 64n;
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({ hi: xdr.Int64.fromString(hi.toString()), lo: xdr.Uint64.fromString(lo.toString()) }),
  );
}

/** Simulation success — has no 'error' key, only what isSimulationError checks for. */
function simSuccess(retval: xdr.ScVal) {
  return { result: { retval }, transactionData: {} };
}

function simError(message: string) {
  return { error: message };
}

/** getTransaction success — matches GetTransactionStatus.SUCCESS. */
function txSuccess(returnValue?: xdr.ScVal) {
  return returnValue === undefined
    ? { status: 'SUCCESS' }
    : { status: 'SUCCESS', returnValue };
}

function txFailed() {
  return { status: 'FAILED' };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockStreamAddress.mockReset();
  mockSimulate.mockReset();
  mockSend.mockReset().mockResolvedValue({ status: 'PENDING', hash: 'deadbeef' });
  mockGetTransaction.mockReset();
  mockAssemble.mockReset().mockReturnValue({ build: () => ({ sign: mockSign }) });
  mockSign.mockReset();
  mockGetTokenDecimals.mockReset().mockResolvedValue(7);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs `fn()` and drains the sleep(1000) inside _sendAndPoll's first iteration. */
async function runThroughFirstPoll<T>(fn: () => Promise<T>): Promise<T> {
  const promise = fn();
  // Prevents a spurious "unhandled rejection" warning for the brief window
  // before the caller's own await/expect(...).rejects attaches its handler —
  // does not swallow the rejection for the caller, which still gets `promise`.
  promise.catch(() => {});
  await vi.advanceTimersByTimeAsync(1000);
  return promise;
}

describe('StreamsModule.create() — success path', () => {
  it('reads stream_id from the confirmed transaction, not the simulation', async () => {
    mockSimulate.mockResolvedValue(simSuccess(u64Scv(999n))); // decoy — must be ignored
    mockGetTransaction.mockResolvedValue(txSuccess(u64Scv(5n))); // the real assigned ID
    mockStreamAddress.mockResolvedValue(STREAM_ADDR);

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const result = await runThroughFirstPoll(() => sdk.create({
      recipient:       RECIPIENT,
      token:           TOKEN,
      depositAmount:   '1000',
      durationSeconds: 3600,
    }));

    expect(result.streamId).toBe(5n);
    expect(result.streamAddress).toBe(STREAM_ADDR);
    expect(result.txHash).toBe('deadbeef');
  });

  it('queries the token decimals and does not hardcode 7', async () => {
    mockGetTokenDecimals.mockResolvedValue(2); // e.g. a 2-decimal token
    mockSimulate.mockResolvedValue(simSuccess(u64Scv(1n)));
    mockGetTransaction.mockResolvedValue(txSuccess(u64Scv(1n)));
    mockStreamAddress.mockResolvedValue(STREAM_ADDR);

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    await runThroughFirstPoll(() => sdk.create({
      recipient:       RECIPIENT,
      token:           TOKEN,
      depositAmount:   '10',
      durationSeconds: 3600,
    }));

    expect(mockGetTokenDecimals).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String), TOKEN,
    );
  });

  it('throws a ConduitError scoped to "factory" on simulation failure', async () => {
    mockSimulate.mockResolvedValue(simError('HostError: Error(Contract, #8)')); // RateExceedsMax

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const err = await sdk.create({
      recipient:       RECIPIENT,
      token:           TOKEN,
      depositAmount:   '1000',
      durationSeconds: 3600,
    }).catch(e => e);

    expect(err).toBeInstanceOf(ConduitError);
    expect((err as ConduitError).contract).toBe('factory');
    expect((err as ConduitError).code).toBe(8);
  });

  it('throws if the confirmed transaction returned no value', async () => {
    mockSimulate.mockResolvedValue(simSuccess(u64Scv(1n)));
    mockGetTransaction.mockResolvedValue(txSuccess()); // SUCCESS but no returnValue

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    await expect(runThroughFirstPoll(() => sdk.create({
      recipient:       RECIPIENT,
      token:           TOKEN,
      depositAmount:   '1000',
      durationSeconds: 3600,
    }))).rejects.toThrow(/returned no value/);
  });
});

describe('StreamsModule.clawback() — success path', () => {
  it('reads the reclaimed amount from the confirmed transaction, not the simulation', async () => {
    mockStreamAddress.mockResolvedValue(STREAM_ADDR);
    mockSimulate.mockResolvedValue(simSuccess(i128Scv(999_999n))); // decoy
    mockGetTransaction.mockResolvedValue(txSuccess(i128Scv(42_000n))); // the real amount

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const amount = await runThroughFirstPoll(() => sdk.clawback(1n));
    expect(amount).toBe(42_000n);
  });

  it('throws a ConduitError scoped to "stream" on simulation failure', async () => {
    mockStreamAddress.mockResolvedValue(STREAM_ADDR);
    mockSimulate.mockResolvedValue(simError('HostError: Error(Contract, #11)')); // ClawbackDisabled

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const err = await sdk.clawback(1n).catch(e => e);
    expect(err).toBeInstanceOf(ConduitError);
    expect((err as ConduitError).contract).toBe('stream');
    expect((err as ConduitError).code).toBe(11);
  });
});

describe('StreamsModule — withdraw/cancel/pause/resume/topUp success paths', () => {
  beforeEach(() => {
    mockStreamAddress.mockResolvedValue(STREAM_ADDR);
    mockSimulate.mockResolvedValue(simSuccess(xdr.ScVal.scvVoid()));
    mockGetTransaction.mockResolvedValue(txSuccess());
  });

  it('withdraw() returns the confirmed transaction hash', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());
    const hash = await runThroughFirstPoll(() => sdk.withdraw(1n, 100n));
    expect(hash).toBe('deadbeef');
  });

  it('cancel() returns the confirmed transaction hash', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());
    const hash = await runThroughFirstPoll(() => sdk.cancel(1n));
    expect(hash).toBe('deadbeef');
  });

  it('pause() returns the confirmed transaction hash', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());
    const hash = await runThroughFirstPoll(() => sdk.pause(1n));
    expect(hash).toBe('deadbeef');
  });

  it('resume() returns the confirmed transaction hash', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());
    const hash = await runThroughFirstPoll(() => sdk.resume(1n));
    expect(hash).toBe('deadbeef');
  });

  it('topUp() returns the confirmed transaction hash', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());
    const hash = await runThroughFirstPoll(() => sdk.topUp(1n, 500n));
    expect(hash).toBe('deadbeef');
  });

  it('throws when the send is rejected', async () => {
    mockSend.mockResolvedValue({ status: 'ERROR', errorResult: 'boom' });
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());
    await expect(sdk.pause(1n)).rejects.toThrow(/rejected/);
  });

  it('throws when the transaction fails on-chain', async () => {
    mockGetTransaction.mockResolvedValue(txFailed());
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());
    await expect(runThroughFirstPoll(() => sdk.pause(1n))).rejects.toThrow(/failed/);
  });
});
