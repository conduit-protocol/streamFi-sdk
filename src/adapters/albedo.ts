import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
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

/** Why an Albedo response was rejected. */
export type AlbedoEnvelopeErrorReason =
  | 'invalid_response'
  | 'invalid_xdr'
  | 'invalid_structure'
  | 'invalid_signature_count'
  | 'signature_mismatch';

/** Thrown when an Albedo popup returns a malformed or unexpected envelope (#1188). */
export class AlbedoEnvelopeError extends Error {
  readonly reason: AlbedoEnvelopeErrorReason;

  constructor(reason: AlbedoEnvelopeErrorReason, message: string) {
    super(message);
    this.name = 'AlbedoEnvelopeError';
    this.reason = reason;
  }
}

export interface VerifyEnvelopeOptions {
  /** Require exactly this many decorated signatures. */
  expectedSignatureCount?: number;
  /** Require at least this many decorated signatures. Defaults to 1. */
  minSignatureCount?: number;
  /**
   * Cryptographically verify each signature against this G-address. Off by
   * default because most callers only need structural validation.
   */
  signerPublicKey?: string;
}

export interface EnvelopeVerificationResult {
  transaction: Transaction;
  signatureCount: number;
}

/**
 * Verifies that a base64 transaction envelope returned by an Albedo popup is
 * well-formed and carries the expected signatures (#1188).
 *
 * Checks, in order:
 *  1. the response is a non-empty XDR string;
 *  2. it decodes into a Stellar `Transaction` for the given passphrase;
 *  3. each decorated signature has a 4-byte hint and a 64-byte ed25519
 *     signature (malformed signatures otherwise surface as opaque SDK errors
 *     when the transaction is submitted);
 *  4. the signature count satisfies the configured bounds.
 *
 * @throws {AlbedoEnvelopeError} on any failed check.
 */
export function verifyEnvelope(
  xdr: string,
  passphrase: string,
  options: VerifyEnvelopeOptions = {},
): EnvelopeVerificationResult {
  if (typeof xdr !== 'string' || xdr.trim().length === 0) {
    throw new AlbedoEnvelopeError('invalid_xdr', 'Albedo returned an empty transaction envelope XDR.');
  }

  let transaction: Transaction;
  try {
    transaction = new Transaction(xdr, passphrase);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AlbedoEnvelopeError(
      'invalid_xdr',
      `Albedo returned a malformed transaction envelope XDR: ${detail}`,
    );
  }

  const signatures = transaction.signatures;
  if (!Array.isArray(signatures)) {
    throw new AlbedoEnvelopeError('invalid_structure', 'Albedo envelope has no signature list.');
  }

  for (const [index, decorated] of signatures.entries()) {
    let hint: Buffer | undefined;
    let signature: Buffer | undefined;
    try {
      hint = decorated?.hint?.();
      signature = decorated?.signature?.();
    } catch {
      // Treat an undecodable decorated signature as malformed structure.
    }
    if (!hint || hint.length !== 4 || !signature || signature.length !== 64) {
      throw new AlbedoEnvelopeError(
        'invalid_structure',
        `Albedo envelope signature #${index + 1} is malformed (expected a 4-byte hint and a 64-byte signature).`,
      );
    }
  }

  const min = options.minSignatureCount ?? 1;
  if (signatures.length < min) {
    throw new AlbedoEnvelopeError(
      'invalid_signature_count',
      `Albedo envelope has ${signatures.length} signature(s); expected at least ${min} signature(s).`,
    );
  }
  if (options.expectedSignatureCount !== undefined && signatures.length !== options.expectedSignatureCount) {
    throw new AlbedoEnvelopeError(
      'invalid_signature_count',
      `Albedo envelope has ${signatures.length} signature(s); expected exactly ${options.expectedSignatureCount}.`,
    );
  }

  if (options.signerPublicKey) {
    let signer: Keypair;
    try {
      signer = Keypair.fromPublicKey(options.signerPublicKey);
    } catch {
      throw new AlbedoEnvelopeError('signature_mismatch', 'Albedo signer public key is not a valid G-address.');
    }
    const txHash = transaction.hash();
    for (const [index, decorated] of signatures.entries()) {
      if (!signer.verify(txHash, decorated.signature())) {
        throw new AlbedoEnvelopeError(
          'signature_mismatch',
          `Albedo envelope signature #${index + 1} was not produced by ${options.signerPublicKey}.`,
        );
      }
    }
  }

  return { transaction, signatureCount: signatures.length };
}

/** Alias kept for callers that prefer the longer name. */
export const verifySignedEnvelope = verifyEnvelope;
/** Alias kept for callers that prefer a `validate*` name. */
export const validateSignedEnvelope = verifyEnvelope;
/** Alias kept for callers that prefer a `validateEnvelope` name. */
export const validateEnvelope = verifyEnvelope;

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

/** Extra per-call controls for Albedo envelope verification (#1188). */
export interface AlbedoSignOptions extends SignTransactionOptions {
  /** Override the expected signature count (defaults to the input count + 1). */
  expectedSignatureCount?: number;
  /** Cryptographically verify signatures against this key (or the adapter's key). */
  verifySignatures?: boolean;
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
   *
   * The popup's response is schema-checked and the returned envelope is
   * verified (#1188) before it is handed back to the caller, so a malformed
   * or under-signed envelope fails here instead of during submission.
   */
  async signTransaction(
    tx: Transaction | string,
    opts?: AlbedoSignOptions,
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
      if ('error' in signResult && signResult.error) {
        throw new AlbedoEnvelopeError(
          'invalid_response',
          `Albedo signing failed: ${String(signResult.error)}`,
        );
      }
      const candidate = signResult.signed_envelope_xdr ?? signResult.xdr;
      if (candidate !== undefined && typeof candidate !== 'string') {
        throw new AlbedoEnvelopeError(
          'invalid_response',
          'Albedo returned a signed envelope field with a non-string value.',
        );
      }
      signedXdr = candidate;
    } else {
      throw new AlbedoEnvelopeError(
        'invalid_response',
        'Albedo returned an unexpected response shape from the tx intent.',
      );
    }

    if (!signedXdr || typeof signedXdr !== 'string') {
      throw new AlbedoEnvelopeError(
        'invalid_response',
        'Albedo signing did not return valid signed XDR.',
      );
    }

    // The wallet adds one signature to the envelope it was given. Rejecting
    // anything else catches empty, replayed, or over-signed responses before
    // they reach transaction submission (#1188).
    const originalSignatureCount = typeof tx === 'string' ? 0 : tx.signatures.length;
    const expectedSignatureCount = opts?.expectedSignatureCount ?? originalSignatureCount + 1;
    const verification: VerifyEnvelopeOptions = {
      expectedSignatureCount,
      minSignatureCount: 1,
    };
    if (opts?.verifySignatures) {
      const signer = opts.accountToSign ?? this.pubKey;
      if (signer) verification.signerPublicKey = signer;
    }
    verifyEnvelope(signedXdr, passphrase, verification);

    if (typeof tx === 'string') {
      return signedXdr;
    }

    return new Transaction(signedXdr, passphrase);
  }
}
