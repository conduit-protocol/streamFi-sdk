import { Keypair, Transaction } from '@stellar/stellar-sdk';

export interface Signer {
  sign(tx: Transaction): void | Promise<void>;
  publicKey(): string;
}

export class KeypairSigner implements Signer {
  constructor(private readonly keypair: Keypair) {}

  sign(tx: Transaction): void {
    tx.sign(this.keypair);
  }

  publicKey(): string {
    return this.keypair.publicKey();
  }
}
