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
} from './types/index.js';
import { scValToI128, scValToU64 } from './soroban.js';

// ── Event topic names (match symbol_short!() values in Rust) ─────────────────

const TOPIC = {
  WITHDRAWN: 'withdrawn',
  CANCELLED: 'cancelled',
  PAUSED:    'paused',
  RESUMED:   'resumed',
  TOPPED_UP: 'topped_up',
  CLAWBACK:  'clawback',
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

/**
 * Decodes an address topic to its G.../C... string. `ScVal.address()?.accountId()`
 * returns the raw XDR PublicKey object, not a string — calling `.toString()`
 * on it yields `"[object Object]"`. `Address.fromScVal` handles both account
 * and contract address variants correctly.
 */
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
  const server       = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  const pollInterval = handlers.pollInterval ?? 5000;
  let   startLedger  = 0;  // updated after each successful poll
  let   stopped      = false;
  let   timer: ReturnType<typeof setTimeout> | undefined;

  async function poll() {
    if (stopped) return;

    try {
      const response = await server.getEvents({
        ...(startLedger > 0 ? { startLedger } : {}),
        filters: [{
          type:        'contract',
          contractIds: [streamAddress],
        }],
        limit: 100,
      });

      if (response.events.length > 0) {
        // Update startLedger to avoid replaying events
        const maxLedger = Math.max(...response.events.map(e => e.ledger));
        startLedger = maxLedger + 1;

        for (const event of response.events) {
          dispatchEvent(event, handlers);
        }
      }
    } catch (err) {
      // Swallow polling errors; the subscription continues
      console.warn('[conduit-sdk] event polling error:', err);
    }

    if (!stopped) timer = setTimeout(poll, pollInterval);
  }

  // Start polling immediately
  poll();

  return {
    // Clear the pending timer immediately rather than relying solely on the
    // `stopped` flag — otherwise the scheduled setTimeout keeps its callback
    // (and everything it closes over: server, handlers, startLedger) alive
    // in the event loop until it fires on its own, up to `pollInterval` ms
    // after the caller believed the subscription was torn down.
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
export function dispatchEvent(
  event:    SorobanRpc.Api.EventResponse,
  handlers: StreamEventHandlers,
): void {
  // Topics: [symbol, actor_address]
  const topics = event.topic;
  if (!topics || topics.length < 1) return;

  const topicName = topics[0]?.sym()?.toString() ?? '';

  const actor = addressField(topics[1]);

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
      };
      handlers.onClawback(data);
      break;
    }
  }
}
