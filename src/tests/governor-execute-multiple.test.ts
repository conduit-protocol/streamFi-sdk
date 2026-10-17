import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import type { ConduitConfig } from '../types/index.js';

const { mockBuildTx, mockInvoke } = vi.hoisted(() => ({
  mockBuildTx: vi.fn(),
  mockInvoke:  vi.fn(),
}));

vi.mock('../soroban.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../soroban.js')>()),
  buildContractCallTx: mockBuildTx,
  invokeContract:      mockInvoke,
}));

import { GovernorModule } from '../governor.js';

const GOVERNOR = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

function make(extra: Partial<ConduitConfig> = {}): GovernorModule {
  return new GovernorModule({
    network: 'testnet',
    governorAddress: GOVERNOR,
    keypair: Keypair.random(),
    ...extra,
  });
}

describe('GovernorModule.executeMultipleProposals (#846)', () => {
  beforeEach(() => {
    mockBuildTx.mockReset().mockImplementation(async (_u, _p, _c, _id, _m, args) => ({ args }));
    mockInvoke.mockReset().mockImplementation(async (_u, _p, _s, tx) => `hash-${tx.args[0].u64().toString()}`);
  });

  it('submits one transaction per proposal, in order', async () => {
    const results = await make().executeMultipleProposals([3, 1, 2]);
    expect(results.map((r) => r.proposalId)).toEqual([3, 1, 2]);
    expect(results.every((r) => r.success)).toBe(true);
    expect(results.map((r) => r.txHash)).toEqual(['hash-3', 'hash-1', 'hash-2']);
    expect(mockBuildTx.mock.calls.every((c) => c[3] === GOVERNOR && c[4] === 'execute')).toBe(true);
  });

  it('never submits concurrently', async () => {
    let inFlight = 0;
    let peak = 0;
    mockInvoke.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return 'h';
    });
    await make().executeMultipleProposals([1, 2, 3]);
    expect(peak).toBe(1);
  });

  it('reports a failure without hiding the other results', async () => {
    mockInvoke.mockImplementation(async (_u, _p, _s, tx) => {
      if (tx.args[0].u64().toString() === '2') throw new Error('not passed');
      return 'ok';
    });
    const results = await make().executeMultipleProposals([1, 2, 3]);
    expect(results.map((r) => r.success)).toEqual([true, false, true]);
    expect(results[1]!.error?.message).toBe('not passed');
  });

  it('stopOnError skips the remaining proposals', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('boom'));
    const results = await make().executeMultipleProposals([1, 2, 3], { stopOnError: true });
    expect(results.map((r) => r.success)).toEqual([false, false, false]);
    expect(results.map((r) => !!r.skipped)).toEqual([false, true, true]);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('stops submitting once the signal is aborted', async () => {
    const ctrl = new AbortController();
    mockInvoke.mockImplementationOnce(async () => { ctrl.abort(); return 'h1'; });
    const results = await make().executeMultipleProposals([1, 2], { signal: ctrl.signal });
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect((results[1]!.error as Error).name).toBe('AbortError');
  });

  it('validates input before any network call', async () => {
    const gov = make();
    await expect(gov.executeMultipleProposals([])).rejects.toThrow(/non-empty/);
    await expect(gov.executeMultipleProposals([1, 1])).rejects.toThrow(/Duplicate/);
    await expect(gov.executeMultipleProposals([-1])).rejects.toThrow(/Invalid proposal id/);
    await expect(gov.executeMultipleProposals([1.5])).rejects.toThrow(/Invalid proposal id/);
    expect(mockBuildTx).not.toHaveBeenCalled();
  });

  it('requires a governor address and a signer', async () => {
    await expect(
      new GovernorModule({ network: 'testnet', keypair: Keypair.random() }).executeMultipleProposals([1]),
    ).rejects.toThrow(/governorAddress/);
    await expect(
      new GovernorModule({ network: 'testnet', governorAddress: GOVERNOR }).executeMultipleProposals([1]),
    ).rejects.toThrow(/keypair, wallet adapter, or signer/);
  });

  it('signs through a wallet adapter and honours its returned transaction', async () => {
    const signedTx = { signed: true };
    const wallet = {
      getPublicKey: () => 'GWALLET',
      signTransaction: vi.fn().mockResolvedValue(signedTx),
      isConnected: () => true,
    };
    let signerResult: unknown;
    mockInvoke.mockImplementation(async (_u, _p, signer) => {
      signerResult = await signer.sign({ unsigned: true });
      return 'h';
    });
    await make({ wallet, keypair: undefined as never }).executeMultipleProposals([1]);
    expect(mockBuildTx.mock.calls[0]![2]).toBe('GWALLET');
    expect(signerResult).toBe(signedTx);
  });
});
