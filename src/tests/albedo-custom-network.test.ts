import { describe, it, expect, vi } from 'vitest';
import { Keypair, TransactionBuilder, Networks, BASE_FEE, Account } from '@stellar/stellar-sdk';
import { AlbedoWalletAdapter, resolveAlbedoNetwork, type AlbedoApi } from '../adapters/albedo.js';

const STANDALONE = 'Standalone Network ; February 2017';
const PRIVATE_TESTNET = 'Acme Private Test Network ; 2026';

describe('resolveAlbedoNetwork (#1079)', () => {
  it('maps the two Albedo-native networks by passphrase or shorthand', () => {
    expect(resolveAlbedoNetwork(Networks.PUBLIC)).toEqual({ networkParam: 'public', passphrase: Networks.PUBLIC });
    expect(resolveAlbedoNetwork('public')).toEqual({ networkParam: 'public', passphrase: Networks.PUBLIC });
    expect(resolveAlbedoNetwork(Networks.TESTNET)).toEqual({ networkParam: 'testnet', passphrase: Networks.TESTNET });
    expect(resolveAlbedoNetwork('Testnet')).toEqual({ networkParam: 'testnet', passphrase: Networks.TESTNET });
  });

  it('passes custom passphrases through verbatim, even when they contain "test" or "public"', () => {
    for (const passphrase of [STANDALONE, PRIVATE_TESTNET, Networks.FUTURENET, 'My public sandbox ; 1']) {
      expect(resolveAlbedoNetwork(passphrase)).toEqual({ networkParam: passphrase, passphrase });
    }
  });
});

describe('AlbedoWalletAdapter custom networks (#1079)', () => {
  const keypair = Keypair.random();

  function signedXdrFor(passphrase: string): string {
    const tx = new TransactionBuilder(new Account(keypair.publicKey(), '1'), {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .setTimeout(30)
      .build();
    tx.sign(keypair);
    return tx.toXDR();
  }

  it.each([STANDALONE, PRIVATE_TESTNET, Networks.FUTURENET])(
    'sends the custom passphrase %p to Albedo and decodes the result with it',
    async (passphrase) => {
      const signed = signedXdrFor(passphrase);
      const client: AlbedoApi = { tx: vi.fn().mockResolvedValue({ signed_envelope_xdr: signed }) };
      const adapter = new AlbedoWalletAdapter({
        albedo: client,
        publicKey: keypair.publicKey(),
        networkPassphrase: passphrase,
      });

      const tx = new TransactionBuilder(new Account(keypair.publicKey(), '1'), {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
      })
        .setTimeout(30)
        .build();
      const result = await adapter.signTransaction(tx);

      expect(client.tx).toHaveBeenCalledWith(expect.objectContaining({ network: passphrase }));
      expect((result as { networkPassphrase: string }).networkPassphrase).toBe(passphrase);
    },
  );

  it('decodes with the real passphrase when configured with the "testnet" shorthand', async () => {
    const signed = signedXdrFor(Networks.TESTNET);
    const client: AlbedoApi = { tx: vi.fn().mockResolvedValue({ xdr: signed }) };
    const adapter = new AlbedoWalletAdapter({ albedo: client, publicKey: keypair.publicKey() });

    const tx = new TransactionBuilder(new Account(keypair.publicKey(), '1'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .setTimeout(30)
      .build();
    const result = await adapter.signTransaction(tx, { networkPassphrase: 'testnet' });

    expect(client.tx).toHaveBeenCalledWith(expect.objectContaining({ network: 'testnet' }));
    expect((result as { networkPassphrase: string }).networkPassphrase).toBe(Networks.TESTNET);
  });
});
