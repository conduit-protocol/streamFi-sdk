import { SorobanRpc, xdr } from '@stellar/stellar-sdk';

/**
 * Each of the three Conduit contracts defines its own `Error` enum in Rust —
 * the same numeric code means something different in each one (e.g. code 1
 * is `NotAuthorized` on DripStream/DripGovernor, but `NotInitialized` on
 * DripFactory). See each contract's README error table / errors.rs. Treating
 * these as a single shared number space (as this module used to) means a
 * Factory `NotInitialized` gets silently reported as `NotAuthorized`.
 */
export type ConduitContract = 'stream' | 'factory' | 'governor';

/**
 * Sentinel value used by {@link ConduitError.fromContractError} when the
 * contract error code does not match any known code in the SDK's error
 * catalogue. Use this constant (or {@link ConduitError.isKnown}) instead
 * of hardcoding `-1` in consumer code.
 */
export const UNKNOWN_CONTRACT_ERROR_CODE = -1;

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

// ── Recovery hints ────────────────────────────────────────────────────────────
//
// A contract panic surfaces as `HostError(Error(Contract, #14))` — a bare
// numeric code with no indication of what to actually do about it. These
// hints are suggested next steps a caller (or a UI) can show alongside the
// descriptive message above, so "AlreadyInitialized" becomes "this is a
// one-time setup call" instead of a dead end.

const STREAM_RECOVERY_HINTS: Record<StreamErrorCode, string> = {
  [StreamErrorCode.NotAuthorized]:        'Verify the calling account matches the stream’s sender or recipient; sign with the correct keypair, wallet, or signer for this operation.',
  [StreamErrorCode.StreamNotFound]:       'Confirm the stream ID exists and was created on the network you’re currently connected to (mainnet vs. testnet IDs do not overlap).',
  [StreamErrorCode.StreamCancelled]:      'This stream was already cancelled — no further withdrawals, pauses, or resumes are possible. Create a new stream instead.',
  [StreamErrorCode.StreamNotStarted]:     'Wait until the stream’s startTime is reached before withdrawing or otherwise interacting with it.',
  [StreamErrorCode.StreamEnded]:          'The stream has passed its endTime. Withdraw any remaining balance; no further streaming will occur.',
  [StreamErrorCode.NothingToWithdraw]:    'Call withdrawable() first — the balance may already be fully withdrawn, or the stream may not have accrued anything yet.',
  [StreamErrorCode.InsufficientDeposit]:  'Increase depositAmount or shorten durationSeconds so the resulting rate covers at least one second of streaming.',
  [StreamErrorCode.InvalidTimeRange]:     'Ensure endTime (or stopTime) is strictly greater than startTime.',
  [StreamErrorCode.AlreadyPaused]:        'The stream is already paused — call resume() before pausing it again.',
  [StreamErrorCode.NotPaused]:            'The stream is not currently paused — pause() must be called before resume().',
  [StreamErrorCode.ClawbackDisabled]:     'This stream was created with clawbackEnabled: false. Clawback is only available on streams created with that flag set.',
  [StreamErrorCode.ArithmeticOverflow]:   'Reduce the amount, rate, or duration involved — the computation overflowed the contract’s 128-bit integer range.',
  [StreamErrorCode.PauseThresholdNotMet]: 'force_cancel requires the stream to have been paused for at least 30 days. Wait for the threshold to elapse, or use cancel() instead if you’re authorized to.',
  [StreamErrorCode.AlreadyInitialized]:   'This stream contract has already been initialized — initialize() is a one-time setup call per deployment.',
  [StreamErrorCode.InvalidAmount]:        'Provide an amount greater than zero.',
};

const FACTORY_RECOVERY_HINTS: Record<FactoryErrorCode, string> = {
  [FactoryErrorCode.NotInitialized]:      'The factory has not been initialized yet — this is normally done once during protocol deployment/governance setup.',
  [FactoryErrorCode.InvalidDeposit]:      'depositAmount must be greater than zero.',
  [FactoryErrorCode.InvalidRate]:         'The computed ratePerSecond must be greater than zero — check your depositAmount/durationSeconds math.',
  [FactoryErrorCode.InvalidTimeRange]:    'Ensure endTime is strictly greater than startTime.',
  [FactoryErrorCode.InsufficientDeposit]: 'Increase the deposit so it covers at least one second of streaming at the given rate across the full declared duration.',
  [FactoryErrorCode.BackdatedStream]:     'startTime must be now or in the future — check for clock skew or a stale timestamp before building the transaction.',
  [FactoryErrorCode.AlreadyInitialized]:  'The factory has already been initialized — this is a one-time setup call.',
  [FactoryErrorCode.RateExceedsMax]:      'Lower ratePerSecond below the governor’s configured max_rate_per_second, or ask governance to raise the limit.',
  [FactoryErrorCode.DurationTooShort]:    'Increase durationSeconds to at least the governor’s configured min_duration_seconds.',
  [FactoryErrorCode.ArithmeticOverflow]:  'Reduce the deposit or duration involved — the validation computation overflowed.',
};

const GOVERNOR_RECOVERY_HINTS: Record<GovernorErrorCode, string> = {
  [GovernorErrorCode.NotAuthorized]:      'Only the current governor authority can perform this action — verify you’re signing with the configured governor address.',
  [GovernorErrorCode.InvalidParam]:       'Check fee_bps (must be ≤ 10,000) and any duration/rate parameters passed to setConfig — one of them failed validation.',
  [GovernorErrorCode.AlreadyInitialized]: 'The governor has already been initialized — this is a one-time setup call.',
};

const RECOVERY_HINTS_BY_CONTRACT: Record<ConduitContract, Record<number, string>> = {
  stream:   STREAM_RECOVERY_HINTS,
  factory:  FACTORY_RECOVERY_HINTS,
  governor: GOVERNOR_RECOVERY_HINTS,
};

/** Fallback hint for a code with no dedicated entry (e.g. {@link UNKNOWN_CONTRACT_ERROR_CODE}). */
const DEFAULT_RECOVERY_HINT = 'No troubleshooting hint is available for this error code. Check the contract’s errors.rs and the Conduit protocol docs for its meaning.';

/**
 * Returns a human-readable, actionable troubleshooting hint for a
 * contract-scoped error code — the suggested next step a caller (or a UI)
 * can show alongside {@link ConduitError.message}. Falls back to
 * {@link DEFAULT_RECOVERY_HINT} for codes the SDK's catalogue doesn't
 * recognise for `contract` (including {@link UNKNOWN_CONTRACT_ERROR_CODE}).
 *
 * @example
 * ```ts
 * try {
 *   await client.streams.forceCancel(streamId);
 * } catch (err) {
 *   if (err instanceof ConduitError) {
 *     console.error(err.message);       // "force_cancel called before the 30-day pause threshold elapsed."
 *     console.error(err.recoveryHint);  // "force_cancel requires the stream to have been paused for ..."
 *   }
 * }
 * ```
 */
export function getRecoveryHint(contract: ConduitContract, code: number): string {
  return RECOVERY_HINTS_BY_CONTRACT[contract][code] ?? DEFAULT_RECOVERY_HINT;
}

// ── Network / chain validation ─────────────────────────────────────────────────

/**
 * The exhaustive list of network identifiers the Conduit SDK supports.
 * Matches the `Network` type in `src/types/index.ts`.
 */
export const SUPPORTED_NETWORKS = ['mainnet', 'testnet', 'local'] as const;

/**
 * Map from CAIP-2 chain identifiers (as used by WalletConnect adapters) to
 * the canonical SDK network names in {@link SUPPORTED_NETWORKS}. This is the
 * single source of truth shared by `ConduitClient`'s wallet network check
 * (`assertWalletNetworkMatch`) and `WalletConnectAdapter`'s construction-time
 * chain validation, so the two can never silently disagree about which chains
 * are supported (see #445).
 */
export const CAIP2_TO_NETWORK: Readonly<Record<string, string>> = {
  'stellar:pubnet':  'mainnet',
  'stellar:testnet': 'testnet',
  'stellar:local':   'local',
};

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

