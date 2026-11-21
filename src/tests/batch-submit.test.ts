/**
 * Tests for submitBatch() — regression coverage for #518.
 *
 * The bug: buildBatchTransactions pre-assigns sequential sequence numbers with
 * no gap recovery. If any submission in the batch fails, every subsequent
 * transaction carries a gap-below-it sequence and will be rejected with
 * txBAD_SEQ. submitBatch makes this explicit: it submits one transaction at a
 * time, waits for confirmation, and marks everything after the first failure
 * as SKIPPED rather than submitting doomed transactions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SorobanRpc } from '@stellar/stellar-sdk';

const { mockSendTransaction, mockGetTransaction } = vi.hoisted(() => ({
  mockSendTransaction: vi.fn(),
  mockGetTransaction:  vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...actual,
    // submitBatch wraps each stub XDR in `new Transaction(xdr, passphrase)`
    // before handing it to the mocked server; the fixtures use placeholder
    // strings ("XDR_0", ...) that the real parser would reject, so stub the
    // constructor to a transparent carrier.
    Transaction: vi.fn().mockImplementation(function MockTransaction(xdr: string) {
      return { _xdr: xdr, toXDR: () => xdr };
    }),
    SorobanRpc: {
      ...(actual as any).SorobanRpc,
      Server: vi.fn().mockImplementation(function MockServer() {
        return {
          sendTransaction: mockSendTransaction,
          getTransaction:  mockGetTransaction,
        };
      }),
      Api: (actual as any).SorobanRpc.Api,
    },
  };
});

import {
  submitBatch,
  BatchBuildError,
  type BuiltBatchTransaction,
  type BatchSubmitOptions,
} from '../batch-tx.js';
import { clearServerCache } from '../soroban.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const RPC_URL = 'http://localhost:8000/soroban/rpc';

/** Minimal BuiltBatchTransaction fixture (prepared=true). */
function makeTx(index: number, method = 'op'): BuiltBatchTransaction {
  return { index, method, xdr: `XDR_${index}`, prepared: true };
}

const STATUS_FAILED = { status: SorobanRpc.Api.GetTransactionStatus.FAILED };

// sendTransaction returns the hash suffixed by index so tests can distinguish
// which poll response belongs to which tx.
function sendOk(index: number) {
  return { status: 'PENDING', hash: `HASH_${index}` };
}
function statusOk() {
  return { status: SorobanRpc.Api.GetTransactionStatus.SUCCESS };
}

const OPTS: BatchSubmitOptions = {
  pollIntervalMs:  0,   // no real waiting in tests
  maxPollAttempts: 3,
  networkPassphrase: 'Test SDF Network ; September 2015',
};

