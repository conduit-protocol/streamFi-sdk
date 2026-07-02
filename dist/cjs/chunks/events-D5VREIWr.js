'use strict';

var stellarSdk = require('@stellar/stellar-sdk');

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
function scValToBigInt(val) {
    // soroban-sdk emits i128 / u64 as XDR ScVal; parse accordingly
    try {
        return BigInt(val.toString());
    }
    catch {
        return 0n;
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
function dispatchEvent(event, handlers) {
    // Topics: [symbol, actor_address]
    const topics = event.topic;
    if (!topics || topics.length < 1)
        return;
    const topicName = topics[0]?.sym()?.toString() ?? '';
    switch (topicName) {
        case TOPIC.WITHDRAWN: {
            if (!handlers.onWithdraw)
                break;
            const data = {
                recipient: topics[1] ? topics[1].address()?.accountId().toString() ?? '' : '',
                amount: scValToBigInt(event.value),
                totalWithdrawn: 0n, // TODO: parse tuple data
                remaining: 0n,
            };
            handlers.onWithdraw(data);
            break;
        }
        case TOPIC.CANCELLED: {
            if (!handlers.onCancel)
                break;
            const data = {
                sender: topics[1] ? topics[1].address()?.accountId().toString() ?? '' : '',
                refundAmount: 0n, // TODO: parse tuple data
                withdrawnSoFar: 0n,
            };
            handlers.onCancel(data);
            break;
        }
        case TOPIC.PAUSED: {
            if (!handlers.onPause)
                break;
            const data = {
                sender: topics[1] ? topics[1].address()?.accountId().toString() ?? '' : '',
                pausedAt: 0,
                withdrawable: 0n,
            };
            handlers.onPause(data);
            break;
        }
        case TOPIC.RESUMED: {
            if (!handlers.onResume)
                break;
            const data = {
                sender: topics[1] ? topics[1].address()?.accountId().toString() ?? '' : '',
                resumedAt: 0,
            };
            handlers.onResume(data);
            break;
        }
        case TOPIC.TOPPED_UP: {
            if (!handlers.onTopUp)
                break;
            const data = {
                sender: topics[1] ? topics[1].address()?.accountId().toString() ?? '' : '',
                amount: 0n,
                newBalance: 0n,
            };
            handlers.onTopUp(data);
            break;
        }
        case TOPIC.CLAWBACK: {
            if (!handlers.onClawback)
                break;
            const data = {
                sender: topics[1] ? topics[1].address()?.accountId().toString() ?? '' : '',
                amount: scValToBigInt(event.value),
            };
            handlers.onClawback(data);
            break;
        }
    }
}

exports.subscribeToStream = subscribeToStream;
//# sourceMappingURL=events-D5VREIWr.js.map
