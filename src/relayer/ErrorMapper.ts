import type { WebSocketRelayer, WebSocketMessage, MessageHandler } from './WebSocketRelayer.js';
import { ConduitError, type ConduitContract } from '../errors.js';

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
