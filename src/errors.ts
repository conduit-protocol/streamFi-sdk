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
 */
export class ConduitError extends Error {
  readonly contract: ConduitContract;
  readonly code: number;

  constructor(contract: ConduitContract, code: number, detail?: string) {
    super(detail ?? MESSAGES_BY_CONTRACT[contract][code] ?? `ConduitError(${contract}, #${code})`);
    this.name = 'ConduitError';
    this.contract = contract;
    this.code = code;
  }

  /**
   * Returns `true` when this error carries a known contract error code
   * (i.e. the code exists in the SDK's error catalogue for this contract).
   * Returns `false` when the code is {@link UNKNOWN_CONTRACT_ERROR_CODE}.
   */
  get isKnown(): boolean {
    return this.code in MESSAGES_BY_CONTRACT[this.contract];
  }

  /** Builds a ConduitError from a raw `{ code: number }`-shaped contract error object. */
  static fromContractError(contract: ConduitContract, raw: unknown): ConduitError {
    if (raw && typeof raw === 'object' && 'code' in raw) {
      const code = Number((raw as { code: unknown }).code);
      if (code in MESSAGES_BY_CONTRACT[contract]) {
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
    return new ConduitError(contract, code, `${MESSAGES_BY_CONTRACT[contract][code]} (${message})`);
  }
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

// ── Type guard ────────────────────────────────────────────────────────────────

/**
 * Returns `true` when `value` is a Conduit SDK error instance. Useful in
 * catch blocks, logging, and transport boundaries where you cannot rely on
 * `instanceof` across realms or bundled chunks.
 *
 * Recognised error classes:
 * - {@link ConduitError}
 * - {@link UnsupportedChainError}
 * - {@link StreamFiNetworkError}
 * - {@link InsufficientBalanceError}
 * - {@link RateLimitError}
 * - {@link RpcServiceUnavailableError}
 * - {@link IndexerTimeoutError}
 * - {@link OperationAbortedError}
 */
export function isConduitError(value: unknown): value is Error {
  if (!(value instanceof Error)) return false;
  return [
    'ConduitError',
    'UnsupportedChainError',
    'StreamFiNetworkError',
    'InsufficientBalanceError',
    'RateLimitError',
    'RpcServiceUnavailableError',
    'IndexerTimeoutError',
    'OperationAbortedError',
    'ValidationError',
  ].includes(value.name);
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
