/**
 * Event subscription for DripStream contracts.
 *
 * Polls the Soroban event ledger on an interval and dispatches typed events
 * to registered handlers.
 */

import { Address, SorobanRpc, xdr } from '@stellar/stellar-sdk';
import type {
  StreamEventHandlers,
  Subscription,
  WithdrawEvent,
  CancelEvent,
  PauseEvent,
  ResumeEvent,
  StreamTopUpEvent,
  StreamClawbackedEvent,
  CreatedEvent,
  ForceCancelEvent,
  RecipientTransferEvent,
  OperatorSetEvent,
  OperatorRevokedEvent,
  CliffReachedEvent,
} from './types/index.js';
import { scValToI128, scValToU64, createRpcServer } from './soroban.js';
import { LedgerGapDetector, type LedgerGap } from './indexer.js';

// ── Event topic names (match symbol_short!() values in Rust) ─────────────────
//
// `created`, `force_cxl`, `xfer_rec`, `set_op` and `rm_op` are emitted by
// contracts/stream/src/events.rs alongside the six handled below, but were
// never wired into TOPIC/dispatchEvent — a subscriber was silently never
// notified of a recipient transfer, a recipient-initiated force-cancel, or
// an operator delegation/revocation (see #506).

const TOPIC = {
  WITHDRAWN: 'withdrawn',
  CANCELLED: 'cancelled',
  PAUSED:    'paused',
  RESUMED:   'resumed',
  TOPPED_UP: 'topped_up',
  CLAWBACK:  'clawback',
  CREATED:               'created',
  FORCE_CANCELLED:       'force_cxl',
  RECIPIENT_TRANSFERRED: 'xfer_rec',
  OPERATOR_SET:          'set_op',
  OPERATOR_REVOKED:      'rm_op',
} as const;

// ── Parser helpers ────────────────────────────────────────────────────────────

/**
 * The stream contract publishes multi-field event data as a Rust tuple,
 * which soroban-sdk encodes as an ScVec. Single-field events (resumed,
 * clawback) publish the bare scalar instead — callers must know which shape
 * to expect for a given topic (see contracts/stream/src/events.rs).
 */
function tupleFields(val: xdr.ScVal): xdr.ScVal[] {
  return val.vec() ?? [];
}

function i128Field(fields: xdr.ScVal[], index: number): bigint {
  const field = fields[index];
  return field ? scValToI128(field) : 0n;
}

function u64Field(fields: xdr.ScVal[], index: number): number {
  const field = fields[index];
  return field ? Number(scValToU64(field)) : 0;
}

function addressFieldAt(fields: xdr.ScVal[], index: number): string {
  return addressField(fields[index]);
}

/**
 * Decodes an address topic to its G.../C... string. `ScVal.address()?.accountId()`
 * returns the raw XDR PublicKey object, not a string — calling `.toString()`
 * on it yields `"[object Object]"`. `Address.fromScVal` handles both account
 * and contract address variants correctly.
 */
/** Read the sequence topic (topics[2]) from a raw event, if present. */
function sequenceOf(event: SorobanRpc.Api.EventResponse): bigint | undefined {
  const topics = event.topic;
  if (!topics || topics.length < 3) return undefined;
  const seq = topics[2];
  return seq ? scValToU64(seq) : undefined;
}

function addressField(val: xdr.ScVal | undefined): string {
  if (!val) return '';
  try {
    return Address.fromScVal(val).toString();
  } catch {
    return '';
  }
}

// ── Deduplication ─────────────────────────────────────────────────────────────

/** Bounded insertion-ordered set of recently seen event IDs (oldest evicted first). */
class RecentIdWindow {
  private readonly ids = new Set<string>();
  constructor(private readonly size: number) {}

  /** Returns `true` if `id` was already seen; otherwise records it and returns `false`. */
  seen(id: string | undefined): boolean {
    if (this.size <= 0 || !id) return false;
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    if (this.ids.size > this.size) {
      this.ids.delete(this.ids.values().next().value as string);
    }
    return false;
  }
}

const DEFAULT_DEDUP_WINDOW = 1000;

// ── Subscription ──────────────────────────────────────────────────────────────

/**
 * Subscribe to on-chain events for a specific DripStream contract.
 *
 * @param rpcUrl        Soroban RPC endpoint
 * @param streamAddress DripStream contract address (C…)
 * @param handlers      Event handler callbacks
 * @returns             `{ unsubscribe }` — call to stop polling
 */
