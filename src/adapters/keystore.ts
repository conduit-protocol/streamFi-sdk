/**
 * Passphrase-encrypted keystore for Stellar secret keys (#819).
 *
 * Lets CLI tools and bots persist a signing key on disk without keeping the
 * raw `S...` secret in a plaintext file or environment variable.
 *
 * Format (`version: 1`): PBKDF2-HMAC-SHA256 derives a 256-bit key from the
 * passphrase, and AES-256-GCM encrypts the 32-byte raw ed25519 seed. The
 * public key is stored in the clear and bound to the ciphertext as GCM
 * additional data, so a keystore cannot be re-labelled with another account's
 * address. Only the Web Crypto API is used, so it runs unchanged in Node 18+,
 * browsers, and edge runtimes.
 *
 * This is the SDK's own envelope, not the Ethereum Web3 Secret Storage format
 * (that one needs scrypt, which Web Crypto does not provide).
 */

import { Keypair } from '@stellar/stellar-sdk';

export const KEYSTORE_VERSION = 1;

/** OWASP's 2023 minimum for PBKDF2-HMAC-SHA256. */
export const DEFAULT_KEYSTORE_ITERATIONS = 600_000;

const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface Keystore {
  version: typeof KEYSTORE_VERSION;
  /** The account's `G...` address, readable without the passphrase. */
  publicKey: string;
  kdf: 'pbkdf2-sha256';
  kdfparams: { iterations: number; salt: string };
  cipher: 'aes-256-gcm';
  cipherparams: { iv: string };
  /** Base64 of the encrypted seed followed by the 16-byte GCM tag. */
  ciphertext: string;
}

export interface ExportKeystoreOptions {
  /** PBKDF2 iteration count. Defaults to {@link DEFAULT_KEYSTORE_ITERATIONS}. */
  iterations?: number;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  usage: 'encrypt' | 'decrypt',
): Promise<Awaited<ReturnType<typeof globalThis.crypto.subtle.deriveKey>>> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto (crypto.subtle) is not available in this environment');
  }
  const material = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

function assertPassphrase(passphrase: unknown): asserts passphrase is string {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('A non-empty passphrase is required');
  }
}

/** Encrypt `keypair`'s secret seed under `passphrase`. */
export async function encryptKeystore(
  keypair: Keypair,
  passphrase: string,
  opts: ExportKeystoreOptions = {},
): Promise<Keystore> {
  assertPassphrase(passphrase);
  if (!keypair.canSign()) {
    throw new Error('Cannot export a keystore: this Keypair has no secret key (public-key only)');
  }
  const iterations = opts.iterations ?? DEFAULT_KEYSTORE_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error('iterations must be a positive integer');
  }

  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const publicKey = keypair.publicKey();
  const key = await deriveKey(passphrase, salt, iterations, 'encrypt');
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(publicKey) },
    key,
    keypair.rawSecretKey(),
  );

  return {
    version: KEYSTORE_VERSION,
    publicKey,
    kdf: 'pbkdf2-sha256',
    kdfparams: { iterations, salt: toBase64(salt) },
    cipher: 'aes-256-gcm',
    cipherparams: { iv: toBase64(iv) },
    ciphertext: toBase64(new Uint8Array(sealed)),
  };
}

/**
 * Decrypt a keystore (object or JSON string) back into a signing `Keypair`.
 *
 * @throws if the keystore is malformed, the passphrase is wrong, or the
 *   ciphertext/public key was tampered with.
 */
export async function decryptKeystore(
  keystore: Keystore | string,
  passphrase: string,
): Promise<Keypair> {
  assertPassphrase(passphrase);
  let ks: Keystore;
  try {
    ks = typeof keystore === 'string' ? (JSON.parse(keystore) as Keystore) : keystore;
  } catch {
    throw new Error('Invalid keystore: not valid JSON');
  }
  if (
    !ks || ks.version !== KEYSTORE_VERSION || ks.kdf !== 'pbkdf2-sha256' ||
    ks.cipher !== 'aes-256-gcm' || typeof ks.publicKey !== 'string' ||
    typeof ks.ciphertext !== 'string' || !ks.kdfparams || !ks.cipherparams ||
    typeof ks.kdfparams.salt !== 'string' || typeof ks.cipherparams.iv !== 'string' ||
    !Number.isInteger(ks.kdfparams.iterations) || ks.kdfparams.iterations < 1
  ) {
    throw new Error('Invalid or unsupported keystore');
  }

  let seed: ArrayBuffer;
  try {
    const key = await deriveKey(
      passphrase,
      fromBase64(ks.kdfparams.salt),
      ks.kdfparams.iterations,
      'decrypt',
    );
    seed = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(ks.cipherparams.iv),
        additionalData: new TextEncoder().encode(ks.publicKey),
      },
      key,
      fromBase64(ks.ciphertext),
    );
  } catch {
    // GCM authentication failure is indistinguishable between a wrong
    // passphrase and a modified file, and should not be told apart.
    throw new Error('Failed to decrypt keystore: wrong passphrase or corrupted keystore');
  }

  const keypair = Keypair.fromRawEd25519Seed(Buffer.from(seed));
  if (keypair.publicKey() !== ks.publicKey) {
    throw new Error('Keystore public key does not match the decrypted secret key');
  }
  return keypair;
}
