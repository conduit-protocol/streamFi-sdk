import { describe, it, expect, vi } from 'vitest';
import {
  Keypair,
  Transaction,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Account,
} from '@stellar/stellar-sdk';
import { AlbedoWalletAdapter, type AlbedoApi } from '../adapters/albedo.js';

describe('AlbedoWalletAdapter (#805)', () => {
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
    const adapter = new AlbedoWalletAdapter();
    expect(adapter.isConnected()).toBe(false);
  });

  it('reports connected when initialized with a public key', () => {
    const adapter = new AlbedoWalletAdapter({ publicKey: dummyPubKey });
    expect(adapter.isConnected()).toBe(true);
  });

  it('throws error on getPublicKey when not connected and client has no key', async () => {
    const mockClient: AlbedoApi = {
      publicKey: vi.fn().mockResolvedValue(undefined as unknown as string),
    };
    const adapter = new AlbedoWalletAdapter({ albedo: mockClient });
    await expect(adapter.getPublicKey()).rejects.toThrow(/not connected/i);
  });

  it('connects via publicKey intent on injected client', async () => {
    const mockClient: AlbedoApi = {
      publicKey: vi.fn().mockResolvedValue({ pubkey: dummyPubKey }),
    };
    const adapter = new AlbedoWalletAdapter({ albedo: mockClient });

    const key = await adapter.connect();
    expect(key).toBe(dummyPubKey);
    expect(adapter.isConnected()).toBe(true);
    expect(await adapter.getPublicKey()).toBe(dummyPubKey);
  });

  it('disconnects and clears public key', async () => {
    const adapter = new AlbedoWalletAdapter({ publicKey: dummyPubKey });
    expect(adapter.isConnected()).toBe(true);

    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it('signs an XDR string via tx intent and returns signed XDR', async () => {
    const tx = createTestTx();
    const originalXdr = tx.toXDR();
    tx.sign(dummyKeypair);
    const expectedSignedXdr = tx.toXDR();

    const mockClient: AlbedoApi = {
      tx: vi.fn().mockResolvedValue({ signed_envelope_xdr: expectedSignedXdr }),
    };

    const adapter = new AlbedoWalletAdapter({
      albedo: mockClient,
      publicKey: dummyPubKey,
      networkPassphrase: Networks.TESTNET,
    });

    const result = await adapter.signTransaction(originalXdr);
    expect(result).toBe(expectedSignedXdr);
    expect(mockClient.tx).toHaveBeenCalledWith({
      xdr: originalXdr,
      network: 'testnet',
      submit: false,
      pubkey: dummyPubKey,
    });
  });

  it('signs a Transaction instance and returns a signed Transaction instance', async () => {
    const tx = createTestTx();
    const clonedTx = new Transaction(tx.toXDR(), Networks.TESTNET);
    clonedTx.sign(dummyKeypair);
    const signedXdr = clonedTx.toXDR();

    const mockClient: AlbedoApi = {
      tx: vi.fn().mockResolvedValue({ xdr: signedXdr }),
    };

    const adapter = new AlbedoWalletAdapter({
      albedo: mockClient,
      publicKey: dummyPubKey,
    });

    const result = await adapter.signTransaction(tx, { networkPassphrase: Networks.TESTNET });
    expect(result).toBeInstanceOf(Transaction);
    expect((result as Transaction).toXDR()).toBe(signedXdr);
  });
});
