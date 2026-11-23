import { recordConnectionResult } from "../connection-health.js";

export interface WebSocketMessage {
  type: string;
  payload: unknown;
  id?: string;
}

export type MessageHandler = (msg: WebSocketMessage) => Promise<void> | void;
export type StateChangeHandler = (transition: RelayerStateTransition, state: RelayerState) => void;

export interface RelayerState {
  connected: boolean;
  reconnecting: boolean;
  destroyed: boolean;
  pendingCount: number;
}

export type RelayerStateTransition = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'destroyed';

/** A message queued while the WebSocket is offline, with metadata for TTL checks (#858). */
export interface QueuedMessage {
  message: WebSocketMessage;
  /** Unix milliseconds when the message was enqueued. */
  enqueuedAt: number;
}

export interface WebSocketRelayerOptions {
  maxPendingMessages?: number;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  onStateChange?: StateChangeHandler;
  /**
   * Interval in milliseconds between periodic ping keepalive messages to prevent
   * silent socket dropouts by intermediate firewalls and NAT gateways (#920).
   * Defaults to 30,000 ms (30 seconds). Set to 0 to disable.
   */
  heartbeatIntervalMs?: number;
  /**
   * Maximum milliseconds to wait for a pong response before declaring the socket dead
   * and reconnecting (#920). Defaults to 5,000 ms (5 seconds).
   */
  heartbeatTimeoutMs?: number;
  /**
   * Maximum milliseconds a message may sit in the offline buffer before it is
   * silently dropped on the next flush. `0` (default) disables TTL expiry.
   */
  offlineBufferTtlMs?: number;
  /**
   * Number of recently processed inbound message `id`s remembered so a
   * message re-delivered after a reconnect is dispatched to handlers only
   * once (#1056). Oldest ids are evicted first (LRU). Messages without an
   * `id` are never deduplicated. Defaults to 1,000; set to 0 to disable.
   */
  dedupeWindowSize?: number;
  /**
   * Wire encoding for messages. `'json'` (the default) keeps the existing
   * `JSON.stringify` payloads; `'binary'` packs each envelope into a compact
   * framed ArrayBuffer, avoiding repeated envelope keys on high-frequency
   * updates (e.g. stream balance broadcasts).
   */
  messageEncoding?: 'json' | 'binary';
  /** Shorthand for `messageEncoding: 'binary'`. Defaults to `false`. */
  binary?: boolean;
  /** Alias of {@link WebSocketRelayerOptions.binary}. */
  binaryPacking?: boolean;
}

// ── Binary frame codec ───────────────────────────────────────────────────────
//
// Frame layout (all integers little-endian):
//   byte 0-1   magic 'S','F'
//   byte 2     flags: bit 0 = id present
//   byte 3     payload tag (0 = JSON, 1 = UTF-8 string, 2 = int64, 3 = null)
//   u16        type length, then type bytes (UTF-8)
//   u16 + bytes  id, only when bit 0 of flags is set
//   u32 + bytes  payload bytes, for tags 0 and 1
//   8 bytes      payload int64, for tag 2
//
// No bytes are stored for a null/undefined payload (tag 3). The framing
// replaces the repeated `"type"`/`"payload"`/`"id"` JSON keys, and the typed
// payload tags avoid JSON quoting/escaping for string and bigint values.

const BINARY_MAGIC_0 = 0x53; // 'S'
const BINARY_MAGIC_1 = 0x46; // 'F'

const PAYLOAD_JSON = 0;
const PAYLOAD_STRING = 1;
const PAYLOAD_INT64 = 2;
const PAYLOAD_NULL = 3;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

