import { Transaction, Networks } from '@stellar/stellar-sdk';
import type { WalletAdapter, SignTransactionOptions } from './types.js';
import { AlbedoCancelError, AlbedoInvalidSignatureError } from '../errors.js';

/** Albedo intent error code for "rejected by the user" (includes closing the popup). */
const ALBEDO_USER_REJECTED_CODE = -4;

/** Byte length of a well-formed Ed25519 signature. */
const ED25519_SIGNATURE_LENGTH = 64;

/**
 * Asserts every decorated signature on `tx` is a well-formed 64-byte Ed25519
 * signature. The Albedo iframe has been observed returning a signed envelope
 * whose signature was not validated for length before being handed back to
 * the caller; left unchecked, it fails on-chain submission with a less
 * specific `bad_auth` error far from where the real problem is (#971).
 *
 * @throws {AlbedoInvalidSignatureError} if any signature is not 64 bytes.
 */
function assertValidSignatureLength(tx: Transaction): void {
  for (const decoratedSig of tx.signatures) {
    const sigBytes = decoratedSig.signature();
    if (sigBytes.length !== ED25519_SIGNATURE_LENGTH) {
      throw new AlbedoInvalidSignatureError(sigBytes.length);
    }
  }
}

/**
 * True when an Albedo intent rejection means the user closed the popup or
 * declined, rather than a genuine wallet/transaction failure.
 */
function isAlbedoCancellation(err: unknown): boolean {
  if (!err) return false;
  const { code, message } = (typeof err === 'object' ? err : { message: String(err) }) as {
    code?: unknown;
    message?: unknown;
  };
  if (code === ALBEDO_USER_REJECTED_CODE) return true;
  return typeof message === 'string' && /reject|cancel|closed|denied/i.test(message);
}

/** Runs an Albedo intent, rethrowing user cancellations as {@link AlbedoCancelError}. */
async function runIntent<T>(intent: Promise<T>): Promise<T> {
  try {
    return await intent;
  } catch (err) {
    if (isAlbedoCancellation(err)) {
      const message = (err as { message?: unknown })?.message;
      throw new AlbedoCancelError(typeof message === 'string' && message ? message : undefined);
    }
    throw err;
  }
}

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

    const res = await runIntent(client.publicKey({ require_existing: true }));
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

    const res = await runIntent(client.publicKey());
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
   *
   * @throws {AlbedoCancelError} if the user closes the Albedo popup or rejects the request.
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
    const signResult = await runIntent(
      client.tx({
        xdr: xdrString,
        network: networkParam,
        submit: false,
        ...(accountToSign ? { pubkey: accountToSign } : {}),
      }),
    );

    let signedXdr: string | undefined;
    if (typeof signResult === 'string') {
      signedXdr = signResult;
    } else if (signResult && typeof signResult === 'object') {
      signedXdr = signResult.signed_envelope_xdr ?? signResult.xdr;
    }

    if (!signedXdr || typeof signedXdr !== 'string') {
      throw new Error('Albedo signing did not return valid signed XDR.');
    }

    const signedTx = new Transaction(signedXdr, passphrase);
    assertValidSignatureLength(signedTx);

    if (typeof tx === 'string') {
      return signedXdr;
    }

    return signedTx;
  }
}