export function subscribeToStream(
  rpcUrl:        string,
  streamAddress: string,
  handlers:      StreamEventHandlers,
): Subscription {
  const server                 = createRpcServer(rpcUrl);
  const pollInterval           = handlers.pollInterval ?? 5000;
  const maxBackoffMs           = handlers.maxBackoffMs ?? 60_000;
  const maxConsecutiveFailures = handlers.maxConsecutiveFailures ?? 10;
  let   startLedger            = 0;
  let   ledgerSeeded           = false; // true once startLedger holds a real ledger sequence
  let   cursor: string | undefined;
  let   consecutiveFailures    = 0;
  let   stopped                = false;
  let   timer: ReturnType<typeof setTimeout> | undefined;
  // Last per-contract event sequence seen (topics[2]), for gap detection
  // across a poll or reconnect — see contracts/stream/src/events.rs.
  // Ledger used to seed the last successful poll; kept for gap backfills.
  let   lastStartLedger = 0;
  // Guard against recursive gap detection while a replay is in flight.
  let   isReplaying = false;
  let   lastSequence: bigint | undefined;
  const recentIds              = new RecentIdWindow(handlers.dedupWindowSize ?? DEFAULT_DEDUP_WINDOW);
  // Tracks ledger continuity across every dispatched event (independent of
  // whether it carries a sequence topic) so a skipped ledger is caught even
  // when no contract-level sequence gap bracketed it — see #964.
  const ledgerGapDetector       = new LedgerGapDetector();
  let   isBackfillingLedgerGap  = false;

  /**
   * Backfill events whose sequence falls inside a detected gap.
   *
   * When polling resumes after a delay or reconnect, the RPC may return
   * a later sequence while the subscriber never saw the events in between.
   * Re-fetch events from the last known ledger and dispatch any missed
   * events in sequence order so withdraw/pause/etc handlers fire as if
   * the events had been received originally.
   */
  async function replayGap(expected: bigint, actual: bigint) {
    if (isReplaying || lastStartLedger <= 0) return;
    isReplaying = true;
    try {
      const backfill = await server.getEvents({
        startLedger: lastStartLedger,
        filters: [{ type: 'contract', contractIds: [streamAddress] }],
        limit: 200,
      });

      const missed = backfill.events
        .map((event) => ({ event, seq: sequenceOf(event) }))
        .filter((item): item is { event: SorobanRpc.Api.EventResponse; seq: bigint } =>
          item.seq !== undefined && item.seq > expected && item.seq < actual,
        )
        .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

      for (const item of missed) {
        if (recentIds.seen(item.event.id)) continue;
        dispatchIsolated(item.event, handlers);
      }
    } catch (err) {
      console.warn('[conduit-sdk] event replay failed:', err);
    } finally {
      isReplaying = false;
    }
  }

  /**
   * Backfill events whose ledger falls inside a detected ledger gap (#964).
   *
   * Unlike {@link replayGap}, which brackets a gap between two events that
   * both carry the contract's sequence topic, this fires from
   * `ledgerGapDetector` alone — so it also catches a skipped ledger range
   * that contained no events carrying a sequence topic at all.
   */
  async function backfillLedgerGap(gap: LedgerGap) {
    if (isBackfillingLedgerGap) return;
    isBackfillingLedgerGap = true;
    try {
      const backfill = await server.getEvents({
        startLedger: gap.expected,
        filters: [{ type: 'contract', contractIds: [streamAddress] }],
        limit: 200,
      });

      const missed = backfill.events.filter((event) => event.ledger < gap.actual);
      for (const event of missed) {
        if (recentIds.seen(event.id)) continue;
        dispatchIsolated(event, handlers);
      }
    } catch (err) {
      console.warn('[conduit-sdk] ledger gap backfill failed:', err);
    } finally {
      isBackfillingLedgerGap = false;
    }
  }

  async function poll() {
    if (stopped) return;

    try {
      if (!ledgerSeeded && !cursor) {
        // Soroban RPC's getEvents requires a start ledger; the very first
        // call has no cursor to derive one from yet, so seed it from the
        // chain's current ledger. If this itself fails, fall through to the
        // outer catch (below) and retry on the next poll instead of leaving
        // startLedger at 0 forever, which would make every getEvents call
        // fail identically (see #484).
        const latest = await server.getLatestLedger();
        startLedger = latest.sequence;
        lastStartLedger = startLedger;
        ledgerSeeded = true;
      }

      const response = await server.getEvents({
        ...(cursor ? { cursor } : { startLedger }),
        filters: [{
          type:        'contract',
          contractIds: [streamAddress],
        }],
        limit: 100,
      });

      consecutiveFailures = 0;

      if (response.events.length > 0) {
        for (const event of response.events) {
          // `event.ledger` is a required field of the real RPC response, but
          // guard it defensively so a malformed/partial event can't abort
          // the whole poll tick the way an uncaught throw here would.
          if (typeof event.ledger === 'number') {
            const ledgerGap = ledgerGapDetector.observe(event.ledger);
            if (ledgerGap) {
              try {
                handlers.onLedgerGap?.(ledgerGap);
              } catch (handlerError) {
                console.warn('[conduit-sdk] event polling onLedgerGap handler error:', handlerError);
              }
              // Fire-and-forget backfill of the skipped ledger range; poll loop continues.
              backfillLedgerGap(ledgerGap).catch((err) =>
                console.warn('[conduit-sdk] backfillLedgerGap invocation failed:', err),
              );
            }
          }

          if (recentIds.seen(event.id)) continue;
          const sequence = dispatchIsolated(event, handlers);
          if (sequence !== undefined) {
            if (lastSequence !== undefined && sequence !== lastSequence + 1n) {
              try {
                handlers.onGap?.({ expected: lastSequence + 1n, actual: sequence });
              } catch (handlerError) {
                console.warn('[conduit-sdk] event polling onGap handler error:', handlerError);
              }
              // Fire-and-forget replay of missed events; poll loop continues.
              replayGap(lastSequence, sequence).catch((err) =>
                console.warn('[conduit-sdk] replayGap invocation failed:', err),
              );
            }
            lastSequence = sequence;
          }
        }
      }

      // `@stellar/stellar-sdk`'s GetEventsResponse type doesn't declare `cursor`
      // yet, though the RPC returns it — read it defensively.
      const responseCursor = (response as { cursor?: string }).cursor;
      if (responseCursor) {
        cursor = responseCursor;
      } else {
        cursor = undefined;
        if (response.latestLedger !== undefined) {
          startLedger = response.latestLedger + 1;
          lastStartLedger = response.latestLedger;
        }
      }

      consecutiveFailures = 0;
    } catch (err) {
      // Swallow polling errors; the subscription continues (unless the
      // consecutive-failure cutoff below is reached).
      const error = err instanceof Error ? err : new Error(String(err));
      console.warn('[conduit-sdk] event polling error:', error);
      consecutiveFailures++;

      // A consumer error handler must not itself stop future polling.
      try {
        handlers.onError?.(error);
      } catch (handlerError) {
        console.warn('[conduit-sdk] event polling onError handler error:', handlerError);
      }

      if (consecutiveFailures >= maxConsecutiveFailures) {
        console.warn(
          `[conduit-sdk] event polling stopped after ${consecutiveFailures} consecutive failures`,
        );
        stopped = true;
        return;
      }
    }

    if (!stopped) {
      // Exponential backoff: 1x pollInterval after the 1st consecutive
      // failure, 2x after the 2nd, 4x after the 3rd, etc., capped at
      // maxBackoffMs. A successful poll resets consecutiveFailures to 0,
      // which brings the delay back down to the plain pollInterval.
      const delay = consecutiveFailures > 0
        ? Math.min(pollInterval * 2 ** (consecutiveFailures - 1), maxBackoffMs)
        : pollInterval;
      timer = setTimeout(poll, delay);
    }
  }

  // Start polling immediately
  poll();

  return {
    unsubscribe: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      // Release closure references to prevent memory leaks — without this,
      // the handlers object, server instance, and everything they reference
      // stay alive in the event loop until the JS engine garbage-collects
      // the entire closure graph, which may never happen if any external
      // reference to the Subscription object is kept.
      handlers = {};
    },
  };
}

