/**
 * Event subscription for DripStream contracts.
 *
 * Polls the Soroban event ledger on an interval and dispatches typed events
 * to registered handlers.
 */
import type { StreamEventHandlers, Subscription } from './types/index.js';
/**
 * Subscribe to on-chain events for a specific DripStream contract.
 *
 * @param rpcUrl        Soroban RPC endpoint
 * @param streamAddress DripStream contract address (C…)
 * @param handlers      Event handler callbacks
 * @returns             `{ unsubscribe }` — call to stop polling
 */
export declare function subscribeToStream(rpcUrl: string, streamAddress: string, handlers: StreamEventHandlers): Subscription;
