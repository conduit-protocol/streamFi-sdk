import { Transaction } from '@stellar/stellar-sdk';
import type { WalletAdapter, SignTransactionOptions } from './types.js';

export interface FreighterNetworkDetails {
  network?: string;
  networkPassphrase?: string;
  networkUrl?: string;
}

export interface FreighterApi {
  isConnected?: () => Promise<boolean> | boolean;
  isAllowed?: () => Promise<boolean> | boolean;
  requestAccess?: () => Promise<string>;
  getPublicKey?: () => Promise<string>;
  getAddress?: () => Promise<{ address?: string; error?: string } | string>;
  signTransaction?: (
    xdr: string,
    opts?: { network?: string; networkPassphrase?: string; accountToSign?: string },
  ) => Promise<string | { signedTxXdr?: string; error?: string }>;
  getNetwork?: () => Promise<string>;
  getNetworkDetails?: () => Promise<FreighterNetworkDetails>;
  [key: string]: unknown;
}

export interface FreighterWalletAdapterOptions {
  /**
   * Pre-injected or custom Freighter API implementation.
   * If omitted, defaults to `window.freighter` or global `freighter` if available.
   */
  freighter?: FreighterApi | unknown;
  /**
   * Pre-set public key if already authenticated.
   */
  publicKey?: string;
  /**
   * Default Stellar network passphrase.
   */
  networkPassphrase?: string;
}

/**
 * First-party Freighter wallet adapter.
 * Wraps the browser extension or injected `@stellar/freighter-api` instance.
 */
export class FreighterWalletAdapter implements WalletAdapter {
  private freighterClient: FreighterApi | null;
  private pubKey: string | null;
  public networkPassphrase?: string;

  constructor(options: FreighterWalletAdapterOptions = {}) {
    this.freighterClient = (options.freighter as FreighterApi) ?? null;
    this.pubKey = options.publicKey ?? null;
    this.networkPassphrase = options.networkPassphrase;
  }

  private getClient(): FreighterApi {
    if (this.freighterClient) {
      return this.freighterClient;
    }

    if (typeof window !== 'undefined') {
      const win = window as unknown as { freighter?: FreighterApi; stellar?: FreighterApi };
      if (win.freighter) {
        return win.freighter;
      }
      if (win.stellar) {
        return win.stellar;
      }
    }

    if (typeof globalThis !== 'undefined') {
      const glob = globalThis as unknown as { freighter?: FreighterApi };
      if (glob.freighter) {
        return glob.freighter;
      }
    }

    throw new Error('Freighter wallet API not detected. Please install Freighter browser extension.');
  }

  /**
   * Checks if Freighter is currently connected / active account is known.
   */
  isConnected(): boolean {
    return Boolean(this.pubKey);
  }

  /**
   * Returns the Stellar public key / G-address of the active account.
   */
  async getPublicKey(): Promise<string> {
    if (this.pubKey) {
      return this.pubKey;
    }

    const client = this.getClient();
    let key: string | undefined;

    if (typeof client.getPublicKey === 'function') {
      try {
        key = await client.getPublicKey();
      } catch {
        // Fall back to getAddress or requestAccess
      }
    }

    if (!key && typeof client.getAddress === 'function') {
      try {
        const res = await client.getAddress();
        key = typeof res === 'string' ? res : res?.address;
      } catch {
        // Fall back to requestAccess
      }
    }

    if (!key && typeof client.requestAccess === 'function') {
      try {
        key = await client.requestAccess();
      } catch {
        // No access granted yet
      }
    }

    if (!key) {
      throw new Error('Freighter wallet is not connected. Call connect() first.');
    }

    this.pubKey = key;
    return key;
  }

  /**
   * Connects to Freighter by requesting access from the extension.
   */
  async connect(): Promise<string> {
    const client = this.getClient();

    let key: string | undefined;
    if (typeof client.requestAccess === 'function') {
      key = await client.requestAccess();
    } else if (typeof client.getPublicKey === 'function') {
      key = await client.getPublicKey();
    } else if (typeof client.getAddress === 'function') {
      const res = await client.getAddress();
      key = typeof res === 'string' ? res : res?.address;
    }

    if (!key) {
      throw new Error('Failed to obtain public key from Freighter wallet.');
    }

    this.pubKey = key;
    return key;
  }

  /**
   * Disconnects the wallet adapter session.
   */
  async disconnect(): Promise<void> {
    this.pubKey = null;
  }

  /**
   * Signs a Soroban/Stellar transaction via Freighter extension.
   */
  async signTransaction(
    tx: Transaction | string,
    opts?: SignTransactionOptions,
  ): Promise<Transaction | string> {
    const client = this.getClient();
    const xdrString = typeof tx === 'string' ? tx : tx.toXDR();

    let passphrase = opts?.networkPassphrase ?? this.networkPassphrase;
    if (!passphrase && typeof tx !== 'string' && tx.networkPassphrase) {
      passphrase = tx.networkPassphrase;
    }

    if (!passphrase && typeof client.getNetworkDetails === 'function') {
      try {
        const details = await client.getNetworkDetails();
        passphrase = details?.networkPassphrase;
      } catch {
        // Ignore fallback error
      }
    }

    if (!passphrase) {
      throw new Error(
        'networkPassphrase is required to sign transactions with Freighter. ' +
        'Pass { networkPassphrase } in opts or constructor options.',
      );
    }

    if (typeof client.signTransaction !== 'function') {
      throw new Error('Freighter client does not support signTransaction.');
    }

    const signResult = await client.signTransaction(xdrString, {
      networkPassphrase: passphrase,
      accountToSign: opts?.accountToSign ?? this.pubKey ?? undefined,
    });

    let signedXdr: string | undefined;
    if (typeof signResult === 'string') {
      signedXdr = signResult;
    } else if (signResult && typeof signResult === 'object') {
      if (signResult.error) {
        throw new Error(`Freighter signing failed: ${signResult.error}`);
      }
      signedXdr = signResult.signedTxXdr;
    }

    if (!signedXdr || typeof signedXdr !== 'string') {
      throw new Error('Freighter signing did not return valid signed XDR.');
    }

    if (typeof tx === 'string') {
      return signedXdr;
    }

    return new Transaction(signedXdr, passphrase);
  }
}
