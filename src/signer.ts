import { Address, Keypair, Transaction, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { SignatureTimeoutError, UserCancelledError } from './errors.js';

/** Default time (ms) to wait for a wallet/signer to return a signature. */
export const DEFAULT_SIGNATURE_TIMEOUT_MS = 120_000;

export interface SignerOptions {
  /**
   * Max time (ms) to wait for a signature before rejecting with
   * {@link SignatureTimeoutError}. Default 120000. Set to `0` or `Infinity`
   * to wait indefinitely.
   */
  signatureTimeoutMs?: number;
}

/**
 * Races `pending` against a timer so a wallet popup that is never answered
 * cannot leave the caller hanging forever.
 */
export function withSignatureTimeout<T>(
  pending: Promise<T> | T,
  timeoutMs: number = DEFAULT_SIGNATURE_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(pending);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SignatureTimeoutError(timeoutMs)), timeoutMs);
    Promise.resolve(pending).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface Signer {
  /**
   * Sign `tx`. An implementation may either mutate `tx` in place and return
   * `void`, or return a new signed `Transaction` (the immutable pattern).
   * `StreamsModule._signTx` uses the return value when it is a `Transaction`
   * and falls back to the passed `tx` otherwise.
   */
  sign(tx: Transaction): Transaction | void | Promise<Transaction | void>;
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

// ── Ledger hardware wallet error codes ──────────────────────────────────

export enum LedgerErrorType {
  /** The user rejected the signing request on the Ledger device. */
  UserRejected = 'USER_REJECTED',
  /** The Ledger device is locked and requires a PIN unlock. */
  DeviceLocked = 'DEVICE_LOCKED',
  /** The Ledger Stellar app is not open on the device. */
  AppNotOpen = 'APP_NOT_OPEN',
  /** The Ledger device was disconnected during the operation. */
  DeviceDisconnected = 'DEVICE_DISCONNECTED',
  /** A transport-level error occurred (USB/Bluetooth). */
  TransportError = 'TRANSPORT_ERROR',
  /** The Ledger returned an invalid response or malformed data. */
  InvalidResponse = 'INVALID_RESPONSE',
  /** An unknown Ledger error code was received. */
  Unknown = 'UNKNOWN',
}

/** Map of Ledger status words to human-readable error types and messages. */
const LEDGER_ERROR_MAP: Record<number, { type: LedgerErrorType; message: string }> = {
  0x6982: { type: LedgerErrorType.UserRejected, message: 'Transaction rejected by the user on the Ledger device.' },
  0x6984: { type: LedgerErrorType.InvalidResponse, message: 'Invalid data received from the Ledger device.' },
  0x6985: { type: LedgerErrorType.AppNotOpen, message: 'Conditions not satisfied — ensure the Ledger Stellar app is open.' },
  0x6A80: { type: LedgerErrorType.InvalidResponse, message: 'Invalid parameters sent to the Ledger device.' },
  0x6B00: { type: LedgerErrorType.InvalidResponse, message: 'Invalid instruction sent to the Ledger device.' },
  0x6700: { type: LedgerErrorType.InvalidResponse, message: 'Wrong data length in Ledger response.' },
  0x6F00: { type: LedgerErrorType.TransportError, message: 'Generic Ledger transport error.' },
  0x9000: { type: LedgerErrorType.UserRejected, message: 'Ledger operation completed successfully.' },
};

/**
 * Normalizes a raw Ledger error code (status word) into a typed
 * `LedgerErrorType` and a human-readable message.
 *
 * @param statusCode The Ledger status word returned by the device.
 * @returns An object containing the error type and a human-readable message.
 */
export function normalizeLedgerError(statusCode: number): { type: LedgerErrorType; message: string } {
  return LEDGER_ERROR_MAP[statusCode] ?? { type: LedgerErrorType.Unknown, message: `Unknown Ledger error code: 0x${statusCode.toString(16).toUpperCase()}` };
}

/**
 * Checks whether an error originated from a Ledger hardware wallet
 * and, if so, returns the normalized `LedgerErrorType` and message.
 *
 * Returns `null` when the error is not a Ledger error.
 */
export function classifyLedgerError(error: unknown): { type: LedgerErrorType; message: string } | null {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(/Ledger status word: 0x([0-9A-Fa-f]{4})/);
  if (!match?.[1]) return null;
  const statusCode = parseInt(match[1], 16);
  return normalizeLedgerError(statusCode);
}

/**
 * Minimal contract a Ledger device adapter must satisfy, so the signer can be
 * unit-tested with a mock and wired to `@ledgerhq` (or any transport) in
 * production without a hard dependency on the hardware libraries (#912).
 */
export interface LedgerDevice {
  /** Resolve the Stellar public key for `path`. */
  getPublicKey(path: string): Promise<{ publicKey: string }>;
  /** Sign `txXdr`, returning the reconstructed signed transaction XDR. */
  signTransaction(path: string, txXdr: string): Promise<{ signature: Uint8Array; signedTxXdr: string }>;
}

/** A Ledger hardware wallet signer that implements the `Signer` interface (#912). */
/**
 * The subset of `@ledgerhq/hw-app-str`'s `StrApp` this adapter uses. Declared
 * locally because the package is an optional dependency resolved at runtime.
 */
interface LedgerStrApp {
  getPublicKey(path: string): Promise<{ publicKey: string }>;
  signTransaction(path: string, txXdr: string): Promise<{ signature: Uint8Array; signedTxXdr: string }>;
}

export class LedgerSigner implements Signer {
  private readonly appName: string;
  private readonly path: string;
  private readonly device: LedgerDevice | undefined;
  private cachedPublicKey: string | undefined;

  constructor(options?: { appName?: string; path?: string; device?: LedgerDevice; publicKey?: string }) {
    this.appName = options?.appName ?? 'Stellar';
    this.path = options?.path ?? "44'/148'/0'/0/0";
    this.device = options?.device;
    this.cachedPublicKey = options?.publicKey;
  }

  /**
   * Synchronous accessor required by the `Signer` interface. Ledger key
   * resolution is asynchronous, so the key must be supplied up front (e.g.
   * derived offline) or fetched first via {@link getPublicKey}; before that,
   * this throws a {@link LedgerHardwareError}.
   */
  publicKey(): string {
    if (!this.cachedPublicKey) {
      throw new LedgerHardwareError(
        LedgerErrorType.DeviceDisconnected,
        'Ledger public key not yet resolved — pass publicKey in the constructor or call getPublicKey() first.',
      );
    }
    return this.cachedPublicKey;
  }

  /** Fetch and cache the device public key for {@link publicKey}. */
  async getPublicKey(): Promise<string> {
    if (this.cachedPublicKey) return this.cachedPublicKey;
    const device = await this.resolveDevice();
    const { publicKey } = await device.getPublicKey(this.path);
    this.cachedPublicKey = publicKey;
    return publicKey;
  }

  /** Sign `tx` on the device and return the reconstructed transaction. */
  async sign(tx: Transaction): Promise<Transaction> {
    const device = await this.resolveDevice();
    const { signedTxXdr } = await device.signTransaction(this.path, tx.toXDR());
    const passphrase = (tx as { networkPassphrase?: string }).networkPassphrase ?? '';
    return new Transaction(signedTxXdr, passphrase);
  }

  /**
   * Use the injected device when present; otherwise lazily wire the real
   * `@ledgerhq` app over a WebUSB transport. The libraries are only imported
   * here (not at module load) so the SDK builds and tests without them
   * installed — production callers typically inject their own device.
   */
  private async resolveDevice(): Promise<LedgerDevice> {
    if (this.device) return this.device;
    try {
      // The hardware libraries are imported lazily (not at module load) so the
      // SDK builds and tests without them installed. Production callers typically
      // inject their own device instead. The specifiers are kept in variables so
      // bundler/transform import-analysis cannot try to statically resolve these
      // optional deps (which may be absent from the dependency tree).
      const ledgerAppModule = '@ledgerhq/hw-app-str';
      const ledgerTransportModule = '@ledgerhq/hw-transport-webusb';
      const hwApp = (await import(ledgerAppModule)) as {
        default: new (transport: unknown) => LedgerStrApp;
      };
      const transportMod = (await import(ledgerTransportModule)) as {
        default?: { create: () => Promise<unknown> };
        create?: () => Promise<unknown>;
      };
      const TransportWebUSB = transportMod.default ?? transportMod;
      if (typeof TransportWebUSB?.create !== 'function') {
        throw new Error('Ledger transport could not be loaded');
      }
      const t = await TransportWebUSB.create();
      const app = new hwApp.default(t);
      return {
        getPublicKey: (path: string) => app.getPublicKey(path),
        signTransaction: (path: string, txXdr: string) => app.signTransaction(path, txXdr),
      };
    } catch {
      throw new LedgerHardwareError(
        LedgerErrorType.TransportError,
        'Ledger device not available: inject a LedgerDevice or install @ledgerhq/hw-app-str and @ledgerhq/hw-transport-webusb.',
      );
    }
  }
}

/** Error thrown when a Ledger hardware wallet operation fails. */
export class LedgerHardwareError extends Error {
  readonly type: LedgerErrorType;

  constructor(type: LedgerErrorType, message: string) {
    super(message);
    this.name = 'LedgerHardwareError';
    this.type = type;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── WebAuthn / Passkey signing (#966) ─────────────────────────────────────
//
// Modern Soroban "smart wallet" accounts verify authorizations with a
// SECP256R1 (P-256) signature produced by a WebAuthn passkey instead of the
// classic Ed25519 `G...` keypair. Stellar transaction envelopes only support
// Ed25519 signatures, though — a passkey can never classically `tx.sign()`.
// Instead, a passkey-backed account authorizes *individual contract
// invocations* by signing a `SorobanAuthorizationEntry`'s hash (see
// `authorizeEntry` below), independent of the envelope signature. That's why
// `WebAuthnSigner.sign()` is a no-op (the smart-wallet contract account
// needs no envelope signature of its own) while the real work happens in
// `authorizeEntry()`.
//
// `@stellar/stellar-sdk` ships its own `authorizeEntry` helper, but it
// hardcodes Ed25519 verification and an `{ public_key, signature }`
// credential shape — it cannot produce a WebAuthn assertion's credential
// (`authenticator_data` + `client_data_json` + a raw SECP256R1 signature),
// nor can it address a contract account (`C...`) rather than an Ed25519 one.
// This reimplements the same preimage/payload hashing the SDK's helper uses
// (see `@stellar/stellar-base`'s `lib/auth.js`) but encodes the WebAuthn
// assertion in its place.

/** Raw credential material for a registered WebAuthn passkey. */
export interface WebAuthnCredentialDescriptor {
  /** Credential ID, as returned by `PublicKeyCredential.rawId` at registration time. */
  id: Uint8Array;
}

/**
 * Duck-typed subset of the DOM `AuthenticatorAssertionResponse` this signer
 * reads from. Declared locally (rather than relying on `lib.dom.d.ts`) since
 * the SDK's `tsconfig` targets `ES2022` only, with no DOM lib.
 */
export interface WebAuthnAssertionResponse {
  authenticatorData: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
  /** ASN.1 DER-encoded `ECDSA-Sig-Value`, as returned by the authenticator. */
  signature: ArrayBuffer;
}

/** Duck-typed subset of the DOM `PublicKeyCredential` carrying an assertion response. */
export interface WebAuthnAssertionCredential {
  response: WebAuthnAssertionResponse;
}

/** Duck-typed subset of the DOM `CredentialsContainer`, injectable for tests and non-browser runtimes. */
export interface WebAuthnCredentialsContainer {
  get(options: {
    publicKey: {
      challenge: Uint8Array;
      allowCredentials: { id: Uint8Array; type: 'public-key' }[];
      rpId?: string;
      userVerification?: 'required' | 'preferred' | 'discouraged';
    };
  }): Promise<WebAuthnAssertionCredential | null>;
}

/** Field names used when encoding a WebAuthn assertion into a Soroban authorization entry's credential `ScVal`. */
export interface WebAuthnCredentialScValKeys {
  authenticatorData?: string;
  clientDataJSON?: string;
  signature?: string;
}

const DEFAULT_WEBAUTHN_SCVAL_KEYS: Required<WebAuthnCredentialScValKeys> = {
  authenticatorData: 'authenticator_data',
  clientDataJSON: 'client_data_json',
  signature: 'signature',
};

export interface WebAuthnSignerOptions {
  /** The Soroban smart-wallet contract address (`C...`) this signer authorizes invocations for. */
  contractAddress: string;
  /** The passkey credential enrolled for `contractAddress` by that wallet contract's own registration flow. */
  credential: WebAuthnCredentialDescriptor;
  /** Injected `navigator.credentials`-like container. Defaults to `globalThis.navigator.credentials`. */
  credentials?: WebAuthnCredentialsContainer;
  /** Relying party ID passed to `credentials.get()`. Omit to let the platform default to the current origin. */
  rpId?: string;
  /** `userVerification` passed to `credentials.get()`. Default `'preferred'`. */
  userVerification?: 'required' | 'preferred' | 'discouraged';
  /**
   * Map keys used when encoding the WebAuthn assertion into the
   * authorization entry's credential `ScVal`. Override these if your
   * on-chain account contract expects different field names; defaults match
   * the `{authenticator_data, client_data_json, signature}` convention
   * common to SECP256R1/WebAuthn Soroban smart-wallet contracts.
   */
  credentialScValKeys?: WebAuthnCredentialScValKeys;
}

/**
 * Converts an ASN.1 DER-encoded ECDSA signature — `ECDSA-Sig-Value ::=
 * SEQUENCE { r INTEGER, s INTEGER }`, the format every WebAuthn authenticator
 * returns — into the fixed-width raw `r || s` (32 bytes each, 64 total) that
 * Soroban's `secp256r1_verify` host function and SECP256R1 smart-wallet
 * contracts expect.
 *
 * @throws if `der` is not a well-formed two-integer `ECDSA-Sig-Value` sequence.
 */
export function derToRawSignature(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der[0] !== 0x30) {
    throw new Error(
      `Malformed DER signature: expected a SEQUENCE (0x30) of at least 8 bytes, got ${describeByte(der[0])} (${der.length} bytes)`,
    );
  }
  const { next: seqStart } = readDerLength(der, 1);
  const r = readDerInteger(der, seqStart);
  const s = readDerInteger(der, r.next);
  const raw = new Uint8Array(64);
  raw.set(derIntegerToFixedWidth(r.value, 32), 0);
  raw.set(derIntegerToFixedWidth(s.value, 32), 32);
  return raw;
}

function describeByte(b: number | undefined): string {
  return b === undefined ? '<nothing>' : `0x${b.toString(16).padStart(2, '0')}`;
}

/** Reads a DER length (short or long form) starting at `offset`. */
function readDerLength(buf: Uint8Array, offset: number): { length: number; next: number } {
  const first = buf[offset];
  if (first === undefined) {
    throw new Error('Malformed DER signature: unexpected end of input while reading a length');
  }
  if ((first & 0x80) === 0) {
    return { length: first, next: offset + 1 };
  }
  const numBytes = first & 0x7f;
  if (numBytes === 0 || numBytes > 4) {
    throw new Error('Malformed DER signature: unsupported length encoding');
  }
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    const b = buf[offset + 1 + i];
    if (b === undefined) {
      throw new Error('Malformed DER signature: unexpected end of input while reading a length');
    }
    length = (length << 8) | b;
  }
  return { length, next: offset + 1 + numBytes };
}

/** Reads one DER `INTEGER` (tag 0x02) starting at `offset`. */
function readDerInteger(buf: Uint8Array, offset: number): { value: Uint8Array; next: number } {
  const tag = buf[offset];
  if (tag !== 0x02) {
    throw new Error(`Malformed DER signature: expected an INTEGER (0x02), got ${describeByte(tag)}`);
  }
  const { length, next } = readDerLength(buf, offset + 1);
  if (length === 0 || next + length > buf.length) {
    throw new Error('Malformed DER signature: INTEGER has an invalid length');
  }
  return { value: buf.slice(next, next + length), next: next + length };
}

/** Strips DER's sign-padding `0x00` byte (if any) and left-pads to `width` bytes. */
function derIntegerToFixedWidth(value: Uint8Array, width: number): Uint8Array {
  let trimmed = value;
  while (trimmed.length > width && trimmed[0] === 0x00) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.length > width) {
    throw new Error(`Malformed DER signature: INTEGER is ${trimmed.length} bytes, expected at most ${width}`);
  }
  const out = new Uint8Array(width);
  out.set(trimmed, width - trimmed.length);
  return out;
}

/**
 * A `Signer` for Soroban smart-wallet accounts authorized by a WebAuthn
 * passkey instead of an Ed25519 keypair.
 *
 * `publicKey()` returns the smart-wallet's contract address (`C...`) — valid
 * wherever the SDK accepts a stream `sender`/`recipient` `Address`, since
 * Soroban addresses may be either an account or a contract. `sign()` is a
 * no-op (see the module-level note above); call {@link authorizeEntry} on
 * each `SorobanAuthorizationEntry` your invocation needs signed, before
 * submitting the transaction:
 *
 * @example
 * ```ts
 * const signer = new WebAuthnSigner({
 *   contractAddress: 'C...',
 *   credential: { id: enrolledCredentialId },
 * });
 *
 * const sim = await server.simulateTransaction(tx);
 * const op = tx.operations[0] as Operation.InvokeHostFunction;
 * op.auth = await Promise.all(
 *   (op.auth ?? []).map((entry) =>
 *     signer.authorizeEntry(entry, currentLedger + 100, Networks.TESTNET),
 *   ),
 * );
 * ```
 */
export class WebAuthnSigner implements Signer {
  private readonly contractAddress: string;
  private readonly credential: WebAuthnCredentialDescriptor;
  private readonly credentialsContainer: WebAuthnCredentialsContainer;
  private readonly rpId: string | undefined;
  private readonly userVerification: 'required' | 'preferred' | 'discouraged';
  private readonly scValKeys: Required<WebAuthnCredentialScValKeys>;

  constructor(options: WebAuthnSignerOptions) {
    this.contractAddress = options.contractAddress;
    this.credential = options.credential;
    this.credentialsContainer = options.credentials ?? WebAuthnSigner.defaultCredentialsContainer();
    this.rpId = options.rpId;
    this.userVerification = options.userVerification ?? 'preferred';
    this.scValKeys = { ...DEFAULT_WEBAUTHN_SCVAL_KEYS, ...options.credentialScValKeys };
  }

  private static defaultCredentialsContainer(): WebAuthnCredentialsContainer {
    const nav = (globalThis as unknown as {
      navigator?: { credentials?: WebAuthnCredentialsContainer };
    }).navigator;
    if (!nav?.credentials) {
      throw new Error(
        'WebAuthnSigner: no `navigator.credentials` is available in this environment. ' +
        'Pass a `credentials` implementation explicitly (required in Node/tests, and on non-browser runtimes).',
      );
    }
    return nav.credentials;
  }

  /** The smart-wallet contract address (`C...`) this signer authorizes for. */
  publicKey(): string {
    return this.contractAddress;
  }

  /**
   * No-op. A WebAuthn-authorized smart-wallet account carries no Ed25519
   * envelope signature of its own — Stellar transactions only support
   * Ed25519 signatures, which this signer's SECP256R1 passkey cannot
   * produce. Returns `tx` unchanged so this remains a drop-in `Signer` for
   * callers that invoke `signer.sign(tx)` generically; authorize this
   * signer's invocations with {@link authorizeEntry} instead.
   */
  sign(tx: Transaction): Transaction {
    return tx;
  }

  /**
   * Signs one Soroban authorization entry for this signer's smart-wallet
   * account: requests a WebAuthn assertion over the entry's authorization
   * payload (the same `sha256(HashIdPreimageSorobanAuthorization)` hash
   * `@stellar/stellar-sdk`'s own `authorizeEntry` signs for Ed25519 keys),
   * then encodes the assertion into the entry's credential `ScVal`.
   *
   * Entries whose credentials are not address-scoped (source-account
   * credentials) are returned unchanged, matching `authorizeEntry`'s own
   * behavior.
   *
   * @param entry                An unsigned authorization entry, typically
   *                              from `simulateTransaction`'s result.
   * @param validUntilLedgerSeq  The (exclusive) ledger sequence until which
   *                              this authorization is valid.
   * @param networkPassphrase    The network the transaction will be
   *                              submitted to (see `Networks`).
   * @throws {UserCancelledError} if the WebAuthn request is cancelled or returns no credential.
   * @throws if the entry's address does not match {@link publicKey}.
   */
  async authorizeEntry(
    entry: xdr.SorobanAuthorizationEntry,
    validUntilLedgerSeq: number,
    networkPassphrase: string,
  ): Promise<xdr.SorobanAuthorizationEntry> {
    if (
      entry.credentials().switch().value !==
      xdr.SorobanCredentialsType.sorobanCredentialsAddress().value
    ) {
      return entry;
    }

    const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    const addrAuth = clone.credentials().address();

    const entryAddress = Address.fromScAddress(addrAuth.address()).toString();
    if (entryAddress !== this.contractAddress) {
      throw new Error(
        `WebAuthnSigner: authorization entry is for '${entryAddress}', not this signer's '${this.contractAddress}'.`,
      );
    }

    addrAuth.signatureExpirationLedger(validUntilLedgerSeq);
    const networkId = hash(Buffer.from(networkPassphrase));
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId,
        nonce: addrAuth.nonce(),
        invocation: clone.rootInvocation(),
        signatureExpirationLedger: addrAuth.signatureExpirationLedger(),
      }),
    );
    const payload = hash(preimage.toXDR());

    const assertion = await this.requestAssertion(payload);
    const rawSignature = derToRawSignature(new Uint8Array(assertion.response.signature));

    const sigScVal = nativeToScVal(
      {
        [this.scValKeys.authenticatorData]: Buffer.from(assertion.response.authenticatorData),
        [this.scValKeys.clientDataJSON]: Buffer.from(assertion.response.clientDataJSON),
        [this.scValKeys.signature]: Buffer.from(rawSignature),
      },
      {
        type: {
          [this.scValKeys.authenticatorData]: ['symbol', null],
          [this.scValKeys.clientDataJSON]: ['symbol', null],
          [this.scValKeys.signature]: ['symbol', null],
        },
      },
    );
    addrAuth.signature(xdr.ScVal.scvVec([sigScVal]));
    return clone;
  }

  private async requestAssertion(challenge: Buffer): Promise<WebAuthnAssertionCredential> {
    const assertion = await this.credentialsContainer.get({
      publicKey: {
        challenge: new Uint8Array(challenge),
        allowCredentials: [{ id: this.credential.id, type: 'public-key' }],
        ...(this.rpId !== undefined ? { rpId: this.rpId } : {}),
        userVerification: this.userVerification,
      },
    });
    if (!assertion) {
      throw new UserCancelledError(
        'webauthn',
        'The WebAuthn signing request was cancelled, or returned no credential.',
      );
    }
    return assertion;
  }
}
