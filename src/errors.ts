/**
 * Each of the three Conduit contracts defines its own `Error` enum in Rust —
 * the same numeric code means something different in each one (e.g. code 1
 * is `NotAuthorized` on DripStream/DripGovernor, but `NotInitialized` on
 * DripFactory). See each contract's README error table / errors.rs. Treating
 * these as a single shared number space (as this module used to) means a
 * Factory `NotInitialized` gets silently reported as `NotAuthorized`.
 */
export type ConduitContract = 'stream' | 'factory' | 'governor';

// ── DripStream errors (contracts/stream/src/errors.rs) ────────────────────────

export enum StreamErrorCode {
  NotAuthorized        = 1,
  StreamNotFound       = 2,
  StreamCancelled      = 3,
  StreamNotStarted     = 4,
  StreamEnded          = 5,
  NothingToWithdraw    = 6,
  InsufficientDeposit  = 7,
  InvalidTimeRange     = 8,
  AlreadyPaused        = 9,
  NotPaused            = 10,
  ClawbackDisabled     = 11,
  ArithmeticOverflow   = 12,
  PauseThresholdNotMet = 13,
  AlreadyInitialized   = 14,
  InvalidAmount        = 15,
}

const STREAM_MESSAGES: Record<StreamErrorCode, string> = {
  [StreamErrorCode.NotAuthorized]:        'Caller is not the sender or recipient of this stream.',
  [StreamErrorCode.StreamNotFound]:       'Stream not found.',
  [StreamErrorCode.StreamCancelled]:      'This stream has been cancelled.',
  [StreamErrorCode.StreamNotStarted]:     'Stream has not started yet.',
  [StreamErrorCode.StreamEnded]:          'Stream has passed its end time.',
  [StreamErrorCode.NothingToWithdraw]:    'Nothing to withdraw — balance is zero.',
  [StreamErrorCode.InsufficientDeposit]:  'Deposit is too small for the requested stream duration.',
  [StreamErrorCode.InvalidTimeRange]:     'end_time must be greater than start_time.',
  [StreamErrorCode.AlreadyPaused]:        'Stream is already paused.',
  [StreamErrorCode.NotPaused]:            'Stream is not currently paused.',
  [StreamErrorCode.ClawbackDisabled]:     'Clawback was not enabled when this stream was created.',
  [StreamErrorCode.ArithmeticOverflow]:   'Integer overflow in stream calculation.',
  [StreamErrorCode.PauseThresholdNotMet]: 'force_cancel called before the 30-day pause threshold elapsed.',
  [StreamErrorCode.AlreadyInitialized]:   'Stream has already been initialized.',
  [StreamErrorCode.InvalidAmount]:        'Amount must be greater than zero.',
};

// ── DripFactory errors (contracts/factory/src/errors.rs) ──────────────────────

export enum FactoryErrorCode {
  NotInitialized      = 1,
  InvalidDeposit      = 2,
  InvalidRate         = 3,
  InvalidTimeRange    = 4,
  InsufficientDeposit = 5,
  BackdatedStream     = 6,
  AlreadyInitialized  = 7,
  RateExceedsMax      = 8,
  DurationTooShort    = 9,
  ArithmeticOverflow  = 10,
}

const FACTORY_MESSAGES: Record<FactoryErrorCode, string> = {
  [FactoryErrorCode.NotInitialized]:      'Factory has not been initialized.',
  [FactoryErrorCode.InvalidDeposit]:      'Deposit must be greater than zero.',
  [FactoryErrorCode.InvalidRate]:         'rate_per_sec must be greater than zero.',
  [FactoryErrorCode.InvalidTimeRange]:    'end_time must be greater than start_time.',
  [FactoryErrorCode.InsufficientDeposit]: "Deposit doesn't cover rate_per_sec for at least one second, or the full declared duration.",
  [FactoryErrorCode.BackdatedStream]:     'start_time cannot be in the past.',
  [FactoryErrorCode.AlreadyInitialized]:  'Factory has already been initialized.',
  [FactoryErrorCode.RateExceedsMax]:      "rate_per_sec exceeds the governor's max_rate_per_second.",
  [FactoryErrorCode.DurationTooShort]:    "Stream duration is below the governor's min_duration_seconds.",
  [FactoryErrorCode.ArithmeticOverflow]:  'Integer overflow validating deposit against duration.',
};

