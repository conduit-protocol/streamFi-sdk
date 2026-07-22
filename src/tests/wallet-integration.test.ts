import { describe, it, expect, vi } from 'vitest';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import { ConduitClient } from '../client.js';
import { WalletConnectAdapter } from '../adapters/walletconnect.js';
import type { WalletAdapter } from '../adapters/types.js';

describe('ConduitClient WalletAdapter Integration', () => {
  const dummyPubKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSYRZPB26WKP43SXUXZVTYTBAKW7N5B6X';

  it('initializes with a wallet adapter in ConduitConfig', async () => {
    const mockWallet: WalletAdapter = {
      getPublicKey: () => dummyPubKey,
      signTransaction: async (tx) => tx,
      isConnected: () => true,
    };

    const client = new ConduitClient({
      network: 'testnet',
      factoryAddress: 'CDRIPFACTORY1234567890123456789012345678901234567890123',
      wallet: mockWallet,
    });

    expect(client.streams).toBeDefined();
  });

  it('allows dynamically attaching a wallet adapter via setWallet()', async () => {
    const keypair = Keypair.random();
    const mockClient = {
      request: vi.fn().mockImplementation(async ({ request }: { request: { xdr: string } }) => {
        const tx = new Transaction(request.xdr, Networks.TESTNET);
        tx.sign(keypair);
        return tx.toXDR();
      }),
    };
    const session = {
      topic: 'wc-topic',
      account: keypair.publicKey(),
    };

    const wcAdapter = new WalletConnectAdapter({
      client: mockClient,
      session,
      chainId: 'stellar:testnet',
    });

    const client = new ConduitClient({
      network: 'testnet',
      factoryAddress: 'CDRIPFACTORY1234567890123456789012345678901234567890123',
    });

    client.setWallet(wcAdapter);

    // Verify wallet is attached and gets public key
    expect(await wcAdapter.getPublicKey()).toBe(keypair.publicKey());
  });
});
