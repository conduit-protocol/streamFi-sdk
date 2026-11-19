/**
 * #1098 — decodeDiagnosticEvents; #1099 — submitSignedTransaction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Account,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  SorobanRpc,
} from '@stellar/stellar-sdk';
import { ConfirmationTimeoutError } from '../errors.js';

const { mockSendTransaction, mockGetTransaction } = vi.hoisted(() => ({
  mockSendTransaction: vi.fn(),
  mockGetTransaction: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...(actual as any).SorobanRpc,
      Server: vi.fn().mockImplementation(function MockServer() {
        return { sendTransaction: mockSendTransaction, getTransaction: mockGetTransaction };
      }),
      Api: (actual as any).SorobanRpc.Api,
    },
  };
});

import { decodeDiagnosticEvents, submitSignedTransaction, clearServerCache } from '../soroban.js';

type SimResponse = SorobanRpc.Api.SimulateTransactionResponse;

/** Duck-typed DiagnosticEvent around real ScVals (only the accessors the decoder calls). */
function diagnosticEvent(
  topics: xdr.ScVal[],
  data: xdr.ScVal,
  opts: { contractId?: Buffer | null; ok?: boolean } = {},
): xdr.DiagnosticEvent {
  return {
    inSuccessfulContractCall: () => opts.ok ?? false,
    event: () => ({
      contractId: () => opts.contractId ?? null,
      body: () => ({ v0: () => ({ topics: () => topics, data: () => data }) }),
    }),
  } as unknown as xdr.DiagnosticEvent;
}

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });

describe('decodeDiagnosticEvents (#1098)', () => {
  it('puts the simulation error first, then one readable line per event', () => {
    const response = {
      id: '1',
      latestLedger: 100,
      error: 'HostError: Error(Contract, #10)',
      events: [
        diagnosticEvent([sym('fn_call'), sym('transfer')], nativeToScVal(500n, { type: 'i128' }), { ok: true }),
        diagnosticEvent([sym('error')], nativeToScVal('insufficient allowance')),
      ],
    } as unknown as SimResponse;

    expect(decodeDiagnosticEvents(response)).toEqual([
      'error: HostError: Error(Contract, #10)',
      'host: [fn_call, transfer] "500"',
      'host (in failed call): [error] insufficient allowance',
    ]);
  });

  it('names the emitting contract by its C... address', () => {
    const contractId = Buffer.alloc(32, 7);
    const response = {
      id: '1',
      latestLedger: 1,
      transactionData: {},
      events: [diagnosticEvent([sym('log')], nativeToScVal('hi'), { contractId, ok: true })],
    } as unknown as SimResponse;

    const [line] = decodeDiagnosticEvents(response);
    expect(line).toBe(`${StrKey.encodeContract(contractId)}: [log] hi`);
  });

  it('marks undecodable raw events instead of throwing', () => {
    const response = { id: '1', latestLedger: 1, error: 'boom', events: ['not-valid-xdr'] } as unknown as SimResponse;
    expect(decodeDiagnosticEvents(response)).toEqual(['error: boom', '<undecodable diagnostic event>']);
  });

  it('returns an empty list for a successful simulation with no events', () => {
    const response = { id: '1', latestLedger: 1, transactionData: {}, events: [] } as unknown as SimResponse;
    expect(decodeDiagnosticEvents(response)).toEqual([]);
  });
});

describe('submitSignedTransaction (#1099)', () => {
  const RPC = 'http://localhost:8000/submit-signed';
  const keypair = Keypair.random();

  function buildTx(sign: boolean): string {
    const tx = new TransactionBuilder(new Account(keypair.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(30)
      .build();
    if (sign) tx.sign(keypair);
    return tx.toXDR();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    clearServerCache();
    mockSendTransaction.mockReset();
    mockGetTransaction.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('submits a pre-signed envelope unchanged and tracks it to success', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'h1' });
    mockGetTransaction
      .mockResolvedValueOnce({ status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND })
      .mockResolvedValueOnce({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS });
    const statuses: string[] = [];
    const signedXdr = buildTx(true);

    const promise = submitSignedTransaction(RPC, Networks.TESTNET, signedXdr, {
      pollIntervalMs: 10,
      onStatus: (status) => statuses.push(status),
    });
    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toMatchObject({ hash: 'h1', status: 'success' });
    expect(statuses).toEqual(['submitted', 'success']);
    expect(mockSendTransaction.mock.calls[0]![0].toXDR()).toBe(signedXdr);
  });

  it('resolves `failed` instead of throwing so the caller keeps the hash', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'DUPLICATE', hash: 'h2' });
    mockGetTransaction.mockResolvedValue({ status: SorobanRpc.Api.GetTransactionStatus.FAILED });

    const promise = submitSignedTransaction(RPC, Networks.TESTNET, buildTx(true), { pollIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).resolves.toEqual({ hash: 'h2', status: 'failed' });
  });

  it('resolves `pending` on timeout, or throws ConfirmationTimeoutError when strict', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'h3' });
    mockGetTransaction.mockResolvedValue({ status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND });

    const lenient = submitSignedTransaction(RPC, Networks.TESTNET, buildTx(true), {
      pollIntervalMs: 10,
      maxAttempts: 2,
    });
    await vi.advanceTimersByTimeAsync(20);
    await expect(lenient).resolves.toEqual({ hash: 'h3', status: 'pending' });

    const strict = submitSignedTransaction(RPC, Networks.TESTNET, buildTx(true), {
      pollIntervalMs: 10,
      maxAttempts: 2,
      strict: true,
    });
    strict.catch(() => {});
    await vi.advanceTimersByTimeAsync(20);
    await expect(strict).rejects.toBeInstanceOf(ConfirmationTimeoutError);
  });

  it('throws when the network rejects the transaction', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'ERROR', hash: 'h4', errorResult: { code: 'txBadSeq' } });

    await expect(submitSignedTransaction(RPC, Networks.TESTNET, buildTx(true))).rejects.toThrow(
      'Transaction rejected',
    );
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });

  it('refuses an unsigned envelope or invalid XDR without calling the RPC', async () => {
    await expect(submitSignedTransaction(RPC, Networks.TESTNET, buildTx(false))).rejects.toThrow(
      'no signatures',
    );
    await expect(submitSignedTransaction(RPC, Networks.TESTNET, 'garbage')).rejects.toThrow(
      'Invalid signed transaction XDR',
    );
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });
});