// ── DripGovernor errors (contracts/governor/src/errors.rs) ────────────────────

export enum GovernorErrorCode {
  NotAuthorized      = 1,
  InvalidParam       = 2,
  AlreadyInitialized = 3,
}

const GOVERNOR_MESSAGES: Record<GovernorErrorCode, string> = {
  [GovernorErrorCode.NotAuthorized]:      'Caller is not the current governor authority.',
  [GovernorErrorCode.InvalidParam]:       'Parameter failed validation (e.g. fee_bps > 10_000, zero duration/rate).',
  [GovernorErrorCode.AlreadyInitialized]: 'Governor has already been initialized.',
};

const MESSAGES_BY_CONTRACT: Record<ConduitContract, Record<number, string>> = {
  stream:   STREAM_MESSAGES,
  factory:  FACTORY_MESSAGES,
  governor: GOVERNOR_MESSAGES,
};

// ── Network / chain validation ─────────────────────────────────────────────────

/**
 * The exhaustive list of network identifiers the Conduit SDK supports.
 * Matches the `Network` type in `src/types/index.ts`.
 */
export const SUPPORTED_NETWORKS = ['mainnet', 'testnet', 'local'] as const;

/**
 * Thrown synchronously by `ConduitClient` constructor when an unrecognised
 * network string is supplied — before any RPC connection is attempted.
 *
 * @example
 * ```ts
 * try {
 *   const client = new ConduitClient({ network: 'ropsten' as any });
 * } catch (err) {
 *   if (err instanceof UnsupportedChainError) {
 *     console.error(err.message);           // "Unsupported network: 'ropsten'. ..."
 *     console.error(err.providedNetwork);   // "ropsten"
 *     console.error(err.supportedNetworks); // ["mainnet", "testnet", "local"]
 *   }
 * }
 * ```
 */
export class UnsupportedChainError extends Error {
  /** The network value the caller passed in. */
  readonly providedNetwork: string;
  /** The full list of accepted network identifiers at the time of the throw. */
  readonly supportedNetworks: readonly string[];

  constructor(providedNetwork: string) {
    const supported = SUPPORTED_NETWORKS.join(', ');
    super(
      `Unsupported network: '${providedNetwork}'. ` +
      `The Conduit SDK currently supports: ${supported}.`,
    );
    this.name = 'UnsupportedChainError';
    this.providedNetwork    = providedNetwork;
    this.supportedNetworks  = SUPPORTED_NETWORKS;
    // Maintain correct prototype chain for `instanceof` checks in transpiled JS.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConduitError extends Error {
  readonly contract: ConduitContract;
  readonly code: number;

  constructor(contract: ConduitContract, code: number, detail?: string) {
    super(detail ?? MESSAGES_BY_CONTRACT[contract][code] ?? `ConduitError(${contract}, #${code})`);
    this.name = 'ConduitError';
    this.contract = contract;
    this.code = code;
  }

  /** Builds a ConduitError from a raw `{ code: number }`-shaped contract error object. */
  static fromContractError(contract: ConduitContract, raw: unknown): ConduitError {
    if (raw && typeof raw === 'object' && 'code' in raw) {
      const code = Number((raw as { code: unknown }).code);
      if (code in MESSAGES_BY_CONTRACT[contract]) {
        return new ConduitError(contract, code);
      }
    }
    return new ConduitError(contract, -1, String(raw));
  }

  /**
   * Parses a Soroban simulation/transaction failure message (e.g.
   * `"HostError: Error(Contract, #7)"`) into a typed ConduitError scoped to
   * `contract`. Returns a plain Error (not a ConduitError) if no contract
   * error code can be extracted — network failures, timeouts, and non-contract
   * host traps don't carry one.
   */
  static fromSorobanMessage(contract: ConduitContract, message: string): Error {
    const match = /Error\(Contract,\s*#(\d+)\)/.exec(message);
    if (!match || !match[1]) return new Error(message);
    const code = Number(match[1]);
    if (!(code in MESSAGES_BY_CONTRACT[contract])) return new Error(message);
    return new ConduitError(contract, code, `${MESSAGES_BY_CONTRACT[contract][code]} (${message})`);
  }
}