/** Pack a message into the binary frame understood by {@link unpackMessage}. */
export function packMessage(message: WebSocketMessage): ArrayBuffer {
  const typeBytes = utf8Encoder.encode(message.type);
  const idBytes = message.id === undefined ? null : utf8Encoder.encode(message.id);

  let payloadBytes: Uint8Array;
  let payloadTag: number;
  if (message.payload === null || message.payload === undefined) {
    payloadBytes = new Uint8Array(0);
    payloadTag = PAYLOAD_NULL;
  } else if (typeof message.payload === 'string') {
    payloadBytes = utf8Encoder.encode(message.payload);
    payloadTag = PAYLOAD_STRING;
  } else if (typeof message.payload === 'bigint') {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setBigInt64(0, message.payload, true);
    payloadBytes = new Uint8Array(buffer);
    payloadTag = PAYLOAD_INT64;
  } else {
    const json = JSON.stringify(message.payload, (_, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    payloadBytes = utf8Encoder.encode(json ?? 'null');
    payloadTag = PAYLOAD_JSON;
  }

  const hasId = idBytes !== null;
  const hasPayloadLength = payloadTag === PAYLOAD_JSON || payloadTag === PAYLOAD_STRING;
  const size =
    4 +
    2 +
    typeBytes.length +
    (hasId ? 2 + (idBytes?.length ?? 0) : 0) +
    (hasPayloadLength ? 4 : 0) +
    payloadBytes.length;
  const buffer = new ArrayBuffer(size);
  const bytes = new Uint8Array(buffer);
  bytes[0] = BINARY_MAGIC_0;
  bytes[1] = BINARY_MAGIC_1;
  bytes[2] = hasId ? 1 : 0;
  bytes[3] = payloadTag;

  let offset = 4;
  writeU16(bytes, offset, Math.min(0xffff, typeBytes.length));
  offset += 2;
  bytes.set(typeBytes, offset);
  offset += typeBytes.length;
  if (idBytes !== null) {
    writeU16(bytes, offset, Math.min(0xffff, idBytes.length));
    offset += 2;
    bytes.set(idBytes, offset);
    offset += idBytes.length;
  }
  if (hasPayloadLength) {
    writeU32(bytes, offset, payloadBytes.length);
    offset += 4;
  }
  bytes.set(payloadBytes, offset);
  return buffer;
}

/** Unpack a binary frame. Returns `null` for malformed or unknown frames. */
export function unpackMessage(data: ArrayBuffer | ArrayBufferView): WebSocketMessage | null {
  try {
    const bytes =
      data instanceof Uint8Array
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
    if (bytes.length < 6) return null;
    if (bytes[0] !== BINARY_MAGIC_0 || bytes[1] !== BINARY_MAGIC_1) return null;

    const hasId = bytes[2] === 1;
    const payloadTag = bytes[3] ?? PAYLOAD_NULL;
    let offset = 4;
    const typeLength = readU16(bytes, offset);
    offset += 2;
    if (offset + typeLength > bytes.length) return null;
    const type = utf8Decoder.decode(bytes.subarray(offset, offset + typeLength));
    offset += typeLength;

    let id: string | undefined;
    if (hasId) {
      if (offset + 2 > bytes.length) return null;
      const idLength = readU16(bytes, offset);
      offset += 2;
      if (offset + idLength > bytes.length) return null;
      id = utf8Decoder.decode(bytes.subarray(offset, offset + idLength));
      offset += idLength;
    }

    let payload: unknown = null;
    if (payloadTag === PAYLOAD_JSON || payloadTag === PAYLOAD_STRING) {
      if (offset + 4 > bytes.length) return null;
      const payloadLength = readU32(bytes, offset);
      offset += 4;
      if (offset + payloadLength > bytes.length) return null;
      const raw = bytes.subarray(offset, offset + payloadLength);
      payload = payloadTag === PAYLOAD_JSON ? (JSON.parse(utf8Decoder.decode(raw)) as unknown) : utf8Decoder.decode(raw);
    } else if (payloadTag === PAYLOAD_INT64) {
      if (offset + 8 > bytes.length) return null;
      payload = new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigInt64(0, true);
    } else if (payloadTag !== PAYLOAD_NULL) {
      return null;
    }

    const message: WebSocketMessage = { type, payload };
    if (id !== undefined) message.id = id;
    return message;
  } catch {
    return null;
  }
}

export class WebSocketRelayer {
  private url: string;
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private stateChangeHandlers: Set<StateChangeHandler> = new Set();
  private isDestroyed = false;
  private isLocked = false;
  private lockQueue: Array<() => void> = [];
  private connectPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private reconnectEnabled = true;
  private reconnectExhausted = false;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;
  private maxReconnectDelayMs: number;
  private offlineQueue: QueuedMessage[] = [];
  private maxPendingMessages: number;
  private offlineBufferTtlMs: number;
  private stateTransition: RelayerStateTransition = 'disconnected';
  private heartbeatIntervalMs: number;
  private heartbeatTimeoutMs: number;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;
  private heartbeatSentAt: number | null = null;
  private dedupeWindowSize: number;
  private useBinary: boolean;
  /** Insertion-ordered set of recently processed message ids (#1056). */
  private seenMessageIds: Map<string, true> = new Map();

  constructor(url: string, options?: WebSocketRelayerOptions) {
    this.url = url;
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 5;
    this.reconnectDelayMs = options?.reconnectDelayMs ?? 1000;
    this.maxReconnectDelayMs = options?.maxReconnectDelayMs ?? 30_000;
    this.maxPendingMessages = options?.maxPendingMessages ?? 1000;
    this.offlineBufferTtlMs = options?.offlineBufferTtlMs ?? 0;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 30_000;
    this.heartbeatTimeoutMs = options?.heartbeatTimeoutMs ?? 5_000;
    this.dedupeWindowSize = Math.max(0, Math.floor(options?.dedupeWindowSize ?? 1000));
    this.useBinary =
      options?.messageEncoding === 'binary' || options?.binary === true || options?.binaryPacking === true;
    if (options?.onStateChange) {
      this.stateChangeHandlers.add(options.onStateChange);
    }
  }

  get state(): RelayerState {
    return {
      connected: this.ws !== null && this.ws.readyState === 1,
      reconnecting:
        !this.isDestroyed &&
        !this.reconnectExhausted &&
        this.reconnectEnabled &&
        this.reconnectAttempts > 0 &&
        (!this.ws || this.ws.readyState !== 1),
      destroyed: this.isDestroyed,
      pendingCount: this.offlineQueue.length,
    };
  }

  private async acquireLock(): Promise<void> {
    if (!this.isLocked) {
      this.isLocked = true;
      return;
    }
    return new Promise((resolve) => {
      this.lockQueue.push(resolve);
    });
  }

  private releaseLock(): void {
    const next = this.lockQueue.shift();
    if (next) {
      next();
    } else {
      this.isLocked = false;
    }
  }

  private emitStateChange(transition: RelayerStateTransition): void {
    if (this.stateTransition === transition) return;

    this.stateTransition = transition;
    if (transition === "connected") {
      recordConnectionResult(this.url, true, 0, "relayer");
    } else if (transition === "disconnected" || transition === "destroyed") {
      recordConnectionResult(this.url, false, 0, "relayer");
    }
    const state = this.state;
    for (const handler of this.stateChangeHandlers) {
      try {
        handler(transition, state);
      } catch (err) {
        console.warn('[WebSocketRelayer] state change handler error:', err);
      }
    }
  }

  async connect(): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('WebSocketRelayer has been destroyed');
    }
    this.reconnectEnabled = true;
    this.reconnectExhausted = false;
    this.reconnectAttempts = 0;
    if (this.connectPromise) {
      return this.connectPromise;
    }

    // Assign connectPromise synchronously — before the first `await` — so that
    // any connect() call arriving before this one settles sees it on the check
    // above and shares this promise instead of racing into a second
    // establishConnection() (see #492). Assigning it only after acquireLock()
    // resolves left a window where two near-simultaneous callers both passed
    // the check and both queued on the lock.
    const promise = this.doConnect();
    this.connectPromise = promise;
    try {
      await promise;
    } finally {
      if (this.connectPromise === promise) {
        this.connectPromise = null;
      }
    }
  }

  private async doConnect(): Promise<void> {
    await this.acquireLock();
    try {
      if (this.ws && this.ws.readyState === 1) {
        return;
      }

      this.emitStateChange('connecting');
      await this.establishConnection();
    } finally {
      this.releaseLock();
    }
  }

  private wsCtor(): typeof WebSocket | null {
    if (typeof globalThis !== 'undefined' && 'WebSocket' in globalThis) {
      return (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
    }
    if (typeof WebSocket !== 'undefined') {
      return WebSocket;
    }
    return null;
  }

  private async establishConnection(): Promise<void> {
    const WebSocketCtor = this.wsCtor();
    if (!WebSocketCtor) {
      this.emitStateChange('disconnected');
      return;
    }

    return new Promise((resolve, reject) => {
      try {
        let ws: WebSocket;
        try {
          ws = new WebSocketCtor(this.url);
        } catch {
          // Fallback for mocks that are plain functions.
          ws = (WebSocketCtor as unknown as (url: string) => WebSocket)(this.url);
        }
        if (!ws) {
          resolve();
          return;
        }
        // Deliver binary frames as ArrayBuffer so decoding stays synchronous.
        if (this.useBinary) {
          try {
            (ws as unknown as { binaryType?: string }).binaryType = 'arraybuffer';
          } catch {
            // Some mocks/implementations do not expose binaryType; the decoder
            // still handles ArrayBuffer, views and Blob defensively.
          }
        }
        let settled = false;

        ws.onopen = () => {
          if (settled) return;
          settled = true;
          this.reconnectAttempts = 0;
          this.reconnectExhausted = false;
          this.startHeartbeat();
          this.flushPendingMessages();
          this.emitStateChange('connected');
          resolve();
        };

        ws.onmessage = (event: MessageEvent) => {
          // Any inbound frame proves the link is alive, not just a pong.
          if (this.awaitingPong) {
            const latencyMs =
              this.heartbeatSentAt === null ? 0 : Date.now() - this.heartbeatSentAt;
            recordConnectionResult(this.url, true, latencyMs, "relayer");
            this.awaitingPong = false;
            this.heartbeatSentAt = null;
            this.clearHeartbeatTimeout();
          }
          this.handleMessageSafe(event.data as unknown);
        };

        ws.onclose = () => {
          this.stopHeartbeat();
          this.ws = null;
          if (!settled) {
            settled = true;
            reject(new Error(`WebSocket connection closed before opening: ${this.url}`));
          }
          if (!this.isDestroyed && this.reconnectEnabled && this.shouldAttemptReconnect()) {
            this.attemptReconnect();
          } else {
            if (this.isPermanentlyDown()) {
              this.reconnectExhausted = true;
            }
            this.emitStateChange('disconnected');
          }
        };

        ws.onerror = () => {
          if (!settled) {
            settled = true;
            reject(new Error(`WebSocket connection failed: ${this.url}`));
          }
        };

        this.ws = ws;
      } catch (err) {
        reject(err);
      }
    });
  }

  private async safeInvokeHandler(handler: MessageHandler, msg: WebSocketMessage): Promise<void> {
    try {
      const result = handler(msg);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        await (result as Promise<void>).catch((err: Error) => {
          console.warn('[WebSocketRelayer] async handler error:', err);
        });
      }
    } catch (err) {
      console.warn('[WebSocketRelayer] handler error:', err);
    }
  }

  /** Decode and dispatch an inbound frame, whether JSON text or a binary frame. */
  private handleMessageSafe(data: unknown): void {
    if (data === null || data === undefined) return;

    if (typeof data === 'string') {
      let parsed: WebSocketMessage | null;
      try {
        parsed = JSON.parse(data) as WebSocketMessage;
      } catch {
        return;
      }
      this.handleDecodedMessage(parsed);
      return;
    }

    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      this.handleDecodedMessage(unpackMessage(data));
      return;
    }

    // Blob/File inbound (when binaryType could not be set to 'arraybuffer').
    if (
      typeof data === 'object' &&
      data !== null &&
      'arrayBuffer' in data &&
      typeof (data as { arrayBuffer?: unknown }).arrayBuffer === 'function'
    ) {
      const blob = data as { arrayBuffer(): Promise<ArrayBuffer> };
      Promise.resolve(blob.arrayBuffer())
        .then((buffer) => {
          if (!this.isDestroyed) this.handleDecodedMessage(unpackMessage(buffer));
        })
        .catch(() => {});
    }
  }

  private handleDecodedMessage(parsed: WebSocketMessage | null): void {
    if (!parsed || typeof parsed !== 'object' || !parsed.type || typeof parsed.type !== 'string') return;

    // Handle pong responses for heartbeat ping
    if (parsed.type === 'pong' && this.awaitingPong) {
      const latencyMs =
        this.heartbeatSentAt === null ? 0 : Date.now() - this.heartbeatSentAt;
      recordConnectionResult(this.url, true, latencyMs, "relayer");
      this.awaitingPong = false;
      this.heartbeatSentAt = null;
      this.clearHeartbeatTimeout();
      return;
    }

    if (this.isDuplicateMessage(parsed)) return;

    const typeHandlers = this.handlers.get(parsed.type);
    if (!typeHandlers) return;

    for (const handler of typeHandlers) {
      this.safeInvokeHandler(handler, parsed);
    }
  }

  /**
   * True when `msg.id` was already processed within the dedupe window (#1056).
   * Otherwise records the id, evicting the oldest once the window is full.
   */
  private isDuplicateMessage(msg: WebSocketMessage): boolean {
    if (this.dedupeWindowSize === 0) return false;
    if (typeof msg.id !== 'string' || msg.id === '') return false;

    if (this.seenMessageIds.has(msg.id)) {
      // Refresh recency so a message that keeps being re-sent stays remembered.
      this.seenMessageIds.delete(msg.id);
      this.seenMessageIds.set(msg.id, true);
      return true;
    }

    this.seenMessageIds.set(msg.id, true);
    if (this.seenMessageIds.size > this.dedupeWindowSize) {
      const oldest = this.seenMessageIds.keys().next().value;
      if (oldest !== undefined) this.seenMessageIds.delete(oldest);
    }
    return false;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (!(this.heartbeatIntervalMs > 0)) return;
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === 1 && !this.awaitingPong) {
        try {
          // Keep the default/JSON heartbeat frame byte-for-byte unchanged;
          // binary mode sends the same logical ping through the binary codec.
          this.ws.send(
            this.useBinary
              ? this.encodeMessage({ type: 'ping', payload: null })
              : JSON.stringify({ type: 'ping' }),
          );
          this.awaitingPong = true;
          this.heartbeatSentAt = Date.now();
          this.heartbeatTimeout = setTimeout(() => {
            if (this.awaitingPong && this.ws) {
              this.handleHeartbeatTimeout();
            }
          }, this.heartbeatTimeoutMs);
        } catch {
          // Ignore send errors
        }
      }
    }, this.heartbeatIntervalMs);
  }

  /**
   * No pong arrived in time: the connection is half-open (NAT timeout, device
   * sleep). `close()` on such a socket may never fire `onclose`, so detach the
   * dead socket and drive the reconnect ourselves instead of waiting on it.
   */
  private handleHeartbeatTimeout(): void {
    const dead = this.ws;
    this.stopHeartbeat();
    this.ws = null;
    if (dead) {
      dead.onopen = null;
      dead.onmessage = null;
      dead.onclose = null;
      dead.onerror = null;
      try {
        dead.close();
      } catch {
        // Socket already closed/closing; nothing to clean up.
      }
    }
    if (this.isDestroyed) return;
    if (this.reconnectEnabled && this.shouldAttemptReconnect()) {
      void this.attemptReconnect();
    } else {
      if (this.isPermanentlyDown()) this.reconnectExhausted = true;
      this.emitStateChange('disconnected');
    }
  }

  private stopHeartbeat(): void {
    this.clearHeartbeatTimeout();
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.awaitingPong = false;
    this.heartbeatSentAt = null;
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeout !== null) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  /** Idempotency guard: only reconnect if not already connected or reconnecting */
  private shouldAttemptReconnect(): boolean {
    return (
      !this.isDestroyed &&
      this.reconnectEnabled &&
      this.reconnectAttempts < this.maxReconnectAttempts &&
      (!this.ws || this.ws.readyState !== 1)
    );
  }

  private flushPendingMessages(): void {
    const now = Date.now();
    const pending = this.offlineQueue;
    this.offlineQueue = [];
    for (const queued of pending) {
      if (this.offlineBufferTtlMs > 0 && now - queued.enqueuedAt > this.offlineBufferTtlMs) {
        continue;
      }
      this.send(queued.message).catch(() => {});
    }
  }

  /** Returns a snapshot of the offline queue contents (for inspection/debugging). */
  public getOfflineQueue(): QueuedMessage[] {
    return this.offlineQueue.slice();
  }

  /**
   * True once reconnection has been given up on — attempts exhausted, socket
   * still not open, but the relayer wasn't explicitly disconnected/destroyed.
   * `send()` uses this to reject outright instead of queueing messages that
   * will never be flushed (see #491).
   */
  private isPermanentlyDown(): boolean {
    return (
      !this.isDestroyed &&
      this.reconnectEnabled &&
      this.reconnectAttempts >= this.maxReconnectAttempts &&
      (!this.ws || this.ws.readyState !== 1)
    );
  }

  /**
   * Full-jitter exponential backoff (#1055): a uniformly random delay in
   * `[0, min(maxDelay, baseDelay * 2 ** (attempt - 1)))`. Spreading clients
   * across the whole window — rather than the previous 50–100% band — keeps
   * a fleet reconnecting after a relayer restart from arriving in lockstep.
   */
  private reconnectDelayFor(attempt: number): number {
    const cap = Math.min(this.maxReconnectDelayMs, this.reconnectDelayMs * 2 ** (attempt - 1));
    return Math.floor(Math.random() * cap);
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.shouldAttemptReconnect()) {
      if (this.isPermanentlyDown()) {
        this.reconnectExhausted = true;
      }
      this.emitStateChange('disconnected');
      return;
    }

    await this.acquireLock();
    try {
      if (!this.shouldAttemptReconnect()) {
        if (this.isPermanentlyDown()) {
          this.reconnectExhausted = true;
        }
        this.emitStateChange('disconnected');
        return;
      }

      this.reconnectAttempts++;
      this.emitStateChange('reconnecting');
      const delay = this.reconnectDelayFor(this.reconnectAttempts);
      await new Promise((r) => setTimeout(r, delay));
      // disconnect()/destroy() can land during the backoff delay; bail before
      // opening another socket if reconnection was cancelled meanwhile (#619).
      if (this.isDestroyed || !this.reconnectEnabled) return;

      await this.establishConnection();
    } catch {
      // Reconnect attempt failed; the next scheduled attempt (if any) will retry.
    } finally {
      this.releaseLock();
    }
  }

  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    return () => {
      const handlers = this.handlers.get(type);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.handlers.delete(type);
        }
      }
    };
  }

  onStateChange(handler: StateChangeHandler): () => void {
    this.stateChangeHandlers.add(handler);

    return () => {
      this.stateChangeHandlers.delete(handler);
    };
  }

  off(type: string, handler: MessageHandler): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(type);
      }
    }
  }

  /**
   * Push onto the bounded offline queue, dropping the oldest entry once
   * `maxPendingMessages` is reached (see #491) — `send()` must route through
   * this rather than pushing to `offlineQueue` directly.
   */
  private _queueMessage(message: WebSocketMessage): void {
    if (this.offlineQueue.length >= this.maxPendingMessages) {
      this.offlineQueue.shift();
    }
    this.offlineQueue.push({ message, enqueuedAt: Date.now() });
  }

  /** Serialize using the encoding selected at construction time. */
  private encodeMessage(message: WebSocketMessage): string | ArrayBuffer {
    return this.useBinary ? packMessage(message) : JSON.stringify(message);
  }

  async send(message: WebSocketMessage): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('WebSocketRelayer has been destroyed');
    }
    if (this.reconnectExhausted) {
      throw new Error(
        `WebSocketRelayer: connection to ${this.url} is down and reconnect attempts ` +
        `(${this.maxReconnectAttempts}) are exhausted; message was not queued`,
      );
    }

    if (!this.ws || this.ws.readyState !== 1) {
      this._queueMessage(message);
      return;
    }

    await this.acquireLock();
    try {
      if (this.isDestroyed) throw new Error('WebSocketRelayer has been destroyed');
      if (this.reconnectExhausted) {
        throw new Error(
          `WebSocketRelayer: connection to ${this.url} is down and reconnect attempts ` +
          `(${this.maxReconnectAttempts}) are exhausted; message was not queued`,
        );
      }
      if (!this.ws || this.ws.readyState !== 1) {
        this._queueMessage(message);
        return;
      }

      const payload = this.encodeMessage(message);
      this.ws.send(payload);
    } finally {
      this.releaseLock();
    }
  }

  disconnect(): void {
    this.reconnectEnabled = false;
    this.connectPromise = null;
    this.reconnectAttempts = 0;
    this.reconnectExhausted = false;
    this.stopHeartbeat();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Socket already closed/closing; nothing to clean up.
      }
      this.ws = null;
    }
    this.emitStateChange('disconnected');
  }

  destroy(): void {
    this.isDestroyed = true;
    this.reconnectEnabled = false;
    this.reconnectExhausted = true;
    this.connectPromise = null;
    this.offlineQueue = [];
    this.reconnectAttempts = this.maxReconnectAttempts;
    this.stopHeartbeat();

    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close();
      } catch {
        // Socket already closed/closing; nothing to clean up.
      }
      this.ws = null;
    }

    this.emitStateChange('destroyed');
    this.handlers.clear();
    this.stateChangeHandlers.clear();
    this.seenMessageIds.clear();
    this.lockQueue = [];
    this.isLocked = false;
  }
}