/**
 * Subscribe to on-chain events for multiple DripStream contracts at once.
 *
 * A convenience that fans out to one `subscribeToStream` call per address
 * internally and returns a single `Subscription` whose `unsubscribe()`
 * tears all of them down together (#797). Without this, a UI showing a
 * portfolio of streams (5, 20, 50 of them) has to call `subscribeToStream`
 * once per stream and separately track and tear down that many independent
 * `Subscription` objects itself.
 *
 * All addresses share the same `handlers` and each keeps its own polling
 * interval, cursor, and backoff state — this does not merge the underlying
 * polling into a single request. Event payloads (`WithdrawEvent`,
 * `CancelEvent`, etc.) don't carry the originating stream's address, so a
 * shared handler firing across several addresses can't by itself tell
 * which stream an event came from; subscribe per-group with distinct
 * handlers if you need to attribute events to a specific stream.
 *
 * @param rpcUrl    Soroban RPC endpoint
 * @param addresses DripStream contract addresses (C…) to subscribe to
 * @param handlers  Event handler callbacks, shared across all addresses
 * @returns         `{ unsubscribe }` — stops polling for every address
 */
export function subscribeToStreams(
  rpcUrl:    string,
  addresses: string[],
  handlers:  StreamEventHandlers,
): Subscription {
  const subscriptions = addresses.map((address) => subscribeToStream(rpcUrl, address, handlers));

  return {
    unsubscribe: () => {
      for (const sub of subscriptions) {
        sub.unsubscribe();
      }
    },
  };
}

// ── Typed single-event listener ────────────────────────────────────────────────

