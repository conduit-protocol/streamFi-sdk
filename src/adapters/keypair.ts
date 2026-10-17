import { Keypair, Transaction } from '@stellar/stellar-sdk';
import type { WalletAdapter, SignTransactionOptions } from './types.js';
import {
  encryptKeystore,
  decryptKeystore,
  type Keystore,
  type ExportKeystoreOptions,
} from './keystore.js';

/**
 * Adapter wrapping a standard @stellar/stellar-sdk Keypair.
 * Allows secret keys / keypairs to be used seamlessly through the WalletAdapter interface.
 */
export class KeypairWalletAdapter implements WalletAdapter {
  constructor(private readonly keypair: Keypair) {}

  /**
   * Rebuild an adapter from a keystore produced by {@link exportKeystore}.
   *
   * @param keystore - The keystore object, or its JSON string as read from disk.
   * @throws if the passphrase is wrong or the keystore is malformed/tampered.
   */
  static async fromKeystore(
    keystore: Keystore | string,
    passphrase: string,
  ): Promise<KeypairWalletAdapter> {
    return new KeypairWalletAdapter(await decryptKeystore(keystore, passphrase));
  }

  /**
   * Export this adapter's secret key as a passphrase-encrypted keystore
   * (PBKDF2-SHA256 + AES-256-GCM), so it can be written to disk instead of
   * keeping the raw secret in plaintext. `JSON.stringify` the result to
   * persist it; restore with {@link KeypairWalletAdapter.fromKeystore}.
   *
   * @throws if the wrapped Keypair is public-key only.
   */
  exportKeystore(passphrase: string, opts?: ExportKeystoreOptions): Promise<Keystore> {
    return encryptKeystore(this.keypair, passphrase, opts);
  }

  getPublicKey(): string {
    return this.keypair.publicKey();
  }

  async signTransaction(
    tx: Transaction | string,
    _opts?: SignTransactionOptions,
  ): Promise<Transaction | string> {
    if (typeof tx === 'string') {
      if (!_opts?.networkPassphrase) {
        throw new Error(
          'networkPassphrase is required when signing a raw XDR string. ' +
            'Pass { networkPassphrase } in the options argument.',
        );
      }
      const parsedTx = new Transaction(tx, _opts.networkPassphrase);
      parsedTx.sign(this.keypair);
      return parsedTx.toXDR();
    }

    if (
      _opts?.networkPassphrase &&
      tx.networkPassphrase !== undefined &&
      tx.networkPassphrase !== _opts.networkPassphrase
    ) {
      throw new Error(
        `networkPassphrase mismatch: the transaction was built for "${tx.networkPassphrase}" ` +
          `but opts.networkPassphrase is "${_opts.networkPassphrase}".`,
      );
    }

    tx.sign(this.keypair);
    return tx;
  }

  isConnected(): boolean {
    return true;
  }
}