/**
 * The root error for any failure that originated from a Conduit smart
 * contract. The `contract` + `code` pair uniquely identifies the failure,
 * and `isKnown` tells you whether the SDK recognises the code in its
 * catalogue for that contract.
 *
 * Use {@link isConduitError} when you need a type guard instead of an
 * `instanceof` check (e.g. across bundle boundaries or when the error may
 * have been serialized).
 *
 * `recoveryHint` carries a suggested next step for the specific `code` (see
 * {@link getRecoveryHint}) — useful for surfacing actionable guidance instead
 * of a bare `HostError(Error(Contract, #14))`-style message in a UI or log.
 */
export class ConduitError extends Error {
  readonly contract: ConduitContract;
  readonly code: number;
  /** Suggested troubleshooting step for this error's `contract` + `code`. See {@link getRecoveryHint}. */
  readonly recoveryHint: string;

  constructor(contract: ConduitContract, code: number, detail?: string) {
    super(detail ?? MESSAGES_BY_CONTRACT[contract][code] ?? `ConduitError(${contract}, #${code})`);
    this.name = 'ConduitError';
    this.contract = contract;
    this.code = code;
    this.recoveryHint = getRecoveryHint(contract, code);
  }

  /**
   * Returns `true` when this error carries a known contract error code
   * (i.e. the code exists in the SDK's error catalogue for this contract).
   * Returns `false` when the code is {@link UNKNOWN_CONTRACT_ERROR_CODE}.
   */
  get isKnown(): boolean {
    return this.code in MESSAGES_BY_CONTRACT[this.contract];
  }

  /**
   * Builds a ConduitError from a raw `{ code: number }`-shaped contract error object.
   *
   * Error numbers are contract-scoped: the same numeric code can mean different
   * things on the stream, factory, and governor contracts. Always pass the
   * contract that produced the error; see the warning at the top of this file.
   */
  static fromContractError(contract: ConduitContract, raw: unknown): ConduitError {
    if (raw && typeof raw === 'object' && 'code' in raw) {
      const code = Number((raw as { code: unknown }).code);
      if (code in MESSAGES_BY_CONTRACT[contract]) {
        if (contract === 'governor' && code === GovernorErrorCode.InvalidParam) {
          return new GovernorInvalidParamError();
        }
        return new ConduitError(contract, code);
      }
    }
    return new ConduitError(contract, UNKNOWN_CONTRACT_ERROR_CODE, String(raw));
  }

