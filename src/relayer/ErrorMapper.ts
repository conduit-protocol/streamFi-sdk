import { SorobanRpc } from '@stellar/stellar-sdk';
import type { WebSocketRelayer, WebSocketMessage, MessageHandler } from './WebSocketRelayer.js';
import {
  ConduitError,
  FactoryErrorCode,
  GovernorErrorCode,
  SorobanRpcError,
  StreamErrorCode,
  type ConduitContract,
} from '../errors.js';

/**
 * Maps a raw Horizon transaction-submission error (`extras.result_codes`,
 * e.g. `tx_bad_auth`, `op_underfunded`) to a typed SDK error
 * ({@link BadAuthError}, {@link InsufficientBalanceError}, or
 * {@link HorizonTransactionError}). Re-exported here — alongside
 * {@link ErrorMapper}, which does the equivalent job for WebSocket relayer
 * messages — so both of this module's error-mapping entry points live under
 * one import (#975).
 */
export { mapHorizonError, BadAuthError, HorizonTransactionError } from '../errors.js';
export type { HorizonResultCodes } from '../errors.js';

export type MappedErrorHandler = (error: Error) => void;
export type ErrorMessageTypeMap = Record<string, ConduitContract>;

export interface ErrorMapperOptions {
  errorMessageTypes?: ErrorMessageTypeMap;
}

/** WebSocket message types that carry a raw on-chain error payload, and which contract each belongs to. */
const DEFAULT_ERROR_MESSAGE_TYPE_MAP: ErrorMessageTypeMap = {
  stream_error: 'stream',
  factory_error: 'factory',
  governor_error: 'governor',
};

/**
 * The SDK's own default map of WebSocket error-message types to the contract
 * each should be parsed against (#773). Covers the SDK's known
 * `*_error` message types so consumers can spread it and only add their own
 * custom types instead of hand-writing the boilerplate from scratch.
 */
export { DEFAULT_ERROR_MESSAGE_TYPE_MAP };

/**
 * Subscribes to error-shaped messages on a `WebSocketRelayer` and forwards
 * them to `onError` as typed `ConduitError` instances instead of raw payloads.
 *
 * Must be paired with `dispose()` — see #81. Without it, each `attach()`
 * leaves its listeners registered on the relayer forever, and any handler
 * call still in flight when the caller stops caring can fire late.
 */
export class ErrorMapper {
  private readonly relayer: WebSocketRelayer;
  private readonly onError: MappedErrorHandler;
  private readonly errorMessageTypes: ErrorMessageTypeMap;
  private unsubscribers: Array<() => void> = [];
  private isDisposed = false;

  constructor(relayer: WebSocketRelayer, onError: MappedErrorHandler, options: ErrorMapperOptions = {}) {
    this.relayer = relayer;
    this.onError = onError;
    this.errorMessageTypes = {
      ...DEFAULT_ERROR_MESSAGE_TYPE_MAP,
      ...(options.errorMessageTypes ?? {}),
    };
  }

  /** Registers one relayer listener per error message type. Safe to call more than once. */
  attach(): void {
    if (this.isDisposed) {
      throw new Error('ErrorMapper has been disposed and cannot be re-attached');
    }

    // Re-attaching without detaching first would register a second set of
    // listeners on top of the first, leaking the originals. Guard against it.
    this.detach();

    for (const type of Object.keys(this.errorMessageTypes)) {
      const handler: MessageHandler = (msg) => this.handleMessage(type, msg);
      this.unsubscribers.push(this.relayer.on(type, handler));
    }
  }

  private handleMessage(type: string, msg: WebSocketMessage): void {
    // Boundary check: bail before touching a disposed mapper or a
    // null/malformed payload, rather than passing it downstream.
    if (this.isDisposed || !msg || typeof msg !== 'object' || msg.payload == null) {
      return;
    }

    const contract = this.errorMessageTypes[type];
    if (!contract) return;

    const mapped = ConduitError.fromContractError(contract, msg.payload);

    // Re-check disposal after mapping: dispose() may have run while this
    // callback was pending, and state shouldn't mutate after teardown.
    if (this.isDisposed) return;

    this.onError(mapped);
  }