beforeEach(() => {
  clearServerCache();
  mockSendTransaction.mockReset();
  mockGetTransaction.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('submitBatch — argument validation', () => {
  it('throws BatchBuildError when rpcUrl is empty', async () => {
    await expect(submitBatch([makeTx(0)], '')).rejects.toThrow(BatchBuildError);
    await expect(submitBatch([makeTx(0)], '')).rejects.toThrow('rpcUrl');
  });

  it('throws BatchBuildError when transactions is not an array', async () => {
    await expect(submitBatch(null as any, RPC_URL)).rejects.toThrow(BatchBuildError);
  });

  it('returns allSucceeded=true and empty outcomes for an empty array', async () => {
    const result = await submitBatch([], RPC_URL, OPTS);
    expect(result.allSucceeded).toBe(true);
    expect(result.firstFailureIndex).toBe(-1);
    expect(result.outcomes).toEqual([]);
  });
});

describe('submitBatch — successful batch', () => {
  it('submits all transactions in order and reports SUCCESS for each', async () => {
    mockSendTransaction
      .mockResolvedValueOnce(sendOk(0))
      .mockResolvedValueOnce(sendOk(1))
      .mockResolvedValueOnce(sendOk(2));
    mockGetTransaction.mockResolvedValue(statusOk());

    const txs = [makeTx(0), makeTx(1), makeTx(2)];
    const result = await submitBatch(txs, RPC_URL, OPTS);

    expect(result.allSucceeded).toBe(true);
    expect(result.firstFailureIndex).toBe(-1);
    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes.map(o => o.status)).toEqual(['SUCCESS', 'SUCCESS', 'SUCCESS']);
    expect(result.outcomes[0]!.txHash).toBe('HASH_0');
    expect(result.outcomes[1]!.txHash).toBe('HASH_1');
    expect(result.outcomes[2]!.txHash).toBe('HASH_2');
  });

  it('calls sendTransaction once per transaction, in order', async () => {
    mockSendTransaction
      .mockResolvedValueOnce(sendOk(0))
      .mockResolvedValueOnce(sendOk(1));
    mockGetTransaction.mockResolvedValue(statusOk());

    await submitBatch([makeTx(0, 'withdraw'), makeTx(1, 'cancel')], RPC_URL, OPTS);

    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });

  it('confirms each transaction before submitting the next (#518)', async () => {
    const submitOrder: number[] = [];
    const confirmOrder: number[] = [];
    let submitCount = 0;

    mockSendTransaction.mockImplementation(async () => {
      submitOrder.push(submitCount++);
      return sendOk(submitOrder.length - 1);
    });
    mockGetTransaction.mockImplementation(async () => {
      confirmOrder.push(confirmOrder.length);
      return statusOk();
    });

    await submitBatch([makeTx(0), makeTx(1), makeTx(2)], RPC_URL, OPTS);

    // Interleaved order must be: submit-0, confirm-0, submit-1, confirm-1, ...
    // If submissions were concurrent, multiple sendTransaction calls would fire
    // before any getTransaction calls, breaking the sequential guarantee.
    expect(mockSendTransaction).toHaveBeenCalledTimes(3);
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
  });
});

describe('submitBatch — stop on failure (#518 core regression)', () => {
  it('marks all transactions after a FAILED one as SKIPPED', async () => {
    // tx 0 succeeds, tx 1 fails at submission, tx 2 and 3 must be SKIPPED.
    mockSendTransaction
      .mockResolvedValueOnce(sendOk(0))            // tx 0: PENDING
      .mockResolvedValueOnce({ status: 'ERROR', errorResult: 'txBAD_AUTH' }); // tx 1: ERROR
    mockGetTransaction.mockResolvedValueOnce(statusOk()); // tx 0 poll: SUCCESS

    const txs = [makeTx(0), makeTx(1), makeTx(2), makeTx(3)];
    const result = await submitBatch(txs, RPC_URL, OPTS);

    expect(result.allSucceeded).toBe(false);
    expect(result.firstFailureIndex).toBe(1);

    expect(result.outcomes[0]!.status).toBe('SUCCESS');
    expect(result.outcomes[1]!.status).toBe('FAILED');
    expect(result.outcomes[2]!.status).toBe('SKIPPED');
    expect(result.outcomes[3]!.status).toBe('SKIPPED');

    // Crucially: only 2 sendTransaction calls — tx 2 and 3 were never submitted.
    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });

  it('marks remaining transactions SKIPPED when on-chain confirmation fails', async () => {
    mockSendTransaction
      .mockResolvedValueOnce(sendOk(0))
      .mockResolvedValueOnce(sendOk(1));
    mockGetTransaction
      .mockResolvedValueOnce(statusOk())         // tx 0: confirmed
      .mockResolvedValueOnce(STATUS_FAILED);     // tx 1: failed on-chain

    const txs = [makeTx(0), makeTx(1), makeTx(2)];
    const result = await submitBatch(txs, RPC_URL, OPTS);

    expect(result.allSucceeded).toBe(false);
    expect(result.firstFailureIndex).toBe(1);
    expect(result.outcomes[1]!.status).toBe('FAILED');
    expect(result.outcomes[2]!.status).toBe('SKIPPED');
    expect(result.outcomes[2]!.error).toContain('transaction 1 failed');
    // tx 2 was never submitted.
    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });

  it('sets firstFailureIndex=0 and SKIPs everything when the first tx fails', async () => {
    mockSendTransaction.mockResolvedValue({ status: 'ERROR', errorResult: 'txBAD_SEQ' });

    const txs = [makeTx(0), makeTx(1), makeTx(2)];
    const result = await submitBatch(txs, RPC_URL, OPTS);

    expect(result.firstFailureIndex).toBe(0);
    expect(result.outcomes.map(o => o.status)).toEqual(['FAILED', 'SKIPPED', 'SKIPPED']);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it('marks tx as ERROR and stops when sendTransaction throws', async () => {
    mockSendTransaction
      .mockResolvedValueOnce(sendOk(0))
      .mockRejectedValueOnce(new Error('network timeout'));
    mockGetTransaction.mockResolvedValueOnce(statusOk());

    const txs = [makeTx(0), makeTx(1), makeTx(2)];
    const result = await submitBatch(txs, RPC_URL, OPTS);

    expect(result.firstFailureIndex).toBe(1);
    expect(result.outcomes[1]!.status).toBe('ERROR');
    expect(result.outcomes[1]!.error).toContain('Submit failed');
    expect(result.outcomes[2]!.status).toBe('SKIPPED');
    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });

  it('marks tx as ERROR and stops when getTransaction throws during polling', async () => {
    mockSendTransaction.mockResolvedValue(sendOk(0));
    mockGetTransaction
      .mockResolvedValueOnce(statusOk())             // tx 0 confirmed
      .mockRejectedValueOnce(new Error('RPC down')); // tx 1 poll throws

    const txs = [makeTx(0), makeTx(1), makeTx(2)];
    const result = await submitBatch(txs, RPC_URL, OPTS);

    expect(result.firstFailureIndex).toBe(1);
    expect(result.outcomes[1]!.status).toBe('ERROR');
    expect(result.outcomes[1]!.error).toContain('Poll failed');
    expect(result.outcomes[2]!.status).toBe('SKIPPED');
  });

  it('marks tx as ERROR after maxPollAttempts without confirmation', async () => {
    mockSendTransaction.mockResolvedValue(sendOk(0));
    // Always return NOT_FOUND (pending) — never confirm.
    mockGetTransaction.mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.NOT_FOUND,
    });

    const txs = [makeTx(0), makeTx(1)];
    const result = await submitBatch(txs, RPC_URL, { ...OPTS, maxPollAttempts: 2 });

    expect(result.firstFailureIndex).toBe(0);
    expect(result.outcomes[0]!.status).toBe('ERROR');
    expect(result.outcomes[0]!.error).toContain('timed out');
    expect(result.outcomes[1]!.status).toBe('SKIPPED');
    // Only one sendTransaction call — tx 1 was never submitted.
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });
});


describe('submitBatch — onProgress callback', () => {
  it('emits a progress event for every terminal outcome', async () => {
    mockSendTransaction
      .mockResolvedValueOnce(sendOk(0))
      .mockResolvedValueOnce(sendOk(1))
      .mockResolvedValueOnce(sendOk(2));
    mockGetTransaction.mockResolvedValue(statusOk());

    const progress: { index: number; method: string; status: string }[] = [];
    const onProgress = vi.fn((p) => progress.push(p));

    const result = await submitBatch(
      [makeTx(0, 'withdraw'), makeTx(1, 'pause'), makeTx(2, 'cancel')],
      RPC_URL,
      { ...OPTS, onProgress },
    );

    expect(result.allSucceeded).toBe(true);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(progress.map(p => ({ index: p.index, method: p.method, status: p.status })))
      .toEqual([
        { index: 0, method: 'withdraw', status: 'SUCCESS' },
        { index: 1, method: 'pause', status: 'SUCCESS' },
        { index: 2, method: 'cancel', status: 'SUCCESS' },
      ]);
  });

  it('reports FAILED then SKIPPED for remaining transactions after a failure', async () => {
    mockSendTransaction
      .mockResolvedValueOnce(sendOk(0))
      .mockResolvedValueOnce({ status: 'ERROR', errorResult: 'txBAD_AUTH' });
    mockGetTransaction.mockResolvedValueOnce(statusOk());

    const onProgress = vi.fn();
    const result = await submitBatch(
      [makeTx(0), makeTx(1), makeTx(2)],
      RPC_URL,
      { ...OPTS, onProgress },
    );

    expect(result.firstFailureIndex).toBe(1);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, { index: 0, method: 'op', status: 'SUCCESS' });
    expect(onProgress).toHaveBeenNthCalledWith(2, { index: 1, method: 'op', status: 'FAILED' });
    expect(onProgress).toHaveBeenNthCalledWith(3, { index: 2, method: 'op', status: 'SKIPPED' });
  });

  it('does not let an onProgress exception break the batch', async () => {
    mockSendTransaction.mockResolvedValue(sendOk(0));
    mockGetTransaction.mockResolvedValue(statusOk());

    const onProgress = vi.fn()
      .mockImplementationOnce(() => { throw new Error('progress UI crashed'); });

    const result = await submitBatch(
      [makeTx(0), makeTx(1)],
      RPC_URL,
      { ...OPTS, onProgress },
    );

    expect(result.allSucceeded).toBe(true);
    expect(onProgress).toHaveBeenCalledTimes(2);
  });
});

