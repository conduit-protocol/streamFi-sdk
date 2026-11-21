import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import type { ConduitConfig, StreamConfig } from '../types/index.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const {
  mockStreamAddress,
  mockGetAccount,
  mockSimulate,
  mockSend,
  mockGetTransaction,
  mockAssemble,
  mockGetTokenDecimals,
} = vi.hoisted(() => ({
  mockStreamAddress:    vi.fn(),
  mockGetAccount:       vi.fn(),
  mockSimulate:         vi.fn(),
  mockSend:             vi.fn(),
  mockGetTransaction:   vi.fn(),
  // Pass-through "assembly": returns the real (unmocked TransactionBuilder-built)
  // transaction unchanged, so its XDR stays genuinely parseable. Batch-tx.ts
  // hands back real XDR strings that createBatchStreams reconstructs a real
  // Transaction from, so a fake, non-serialisable assembled object here would
  // break that round-trip -- unlike StreamsModule.create()'s own tests, which
  // never re-serialise the "assembled" object and so can get away with a stub.
  mockAssemble: vi.fn().mockImplementation((tx: unknown) => ({ build: () => tx })),
  mockGetTokenDecimals: vi.fn().mockResolvedValue(7),
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
    getTokenDecimals: mockGetTokenDecimals,
  };
});

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: class {
        getAccount          = mockGetAccount;
        simulateTransaction = mockSimulate;
        sendTransaction     = mockSend;
        getTransaction      = mockGetTransaction;
      },
      assembleTransaction: mockAssemble,
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const FACTORY_ADDR = StrKey.encodeContract(Buffer.alloc(32, 1));
const STREAM_ADDR  = StrKey.encodeContract(Buffer.alloc(32, 2));
const TOKEN        = StrKey.encodeContract(Buffer.alloc(32, 3));
const RECIPIENT    = Keypair.random().publicKey();

function makeConfig(overrides: Partial<ConduitConfig> = {}): ConduitConfig {
  return {
    network:        'testnet',
    factoryAddress: FACTORY_ADDR,
    keypair:        Keypair.random(),
    ...overrides,
  };
}

function makeStreamConfig(overrides: Partial<StreamConfig> = {}): StreamConfig {
  return {
    recipient:       RECIPIENT,
    token:           TOKEN,
    depositAmount:   '1000',
    durationSeconds: 3600,
    ...overrides,
  };
}

function u64Scv(n: bigint) {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(n.toString()));
}

function simSuccess(retval: xdr.ScVal) {
  return { result: { retval }, transactionData: {} };
}

function simError(message: string) {
  return { error: message };
}

function txSuccess(returnValue?: xdr.ScVal) {
  return returnValue === undefined
    ? { status: 'SUCCESS' }
    : { status: 'SUCCESS', returnValue };
}

