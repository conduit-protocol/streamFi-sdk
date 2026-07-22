import { describe, it, expect, vi } from 'vitest';
import { Keypair, Transaction, TransactionBuilder, Networks, BASE_FEE, Account } from '@stellar/stellar-sdk';
import { WalletConnectAdapter } from '../adapters/walletconnect.js';
import { KeypairWalletAdapter } from '../adapters/keypair.js';

describe('WalletConnectAdapter', () => {
  const dummyPubKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSYRZPB26WKP43SXUXZVTYTBAKW7N5B6X';

  it('reports not connected when no session is present', () => {
    const adapter = new WalletConnectAdapter({ projectId: 'test-project-id' });
    expect(adapter.isConnected()).toBe(false);
  });

  it('throws when getting public key without active session', async () => {
    const adapter = new WalletConnectAdapter({ projectId: 'test-project-id' });
    await expect(adapter.getPublicKey()).rejects.toThrow(/not connected/i);
  });

  it('extracts public key from active session namespaces', async () => {
    const session = {
      topic: 'test-topic',
      namespaces: {
        stellar: {
          accounts: [`stellar:pubnet:${dummyPubKey}`],
        },
      },
    };
    const adapter = new WalletConnectAdapter({ session });
    expect(adapter.isConnected()).toBe(true);
    expect(await adapter.getPublicKey()).toBe(dummyPubKey);
  });

  it('extracts public key from fallback session accounts array', async () => {
    const session = {
      topic: 'test-topic',
      accounts: [`stellar:testnet:${dummyPubKey}`],
    };
    const adapter = new WalletConnectAdapter({ session });
    expect(adapter.isConnected()).toBe(true);
    expect(await adapter.getPublicKey()).toBe(dummyPubKey);
  });

  it('connects via client handshake if client is provided', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue({
        session: {
          topic: 'new-topic',
          namespaces: {
            stellar: {
              accounts: [`stellar:pubnet:${dummyPubKey}`],
            },
          },
        },
      }),
    };
    const adapter = new WalletConnectAdapter({ client: mockClient, chainId: 'stellar:pubnet' });
    const pubKey = await adapter.connect();

    expect(pubKey).toBe(dummyPubKey);
    expect(mockClient.connect).toHaveBeenCalledWith({
      requiredNamespaces: {
        stellar: {
          methods: ['stellar_signTransaction', 'stellar_signXdr', 'soroban_signTransaction'],
          chains: ['stellar:pubnet'],
          events: ['accountsChanged', 'chainChanged'],
        },
      },
    });
  });

  it('disconnects active session', async () => {
    const mockClient = {
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const session = {
      topic: 'test-topic',
      account: dummyPubKey,
    };
    const adapter = new WalletConnectAdapter({ client: mockClient, session });
    expect(adapter.isConnected()).toBe(true);

    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
    expect(mockClient.disconnect).toHaveBeenCalledWith({
      topic: 'test-topic',
      reason: { code: 6000, message: 'User disconnected' },
    });
  });

  it('signs transaction XDR via stellar_signTransaction RPC request', async () => {
    const keypair = Keypair.random();
    const account = new Account(keypair.publicKey(), '100');
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .setTimeout(30)
      .build();

    tx.sign(keypair);
    const signedXdr = tx.toXDR();

    const mockClient = {
      request: vi.fn().mockResolvedValue(signedXdr),
    };
    const session = {
      topic: 'test-topic',
      account: keypair.publicKey(),
    };

    const adapter = new WalletConnectAdapter({ client: mockClient, session, chainId: 'stellar:testnet' });
    const signedTx = await adapter.signTransaction(tx, { networkPassphrase: Networks.TESTNET });

    expect(signedTx).toBeInstanceOf(Transaction);
    expect((signedTx as Transaction).toXDR()).toBe(signedXdr);
    expect(mockClient.request).toHaveBeenCalledWith({
      topic: 'test-topic',
      chainId: 'stellar:testnet',
      request: {
        method: 'stellar_signTransaction',
        params: {
          xdr: tx.toXDR(),
          accountToSign: keypair.publicKey(),
          networkPassphrase: Networks.TESTNET,
        },
      },
    });
  });
});

describe('KeypairWalletAdapter', () => {
  it('returns public key and signs transaction', async () => {
    const keypair = Keypair.random();
    const adapter = new KeypairWalletAdapter(keypair);

    expect(adapter.getPublicKey()).toBe(keypair.publicKey());
    expect(adapter.isConnected()).toBe(true);

    const account = new Account(keypair.publicKey(), '100');
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .setTimeout(30)
      .build();

    const signedTx = await adapter.signTransaction(tx, { networkPassphrase: Networks.TESTNET });
    expect(signedTx).toBeInstanceOf(Transaction);
    expect((signedTx as Transaction).signatures.length).toBe(1);
  });
});
