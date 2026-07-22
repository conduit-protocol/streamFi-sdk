import type { Transaction } from '@stellar/stellar-sdk';

/**
 * Common sign transaction options.
 */
export interface SignTransactionOptions {
  networkPassphrase?: string;
  accountToSign?: string;
}

/**
 * Generic wallet adapter interface for Stellar / Soroban transaction signing.
 * Allows StreamFi SDK to support browser wallets, mobile wallets (WalletConnect v2),
 * Freighter, Albedo, or direct Keypairs uniformly.
 */
export interface WalletAdapter {
  /**
   * Returns the Stellar public key / G-address of the active account.
   */
  getPublicKey(): Promise<string> | string;

  /**
   * Signs a Soroban Transaction instance or XDR string.
   * Returns the signed Transaction instance or signed XDR string.
   */
  signTransaction(
    tx: Transaction | string,
    opts?: SignTransactionOptions,
  ): Promise<Transaction | string>;

  /**
   * Checks if the wallet is currently connected.
   */
  isConnected?(): boolean;

  /**
   * Initiates wallet connection / session handshake if applicable.
   * Returns the connected account public key.
   */
  connect?(): Promise<string>;

  /**
   * Disconnects the wallet session if applicable.
   */
  disconnect?(): Promise<void>;
}