  /** Unsubscribes every listener this mapper registered on the relayer. */
  detach(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  /** Detaches all listeners and permanently blocks any in-flight callback from firing. */
  dispose(): void {
    this.isDisposed = true;
    this.detach();
  }
}

/**
 * Numeric enums carry a reverse mapping (`StreamErrorCode[5] === 'StreamEnded'`),
 * so each contract's enum doubles as its code → name dictionary (#1057).
 */
const ERROR_CODE_NAMES: Record<ConduitContract, Record<number, string>> = {
  stream: StreamErrorCode as unknown as Record<number, string>,
  factory: FactoryErrorCode as unknown as Record<number, string>,
  governor: GovernorErrorCode as unknown as Record<number, string>,
};

/** A contract revert code resolved to its name and descriptive message. */
export interface DescribedContractError {
  contract: ConduitContract;
  code: number;
  /** The contract's error variant name, e.g. `StreamEnded`. */
  name: string;
  /** The SDK's descriptive message for the code, e.g. `Stream has passed its end time.` */
  message: string;
}

/**
 * Maps a contract revert code to its variant name and descriptive message
 * (#1057), so `Error(Contract, #5)` on the stream contract reads as
 * `StreamEnded` instead of a bare number.
 *
 * Codes are contract-scoped — pass the contract that produced the error.
 * Returns `undefined` for a code the SDK's catalogue does not know.
 */
export function describeContractError(
  contract: ConduitContract,
  code: number,
): DescribedContractError | undefined {
  const name = ERROR_CODE_NAMES[contract][code];
  if (typeof name !== 'string') return undefined;
  return { contract, code, name, message: new ConduitError(contract, code).message };
}

/**
 * Rewrites a raw revert string such as `HostError: Error(Contract, #5)` into
 * `StreamEnded: Stream has passed its end time.` (#1057). Strings without a
 * recognisable contract code, or with a code unknown for `contract`, are
 * returned unchanged.
 */
export function humanizeContractRevert(contract: ConduitContract, raw: string): string {
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(raw);
  if (!match?.[1]) return raw;
  const described = describeContractError(contract, Number(match[1]));
  return described ? `${described.name}: ${described.message}` : raw;
}

/**
 * Extracts a human-readable diagnostic message from a Soroban simulation
 * response (#921).
 *
 * Simulation failures carry their root cause buried in diagnostic host log
 * events rather than in a plain error string. Reuses {@link SorobanRpcError}'s
 * existing diagnostic decoding — host function call stack and auth failure
 * extraction — instead of re-implementing a second parser here.
 *
 * @param simResult - The simulation response from the Soroban RPC.
 * @returns A readable one-line diagnostic message. For a successful
 *   simulation, or an error with no decodable diagnostics, falls back to
 *   the raw RPC error string (or a generic message).
 */
export function extractDiagnosticMessage(simResult: SorobanRpc.Api.SimulateTransactionResponse): string {
  if (!SorobanRpc.Api.isSimulationError(simResult)) {
    return 'Simulation succeeded; no diagnostic message to extract.';
  }

  const { diagnostics } = SorobanRpcError.fromSimulationError({
    error: simResult.error,
    events: simResult.events,
  });

  const parts: string[] = [diagnostics.rpcError];

  if (diagnostics.authFailureReasons) {
    parts.push(`Auth failure: ${diagnostics.authFailureReasons.join('; ')}`);
  }

  if (diagnostics.hostFunctionCallStack) {
    parts.push(`Call stack: ${diagnostics.hostFunctionCallStack.join(' -> ')}`);
  }

  return parts.join(' | ');
}
