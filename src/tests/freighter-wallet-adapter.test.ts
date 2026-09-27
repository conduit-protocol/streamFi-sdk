import { describe, it, expect, vi } from 'vitest';
import {
  Keypair,
  Transaction,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Account,
} from '@stellar/stellar-sdk';
import { FreighterWalletAdapter, type FreighterApi } from '../adapters/freighter.js';

describe('FreighterWalletAdapter (#805)', () => {
  const dummyKeypair = Keypair.random();
  const dummyPubKey = dummyKeypair.publicKey();

  function createTestTx(): Transaction {
    const account = new Account(dummyPubKey, '100');
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .setTimeout(30)
      .build();
  }

  it('reports not connected initially when no public key is provided', () => {
    const adapter = new FreighterWalletAdapter();
    expect(adapter.isConnected()).toBe(false);
  });

  it('reports connected when initialized with a public key', () => {
    const adapter = new FreighterWalletAdapter({ publicKey: dummyPubKey });
    expect(adapter.isConnected()).toBe(true);
  });

  it('throws error on getPublicKey when not connected and client has no key', async () => {
    const mockClient: FreighterApi = {
      getPublicKey: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new FreighterWalletAdapter({ freighter: mockClient });
    await expect(adapter.getPublicKey()).rejects.toThrow(/not connected/i);
  });

  it('connects via requestAccess on injected client', async () => {
    const mockClient: FreighterApi = {
      requestAccess: vi.fn().mockResolvedValue(dummyPubKey),
    };
    const adapter = new FreighterWalletAdapter({ freighter: mockClient });

    const key = await adapter.connect();
    expect(key).toBe(dummyPubKey);
    expect(adapter.isConnected()).toBe(true);
    expect(await adapter.getPublicKey()).toBe(dummyPubKey);
  });

  it('disconnects and clears public key', async () => {
    const adapter = new FreighterWalletAdapter({ publicKey: dummyPubKey });
    expect(adapter.isConnected()).toBe(true);

    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it('signs an XDR string and returns signed XDR', async () => {
    const tx = createTestTx();
    const originalXdr = tx.toXDR();
    tx.sign(dummyKeypair);
    const expectedSignedXdr = tx.toXDR();

    const mockClient: FreighterApi = {
      signTransaction: vi.fn().mockResolvedValue(expectedSignedXdr),
    };

    const adapter = new FreighterWalletAdapter({
      freighter: mockClient,
      publicKey: dummyPubKey,
      networkPassphrase: Networks.TESTNET,
    });

    const result = await adapter.signTransaction(originalXdr);
    expect(result).toBe(expectedSignedXdr);
    expect(mockClient.signTransaction).toHaveBeenCalledWith(originalXdr, {
      networkPassphrase: Networks.TESTNET,
      accountToSign: dummyPubKey,
    });
  });

  it('signs a Transaction instance and returns a signed Transaction instance', async () => {
    const tx = createTestTx();
    const clonedTx = new Transaction(tx.toXDR(), Networks.TESTNET);
    clonedTx.sign(dummyKeypair);
    const signedXdr = clonedTx.toXDR();

    const mockClient: FreighterApi = {
      signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: signedXdr }),
    };

    const adapter = new FreighterWalletAdapter({
      freighter: mockClient,
      publicKey: dummyPubKey,
    });

    const result = await adapter.signTransaction(tx, { networkPassphrase: Networks.TESTNET });
    expect(result).toBeInstanceOf(Transaction);
    expect((result as Transaction).toXDR()).toBe(signedXdr);
  });

  it('throws descriptive error if Freighter API returns an error', async () => {
    const mockClient: FreighterApi = {
      signTransaction: vi.fn().mockResolvedValue({ error: 'User rejected signing request' }),
    };

    const adapter = new FreighterWalletAdapter({
      freighter: mockClient,
      publicKey: dummyPubKey,
      networkPassphrase: Networks.TESTNET,
    });

    await expect(adapter.signTransaction('fake-xdr')).rejects.toThrow('User rejected signing request');
  });
});
