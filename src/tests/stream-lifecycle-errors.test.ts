import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import {
  AmountExceedsWithdrawableError,
  UnauthorizedStreamActionError,
  InvalidStreamStateError,
  ClawbackNotEnabledError,
} from '../errors.js';
import type { ConduitConfig } from '../types/index.js';

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
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const FACTORY_ADDR = StrKey.encodeContract(Buffer.alloc(32, 1));
const STREAM_ADDR  = StrKey.encodeContract(Buffer.alloc(32, 2));

function makeConfig(): ConduitConfig {
  return {
    network:        'testnet',
    factoryAddress: FACTORY_ADDR,
    keypair:        Keypair.random(),
  };
}

function i128Scv(n: bigint) {
  const lo = n & 0xffffffffffffffffn;
  const hi = n >> 64n;
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({ hi: xdr.Int64.fromString(hi.toString()), lo: xdr.Uint64.fromString(lo.toString()) }),
  );
}

function simSuccess(retval: xdr.ScVal) {
  return { result: { retval }, transactionData: {} };
}

function simError(code: number) {
  return { error: `HostError: Error(Contract, #${code})` };
}

beforeEach(() => {
  mockStreamAddress.mockReset().mockResolvedValue(STREAM_ADDR);
  mockSimulate.mockReset();
});

describe('withdraw() — AmountExceedsWithdrawableError (#717)', () => {
  it('throws with the actual withdrawable amount when the requested amount is too large', async () => {
    mockSimulate.mockResolvedValueOnce(simSuccess(i128Scv(100n))); // withdrawable() check

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const err = await sdk.withdraw(1n, 500n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmountExceedsWithdrawableError);
    expect((err as AmountExceedsWithdrawableError).available).toBe(100n);
  });

  it('does not throw when the requested amount is exactly the withdrawable balance', async () => {
    mockSimulate
      .mockResolvedValueOnce(simSuccess(i128Scv(100n))) // withdrawable() check
      .mockResolvedValueOnce(simError(1)); // the actual withdraw invoke — irrelevant here

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const err = await sdk.withdraw(1n, 100n).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(AmountExceedsWithdrawableError);
  });
});

describe('UnauthorizedStreamActionError (#716)', () => {
  it('cancel() throws UnauthorizedStreamActionError carrying the operation and caller', async () => {
    mockSimulate.mockResolvedValueOnce(simError(1)); // StreamErrorCode.NotAuthorized

    const config = makeConfig();
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(config);

    const err = await sdk.cancel(1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedStreamActionError);
    expect((err as UnauthorizedStreamActionError).operation).toBe('cancel');
    expect((err as UnauthorizedStreamActionError).caller).toBe(config.keypair!.publicKey());
  });

  it('pause() throws UnauthorizedStreamActionError', async () => {
    mockSimulate.mockResolvedValueOnce(simError(1));

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const err = await sdk.pause(1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedStreamActionError);
    expect((err as UnauthorizedStreamActionError).operation).toBe('pause');
  });

  it('transferRecipient() throws UnauthorizedStreamActionError', async () => {
    mockSimulate.mockResolvedValueOnce(simError(1));

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const err = await sdk
      .transferRecipient(1n, Keypair.random().publicKey())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedStreamActionError);
    expect((err as UnauthorizedStreamActionError).operation).toBe('transfer_recipient');
  });

  it('clawback() throws UnauthorizedStreamActionError', async () => {
    mockSimulate.mockResolvedValueOnce(simError(1));

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const err = await sdk.clawback(1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedStreamActionError);
    expect((err as UnauthorizedStreamActionError).operation).toBe('clawback');
  });
});

describe('InvalidStreamStateError (#714)', () => {
  it('resume() throws InvalidStreamStateError with currentState "active" when the stream is not paused', async () => {
    mockSimulate.mockResolvedValueOnce(simError(10)); // StreamErrorCode.NotPaused

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const err = await sdk.resume(1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidStreamStateError);
    expect((err as InvalidStreamStateError).operation).toBe('resume');
    expect((err as InvalidStreamStateError).currentState).toBe('active');
  });

  it('pause() throws InvalidStreamStateError with currentState "paused" when already paused', async () => {
    mockSimulate.mockResolvedValueOnce(simError(9)); // StreamErrorCode.AlreadyPaused

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const err = await sdk.pause(1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidStreamStateError);
    expect((err as InvalidStreamStateError).currentState).toBe('paused');
  });

  it('cancel() throws InvalidStreamStateError with currentState "cancelled"', async () => {
    mockSimulate.mockResolvedValueOnce(simError(3)); // StreamErrorCode.StreamCancelled

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const err = await sdk.cancel(1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidStreamStateError);
    expect((err as InvalidStreamStateError).currentState).toBe('cancelled');
  });

  it('forceCancel() throws InvalidStreamStateError with currentState "ended"', async () => {
    mockSimulate.mockResolvedValueOnce(simError(5)); // StreamErrorCode.StreamEnded

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const err = await sdk.forceCancel(1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidStreamStateError);
    expect((err as InvalidStreamStateError).operation).toBe('force_cancel');
    expect((err as InvalidStreamStateError).currentState).toBe('ended');
  });
});

describe('ClawbackNotEnabledError (#715)', () => {
  it('clawback() throws ClawbackNotEnabledError, not a generic ConduitError', async () => {
    mockSimulate.mockResolvedValueOnce(simError(11)); // StreamErrorCode.ClawbackDisabled

    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule(makeConfig());

    const err = await sdk.clawback(1n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClawbackNotEnabledError);
  });
});
