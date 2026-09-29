import { Transaction, Networks } from '@stellar/stellar-sdk';
import type { WalletAdapter, SignTransactionOptions } from './types.js';

export interface AlbedoPublicKeyResult {
  pubkey: string;
  signed_message?: string;
  signature?: string;
  [key: string]: unknown;
}

export interface AlbedoTxResult {
  xdr?: string;
  signed_envelope_xdr?: string;
  tx_hash?: string;
  network?: string;
  [key: string]: unknown;
}

export interface AlbedoApi {
  publicKey?: (opts?: { require_existing?: boolean }) => Promise<AlbedoPublicKeyResult | string>;
  tx?: (opts: {
    xdr: string;
    network?: string;
    submit?: boolean;
    pubkey?: string;
  }) => Promise<AlbedoTxResult | string>;
  [key: string]: unknown;
}

export interface AlbedoWalletAdapterOptions {
  /**
   * Pre-injected or custom Albedo API implementation.
   * If omitted, defaults to `window.albedo` or global `albedo` if available.
   */
  albedo?: AlbedoApi | unknown;
  /**
   * Pre-set public key if already authenticated.
   */
  publicKey?: string;
  /**
   * Default network passphrase or identifier (e.g. 'public', 'testnet').
   */
  networkPassphrase?: string;
}

/**
 * First-party Albedo wallet adapter.
 * Wraps the Albedo browser extension or `@albedo-link/intent` web API.
 */
export class AlbedoWalletAdapter implements WalletAdapter {
  private albedoClient: AlbedoApi | null;
  private pubKey: string | null;
  public networkPassphrase: string | undefined;

  constructor(options: AlbedoWalletAdapterOptions = {}) {
    this.albedoClient = (options.albedo as AlbedoApi) ?? null;
    this.pubKey = options.publicKey ?? null;
    this.networkPassphrase = options.networkPassphrase;
  }

  private getClient(): AlbedoApi {
    if (this.albedoClient) {
      return this.albedoClient;
    }

    if (typeof globalThis !== 'undefined') {
      const win = globalThis as unknown as { albedo?: AlbedoApi };
      if (win.albedo) {
        return win.albedo;
      }
    }

    if (typeof globalThis !== 'undefined') {
      const glob = globalThis as unknown as { albedo?: AlbedoApi };
      if (glob.albedo) return glob.albedo;
    }

    throw new Error('Albedo wallet API not detected. Please ensure Albedo is available.');
  }

  /**
   * Checks if Albedo is currently connected / active account is known.
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
    if (typeof client.publicKey !== 'function') {
      throw new Error('Albedo wallet API does not support publicKey intent.');
    }

    const res = await client.publicKey({ require_existing: true });
    const key = typeof res === 'string' ? res : res?.pubkey;

    if (!key) {
      throw new Error('Albedo wallet is not connected. Call connect() first.');
    }

    this.pubKey = key;
    return key;
  }

  /**
   * Connects to Albedo by invoking the publicKey intent.
   */
  async connect(): Promise<string> {
    const client = this.getClient();
    if (typeof client.publicKey !== 'function') {
      throw new Error('Albedo wallet API does not support publicKey intent.');
    }

    const res = await client.publicKey();
    const key = typeof res === 'string' ? res : res?.pubkey;

    if (!key) {
      throw new Error('Failed to obtain public key from Albedo wallet.');
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
   * Signs a Soroban/Stellar transaction via Albedo tx intent.
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

    if (!passphrase) {
      throw new Error(
        'networkPassphrase is required to sign transactions with Albedo. ' +
        'Pass { networkPassphrase } in opts or constructor options.',
      );
    }

    if (typeof client.tx !== 'function') {
      throw new Error('Albedo client does not support tx intent.');
    }

    // Determine network param for Albedo: 'public', 'testnet', or full passphrase
    let networkParam = passphrase;
    if (passphrase === Networks.PUBLIC || passphrase.toLowerCase().includes('public')) {
      networkParam = 'public';
    } else if (passphrase === Networks.TESTNET || passphrase.toLowerCase().includes('test')) {
      networkParam = 'testnet';
    }

    const accountToSign = opts?.accountToSign ?? this.pubKey;
    const signResult = await client.tx({
      xdr: xdrString,
      network: networkParam,
      submit: false,
      ...(accountToSign ? { pubkey: accountToSign } : {}),
    });

    let signedXdr: string | undefined;
    if (typeof signResult === 'string') {
      signedXdr = signResult;
    } else if (signResult && typeof signResult === 'object') {
      signedXdr = signResult.signed_envelope_xdr ?? signResult.xdr;
    }

    if (!signedXdr || typeof signedXdr !== 'string') {
      throw new Error('Albedo signing did not return valid signed XDR.');
    }

    if (typeof tx === 'string') {
      return signedXdr;
    }

    return new Transaction(signedXdr, passphrase);
  }
}
