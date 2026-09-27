import { Keypair, Transaction } from '@stellar/stellar-sdk';

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

/** A Ledger hardware wallet signer that implements the `Signer` interface. */
export class LedgerSigner implements Signer {
  private readonly appName: string;
  private readonly path: string;

  constructor(options?: { appName?: string; path?: string }) {
    this.appName = options?.appName ?? 'Stellar';
    this.path = options?.path ?? "44'/148'/0'/0/0";
  }

  async sign(tx: Transaction): Promise<Transaction> {
    throw new LedgerHardwareError(
      LedgerErrorType.DeviceDisconnected,
      'Ledger device signing is not implemented. Ensure the Ledger device is connected and the Stellar app is open.',
    );
  }

  publicKey(): string {
    throw new LedgerHardwareError(
      LedgerErrorType.DeviceDisconnected,
      'Ledger public key retrieval is not implemented. Ensure the Ledger device is connected.',
    );
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
