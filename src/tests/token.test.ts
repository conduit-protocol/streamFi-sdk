import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Address, Keypair } from '@stellar/stellar-sdk';

const {
  mockBuildContractCallTx,
  mockInvokeContract,
  mockScValToI128,
  mockSimulateReadOnly,
} = vi.hoisted(() => ({
  mockBuildContractCallTx: vi.fn(),
  mockInvokeContract: vi.fn(),
  mockScValToI128: vi.fn(),
  mockSimulateReadOnly: vi.fn(),
}));

vi.mock('../soroban.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../soroban.js')>()),
  buildContractCallTx: mockBuildContractCallTx,
  invokeContract: mockInvokeContract,
  scValToI128: mockScValToI128,
  simulateReadOnly: mockSimulateReadOnly,
}));

import { TokenModule } from '../token.js';

describe('TokenModule', () => {
  const owner = Keypair.random();
  const spenderAddress = Keypair.random().publicKey();
  const tokenAddress = Address.contract(Buffer.alloc(32, 7)).toString();
  const transaction = { kind: 'transaction' };

  beforeEach(() => {
    mockBuildContractCallTx.mockReset().mockResolvedValue(transaction);
    mockInvokeContract.mockReset().mockResolvedValue('tx-hash');
    mockScValToI128.mockReset().mockReturnValue(75n);
    mockSimulateReadOnly.mockReset().mockResolvedValue({ kind: 'retval' });
  });

  it('reads a SEP-41 allowance for an owner and spender', async () => {
    const tokens = new TokenModule({ network: 'testnet', keypair: owner });

    await expect(tokens.allowance(tokenAddress, owner.publicKey(), spenderAddress)).resolves.toBe(75n);

    expect(mockBuildContractCallTx).toHaveBeenCalledWith(
      'https://soroban-testnet.stellar.org',
      expect.any(String),
      owner.publicKey(),
      tokenAddress,
      'allowance',
      expect.any(Array),
      '100',
    );
    const args = mockBuildContractCallTx.mock.calls[0]?.[5];
    expect(Address.fromScVal(args[0]).toString()).toBe(owner.publicKey());
    expect(Address.fromScVal(args[1]).toString()).toBe(spenderAddress);
  });

  it('submits an approval through the configured owner keypair', async () => {
    const tokens = new TokenModule({ network: 'testnet', keypair: owner });

    await expect(
      tokens.approve(tokenAddress, owner.publicKey(), spenderAddress, 250n, 12345),
    ).resolves.toBe('tx-hash');

    expect(mockBuildContractCallTx).toHaveBeenCalledWith(
      'https://soroban-testnet.stellar.org',
      expect.any(String),
      owner.publicKey(),
      tokenAddress,
      'approve',
      expect.any(Array),
      '100',
    );
    expect(mockInvokeContract).toHaveBeenCalledWith(
      'https://soroban-testnet.stellar.org',
      expect.any(String),
      expect.objectContaining({ publicKey: expect.any(Function), sign: expect.any(Function) }),
      transaction,
    );
  });

  it('rejects approval when the owner is not the configured signer', async () => {
    const tokens = new TokenModule({ network: 'testnet', keypair: owner });

    await expect(
      tokens.approve(tokenAddress, Keypair.random().publicKey(), spenderAddress, 1n, 12345),
    ).rejects.toThrow(/does not match the connected wallet/);
    expect(mockBuildContractCallTx).not.toHaveBeenCalled();
  });
});
