import { describe, it, expect } from 'vitest';
import { TransactionSigner } from '../signer.js';

describe('TransactionSigner EIP-712 Dynamic chainId Tests', () => {
  it('extracts chainId dynamically from WalletAdapter state (e.g., Arbitrum 42161)', async () => {
    const mockArbitrumWallet = {
      chainId: 42161,
      getPublicKey: async () => '0x0000000000000000000000000000000000000001',
      signTransaction: async (tx: any) => tx,
    };

    const signer = new TransactionSigner({ walletAdapter: mockArbitrumWallet as any });
    const proposalPayload = await signer.signProposal(['stream-1', 'stream-2']);

    expect(proposalPayload.domain).toMatchObject({
      name: 'ConduitBatcher',
      version: '1',
      chainId: 42161,
    });
    expect(proposalPayload.signature).toBeDefined();

    signer.cleanup();
  });

  it('falls back to RPC provider when WalletAdapter state has no chainId', async () => {
    const mockWalletWithoutChainId = {
      getPublicKey: async () => '0x0000000000000000000000000000000000000001',
      signTransaction: async (tx: any) => tx,
    };

    const mockRpcProvider = {
      getChainId: async () => 42161,
    };

    const signer = new TransactionSigner({
      walletAdapter: mockWalletWithoutChainId as any,
      rpcProvider: mockRpcProvider,
    });

    const chainId = await signer.getChainId();
    expect(chainId).toBe(42161);

    const typedData = await signer._signTypedData(
      { name: 'StreamFi' },
      { Stream: [{ name: 'id', type: 'string' }] },
      { id: 'stream-100' }
    );

    expect(typedData.domain).toEqual({
      name: 'StreamFi',
      chainId: 42161,
    });

    signer.cleanup();
  });

  it('defaults to chainId 1 when neither adapter nor RPC provider specifies chainId', async () => {
    const signer = new TransactionSigner();
    const chainId = await signer.getChainId();
    expect(chainId).toBe(1);

    signer.cleanup();
  });
});