/** Options accepted by the `'CliffReached'` overload of {@link onStreamEvent}. */
export interface CliffReachedListenerOptions {
  /**
   * Unix timestamp (seconds) at which the vesting cliff ends — the stream's
   * `startTime` when the cliff is modeled as "nothing accrues before
   * `startTime`" (see `examples/vesting-schedule.ts`).
   */
  cliffTime: number;
  /** How often (ms) to check the wall clock against `cliffTime`. Default 5000. */
  pollInterval?: number;
}

/**
 * Strongly-typed listener for a single named stream notification, decoding
 * the payload automatically so callers don't wrangle raw Soroban XDR.
 *
 * `'Cancelled'` is a real on-chain event — this delegates to
 * {@link subscribeToStream}'s existing `onCancel` decoding.
 *
 * `'CliffReached'` has no on-chain counterpart (the stream contract emits no
 * cliff event; a vesting cliff is a client-side scheduling convention, see
 * {@link CliffReachedListenerOptions.cliffTime}), so it's a one-shot timer
 * that fires `callback` once the wall clock reaches the supplied `cliffTime`.
 *
 * @example
 * ```ts
 * const sub = onStreamEvent(rpcUrl, streamAddress, 'Cancelled', (e) => {
 *   console.log('refunded', e.refundAmount);
 * });
 *
 * const cliffSub = onStreamEvent(rpcUrl, streamAddress, 'CliffReached', (e) => {
 *   console.log('cliff reached at', e.cliffTime);
 * }, { cliffTime: vestingParams.cliffEndTime });
 * ```
 */