  /**
   * Parses a Soroban simulation/transaction failure message (e.g.
   * `"HostError: Error(Contract, #7)"`) into a typed ConduitError scoped to
   * `contract`. Returns a plain Error (not a ConduitError) if no contract
   * error code can be extracted — network failures, timeouts, and non-contract
   * host traps don't carry one.
   *
   * Error numbers are contract-scoped, so passing the wrong contract can map a
   * valid code to the wrong meaning. See the collision warning at the top of
   * this file.
   */
  static fromSorobanMessage(contract: ConduitContract, message: string): Error {
    // Check for WasmVm / InvalidAction which signals an insufficient balance
    // on the Soroban host side (missing XLM for deposit + rent bump).
    if (/Error\(WasmVm,\s*InvalidAction\)/.test(message)) {
      return new InsufficientBalanceError(0n, 0n, message);
    }
    const match = /Error\(Contract,\s*#(\d+)\)/.exec(message);
    if (!match || !match[1]) return new Error(message);
    const code = Number(match[1]);
    if (!(code in MESSAGES_BY_CONTRACT[contract])) return new Error(message);

    // Return typed factory errors for high-value error codes
    if (contract === 'factory') {
      if (code === FactoryErrorCode.RateExceedsMax) {
        return new RateExceedsMaxError();
      }
      if (code === FactoryErrorCode.DurationTooShort) {
        return new DurationTooShortError();
      }
      if (code === FactoryErrorCode.BackdatedStream) {
        return new BackdatedStreamError();
      }
    }

    if (contract === 'governor' && code === GovernorErrorCode.InvalidParam) {
      return new GovernorInvalidParamError(`${MESSAGES_BY_CONTRACT[contract][code]} (${message})`);
    }

    return new ConduitError(contract, code, `${MESSAGES_BY_CONTRACT[contract][code]} (${message})`);
  }
}

// ── DripGovernor typed errors ─────────────────────────────────────────────────

/**
 * Thrown when the governor rejects a parameter as invalid
 * ({@link GovernorErrorCode.InvalidParam}), for example `fee_bps > 10_000` or a
 * zero duration or rate. It is a {@link ConduitError} with
 * `contract === 'governor'` and `code === GovernorErrorCode.InvalidParam`, so
 * callers can handle it with `instanceof` instead of checking `.code` by hand.
 *
 * @example
 * ```ts
 * try {
 *   await client.governor.setConfig({ ... });
 * } catch (err) {
 *   if (err instanceof GovernorInvalidParamError) {
 *     console.error('The governor config contains an invalid parameter.');
 *   }
 * }
 * ```
 */
export class GovernorInvalidParamError extends ConduitError {
  constructor(detail?: string) {
    super('governor', GovernorErrorCode.InvalidParam, detail);
    this.name = 'GovernorInvalidParamError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── DripStream typed read errors ──────────────────────────────────────────────

/**
 * Thrown when a stream ID cannot be resolved to an existing DripStream
 * contract. This is distinct from a transport failure or an invalid ID: the
 * lookup itself succeeded, but the contract returned no stream for the
 * requested ID.
 *
 * @example
 * ```ts
 * try {
 *   await client.streams.get(999n);
 * } catch (err) {
 *   if (err instanceof StreamNotFoundError) {
 *     console.error(`No stream exists for ID ${err.streamId}.`);
 *   }
 * }
 * ```
 */
export class StreamNotFoundError extends ConduitError {
  /** The stream ID that could not be resolved. */
  readonly streamId: bigint;

  constructor(streamId: bigint | string) {
    const id = BigInt(streamId);
    super('stream', StreamErrorCode.StreamNotFound, `Stream ${id} not found`);
    this.name = 'StreamNotFoundError';
    this.streamId = id;
    // Maintain correct prototype chain for `instanceof` checks in transpiled JS.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── DripStream typed lifecycle errors ───────────────────────────────────────────

/**
 * Thrown by {@link StreamsModule.withdraw} when the requested amount is
 * larger than what {@link StreamsModule.withdrawable} currently reports.
 * Carries the actual withdrawable amount so a UI can immediately show
 * "you can withdraw up to X" without a second round trip.
 *
 * @example
 * ```ts
 * try {
 *   await client.streams.withdraw(streamId, tooMuch);
 * } catch (err) {
 *   if (err instanceof AmountExceedsWithdrawableError) {
 *     console.error(`You can withdraw up to ${err.available} stroops.`);
 *   }
 * }
 * ```
 */
export class AmountExceedsWithdrawableError extends ConduitError {
  /** The actual amount currently withdrawable, in stroops. */
  readonly available: bigint;

  constructor(available: bigint, requested: bigint) {
    super(
      'stream',
      StreamErrorCode.NothingToWithdraw,
      `Requested amount (${requested}) exceeds the withdrawable balance (${available}).`,
    );
    this.name = 'AmountExceedsWithdrawableError';
    this.available = available;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a caller who is neither the stream's sender nor recipient
 * (depending on the action) attempts a lifecycle action restricted to one
 * of them — e.g. `cancel`, `pause`, `transferRecipient`, `clawback`.
 * Carries the attempted operation and the rejected caller address so a UI
 * can show "you don't have permission to do this" instead of a raw RPC
 * error string.
 *
 * @example
 * ```ts
 * try {
 *   await client.streams.cancel(streamId);
 * } catch (err) {
 *   if (err instanceof UnauthorizedStreamActionError) {
 *     console.error(`${err.caller} cannot ${err.operation} this stream.`);
 *   }
 * }
 * ```
 */
export class UnauthorizedStreamActionError extends ConduitError {
  /** The lifecycle method that was attempted, e.g. "cancel", "withdraw". */
  readonly operation: string;
  /** The address that was rejected by the contract's auth check. */
  readonly caller: string;

  constructor(operation: string, caller: string) {
    super(
      'stream',
      StreamErrorCode.NotAuthorized,
      `'${caller}' is not authorized to perform '${operation}' on this stream.`,
    );
    this.name = 'UnauthorizedStreamActionError';
    this.operation = operation;
    this.caller = caller;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The human-readable state names {@link InvalidStreamStateError} can carry,
 * derived from the specific {@link StreamErrorCode} the contract rejected
 * the call with.
 */
export type StreamLifecycleState = 'cancelled' | 'not_started' | 'ended' | 'paused' | 'active';

const STATE_BY_CODE: Partial<Record<StreamErrorCode, StreamLifecycleState>> = {
  [StreamErrorCode.StreamCancelled]:  'cancelled',
  [StreamErrorCode.StreamNotStarted]: 'not_started',
  [StreamErrorCode.StreamEnded]:      'ended',
  [StreamErrorCode.AlreadyPaused]:    'paused',
  [StreamErrorCode.NotPaused]:        'active',
};

/**
 * Thrown when a lifecycle action (`withdraw`, `cancel`, `pause`, `resume`,
 * `forceCancel`) is rejected because the stream is in the wrong state for
 * it — e.g. already cancelled, already paused, or not paused when trying to
 * resume. Carries the attempted operation and, where the rejected contract
 * error code maps to one, the stream's current state.
 *
 * @example
 * ```ts
 * try {
 *   await client.streams.resume(streamId);
 * } catch (err) {
 *   if (err instanceof InvalidStreamStateError) {
 *     console.error(`Cannot ${err.operation}: stream is ${err.currentState ?? 'in an invalid state'}.`);
 *   }
 * }
 * ```
 */
export class InvalidStreamStateError extends ConduitError {
  /** The lifecycle method that was attempted, e.g. "resume", "withdraw". */
  readonly operation: string;
  /** The stream's current state, if it could be inferred from the contract error code. */
  readonly currentState: StreamLifecycleState | undefined;

  constructor(operation: string, code: StreamErrorCode) {
    const currentState = STATE_BY_CODE[code];
    super(
      'stream',
      code,
      currentState
        ? `Cannot ${operation}: stream is ${currentState}.`
        : `Cannot ${operation}: stream is in an invalid state for this action.`,
    );
    this.name = 'InvalidStreamStateError';
    this.operation = operation;
    this.currentState = currentState;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by {@link StreamsModule.clawback} when the stream was created
 * without `clawbackEnabled: true`. Distinct from a generic RPC/contract
 * rejection so a caller can tell "clawback isn't enabled for this stream"
 * apart from any other failure.
 *
 * @example
 * ```ts
 * try {
 *   await client.streams.clawback(streamId);
 * } catch (err) {
 *   if (err instanceof ClawbackNotEnabledError) {
 *     console.error('This stream was not created with clawback enabled.');
 *   }
 * }
 * ```
 */
export class ClawbackNotEnabledError extends ConduitError {
  constructor() {
    super('stream', StreamErrorCode.ClawbackDisabled);
    this.name = 'ClawbackNotEnabledError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by {@link FactoryModule} when the stream's rate per second exceeds
 * the governor's configured maximum rate. Carries the rate and limit so a UI
 * can show "your rate (X stroops/sec) exceeds the maximum (Y stroops/sec)".
 *
 * @example
 * ```ts
 * try {
 *   await client.factory.create({ ... });
 * } catch (err) {
 *   if (err instanceof RateExceedsMaxError) {
 *     console.error(`Rate ${err.rate} exceeds max ${err.max}`);
 *   }
 * }
 * ```
 */
export class RateExceedsMaxError extends ConduitError {
  constructor() {
    super(
      'factory',
      FactoryErrorCode.RateExceedsMax,
    );
    this.name = 'RateExceedsMaxError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by {@link FactoryModule} when the stream duration is below the
 * governor's configured minimum duration. Carries the duration and minimum
 * so a UI can show "your duration (X seconds) is below the minimum (Y seconds)".
 *
 * @example
 * ```ts
 * try {
 *   await client.factory.create({ ... });
 * } catch (err) {
 *   if (err instanceof DurationTooShortError) {
 *     console.error(`Duration ${err.duration} is below minimum ${err.minimum}`);
 *   }
 * }
 * ```
 */
export class DurationTooShortError extends ConduitError {
  constructor() {
    super(
      'factory',
      FactoryErrorCode.DurationTooShort,
    );
    this.name = 'DurationTooShortError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by {@link FactoryModule} when the stream's start time is in the past.
 * A stream can only be created with a start time equal to or after the current
 * timestamp to avoid immediate backdated accrual.
 *
 * @example
 * ```ts
 * try {
 *   await client.factory.create({ ... });
 * } catch (err) {
 *   if (err instanceof BackdatedStreamError) {
 *     console.error('Stream start time cannot be in the past');
 *   }
 * }
 * ```
 */
export class BackdatedStreamError extends ConduitError {
  constructor() {
    super(
      'factory',
      FactoryErrorCode.BackdatedStream,
    );
    this.name = 'BackdatedStreamError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Inspects a {@link ConduitError} raised from a `DripStream` contract call
 * and, when its code matches a known lifecycle failure, rethrows the more
 * specific typed error ({@link UnauthorizedStreamActionError},
 * {@link InvalidStreamStateError}, or {@link ClawbackNotEnabledError})
 * instead. Any other error (including non-stream `ConduitError`s and plain
 * network errors) is rethrown unchanged.
 *
 * @internal
 */
export function translateStreamError(err: unknown, operation: string, caller: string): never {
  if (err instanceof ConduitError && err.contract === 'stream') {
    if (err.code === StreamErrorCode.NotAuthorized) {
      throw new UnauthorizedStreamActionError(operation, caller);
    }
    if (err.code === StreamErrorCode.ClawbackDisabled) {
      throw new ClawbackNotEnabledError();
    }
    if (err.code in STATE_BY_CODE) {
      throw new InvalidStreamStateError(operation, err.code as StreamErrorCode);
    }
  }
  throw err;
}

// ── Network error ──────────────────────────────────────────────────────────────

/**
 * Thrown when an RPC call fails due to a network-level error (e.g. Horizon /
 * Soroban RPC is unreachable, DNS resolution failure, connection refused).
 *
 * Frontends can catch this and display a 'Network Offline' banner.
 *
 * @example
 * ```ts
 * try {
 *   const stream = await client.streams.get(1n);
 * } catch (err) {
 *   if (err instanceof StreamFiNetworkError) {
 *     console.warn('Network offline:', err.cause);
 *   }
 * }
 * ```
 */
export class StreamFiNetworkError extends Error {
  /** The underlying error that caused the network failure. */
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'StreamFiNetworkError';
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Insufficient balance error ────────────────────────────────────────────────

/**
 * Thrown when the user does not have enough XLM in their account to cover the
 * deposit + rent bump (Soroban resource fees) required to create a stream.
 *
 * @example
 * ```ts
 * try {
 *   const result = await client.streams.create({ ... });
 * } catch (err) {
 *   if (err instanceof InsufficientBalanceError) {
 *     console.error(err.message); // 'You need at least 5.123 XLM to create this stream.'
 *     console.error(err.currentBalance); // 1234567890n (in stroops)
 *     console.error(err.requiredBalance); // 5123456789n (in stroops)
 *   }
 * }
 * ```
 */
export class InsufficientBalanceError extends Error {
  /** The account's current XLM balance in stroops. */
  readonly currentBalance: bigint;
  /** The minimum XLM balance required in stroops. */
  readonly requiredBalance: bigint;

  constructor(currentBalance: bigint, requiredBalance: bigint, detail?: string) {
    const current = fromStroopsInternal(currentBalance, 7);
    const required = fromStroopsInternal(requiredBalance, 7);
    super(
      detail
        ? `You need at least ${required} XLM to create this stream (you have ${current} XLM). (${detail})`
        : `You need at least ${required} XLM to create this stream (you have ${current} XLM).`,
    );
    this.name = 'InsufficientBalanceError';
    this.currentBalance = currentBalance;
    this.requiredBalance = requiredBalance;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Minimal internal version of `fromStroops` to avoid a circular dependency
 * with `utils.ts` (which imports StreamInfo type).
 */
function fromStroopsInternal(stroops: bigint, decimals: number): string {
  const factor = BigInt(10 ** decimals);
  const whole  = stroops / factor;
  const frac   = (stroops % factor).toString().padStart(decimals, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}


/**
 * Thrown when an RPC node responds with HTTP 429 (Too Many Requests) or
 * an equivalent JSON-RPC rate-limit error code, instead of the previous
 * generic/unclassified error that made rate limiting indistinguishable
 * from any other network failure. See #120.
 *
 * A 429 means the caller is being throttled: back off and retry against
 * the *same* endpoint. HTTP 503 (Service Unavailable) is a different
 * failure mode and is reported as {@link RpcServiceUnavailableError} so
 * consumers can distinguish "throttled" from "endpoint down".
 */
export class RateLimitError extends Error {
  /** Milliseconds to wait before retrying, parsed from a Retry-After header if present. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  private static parseRetryAfterMs(raw: unknown): number | undefined {
    if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;

    const value = String(raw).trim();
    if (!value) return undefined;

    const delaySeconds = Number(value);
    if (Number.isFinite(delaySeconds) && delaySeconds >= 0) {
      return delaySeconds * 1000;
    }

    const retryAt = Date.parse(value);
    if (!Number.isNaN(retryAt)) {
      return Math.max(0, retryAt - Date.now());
    }

    return undefined;
  }

  /**
   * Detects a rate-limit or service-unavailable condition from a raw error
   * thrown by the RPC client and converts it into a typed error. Handles
   * two shapes:
   *
   * 1. An axios-style error (network-level HTTP status), shaped like
   *    `{ response: { status, headers } }`.
   * 2. A raw JSON-RPC error object (rpc/jsonrpc.js does `throw response.data.error`
   *    directly, so it is a plain object, not an Error instance), shaped
   *    like `{ code: -32029 }`.
   *
   * HTTP 429 and the equivalent JSON-RPC codes map to a {@link RateLimitError}
   * (throttled — back off and retry the same endpoint), while HTTP 503 maps
   * to a {@link RpcServiceUnavailableError} (endpoint down — consider failing
   * over to a different RPC URL). See #456.
   *
   * Returns null if `raw` is neither a rate-limit nor a service-unavailable
   * error, so callers can fall back to their existing error handling.
   */
  static fromRpcError(raw: unknown): RateLimitError | RpcServiceUnavailableError | null {
    if (!raw || typeof raw !== 'object') return null;

    const response = (raw as { response?: { status?: number; headers?: Record<string, unknown> } }).response;
    if (response?.status === 429) {
      const retryAfterHeader = response.headers?.['retry-after'];
      const retryAfterMs = RateLimitError.parseRetryAfterMs(retryAfterHeader);
      return new RateLimitError(
        `RPC node rate limit exceeded (429). Back off and retry against the same endpoint.`,
        retryAfterMs,
      );
    }
    if (response?.status === 503) {
      const retryAfterHeader = response.headers?.['retry-after'];
      const retryAfterMs = RateLimitError.parseRetryAfterMs(retryAfterHeader);
      return new RpcServiceUnavailableError(
        `RPC node service unavailable (503). The endpoint may be down; consider failing over to a different RPC URL.`,
        retryAfterMs,
      );
    }

    // De facto "too many requests" JSON-RPC error code used by several
    // Soroban RPC providers, plus a literal 429 in case a provider reuses
    // the HTTP status as the JSON-RPC error code.
    const code = (raw as { code?: unknown }).code;
    if (code === 429 || code === -32029) {
      return new RateLimitError('RPC node rate limit exceeded (JSON-RPC error). Back off and retry.');
    }

    return null;
  }
}

/**
 * Thrown when an RPC node responds with HTTP 503 (Service Unavailable).
 *
 * Distinct from {@link RateLimitError}: a 429 means the caller is being
 * throttled and should back off and retry the *same* endpoint, while a 503
 * usually means the node/endpoint itself is down — the appropriate
 * remediation is to fail over to a different RPC URL rather than retrying
 * the same one. Consumers catching `RateLimitError` for backoff-and-retry
 * therefore never loop forever against a genuinely unavailable service.
 * See #456.
 */
export class RpcServiceUnavailableError extends Error {
  /** Milliseconds to wait before retrying, parsed from a Retry-After header if present. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'RpcServiceUnavailableError';
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Circuit open ───────────────────────────────────────────────────────────────

/**
 * Thrown by {@link withRetry} when a `circuitScope` is provided and
 * `rpc-circuit-state.ts` already reports that scope's circuit as `'open'`
 * (repeated recent failures). Rather than dutifully retrying with
 * exponential backoff against an endpoint the SDK itself has already
 * determined is down, `withRetry` fails fast with this error instead of
 * entering the retry loop. See #787.
 */
export class CircuitOpenError extends Error {
  /** The circuit scope (typically an RPC URL) that is currently open. */
  readonly scope: string;
  /** Epoch ms when the circuit will move to 'half-open' and allow a probe request. */
  readonly cooldownUntil: number | null;

  constructor(scope: string, cooldownUntil: number | null) {
    const waitMs = cooldownUntil !== null ? Math.max(0, cooldownUntil - Date.now()) : undefined;
    super(
      `Circuit for '${scope}' is open` +
        (waitMs !== undefined ? ` — retrying in ${waitMs}ms` : '') +
        '. Failing fast instead of retrying.',
    );
    this.name = 'CircuitOpenError';
    this.scope = scope;
    this.cooldownUntil = cooldownUntil;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Indexer timeout ────────────────────────────────────────────────────────────

/**
 * Thrown when a `GraphQLIndexer.query()` call exceeds its time budget
 * because the indexer is hung or too slow to respond.  The underlying
 * `fetch` is aborted via an `AbortController` wired into the timeout.
 *
 * @example
 * ```ts
 * try {
 *   const data = await indexer.query({ query: '...' });
 * } catch (err) {
 *   if (err instanceof IndexerTimeoutError) {
 *     console.warn(`Indexer did not respond within ${err.timeoutMs}ms`);
 *   }
 * }
 * ```
 */
export class IndexerTimeoutError extends Error {
  /** The indexer endpoint that timed out. */
  readonly endpoint: string;
  /** The timeout window in milliseconds that was exceeded. */
  readonly timeoutMs: number;

  constructor(endpoint: string, timeoutMs: number) {
    super(
      `GraphQL indexer query to ${endpoint} timed out after ${timeoutMs}ms. ` +
      `The query has been aborted.`,
    );
    this.name = 'IndexerTimeoutError';
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Operation aborted ─────────────────────────────────────────────────────────

/**
 * Thrown when an in-flight SDK operation is cancelled by the caller through
 * an `AbortSignal`. This gives consumers a typed, SDK-native way to
 * distinguish "the user cancelled" from network, contract, or indexer errors,
 * instead of relying on the generic DOM `AbortError`.
 *
 * @example
 * ```ts
 * const controller = new AbortController();
 * const promise = client.streams.create({ ... }, { signal: controller.signal });
 * controller.abort();
 * try { await promise; } catch (err) {
 *   if (err instanceof OperationAbortedError) {
    console.log('Cancelled by user:', err.operation);
   }
 }
 ```
 */
export class OperationAbortedError extends Error {
  /** Human-readable name of the operation that was aborted (e.g. "submitBatch"). */
  readonly operation: string;

  constructor(operation: string) {
    super(`Operation aborted: ${operation}`);
    this.name = 'OperationAbortedError';
    this.operation = operation;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Confirmation timeout error (#596) ─────────────────────────────────────────

/**
 * Thrown by `invokeContract()` when confirmation polling exceeds `maxAttempts`
 * without reaching a terminal `SUCCESS` or `FAILED` status, and `strict: true`
 * is enabled in the polling options.
 *
 * This allows callers to distinguish a confirmed transaction from an unconfirmed
 * or timed-out submission, while preserving access to the submitted transaction `hash`.
 */
export class ConfirmationTimeoutError extends Error {
  /** The transaction hash that was submitted to the network. */
  readonly hash: string;
  /** The number of poll attempts performed before timing out. */
  readonly attempts: number;
  /** The total polling duration in milliseconds before timing out. */
  readonly timeoutMs: number;

  constructor(hash: string, attempts: number, timeoutMs: number) {
    super(
      `Transaction confirmation timed out after ${attempts} attempts (${timeoutMs}ms): ${hash}. ` +
      `The transaction was submitted and may still confirm on-chain.`,
    );
    this.name = 'ConfirmationTimeoutError';
    this.hash = hash;
    this.attempts = attempts;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Signature timeout ─────────────────────────────────────────────────────────

/**
 * Thrown when a wallet or signer does not produce a signature within the
 * configured `signatureTimeoutMs` — e.g. the user opened a wallet popup and
 * forgot about it or closed it without rejecting.
 */
export class SignatureTimeoutError extends Error {
  /** The timeout window in milliseconds that was exceeded. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Signature request timed out after ${timeoutMs}ms without a response from the wallet or signer.`);
    this.name = 'SignatureTimeoutError';
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Wallet adapter errors ─────────────────────────────────────────────────────

/**
 * Thrown when the user dismisses a wallet prompt (closes the popup or rejects
 * the request) rather than the wallet failing. Apps can catch this to skip
 * showing an error alert for a deliberate cancellation.
 */
export class UserCancelledError extends Error {
  /** The wallet that reported the cancellation, e.g. `'albedo'`. */
  readonly wallet: string;

  constructor(wallet: string, message = `The ${wallet} request was cancelled by the user.`) {
    super(message);
    this.name = 'UserCancelledError';
    this.wallet = wallet;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** {@link UserCancelledError} raised by the Albedo adapter when its popup is closed. */
export class AlbedoCancelError extends UserCancelledError {
  constructor(message?: string) {
    super('albedo', message);
    this.name = 'AlbedoCancelError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the wallet's active network does not match the network the
 * client is configured for (e.g. Freighter on Testnet, client on Mainnet).
 */
export class NetworkMismatchError extends Error {
  readonly expectedPassphrase: string;
  readonly walletPassphrase: string;

  constructor(expectedPassphrase: string, walletPassphrase: string) {
    super(
      `Wallet network mismatch: the client expects "${expectedPassphrase}" ` +
        `but the wallet is connected to "${walletPassphrase}". Switch networks in the wallet and retry.`,
    );
    this.name = 'NetworkMismatchError';
    this.expectedPassphrase = expectedPassphrase;
    this.walletPassphrase = walletPassphrase;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a browser-extension wallet adapter's `signTransaction` call
 * does not resolve within its configured timeout — e.g. the user left the
 * Freighter popup open without approving or closing it, which would
 * otherwise hang the caller's promise indefinitely (#970).
 */
export class WalletTimeoutError extends Error {
  /** The wallet that failed to respond in time, e.g. `'freighter'`. */
  readonly wallet: string;
  /** The timeout window in milliseconds that was exceeded. */
  readonly timeoutMs: number;

  constructor(wallet: string, timeoutMs: number) {
    super(
      `${wallet} signTransaction timed out after ${timeoutMs}ms without a response. ` +
        'The wallet popup may have been left open — close it and retry.',
    );
    this.name = 'WalletTimeoutError';
    this.wallet = wallet;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the Albedo iframe returns a signed transaction whose
 * decorated signature is not a well-formed 64-byte Ed25519 signature.
 * Catches a malformed signature before it is submitted on-chain, where it
 * would otherwise fail with a less specific `bad_auth` error (#971).
 */
export class AlbedoInvalidSignatureError extends Error {
  /** The actual signature length Albedo returned, in bytes. */
  readonly actualLength: number;

  constructor(actualLength: number) {
    super(
      `Albedo returned a malformed signature: expected 64 bytes (Ed25519), got ${actualLength}. ` +
        'The transaction was not returned to the caller.',
    );
    this.name = 'AlbedoInvalidSignatureError';
    this.actualLength = actualLength;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Horizon transaction submission errors (#975) ──────────────────────────────

/**
 * The `extras.result_codes` block Horizon attaches to a failed
 * `/transactions` submission: the transaction-level result code, plus one
 * result code per operation in the envelope (same index as the operation).
 *
 * See https://developers.stellar.org/docs/data/horizon/api-reference/errors/result-codes.
 */
export interface HorizonResultCodes {
  /** The transaction-level result code, e.g. `'tx_bad_auth'`, `'tx_failed'`. */
  transaction?: string;
  /** Per-operation result codes, e.g. `'op_underfunded'`. Only present when `transaction === 'tx_failed'`. */
  operations?: string[];
}

/** Transaction/operation result codes that indicate a missing or invalid signature. */
const HORIZON_BAD_AUTH_CODES = new Set(['tx_bad_auth', 'tx_bad_auth_extra', 'op_bad_auth']);
/** Transaction/operation result codes that indicate the source account can't cover the operation. */
const HORIZON_UNDERFUNDED_CODES = new Set(['tx_insufficient_balance', 'op_underfunded', 'op_low_reserve']);

/**
 * Thrown by {@link mapHorizonError} when Horizon rejects a transaction for
 * `tx_bad_auth`, `tx_bad_auth_extra`, or `op_bad_auth` — the submitted
 * envelope is missing a required signature, carries an unexpected one, or a
 * signature does not verify against the signer's key.
 *
 * @example
 * ```ts
 * try {
 *   await horizonServer.submitTransaction(signedTx);
 * } catch (err) {
 *   const mapped = mapHorizonError(err);
 *   if (mapped instanceof BadAuthError) {
 *     console.error('Missing or invalid signature(s):', mapped.resultCodes);
 *   }
 * }
 * ```
 */
export class BadAuthError extends Error {
  /** The raw Horizon result codes this error was mapped from. */
  readonly resultCodes: HorizonResultCodes;

  constructor(resultCodes: HorizonResultCodes, detail?: string) {
    super(detail ?? 'Transaction rejected: missing or invalid signature(s).');
    this.name = 'BadAuthError';
    this.resultCodes = resultCodes;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by {@link mapHorizonError} for a Horizon result code that isn't one
 * of the dedicated typed errors ({@link BadAuthError},
 * {@link InsufficientBalanceError}) — e.g. `tx_bad_seq`, `op_no_trust`,
 * `op_no_destination`. Carries the raw result codes and response body so
 * callers can still branch on the specific code.
 *
 * @example
 * ```ts
 * const mapped = mapHorizonError(err);
 * if (mapped instanceof HorizonTransactionError) {
 *   console.error(mapped.resultCodes.transaction, mapped.resultCodes.operations);
 * }
 * ```
 */
export class HorizonTransactionError extends Error {
  /** The raw Horizon result codes this error was mapped from. */
  readonly resultCodes: HorizonResultCodes;
  /** The raw Horizon error response `mapHorizonError` was given. */
  readonly raw: unknown;

  constructor(resultCodes: HorizonResultCodes, detail?: string, raw?: unknown) {
    super(
      detail ??
        (resultCodes.transaction
          ? `Horizon rejected the transaction: ${resultCodes.transaction}` +
            (resultCodes.operations?.length ? ` (${resultCodes.operations.join(', ')})` : '')
          : 'Horizon rejected the transaction.'),
    );
    this.name = 'HorizonTransactionError';
    this.resultCodes = resultCodes;
    this.raw = raw;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Extracts `extras.result_codes` from a raw Horizon error response. Accepts
 * the plain Horizon JSON body (`{ extras: { result_codes } }`), an
 * axios-style wrapper (`{ response: { data: { extras } } }`), or a fetch-style
 * wrapper (`{ data: { extras } }`). Returns `null` when no result codes can
 * be found.
 *
 * @internal
 */
function extractHorizonResultCodes(json: unknown): HorizonResultCodes | null {
  if (!json || typeof json !== 'object') return null;

  const obj = json as Record<string, unknown>;
  const response = obj.response as { data?: unknown } | undefined;
  const data = obj.data as Record<string, unknown> | undefined;
  const body = (obj.extras ? obj : response?.data ?? data ?? obj) as Record<string, unknown>;

  const extras = body.extras as Record<string, unknown> | undefined;
  const resultCodes = extras?.result_codes as Record<string, unknown> | undefined;
  if (!resultCodes) return null;

  const transaction = typeof resultCodes.transaction === 'string' ? resultCodes.transaction : undefined;
  const operations = Array.isArray(resultCodes.operations)
    ? resultCodes.operations.filter((code): code is string => typeof code === 'string')
    : undefined;

  if (!transaction && !operations?.length) return null;
  const result: HorizonResultCodes = {};
  if (transaction !== undefined) result.transaction = transaction;
  if (operations !== undefined) result.operations = operations;
  return result;
}

/**
 * Converts a raw Horizon transaction-submission error (as thrown by
 * `Server.submitTransaction()` / `POST /transactions`) into a typed SDK
 * error, instead of leaving callers to parse `extras.result_codes` JSON by
 * hand.
 *
 * - `tx_bad_auth` / `tx_bad_auth_extra` / `op_bad_auth` → {@link BadAuthError}
 * - `tx_insufficient_balance` / `op_underfunded` / `op_low_reserve` →
 *   {@link InsufficientBalanceError} (balances are unknown from the Horizon
 *   response alone, so both are reported as `0n`; see `currentBalance`/
 *   `requiredBalance` in that class's docs)
 * - any other recognised `result_codes` → {@link HorizonTransactionError}
 * - anything without `extras.result_codes` (network failures, timeouts) is
 *   returned unchanged (wrapped in `Error` if it isn't one already), so this
 *   is safe to call in a catch block
 *
 * @example
 * ```ts
 * try {
 *   await horizonServer.submitTransaction(signedTx);
 * } catch (err) {
 *   throw mapHorizonError(err);
 * }
 * ```
 */
export function mapHorizonError(json: unknown): Error {
  const resultCodes = extractHorizonResultCodes(json);
  if (!resultCodes) {
    if (json instanceof Error) return json;
    return new Error(typeof json === 'string' ? json : String(json));
  }

  const codes = [resultCodes.transaction, ...(resultCodes.operations ?? [])].filter(
    (code): code is string => typeof code === 'string',
  );

  if (codes.some((code) => HORIZON_UNDERFUNDED_CODES.has(code))) {
    return new InsufficientBalanceError(0n, 0n, `Horizon result codes: ${codes.join(', ')}`);
  }
  if (codes.some((code) => HORIZON_BAD_AUTH_CODES.has(code))) {
    return new BadAuthError(resultCodes, `Transaction rejected: missing or invalid signature(s) (${codes.join(', ')}).`);
  }

  const detail =
    json && typeof json === 'object' && typeof (json as { detail?: unknown }).detail === 'string'
      ? (json as { detail: string }).detail
      : undefined;
  return new HorizonTransactionError(resultCodes, detail, json);
}

// ── Type guard ────────────────────────────────────────────────────────────────

/**
 * Returns `true` when `value` is a Conduit SDK error instance. Useful in
 * catch blocks, logging, and transport boundaries where you cannot rely on
 * `instanceof` across realms or bundled chunks.
 *
 * Recognised error classes:
 * - {@link SorobanRpcError}
 * - {@link ConduitError}
 * - {@link UnsupportedChainError}
 * - {@link StreamFiNetworkError}
 * - {@link InsufficientBalanceError}
 * - {@link RateLimitError}
 * - {@link RpcServiceUnavailableError}
 * - {@link IndexerTimeoutError}
 * - {@link OperationAbortedError}
 * - {@link StreamNotFoundError}
 * - {@link AmountExceedsWithdrawableError}
 * - {@link UnauthorizedStreamActionError}
 * - {@link InvalidStreamStateError}
 * - {@link ClawbackNotEnabledError}
 * - {@link RateExceedsMaxError}
 * - {@link DurationTooShortError}
 * - {@link BackdatedStreamError}
 * - {@link ConfirmationTimeoutError}
 * - {@link SignatureTimeoutError}
 * - {@link CircuitOpenError}
 * - {@link ValidationError}
 * - {@link IndexerMaxPagesExceededError}
 * - {@link UserCancelledError}
 * - {@link AlbedoCancelError}
 * - {@link NetworkMismatchError}
 * - {@link BadAuthError}
 * - {@link HorizonTransactionError}
 */
export function isConduitError(value: unknown): value is Error {
  if (!(value instanceof Error)) return false;
  return [
    'SorobanRpcError',
    'ConduitError',
    'UnsupportedChainError',
    'StreamFiNetworkError',
    'InsufficientBalanceError',
    'RateLimitError',
    'RpcServiceUnavailableError',
    'IndexerTimeoutError',
    'OperationAbortedError',
    'StreamNotFoundError',
    'AmountExceedsWithdrawableError',
    'UnauthorizedStreamActionError',
    'InvalidStreamStateError',
    'ClawbackNotEnabledError',
    'RateExceedsMaxError',
    'DurationTooShortError',
    'BackdatedStreamError',
    'ConfirmationTimeoutError',
    'SignatureTimeoutError',
    'CircuitOpenError',
    'ValidationError',
    'IndexerMaxPagesExceededError',
    'UserCancelledError',
    'AlbedoCancelError',
    'NetworkMismatchError',
    'BadAuthError',
    'HorizonTransactionError',
   ].includes(value.name);
}

/**
 * Result of decoding diagnostic events from a Soroban simulation error.
 * Extracts structured diagnostic information that is otherwise buried
 * in raw error strings.
 */
export interface SorobanDiagnosticInfo {
  /** Decoded diagnostic events from the simulation response. */
  diagnosticEvents: xdr.DiagnosticEvent[];
  /** Host function call stack extracted from diagnostic events, or null. */
  hostFunctionCallStack: string[] | null;
  /** Auth failure reasons extracted from diagnostic events, or null. */
  authFailureReasons: string[] | null;
  /** Raw error string from the RPC response. */
  rpcError: string;
}

/**
 * Error thrown when a Soroban contract call reverts or fails at the
 * RPC level. Unlike the generic `Error` strings previously thrown,
 * this class extracts structured diagnostic information from the
 * simulation response including diagnostic events, host function
 * call stack, and auth failure reasons.
 *
 * @example
 * ```ts
 * try {
 *   await client.streams.create({ ... });
 * } catch (err) {
 *   if (err instanceof SorobanRpcError) {
 *     console.error(err.rpcError);
 *     console.error('Diagnostic events:', err.diagnostics.diagnosticEvents);
 *     console.error('Call stack:', err.diagnostics.hostFunctionCallStack);
 *     console.error('Auth failures:', err.diagnostics.authFailureReasons);
 *   }
 * }
 * ```
 */
export class SorobanRpcError extends Error {
  /** The raw RPC error string. */
  readonly rpcError: string;
  /** Structured diagnostic information extracted from the simulation response. */
  readonly diagnostics: SorobanDiagnosticInfo;

  constructor(rpcError: string, diagnostics: SorobanDiagnosticInfo) {
    super(rpcError);
    this.name = 'SorobanRpcError';
    this.rpcError = rpcError;
    this.diagnostics = diagnostics;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Creates a {@link SorobanRpcError} from a Soroban simulation error response.
   * Extracts diagnostic events, host function call stack, and auth
   * failure reasons from the raw response.
   *
   * @param simError - The simulation error response from the Soroban RPC.
   * @returns A typed {@link SorobanRpcError} with structured diagnostics.
   */
  static fromSimulationError(simError: { error: string; events?: xdr.DiagnosticEvent[] | string[] }): SorobanRpcError {
    const rpcError = simError.error ?? 'Unknown Soroban RPC error';
    const events = simError.events ?? [];

    const diagnosticEvents = events.map(e =>
      typeof e === 'string' ? xdr.DiagnosticEvent.fromXDR(e, 'base64') : e
    );

    const hostFunctionCallStack = SorobanRpcError.extractHostFunctionCallStack(diagnosticEvents);
    const authFailureReasons = SorobanRpcError.extractAuthFailureReasons(diagnosticEvents);

    const diagnostics: SorobanDiagnosticInfo = {
      diagnosticEvents,
      hostFunctionCallStack,
      authFailureReasons,
      rpcError,
    };

    return new SorobanRpcError(rpcError, diagnostics);
  }

  /**
   * Creates a {@link SorobanRpcError} from a raw unknown error thrown by the RPC client.
   * Attempts to extract structured information from the error.
   *
   * @param raw - The raw error from the RPC client.
   * @returns A {@link SorobanRpcError} if the error can be decoded, or `null` if not.
   */
  static fromRaw(raw: unknown): SorobanRpcError | null {
    if (!raw || typeof raw !== 'object') return null;

    const resp = raw as { error?: unknown; events?: unknown; result?: { error?: unknown; events?: unknown } };
    const result = resp.result as { error?: unknown; events?: unknown } | undefined;
    const error = typeof resp.error === 'string' ? resp.error :
      typeof result?.error === 'string' ? String(result.error) : undefined;

    if (!error) return null;

    const events = resp.events ?? result?.events ?? [];
    return SorobanRpcError.fromSimulationError({ error, events: events as xdr.DiagnosticEvent[] | string[] });
  }

  /**
   * Attempts to extract a host function call stack from diagnostic events.
   * Returns null if no call stack can be identified.
   */
  private static extractHostFunctionCallStack(events: xdr.DiagnosticEvent[]): string[] | null {
    const callStack: string[] = [];
    for (const event of events) {
      try {
        const contractEvent = event.event();
        const body = contractEvent.body();
        const v0 = body.v0();
        const topics = v0.topics()?.map(t => t.toString()) ?? [];
        const data = v0.data();
        const dataStr = data?.toString() ?? '';
        if (topics.length > 0 || dataStr.length > 0) {
          callStack.push(`Topics: ${topics.join(', ')} | Data: ${dataStr}`);
        }
      } catch {
        // Skip events that can't be decoded
      }
    }
    return callStack.length > 0 ? callStack : null;
  }

  /**
   * Attempts to extract auth failure reasons from diagnostic events.
   * Returns null if no auth failures can be identified.
   */
  private static extractAuthFailureReasons(events: xdr.DiagnosticEvent[]): string[] | null {
    const reasons: string[] = [];
    for (const event of events) {
      try {
        const contractEvent = event.event();
        const body = contractEvent.body();
        const v0 = body.v0();
        const data = v0.data();
        if (data) {
          const valStr = data.toString();
          if (/auth/i.test(valStr) || /authorize/i.test(valStr) || /permission/i.test(valStr)) {
            reasons.push(valStr);
          }
        }
      } catch {
        // Skip events that can't be decoded
      }
    }
    return reasons.length > 0 ? reasons : null;
  }
}

// ── Validation error ─────────────────────────────────────────────────────────

/**
 * Thrown when a {@link StreamBuilder} fails validation with one or more
 * issues. Unlike the previous behaviour of throwing on the first problem,
 * `validate()` collects every issue and raises a single error so callers
 * can surface the full list in a form or toast.
 *
 * @example
 * ```ts
 * try {
 *   builder.build();
 * } catch (err) {
 *   if (err instanceof ValidationError) {
 *     console.error(err.message);     // "3 validation issue(s) ..."
 *     console.error(err.issues);      // ["token is required", ...]
 *   }
 * }
 * ```
 */
export class ValidationError extends Error {
  /** The individual validation messages collected by `validate()`. */
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    const summary = issues.length === 1
      ? issues[0]
      : `${issues.length} validation issue(s): ${issues.join('; ')}`;
    super(summary);
    this.name = 'ValidationError';
    this.issues = Object.freeze(issues.slice());
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by {@link GraphQLIndexer.fetchAll} when the paginated query
 * accumulates more pages than the configured maximum
 * (`DEFAULT_INDEXER_MAX_PAGES`, 1 000 by default), preventing runaway
 * memory usage or accidental full-table scans.
 *
 * Consumers can distinguish this from network failures or timeouts with a
 * standard `instanceof` check:
 *
 * @example
 * ```ts
 * try {
 *   const rows = await indexer.fetchAll({ query, getNextCursor });
 * } catch (err) {
 *   if (err instanceof IndexerMaxPagesExceededError) {
 *     console.error(
 *       `Query aborted after ${err.attemptedPages} pages ` +
 *       `(limit is ${err.maxPages}).`,
 *     );
 *   }
 * }
 * ```
 *
 * See #801.
 */
export class IndexerMaxPagesExceededError extends Error {
  /** The number of pages that had been fetched when the limit was hit. */
  readonly attemptedPages: number;
  /** The maximum number of pages that was configured. */
  readonly maxPages: number;

  constructor(attemptedPages: number, maxPages: number) {
    super(
      `GraphQLIndexer.fetchAll exceeded the maximum page limit of ${maxPages} ` +
      `(fetched ${attemptedPages} pages). ` +
      `Refine your query filters or increase the limit via fetchAllOptions.maxPages.`,
    );
    this.name = 'IndexerMaxPagesExceededError';
    this.attemptedPages = attemptedPages;
    this.maxPages = maxPages;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Recoverable error classification ─────────────────────────────────────────

const RECOVERABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RECOVERABLE_NODE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);
const RECOVERABLE_ERROR_NAMES = new Set([
  'RateLimitError', 'RpcServiceUnavailableError', 'StreamFiNetworkError',
  'IndexerTimeoutError', 'ConfirmationTimeoutError', 'CircuitOpenError', 'TimeoutError',
]);

function isRecoverableOnce(err: unknown): boolean | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as {
    name?: unknown; code?: unknown; status?: unknown;
    response?: { status?: unknown };
  };

  if (typeof e.name === 'string' && RECOVERABLE_ERROR_NAMES.has(e.name)) return true;
  // The caller cancelled; retrying would defy their intent.
  if (e.name === 'OperationAbortedError' || e.name === 'AbortError') return false;
  // Typed SDK errors that are not transport-related (contract rejections,
  // validation, signature timeouts) will fail identically on retry.
  if (isConduitError(err)) return false;

  const status = typeof e.status === 'number' ? e.status : e.response?.status;
  if (typeof status === 'number') return RECOVERABLE_HTTP_STATUSES.has(status);

  // JSON-RPC style numeric codes mirror the HTTP status (see RateLimitError).
  if (typeof e.code === 'number') return RECOVERABLE_HTTP_STATUSES.has(e.code) ? true : undefined;
  if (typeof e.code === 'string' && RECOVERABLE_NODE_CODES.has(e.code)) return true;

  // `fetch` rejects with a bare TypeError when the network is unreachable.
  if (err instanceof TypeError && /failed to fetch|network|load failed/i.test(err.message)) return true;
  return undefined;
}

/**
 * Returns `true` when `err` represents a transient failure that is worth
 * retrying or failing over to another RPC endpoint: rate limits, 408/425/429/5xx
 * HTTP statuses, socket-level errors (`ECONNRESET`, `ETIMEDOUT`, …), timeouts,
 * and an open circuit. Contract errors, validation errors, user aborts and
 * unknown values return `false`. The `cause` chain is followed.
 */
export function isRecoverableError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    const verdict = isRecoverableOnce(current);
    if (verdict !== undefined) return verdict;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ── Contract error parsing ────────────────────────────────────────────────────

/**
 * A human-readable diagnostic for a contract error code, keyed by the contract
 * that raised it. Used by {@link parseContractError} to describe codes that
 * cannot be mapped to a dedicated error class.
 */
export interface ContractErrorDiagnostic {
  /** The contract that raised the error. */
  contract: ConduitContract;
  /** The numeric contract error code. */
  code: number;
  /** The human-readable message for `code` on `contract`. */
  message: string;
}

/**
 * Extra context used to build the richer typed error classes.
 *
 * The dedicated error classes for some stream codes carry details that cannot
 * be recovered from the numeric code alone (the stream ID, the attempted
 * operation, the rejected caller). When this context is not supplied,
 * {@link parseContractError} falls back to a {@link ConduitError} — which
 * still carries the correct contract-scoped message — rather than inventing
 * placeholder values.
 */
export interface ContractErrorContext {
  /** The stream ID the failing call was operating on. */
  streamId?: bigint | string;
  /** The lifecycle operation that was attempted, e.g. `"withdraw"`. */
  operation?: string;
  /** The address that was rejected by the contract's auth check. */
  caller?: string;
}

/**
 * Error raised for a contract error code that could be parsed but does not map
 * to one of the dedicated typed errors — either because the code has no
 * dedicated class, or because the contract it belongs to could not be
 * determined unambiguously.
 *
 * Carries the parsed code (and diagnostic, when the contract is known) so
 * callers can still surface a meaningful message.
 *
 * @example
 * ```ts
 * try {
 *   await client.streams.withdraw(streamId);
 * } catch (err) {
 *   const parsed = parseContractError(err, 'stream');
 *   if (parsed instanceof ContractError) {
 *     console.error(`Contract error #${parsed.code}: ${parsed.message}`);
 *   }
 * }
 * ```
 */
export class ContractError extends Error {
  /** The contract that raised the error, when it could be determined. */
  readonly contract: ConduitContract | undefined;
  /** The numeric contract error code, when one could be extracted. */
  readonly code: number | undefined;
  /** The parsed diagnostic, when the code could be resolved to a contract. */
  readonly diagnostic: ContractErrorDiagnostic | undefined;
  /**
   * Suggested troubleshooting step for `code`, when `contract` is known
   * (see {@link getRecoveryHint}); falls back to {@link DEFAULT_RECOVERY_HINT}
   * when the contract couldn't be determined (e.g. an ambiguous code).
   */
  readonly recoveryHint: string;

  constructor(
    message: string,
    contract?: ConduitContract,
    code?: number,
    diagnostic?: ContractErrorDiagnostic,
  ) {
    super(message);
    this.name = 'ContractError';
    this.contract = contract;
    this.code = code;
    this.diagnostic = diagnostic;
    this.recoveryHint = contract !== undefined && code !== undefined
      ? getRecoveryHint(contract, code)
      : DEFAULT_RECOVERY_HINT;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Extracts a numeric contract error code from a raw error value.
 *
 * Recognises the shapes a Soroban contract error takes on the wire:
 * - `Error(Contract, #12)` embedded in an error message (the host error format);
 * - an object carrying a numeric `code` property (e.g. an `xdr.ScError`);
 * - an `Error` whose `cause` chain contains either of the above.
 *
 * Returns `undefined` when no contract error code can be found.
 *
 * @internal
 */
function extractContractErrorCode(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (typeof current === 'object') {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'number' && Number.isInteger(code) && code > 0) {
        return code;
      }
    }
    if (typeof current === 'string') {
      const match = /Error\(Contract,\s*#(\d+)\)/.exec(current);
      if (match?.[1]) return Number(match[1]);
    }
    if (current instanceof Error) {
      const match = /Error\(Contract,\s*#(\d+)\)/.exec(current.message);
      if (match?.[1]) return Number(match[1]);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Returns the contracts whose error catalogue defines `code`.
 *
 * Because error numbers are contract-scoped, the same numeric code can mean
 * different things on different contracts (e.g. code 1 is `NotAuthorized` on
 * DripStream/DripGovernor but `NotInitialized` on DripFactory). When more than
 * one contract defines a code, the code alone cannot identify the contract.
 *
 * @internal
 */
function contractsDefiningCode(code: number): ConduitContract[] {
  return (Object.keys(MESSAGES_BY_CONTRACT) as ConduitContract[]).filter(
    (contract) => code in MESSAGES_BY_CONTRACT[contract],
  );
}

/**
 * Parses an arbitrary error into a typed contract error.
 *
 * Soroban host errors surface as raw integers (e.g. `Error(Contract, #12)`),
 * which makes them hard to diagnose. This function extracts the numeric
 * contract error code from an unknown value and maps it to the matching typed
 * error class — {@link StreamNotFoundError}, {@link UnauthorizedStreamActionError},
 * {@link InvalidStreamStateError}, {@link ClawbackNotEnabledError},
 * {@link RateExceedsMaxError}, {@link DurationTooShortError},
 * {@link BackdatedStreamError}, {@link GovernorInvalidParamError} — or to a
 * {@link ConduitError} carrying the contract-scoped message.
 *
 * Error numbers are contract-scoped, so the `contract` argument tells the
 * parser which catalogue to read. When it is omitted, the parser only resolves
 * the code automatically if exactly one contract defines it; otherwise it
 * returns a {@link ContractError} listing the candidates instead of guessing
 * and reporting the wrong meaning.
 *
 * Errors that do not carry a contract error code (network failures, timeouts,
 * user cancellations) are returned unchanged, so this is safe to call in a
 * catch block.
 *
 * @param error - The raw error value to parse.
 * @param contract - The contract the error came from, when known.
 * @param context - Optional details used to build the richer typed errors.
 * @returns A typed contract error, or the original error when it carries no
 *          contract error code.
 *
 * @example
 * ```ts
 * try {
 *   await client.streams.withdraw(streamId);
 * } catch (err) {
 *   const parsed = parseContractError(err, 'stream', { streamId, operation: 'withdraw' });
 *   if (parsed instanceof ClawbackNotEnabledError) {
 *     console.error('Clawback was not enabled for this stream.');
 *   } else if (parsed instanceof ContractError) {
 *     console.error(`Contract error #${parsed.code}: ${parsed.message}`);
 *   }
 * }
 * ```
 */
export function parseContractError(
  error: unknown,
  contract?: ConduitContract,
  context: ContractErrorContext = {},
): Error {
  // Already a typed contract error — nothing to parse.
  if (error instanceof ConduitError) return error;

  const code = extractContractErrorCode(error);
  if (code === undefined) {
    // Not a contract error (network failure, timeout, user abort, …).
    return error instanceof Error ? error : new Error(String(error));
  }

  // Determine which contract's catalogue to read.
  let scope: ConduitContract;
  if (contract) {
    scope = contract;
  } else {
    const candidates = contractsDefiningCode(code);
    if (candidates.length !== 1) {
      const options = candidates
        .map((c) => `${c} #${code} (${MESSAGES_BY_CONTRACT[c][code]})`)
        .join(', ');
      return new ContractError(
        candidates.length === 0
          ? `Unknown contract error code #${code}.`
          : `Contract error code #${code} is ambiguous — it is defined by more than one contract: ${options}. Pass the contract to disambiguate.`,
        undefined,
        code,
      );
    }
    scope = candidates[0] as ConduitContract;
  }

  if (!(code in MESSAGES_BY_CONTRACT[scope])) {
    return new ContractError(
      `Unknown ${scope} contract error code #${code}.`,
      scope,
      code,
    );
  }

  // Map to the dedicated typed error class where one exists.
  switch (scope) {
    case 'governor':
      if (code === GovernorErrorCode.InvalidParam) {
        return new GovernorInvalidParamError();
      }
      break;
    case 'factory':
      if (code === FactoryErrorCode.RateExceedsMax) return new RateExceedsMaxError();
      if (code === FactoryErrorCode.DurationTooShort) return new DurationTooShortError();
      if (code === FactoryErrorCode.BackdatedStream) return new BackdatedStreamError();
      break;
    case 'stream':
      if (code === StreamErrorCode.ClawbackDisabled) return new ClawbackNotEnabledError();
      if (code === StreamErrorCode.NotAuthorized && context.operation && context.caller) {
        return new UnauthorizedStreamActionError(context.operation, context.caller);
      }
      if (code === StreamErrorCode.StreamNotFound && context.streamId !== undefined) {
        return new StreamNotFoundError(context.streamId);
      }
      if (code in STATE_BY_CODE && context.operation) {
        return new InvalidStreamStateError(context.operation, code as StreamErrorCode);
      }
      break;
  }

  return new ConduitError(scope, code);
}
