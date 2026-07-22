import { Keypair, Transaction } from '@stellar/stellar-sdk';
import type { WalletAdapter, SignTransactionOptions } from './types.js';

/**
 * Adapter wrapping a standard @stellar/stellar-sdk Keypair.
 * Allows secret keys / keypairs to be used seamlessly through the WalletAdapter interface.
 */
export class KeypairWalletAdapter implements WalletAdapter {
  constructor(private readonly keypair: Keypair) {}

  getPublicKey(): string {
    return this.keypair.publicKey();
  }

  async signTransaction(
    tx: Transaction | string,
    _opts?: SignTransactionOptions,
  ): Promise<Transaction | string> {
    if (typeof tx === 'string') {
      const parsedTx = new Transaction(tx, _opts?.networkPassphrase ?? '');
      parsedTx.sign(this.keypair);
      return parsedTx.toXDR();
    }

    tx.sign(this.keypair);
    return tx;
  }

  isConnected(): boolean {
    return true;
  }
}