export function onStreamEvent(
  rpcUrl: string,
  streamAddress: string,
  type: 'Cancelled',
  callback: (event: CancelEvent) => void,
): Subscription;
export function onStreamEvent(
  rpcUrl: string,
  streamAddress: string,
  type: 'CliffReached',
  callback: (event: CliffReachedEvent) => void,
  options: CliffReachedListenerOptions,
): Subscription;
export function onStreamEvent(
  rpcUrl: string,
  streamAddress: string,
  type: 'CliffReached' | 'Cancelled',
  // Union of the two callback shapes: `strictFunctionTypes` rejects a narrower
  // single-parameter type here, because the implementation would then be
  // claiming it may call with either event.
  callback: ((event: CancelEvent) => void) | ((event: CliffReachedEvent) => void),
  options?: CliffReachedListenerOptions,
): Subscription {
  if (type === 'Cancelled') {
    return subscribeToStream(rpcUrl, streamAddress, { onCancel: callback as (event: CancelEvent) => void });
  }

  if (!options || !Number.isFinite(options.cliffTime)) {
    throw new Error("onStreamEvent('CliffReached', ...) requires options.cliffTime");
  }
  const { cliffTime } = options;
  const pollInterval = options.pollInterval ?? 5000;

  let stopped = false;
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const check = () => {
    if (stopped || fired) return;
    if (Math.floor(Date.now() / 1000) >= cliffTime) {
      fired = true;
      (callback as (event: CliffReachedEvent) => void)({ cliffTime });
      return;
    }
    timer = setTimeout(check, pollInterval);
  };
  check();

  return {
    unsubscribe: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

// ── Event dispatcher ──────────────────────────────────────────────────────────

// Exported (but not re-exported from index.ts) so tests can exercise the
// tuple-decoding logic directly without standing up a fake RPC server.
// Returns the event's sequence number (topics[2]) so callers can track gaps
// across polls/reconnects, or undefined if the event had no topics at all.
/**
 * Dispatches one event with the consumer's handler isolated (#809).
 *
 * A handler that throws is a bug in the consumer's own code; it must not
 * abort the rest of a poll batch or a gap replay, nor be mistaken for an RPC
 * failure. The error is logged (as `onGap` handler errors are) and the
 * event's sequence is still returned so gap tracking continues normally.
 */
function dispatchIsolated(
  event:    SorobanRpc.Api.EventResponse,
  handlers: StreamEventHandlers,
): bigint | undefined {
  try {
    return dispatchEvent(event, handlers);
  } catch (handlerError) {
    console.warn('[conduit-sdk] event handler error:', handlerError);
    try {
      return sequenceOf(event);
    } catch {
      return undefined;
    }
  }
}

export function dispatchEvent(
  event:    SorobanRpc.Api.EventResponse,
  handlers: StreamEventHandlers,
): bigint | undefined {
  // Topics: [symbol, actor_address, sequence]
  const topics = event.topic;
  if (!topics || topics.length < 1) return undefined;

  const topicName = topics[0]?.sym()?.toString() ?? '';

  const actor    = addressField(topics[1]);
  const sequence = topics[2] ? scValToU64(topics[2]) : undefined;
  // Spread this into each decoded event so an absent sequence topic leaves
  // the optional `sequence` field off entirely rather than set to
  // `undefined` (which `exactOptionalPropertyTypes` rejects).
  const seq: { sequence?: bigint } = sequence === undefined ? {} : { sequence };

  switch (topicName) {
    case TOPIC.WITHDRAWN: {
      if (!handlers.onWithdraw) break;
      // data: (amount: i128, total_withdrawn: i128, remaining: i128)
      const fields = tupleFields(event.value);
      const data: WithdrawEvent = {
        recipient:      actor,
        amount:         i128Field(fields, 0),
        totalWithdrawn: i128Field(fields, 1),
        remaining:      i128Field(fields, 2),
        ...seq,
      };
      handlers.onWithdraw(data);
      break;
    }

    case TOPIC.CANCELLED: {
      if (!handlers.onCancel) break;
      // data: (refund_amount: i128, withdrawn_so_far: i128)
      const fields = tupleFields(event.value);
      const data: CancelEvent = {
        sender:         actor,
        refundAmount:   i128Field(fields, 0),
        withdrawnSoFar: i128Field(fields, 1),
        ...seq,
      };
      handlers.onCancel(data);
      break;
    }

    case TOPIC.PAUSED: {
      if (!handlers.onPause) break;
      // data: (paused_at: u64, withdrawable: i128)
      const fields = tupleFields(event.value);
      const data: PauseEvent = {
        sender:       actor,
        pausedAt:     u64Field(fields, 0),
        withdrawable: i128Field(fields, 1),
        ...seq,
      };
      handlers.onPause(data);
      break;
    }

    case TOPIC.RESUMED: {
      if (!handlers.onResume) break;
      // data: resumed_at: u64 (bare scalar, not a tuple — resumed() only
      // publishes one field, see contracts/stream/src/events.rs)
      const data: ResumeEvent = {
        sender:    actor,
        resumedAt: Number(scValToU64(event.value)),
        ...seq,
      };
      handlers.onResume(data);
      break;
    }

    case TOPIC.TOPPED_UP: {
      if (!handlers.onTopUp) break;
      // data: (amount: i128, new_balance: i128)
      const fields = tupleFields(event.value);
      const data: StreamTopUpEvent = {
        sender:     actor,
        amount:     i128Field(fields, 0),
        newBalance: i128Field(fields, 1),
        ...seq,
      };
      handlers.onTopUp(data);
      break;
    }

    case TOPIC.CLAWBACK: {
      if (!handlers.onClawback) break;
      // data: amount: i128 (bare scalar, not a tuple)
      const data: StreamClawbackedEvent = {
        sender: actor,
        amount: scValToI128(event.value),
        ...seq,
      };
      handlers.onClawback(data);
      break;
    }

    case TOPIC.CREATED: {
      if (!handlers.onCreated) break;
      // data: (recipient, token, deposit_amount: i128, rate_per_second: i128, start_time: u64, end_time: u64)
      const fields = tupleFields(event.value);
      const data: CreatedEvent = {
        sender:         actor,
        recipient:      addressFieldAt(fields, 0),
        token:          addressFieldAt(fields, 1),
        depositAmount:  i128Field(fields, 2),
        ratePerSecond:  i128Field(fields, 3),
        startTime:      u64Field(fields, 4),
        endTime:        u64Field(fields, 5),
        ...seq,
      };
      handlers.onCreated(data);
      break;
    }

    case TOPIC.FORCE_CANCELLED: {
      if (!handlers.onForceCancel) break;
      // data: (payout_amount: i128, refund_amount: i128) — mirrors cancel()'s
      // (refund_amount, withdrawn_so_far) shape but recipient-initiated.
      const fields = tupleFields(event.value);
      const data: ForceCancelEvent = {
        recipient:    actor,
        payoutAmount: i128Field(fields, 0),
        refundAmount: i128Field(fields, 1),
        ...seq,
      };
      handlers.onForceCancel(data);
      break;
    }

    case TOPIC.RECIPIENT_TRANSFERRED: {
      if (!handlers.onRecipientTransfer) break;
      // data: new_recipient: address (bare scalar, not a tuple)
      const data: RecipientTransferEvent = {
        previousRecipient: actor,
        newRecipient:      addressField(event.value),
        ...seq,
      };
      handlers.onRecipientTransfer(data);
      break;
    }

    case TOPIC.OPERATOR_SET: {
      if (!handlers.onOperatorSet) break;
      // data: operator: address (bare scalar, not a tuple)
      const data: OperatorSetEvent = {
        sender:   actor,
        operator: addressField(event.value),
        ...seq,
      };
      handlers.onOperatorSet(data);
      break;
    }

    case TOPIC.OPERATOR_REVOKED: {
      if (!handlers.onOperatorRevoke) break;
      // data: operator: address (bare scalar, not a tuple)
      const data: OperatorRevokedEvent = {
        sender:   actor,
        operator: addressField(event.value),
        ...seq,
      };
      handlers.onOperatorRevoke(data);
      break;
    }
  }

  return sequence;
}

// ── History (paginated, one-shot) ────────────────────────────────────────────

/** Soroban RPC retains roughly seven days of events at ~5s per ledger. */
export const DEFAULT_HISTORY_LOOKBACK_LEDGERS = 120_000;
export const DEFAULT_HISTORY_PAGE_SIZE = 50;
export const MAX_HISTORY_PAGE_SIZE = 200;

interface StreamHistoryBase {
  /** Soroban event id, unique per event. */
  id:        string;
  ledger:    number;
  /** ISO-8601 ledger close time. */
  timestamp: string;
  txHash:    string;
}

/** One decoded stream event, discriminated by `kind`. */
export type StreamHistoryEntry = StreamHistoryBase & (
  | { kind: 'created';  event: CreatedEvent }
  | { kind: 'withdraw'; event: WithdrawEvent }
  | { kind: 'top_up';   event: StreamTopUpEvent }
  | { kind: 'pause';    event: PauseEvent }
  | { kind: 'resume';   event: ResumeEvent }
  | { kind: 'cancel';   event: CancelEvent }
  | { kind: 'clawback'; event: StreamClawbackedEvent }
);

export interface StreamHistoryPage {
  /** Entries in ledger order, oldest first. */
  entries:    StreamHistoryEntry[];
  /** Pass as `cursor` to fetch the next page; `undefined` when exhausted. */
  nextCursor: string | undefined;
}

/**
 * A single decoded stream event, discriminated by its `kind` field so
 * consumer code can `switch` on it for type-safe handling — the strongly
 * typed counterpart to the raw `SorobanRpc` `EventResponse` that the network
 * returns. This is the "parsing function" that turns contract event topics
 * into a TypeScript discriminated union (#908): each member carries the
 * already-decoded payload (`CreatedEvent`, `WithdrawEvent`, …).
 *
 * It mirrors the shape `getStreamHistory` assembles internally; exposing it
 * lets callers parse one event without standing up a full history page.
 */
export type StreamEvent =
  | { kind: 'created'; event: CreatedEvent }
  | { kind: 'withdrawn'; event: WithdrawEvent }
  | { kind: 'topped_up'; event: StreamTopUpEvent }
  | { kind: 'paused'; event: PauseEvent }
  | { kind: 'resumed'; event: ResumeEvent }
  | { kind: 'cancelled'; event: CancelEvent }
  | { kind: 'clawback'; event: StreamClawbackedEvent }
  | { kind: 'force_cancelled'; event: ForceCancelEvent }
  | { kind: 'recipient_transferred'; event: RecipientTransferEvent }
  | { kind: 'operator_set'; event: OperatorSetEvent }
  | { kind: 'operator_revoked'; event: OperatorRevokedEvent };

/**
 * Parse one raw contract `EventResponse` into a typed {@link StreamEvent}, or
 * `null` when the topic is not a recognised stream event (the dispatch layer
 * simply has no handler registered for it).
 *
 * @example
 * ```ts
 * const ev = parseStreamEvent(raw);
 * if (ev) switch (ev.kind) {
 *   case 'created':   console.log(ev.event.recipient); break;
 *   case 'withdrawn': console.log(ev.event.amount); break;
 * }
 * ```
 */
export function parseStreamEvent(event: SorobanRpc.Api.EventResponse): StreamEvent | null {
  let result: StreamEvent | null = null;
  dispatchEvent(event, {
    onCreated:           (event) => { result = { kind: 'created', event }; },
    onWithdraw:          (event) => { result = { kind: 'withdrawn', event }; },
    onTopUp:             (event) => { result = { kind: 'topped_up', event }; },
    onPause:             (event) => { result = { kind: 'paused', event }; },
    onResume:            (event) => { result = { kind: 'resumed', event }; },
    onCancel:            (event) => { result = { kind: 'cancelled', event }; },
    onClawback:          (event) => { result = { kind: 'clawback', event }; },
    onForceCancel:       (event) => { result = { kind: 'force_cancelled', event }; },
    onRecipientTransfer: (event) => { result = { kind: 'recipient_transferred', event }; },
    onOperatorSet:       (event) => { result = { kind: 'operator_set', event }; },
    onOperatorRevoke:    (event) => { result = { kind: 'operator_revoked', event }; },
  });
  return result;
}

export interface StreamHistoryOptions {
  /** Cursor from a previous page's `nextCursor`. Omit for the first page. */
  cursor?:      string;
  /** Events per page, 1–{@link MAX_HISTORY_PAGE_SIZE}. Default {@link DEFAULT_HISTORY_PAGE_SIZE}. */
  limit?:       number;
  /**
   * Ledger to start from on the first page (ignored when `cursor` is set).
   * Defaults to {@link DEFAULT_HISTORY_LOOKBACK_LEDGERS} before the latest
   * ledger. Soroban RPC only serves events inside its retention window; use
   * the indexer for older history.
   */
  startLedger?: number;
  /**
   * Keep only events that match every supplied field. Lets a client that
   * watches a contract for many streams surface just the rows that mention
   * the logged-in user or a specific stream, instead of filtering manually
   * after the page returns (#909). All fields are optional; an omitted field
   * is not constrained. `streamId` matches the `streamId` field when the
   * decoded payload carries one, otherwise the entry is dropped (events are
   * already scoped to one contract by `streamAddress`).
   */
  filter?:      StreamEventFilter;
}

/**
 * Subset of an event's actors/identity used to narrow a history feed (#909).
 *
 * - `recipient` — keep events addressed to this account (withdraw, created,
 *   recipient-transferred, etc.).
 * - `sender` — keep events initiated by this account (created, cancel, pause,
 *   top-up, clawback, …).
 * - `streamId` — keep events for this specific stream id/contract.
 */
export interface StreamEventFilter {
  recipient?: string;
  sender?:    string;
  streamId?:  string;
}

/** Extract the sender/recipient addresses carried by a decoded history entry. */
function actorAddressesOf(entry: StreamHistoryEntry): { sender?: string; recipient?: string } {
  switch (entry.kind) {
    case 'created':  return { sender: entry.event.sender, recipient: entry.event.recipient };
    case 'withdraw': return { recipient: entry.event.recipient };
    case 'top_up':   return { sender: entry.event.sender };
    case 'pause':    return { sender: entry.event.sender };
    case 'resume':   return { sender: entry.event.sender };
    case 'cancel':   return { sender: entry.event.sender };
    case 'clawback': return { sender: entry.event.sender };
  }
}

/**
 * Returns `true` when `entry` satisfies every field set on `filter`.
 * An unset filter field is not constrained; an empty filter matches all.
 */
export function matchesStreamEventFilter(entry: StreamHistoryEntry, filter: StreamEventFilter): boolean {
  const { sender, recipient } = actorAddressesOf(entry);
  if (filter.sender !== undefined && sender !== filter.sender) return false;
  if (filter.recipient !== undefined && recipient !== filter.recipient) return false;
  if (filter.streamId !== undefined) {
    const id = (entry as { streamId?: string }).streamId;
    if (id !== filter.streamId) return false;
  }
  return true;
}

/** Keep only the history entries that satisfy `filter` (#909). */
export function filterStreamEvents(entries: StreamHistoryEntry[], filter: StreamEventFilter): StreamHistoryEntry[] {
  return entries.filter((entry) => matchesStreamEventFilter(entry, filter));
}

/**
 * Fetch one page of a stream contract's event history.
 *
 * Unlike {@link subscribeToStream} this is a single request, suited to
 * "load more" / infinite-scroll UIs: feed `nextCursor` back as `cursor`.
 */
export async function getStreamHistory(
  rpcUrl:        string,
  streamAddress: string,
  options:       StreamHistoryOptions = {},
): Promise<StreamHistoryPage> {
  const limit = options.limit ?? DEFAULT_HISTORY_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE_SIZE) {
    throw new Error(`limit must be an integer between 1 and ${MAX_HISTORY_PAGE_SIZE}`);
  }

  const server = createRpcServer(rpcUrl);
  let request: SorobanRpc.Server.GetEventsRequest;
  const filters = [{ type: 'contract' as const, contractIds: [streamAddress] }];
  if (options.cursor) {
    request = { cursor: options.cursor, filters, limit };
  } else {
    let startLedger = options.startLedger;
    if (startLedger === undefined) {
      const latest = await server.getLatestLedger();
      startLedger = Math.max(1, latest.sequence - DEFAULT_HISTORY_LOOKBACK_LEDGERS);
    }
    request = { startLedger, filters, limit };
  }

  const response = await server.getEvents(request);
  const entries: StreamHistoryEntry[] = [];

  for (const raw of response.events) {
    let entry: StreamHistoryEntry | undefined;
    const base: StreamHistoryBase = {
      id: raw.id, ledger: raw.ledger, timestamp: raw.ledgerClosedAt, txHash: raw.txHash,
    };
    try {
      dispatchEvent(raw, {
        onCreated:  (event) => { entry = { ...base, kind: 'created', event }; },
        onWithdraw: (event) => { entry = { ...base, kind: 'withdraw', event }; },
        onTopUp:    (event) => { entry = { ...base, kind: 'top_up', event }; },
        onPause:    (event) => { entry = { ...base, kind: 'pause', event }; },
        onResume:   (event) => { entry = { ...base, kind: 'resume', event }; },
        onCancel:   (event) => { entry = { ...base, kind: 'cancel', event }; },
        onClawback: (event) => { entry = { ...base, kind: 'clawback', event }; },
      });
    } catch (err) {
      // One undecodable event must not hide the rest of the page.
      console.warn('[conduit-sdk] skipping undecodable history event:', err);
    }
    if (entry && (!options.filter || matchesStreamEventFilter(entry, options.filter))) entries.push(entry);
  }

  // A full page means there may be more. The cursor is a response field the
  // SDK's types omit; fall back to the last event's paging token.
  const last = response.events[response.events.length - 1];
  const cursor = (response as { cursor?: string }).cursor ?? last?.pagingToken;
  const nextCursor = response.events.length >= limit ? cursor : undefined;
  return { entries, nextCursor };
}

// ── Historical replay (reconnect backfill) ───────────────────────────────────

export const DEFAULT_REPLAY_PAGE_SIZE = 200;
export const DEFAULT_REPLAY_MAX_PAGES = 1_000;

export interface ReplayEventsOptions {
  /** Ledger to stop at (inclusive). Defaults to the chain's latest ledger at call time. */
  toLedger?: number;
  /** Events requested per `getEvents` page, 1-{@link MAX_HISTORY_PAGE_SIZE}. Default {@link DEFAULT_REPLAY_PAGE_SIZE}. */
  pageSize?: number;
  /** Safety cap on pages fetched before giving up. Default {@link DEFAULT_REPLAY_MAX_PAGES}. */
  maxPages?: number;
}

export interface ReplayEventsResult {
  /** Number of events dispatched to `handlers`. */
  dispatched: number;
  /** Ledger sequence of the last dispatched event, or `undefined` if none fell in range. */
  lastLedger: number | undefined;
}

/**
 * Replays a stream's historical events over `[fromLedger, toLedger]`,
 * dispatching each through the same decoding {@link dispatchEvent} uses for
 * live polling.
 *
 * An application reconnecting after being offline has no way to recover
 * events it missed while down — {@link subscribeToStream} only sees events
 * from the moment it (re)starts. Pass the last ledger the application
 * successfully processed (or one past it) as `fromLedger` to backfill
 * exactly what was missed, then resume `subscribeToStream` for new events
 * going forward.
 *
 * Unlike {@link getStreamHistory} (one page, for "load more" UIs), this
 * pages through every `getEvents` result up to `toLedger` (or the chain's
 * current ledger) within a single call.
 */
export async function replayEvents(
  rpcUrl:        string,
  streamAddress: string,
  handlers:      StreamEventHandlers,
  fromLedger:    number,
  options:       ReplayEventsOptions = {},
): Promise<ReplayEventsResult> {
  if (!Number.isInteger(fromLedger) || fromLedger < 1) {
    throw new Error(`fromLedger must be a positive integer, got ${String(fromLedger)}`);
  }
  if (options.toLedger !== undefined && (!Number.isInteger(options.toLedger) || options.toLedger < fromLedger)) {
    throw new Error(`toLedger must be an integer >= fromLedger, got ${String(options.toLedger)}`);
  }
  const pageSize = options.pageSize ?? DEFAULT_REPLAY_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_HISTORY_PAGE_SIZE) {
    throw new Error(`pageSize must be an integer between 1 and ${MAX_HISTORY_PAGE_SIZE}, got ${String(pageSize)}`);
  }
  const maxPages = options.maxPages ?? DEFAULT_REPLAY_MAX_PAGES;

  const server = createRpcServer(rpcUrl);
  const toLedger = options.toLedger ?? (await server.getLatestLedger()).sequence;

  const seen = new Set<string>();
  let dispatched = 0;
  let lastLedger: number | undefined;
  let cursor: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    if (pagesFetched >= maxPages) {
      throw new Error(`replayEvents: exceeded maxPages (${maxPages}) before reaching toLedger ${toLedger}`);
    }

    const response = await server.getEvents({
      ...(cursor ? { cursor } : { startLedger: fromLedger }),
      filters: [{ type: 'contract', contractIds: [streamAddress] }],
      limit: pageSize,
    });
    pagesFetched += 1;

    let pastRange = false;
    for (const event of response.events) {
      if (event.ledger > toLedger) { pastRange = true; break; }
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      dispatchIsolated(event, handlers);
      dispatched += 1;
      lastLedger = event.ledger;
    }
    if (pastRange) break;

    const responseCursor = (response as { cursor?: string }).cursor;
    if (!responseCursor || response.events.length < pageSize) break;
    cursor = responseCursor;
  }

  return { dispatched, lastLedger };
}