describe('submitBatch — sign callback', () => {
  it('calls sign() for each transaction before submitting', async () => {
    mockSendTransaction.mockResolvedValue(sendOk(0));
    mockGetTransaction.mockResolvedValue(statusOk());

    const signed: string[] = [];
    const sign = vi.fn(async (xdr: string) => {
      signed.push(xdr);
      return xdr + '_SIGNED';
    });

    await submitBatch([makeTx(0), makeTx(1)], RPC_URL, { ...OPTS, sign });

    expect(sign).toHaveBeenCalledTimes(2);
    expect(sign).toHaveBeenNthCalledWith(1, 'XDR_0');
    expect(sign).toHaveBeenNthCalledWith(2, 'XDR_1');
  });

  it('marks tx as ERROR and stops if sign() throws', async () => {
    const sign = vi.fn(async (_xdr: string) => {
      throw new Error('hardware wallet rejected');
    });

    const result = await submitBatch(
      [makeTx(0), makeTx(1), makeTx(2)],
      RPC_URL,
      { ...OPTS, sign },
    );

    expect(result.firstFailureIndex).toBe(0);
    expect(result.outcomes[0]!.status).toBe('ERROR');
    expect(result.outcomes[0]!.error).toContain('Sign failed');
    expect(result.outcomes[1]!.status).toBe('SKIPPED');
    expect(result.outcomes[2]!.status).toBe('SKIPPED');
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });
});

describe('submitBatch — abort signal', () => {
  it('skips all remaining transactions when signal is aborted before start', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await submitBatch(
      [makeTx(0), makeTx(1), makeTx(2)],
      RPC_URL,
      { ...OPTS, signal: ac.signal },
    );

    expect(result.firstFailureIndex).toBe(0);
    expect(result.outcomes.every(o => o.status === 'SKIPPED')).toBe(true);
    expect(mockSendTransaction).not.toHaveBeenCalled();
  });

  it('records per-tx outcomes up to the abort point', async () => {
    const ac = new AbortController();

    mockSendTransaction.mockResolvedValueOnce(sendOk(0));
    mockGetTransaction.mockImplementationOnce(async () => {
      ac.abort(); // abort during tx 0 poll
      return statusOk();
    });

    const result = await submitBatch(
      [makeTx(0), makeTx(1), makeTx(2)],
      RPC_URL,
      { ...OPTS, signal: ac.signal },
    );

    // tx 0 was already polled and succeeded before abort took effect on tx 1
    expect(result.outcomes[0]!.status).toBe('SUCCESS');
    expect(result.outcomes[1]!.status).toBe('SKIPPED');
    expect(result.outcomes[2]!.status).toBe('SKIPPED');
  });
});