/** Fake account whose sequenceNumber() reflects whatever getAccount() was last called to return. */
function fakeAccount(sequence: string) {
  return { accountId: () => 'ignored', sequenceNumber: () => sequence, incrementSequenceNumber: () => {} };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockStreamAddress.mockReset().mockResolvedValue(STREAM_ADDR);
  mockGetAccount.mockReset().mockResolvedValue(fakeAccount('100'));
  mockSimulate.mockReset();
  mockSend.mockReset().mockResolvedValue({ status: 'PENDING', hash: 'deadbeef' });
  mockGetTransaction.mockReset();
  mockAssemble.mockReset().mockImplementation((tx: unknown) => ({ build: () => tx }));
  mockGetTokenDecimals.mockReset().mockResolvedValue(7);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs `fn()` and drains however many sequential sleep(1000)s _sendAndPoll needs, one per settling transaction. */
async function runThroughPolls<T>(fn: () => Promise<T>, count = 1): Promise<T> {
  const promise = fn();
  promise.catch(() => {});
  for (let i = 0; i < count; i++) {
    await vi.advanceTimersByTimeAsync(1000);
  }
  return promise;
}

describe('StreamsModule.createBatchStreams()', () => {
  it('returns an empty array for an empty configs array without touching the network', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const results = await sdk.createBatchStreams([]);

    expect(results).toEqual([]);
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('throws when no signer/keypair/wallet is configured', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({ network: 'testnet', factoryAddress: FACTORY_ADDR });

    await expect(sdk.createBatchStreams([makeStreamConfig()])).rejects.toThrow(
      /keypair, wallet adapter, or signer/,
    );
  });

  it('creates a single stream and reports success with streamId/streamAddress/txHash', async () => {
    mockSimulate.mockResolvedValue(simSuccess(u64Scv(1n)));
    mockGetTransaction.mockResolvedValue(txSuccess(u64Scv(5n)));

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const results = await runThroughPolls(() => sdk.createBatchStreams([makeStreamConfig()]));

    expect(results).toEqual([
      { index: 0, success: true, streamId: 5n, streamAddress: STREAM_ADDR, txHash: 'deadbeef' },
    ]);
  });

  it('fetches the source account exactly once regardless of batch size (no per-chunk re-fetch)', async () => {
    mockSimulate.mockResolvedValue(simSuccess(u64Scv(1n)));
    mockGetTransaction.mockResolvedValue(txSuccess(u64Scv(1n)));

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const configs = Array.from({ length: 25 }, () => makeStreamConfig());
    await runThroughPolls(() => sdk.createBatchStreams(configs), 25);

    expect(mockGetAccount).toHaveBeenCalledTimes(1);
  });

  it('assigns strictly increasing sequence numbers across a multi-chunk batch (regression for #391)', async () => {
    // The bug this regression-tests: buildBatchContractCallTx-style chunking used
    // to call getAccount() once per chunk, so batches spanning more than one
    // chunk (MAX_BATCH_SIZE = 10) would hand out the SAME sequence number to
    // more than one transaction -- only the first submitted transaction of a
    // multi-chunk batch could ever succeed on-chain. buildBatchTransactions()
    // fetches the account once and increments a local counter per index
    // instead, so every operation gets a distinct sequence number even past 10.
    mockGetAccount.mockResolvedValue(fakeAccount('1000'));
    mockSimulate.mockResolvedValue(simSuccess(u64Scv(1n)));
    mockGetTransaction.mockResolvedValue(txSuccess(u64Scv(1n)));

    const seenXdrs: string[] = [];
    mockAssemble.mockImplementation((tx: { toXDR: () => string }) => ({
      build: () => {
        seenXdrs.push(tx.toXDR());
        return tx;
      },
    }));

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const configs = Array.from({ length: 15 }, () => makeStreamConfig());
    const results = await runThroughPolls(() => sdk.createBatchStreams(configs), 15);

    expect(mockGetAccount).toHaveBeenCalledTimes(1);
    expect(results.every(r => r.success)).toBe(true);

    // Decode each pre-assembled transaction's sequence number back out of its
    // XDR and confirm they are 15 distinct, strictly increasing values --
    // proving no two transactions in this 2-chunk batch collided on sequence.
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    const sequences = seenXdrs.map((xdrStr) => {
      const tx = TransactionBuilder.fromXDR(xdrStr, 'Test SDF Network ; September 2015');
      return BigInt((tx as unknown as { sequence: string }).sequence);
    });

    expect(new Set(sequences.map(String)).size).toBe(15);
    const sorted = [...sequences].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(sequences).toEqual(sorted);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1n);
    }
  });

  it('reports per-config validation failures independently without blocking valid configs', async () => {
    mockSimulate.mockResolvedValue(simSuccess(u64Scv(1n)));
    mockGetTransaction.mockResolvedValue(txSuccess(u64Scv(1n)));

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const configs = [
      makeStreamConfig(),
      makeStreamConfig({ recipient: '' }),
      makeStreamConfig(),
    ];
    const results = await runThroughPolls(() => sdk.createBatchStreams(configs), 2);

    expect(results[0]!.success).toBe(true);
    expect(results[1]).toEqual({
      index: 1,
      success: false,
      error: 'Invalid recipient address: must be a non-empty string',
    });
    expect(results[2]!.success).toBe(true);
    // Only the 2 valid configs should ever reach the network.
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
    expect(mockSimulate).toHaveBeenCalledTimes(2);
  });

  it('fails every config in the call when one on-chain simulation is rejected', async () => {
    // buildBatchTransactions() (already merged, unrelated to this change) uses
    // Promise.all across its simulation step, so one rejected simulation
    // rejects the whole call -- unlike the client-side validation above,
    // which isolates failures per config *before* anything is submitted, an
    // on-chain simulation failure for one config currently fails the rest of
    // that batch too. That's a real, existing property of the batch-building
    // primitive this method reuses, not something introduced here.
    mockSimulate
      .mockResolvedValueOnce(simSuccess(u64Scv(1n)))
      .mockResolvedValueOnce(simError('HostError: Error(Contract, #8)'))
      .mockResolvedValueOnce(simSuccess(u64Scv(1n)));
    mockGetTransaction.mockResolvedValue(txSuccess(u64Scv(1n)));

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const configs = [makeStreamConfig(), makeStreamConfig(), makeStreamConfig()];
    const results = await sdk.createBatchStreams(configs);

    expect(results.every(r => !r.success)).toBe(true);
    expect(results[1]!.error).toMatch(/Simulation failed for operation 1/);
  });

  it('throws when durationSeconds and ratePerSecond are both missing for a config', async () => {
    mockSimulate.mockResolvedValue(simSuccess(u64Scv(1n)));
    mockGetTransaction.mockResolvedValue(txSuccess(u64Scv(1n)));

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const config = makeStreamConfig();
    delete (config as Partial<StreamConfig>).durationSeconds;

    const results = await sdk.createBatchStreams([config]);
    expect(results).toEqual([
      { index: 0, success: false, error: 'Either durationSeconds or ratePerSecond must be provided' },
    ]);
  });

  it('queries token decimals per config and does not hardcode 7', async () => {
    mockGetTokenDecimals.mockResolvedValue(2);
    mockSimulate.mockResolvedValue(simSuccess(u64Scv(1n)));
    mockGetTransaction.mockResolvedValue(txSuccess(u64Scv(1n)));

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    await runThroughPolls(() => sdk.createBatchStreams([makeStreamConfig({ depositAmount: '10' })]));

    expect(mockGetTokenDecimals).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String), TOKEN,
    );
  });
});
