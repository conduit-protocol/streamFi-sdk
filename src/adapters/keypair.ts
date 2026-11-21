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
  private keypair: Keypair | null;
  private readonly publicKey: string;

  constructor(keypair: Keypair) {
    this.keypair = keypair;
    this.publicKey = keypair.publicKey();
  }

  /**
   * Zero the secret key buffers held by the wrapped Keypair and drop the
   * reference, so the secret does not linger in memory for the lifetime of
   * the process (serverless / long-lived Node.js workers). The adapter can
   * still report its public key, but any further signing or export throws.
   * Idempotent.
   *
   * Note: this wipes the Keypair passed to the constructor, so do not reuse
   * that instance afterwards.
   */
  zeroize(): void {
    const keypair = this.keypair;
    if (!keypair) return;
    const internals = keypair as unknown as Record<string, unknown>;
    for (const field of ['_secretKey', '_secretSeed']) {
      const buf = internals[field];
      // `instanceof Uint8Array` can false-negative on a Buffer/TypedArray that
      // crossed a realm boundary (e.g. a different VM context/iframe); the
      // whole point of this method is to guarantee the wipe, so use
      // ArrayBuffer.isView, which checks the internal slot rather than the
      // prototype chain and holds true across realms.
      if (ArrayBuffer.isView(buf) && typeof (buf as { fill?: unknown }).fill === 'function') {
        (buf as unknown as { fill(value: number): void }).fill(0);
      }
      internals[field] = undefined;
    }
    this.keypair = null;
  }

  /** Alias for {@link zeroize}, kept for backwards compatibility. */
  destroy(): void {
    this.zeroize();
  }

  /**
   * Alias for {@link zeroize} (#1081): wipe the secret key from memory once
   * the adapter is no longer needed, e.g. at the end of a signing job.
   */
  wipe(): void {
    this.zeroize();
  }

  /** True once {@link destroy} has been called. */
  get isDestroyed(): boolean {
    return this.keypair === null;
  }

  private requireKeypair(): Keypair {
    if (!this.keypair) {
      throw new Error('KeypairWalletAdapter has been destroyed; its secret key is no longer available.');
    }
    return this.keypair;
  }

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
    return encryptKeystore(this.requireKeypair(), passphrase, opts);
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  async signTransaction(
    tx: Transaction | string,
    _opts?: SignTransactionOptions,
  ): Promise<Transaction | string> {
    const keypair = this.requireKeypair();
    if (typeof tx === 'string') {
      if (!_opts?.networkPassphrase) {
        throw new Error(
          'networkPassphrase is required when signing a raw XDR string. ' +
            'Pass { networkPassphrase } in the options argument.',
        );
      }
      const parsedTx = new Transaction(tx, _opts.networkPassphrase);
      parsedTx.sign(keypair);
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

    tx.sign(keypair);
    return tx;
  }

  isConnected(): boolean {
    return this.keypair !== null;
  }
}
