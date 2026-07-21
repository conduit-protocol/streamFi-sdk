'use strict';

var stellarSdk = require('@stellar/stellar-sdk');
var index = require('./index-BkBD8DcG.js');
require('../utils.js');

/**
 * Event subscription for DripStream contracts.
 *
 * Polls the Soroban event ledger on an interval and dispatches typed events
 * to registered handlers.
 */
// ── Event topic names (match symbol_short!() values in Rust) ─────────────────
const TOPIC = {
    WITHDRAWN: 'withdrawn',
    CANCELLED: 'cancelled',
    PAUSED: 'paused',
    RESUMED: 'resumed',
    TOPPED_UP: 'topped_up',
    CLAWBACK: 'clawback',
};
// ── Parser helpers ────────────────────────────────────────────────────────────
/**
 * The stream contract publishes multi-field event data as a Rust tuple,
 * which soroban-sdk encodes as an ScVec. Single-field events (resumed,
 * clawback) publish the bare scalar instead — callers must know which shape
 * to expect for a given topic (see contracts/stream/src/events.rs).
 */
function tupleFields(val) {
    return val.vec() ?? [];
}
function i128Field(fields, index$1) {
    const field = fields[index$1];
    return field ? index.scValToI128(field) : 0n;
}
function u64Field(fields, index$1) {
    const field = fields[index$1];
    return field ? Number(index.scValToU64(field)) : 0;
}
/**
 * Decodes an address topic to its G.../C... string. `ScVal.address()?.accountId()`
 * returns the raw XDR PublicKey object, not a string — calling `.toString()`
 * on it yields `"[object Object]"`. `Address.fromScVal` handles both account
 * and contract address variants correctly.
 */
function addressField(val) {
    if (!val)
        return '';
    try {
        return stellarSdk.Address.fromScVal(val).toString();
    }
    catch {
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
function subscribeToStream(rpcUrl, streamAddress, handlers) {
    const server = new stellarSdk.SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    const pollInterval = handlers.pollInterval ?? 5000;
    let startLedger = 0; // updated after each successful poll
    let stopped = false;
    async function poll() {
        if (stopped)
            return;
        try {
            const response = await server.getEvents({
                ...(startLedger > 0 ? { startLedger } : {}),
                filters: [{
                        type: 'contract',
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
        }
        catch (err) {
            // Swallow polling errors; the subscription continues
            console.warn('[conduit-sdk] event polling error:', err);
        }
        if (!stopped)
            setTimeout(poll, pollInterval);
    }
    // Start polling immediately
    poll();
    return {
        unsubscribe: () => { stopped = true; },
    };
}
// ── Event dispatcher ──────────────────────────────────────────────────────────
// Exported (but not re-exported from index.ts) so tests can exercise the
// tuple-decoding logic directly without standing up a fake RPC server.
function dispatchEvent(event, handlers) {
    // Topics: [symbol, actor_address]
    const topics = event.topic;
    if (!topics || topics.length < 1)
        return;
    const topicName = topics[0]?.sym()?.toString() ?? '';
    const actor = addressField(topics[1]);
    switch (topicName) {
        case TOPIC.WITHDRAWN: {
            if (!handlers.onWithdraw)
                break;
            // data: (amount: i128, total_withdrawn: i128, remaining: i128)
            const fields = tupleFields(event.value);
            const data = {
                recipient: actor,
                amount: i128Field(fields, 0),
                totalWithdrawn: i128Field(fields, 1),
                remaining: i128Field(fields, 2),
            };
            handlers.onWithdraw(data);
            break;
        }
        case TOPIC.CANCELLED: {
            if (!handlers.onCancel)
                break;
            // data: (refund_amount: i128, withdrawn_so_far: i128)
            const fields = tupleFields(event.value);
            const data = {
                sender: actor,
                refundAmount: i128Field(fields, 0),
                withdrawnSoFar: i128Field(fields, 1),
            };
            handlers.onCancel(data);
            break;
        }
        case TOPIC.PAUSED: {
            if (!handlers.onPause)
                break;
            // data: (paused_at: u64, withdrawable: i128)
            const fields = tupleFields(event.value);
            const data = {
                sender: actor,
                pausedAt: u64Field(fields, 0),
                withdrawable: i128Field(fields, 1),
            };
            handlers.onPause(data);
            break;
        }
        case TOPIC.RESUMED: {
            if (!handlers.onResume)
                break;
            // data: resumed_at: u64 (bare scalar, not a tuple — resumed() only
            // publishes one field, see contracts/stream/src/events.rs)
            const data = {
                sender: actor,
                resumedAt: Number(index.scValToU64(event.value)),
            };
            handlers.onResume(data);
            break;
        }
        case TOPIC.TOPPED_UP: {
            if (!handlers.onTopUp)
                break;
            // data: (amount: i128, new_balance: i128)
            const fields = tupleFields(event.value);
            const data = {
                sender: actor,
                amount: i128Field(fields, 0),
                newBalance: i128Field(fields, 1),
            };
            handlers.onTopUp(data);
            break;
        }
        case TOPIC.CLAWBACK: {
            if (!handlers.onClawback)
                break;
            // data: amount: i128 (bare scalar, not a tuple)
            const data = {
                sender: actor,
                amount: index.scValToI128(event.value),
            };
            handlers.onClawback(data);
            break;
        }
    }
}

exports.dispatchEvent = dispatchEvent;
exports.subscribeToStream = subscribeToStream;
//# sourceMappingURL=events-C3kAsnt4.js.map
