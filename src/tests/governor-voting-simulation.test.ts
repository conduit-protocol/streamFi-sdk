import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Address, Keypair } from '@stellar/stellar-sdk';

const { mockBuildTx, mockSimulateTransaction } = vi.hoisted(() => ({
  mockBuildTx: vi.fn(),
  mockSimulateTransaction: vi.fn(),
}));

vi.mock('../soroban.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../soroban.js')>()),
  buildContractCallTx: mockBuildTx,
  getServer: () => ({ simulateTransaction: mockSimulateTransaction }),
}));

import { GovernorModule, ProposalState, isVotingActive } from '../governor.js';
import { ZERO_ADDR } from '../constants.js';

describe('isVotingActive (#1087)', () => {
  const window = { startLedger: 100, endLedger: 200 };

  it('is active only inside the inclusive ledger window', () => {
    expect(isVotingActive(window, 99)).toBe(false);
    expect(isVotingActive(window, 100)).toBe(true);
    expect(isVotingActive(window, 150)).toBe(true);
    expect(isVotingActive(window, 200)).toBe(true);
    expect(isVotingActive(window, 201)).toBe(false);
  });

  it('respects the on-chain state when provided', () => {
    expect(isVotingActive({ ...window, state: ProposalState.Active }, 150)).toBe(true);
    expect(isVotingActive({ ...window, state: ProposalState.Pending }, 150)).toBe(false);
    expect(isVotingActive({ ...window, state: ProposalState.Defeated }, 150)).toBe(false);
    expect(isVotingActive({ ...window, state: ProposalState.Succeeded }, 150)).toBe(false);
  });

  it('treats a malformed window as never active', () => {
    expect(isVotingActive({ startLedger: 200, endLedger: 100 }, 150)).toBe(false);
    expect(isVotingActive({ startLedger: -1, endLedger: 100 }, 50)).toBe(false);
    expect(isVotingActive({ startLedger: 1.5, endLedger: 100 }, 50)).toBe(false);
  });

  it('rejects an invalid current ledger', () => {
    expect(() => isVotingActive(window, -1)).toThrow(RangeError);
    expect(() => isVotingActive(window, Number.NaN)).toThrow(RangeError);
  });
});

describe('GovernorModule.simulateProposalExecution (#1088)', () => {
  const governorAddress = Address.contract(Buffer.alloc(32, 3)).toString();
  const tx = { kind: 'tx' };
  const successSim = {
    minResourceFee: '12345',
    transactionData: {
      build: () => ({
        resources: () => ({
          instructions: () => 1_000,
          readBytes: () => 200,
          writeBytes: () => 30,
        }),
      }),
    },
  };

  beforeEach(() => {
    mockBuildTx.mockReset().mockResolvedValue(tx);
    mockSimulateTransaction.mockReset().mockResolvedValue(successSim);
  });

  it('simulates execute without credentials and returns the cost', async () => {
    const governor = new GovernorModule({ network: 'testnet', governorAddress });

    const result = await governor.simulateProposalExecution(7);

    expect(result).toMatchObject({
      minResourceFee: 12345n,
      cpuInstructions: 1_000,
      readBytes: 200,
      writeBytes: 30,
    });
    expect(result.raw).toBe(successSim);
    const [, , caller, contractId, method] = mockBuildTx.mock.calls[0];
    expect(caller).toBe(ZERO_ADDR);
    expect(contractId).toBe(governorAddress);
    expect(method).toBe('execute');
    expect(mockSimulateTransaction).toHaveBeenCalledWith(tx);
  });

  it('simulates from the configured keypair when present', async () => {
    const keypair = Keypair.random();
    const governor = new GovernorModule({ network: 'testnet', governorAddress, keypair });

    await governor.simulateProposalExecution(1);
    expect(mockBuildTx.mock.calls[0][2]).toBe(keypair.publicKey());
  });

  it('throws when the execution would revert', async () => {
    mockSimulateTransaction.mockResolvedValue({ error: 'HostError: contract trapped' });
    const governor = new GovernorModule({ network: 'testnet', governorAddress });

    await expect(governor.simulateProposalExecution(2)).rejects.toThrow(
      'Proposal 2 execution simulation failed: HostError: contract trapped',
    );
  });

  it('validates the id and the governor address', async () => {
    await expect(
      new GovernorModule({ network: 'testnet', governorAddress }).simulateProposalExecution(-1),
    ).rejects.toThrow('Invalid proposal id');
    await expect(
      new GovernorModule({ network: 'testnet' }).simulateProposalExecution(1),
    ).rejects.toThrow('governorAddress is required');
    expect(mockBuildTx).not.toHaveBeenCalled();
  });
});
