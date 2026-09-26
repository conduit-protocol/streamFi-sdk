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
  TopUpEvent,
  ClawbackEvent,
  CreatedEvent,
  ForceCancelEvent,
  RecipientTransferEvent,
  OperatorSetEvent,
  OperatorRevokedEvent,
} from './types/index.js';
import { scValToI128, scValToU64, createRpcServer } from './soroban.js';

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
        dispatchIsolated(item.event, handlers);
      }
    } catch (err) {
      console.warn('[conduit-sdk] event replay failed:', err);
    } finally {
      isReplaying = false;
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
      const data: TopUpEvent = {
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
      const data: ClawbackEvent = {
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
