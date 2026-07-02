/**
 * StreamsModule — all DripStream + DripFactory operations.
 */
import type { ConduitConfig, CreateStreamParams, CreateStreamResult, ListStreamsParams, StreamEventHandlers, StreamInfo, Subscription } from './types/index.js';
export declare class StreamsModule {
    private readonly config;
    private readonly rpcUrl;
    private readonly passphrase;
    private readonly callerAddr;
    private readonly _factory;
    constructor(config: ConduitConfig);
    /**
     * Deploy a new DripStream via DripFactory.
     *
     * Simulates first to extract the assigned stream ID from the return value,
     * then signs and submits the assembled transaction.
     */
    create(params: CreateStreamParams): Promise<CreateStreamResult>;
    /** Fetch full stream state from the deployed DripStream contract. */
    get(streamId: bigint | string): Promise<StreamInfo>;
    /** Get withdrawable balance — read-only, no transaction. */
    withdrawable(streamId: bigint | string): Promise<bigint>;
    /** Withdraw tokens as the recipient. Defaults to full available balance. */
    withdraw(streamId: bigint | string, amount?: bigint): Promise<string>;
    /** Cancel the stream (sender only). Settles all balances atomically. */
    cancel(streamId: bigint | string): Promise<string>;
    /** Pause the stream (sender only). */
    pause(streamId: bigint | string): Promise<string>;
    /** Resume a paused stream (sender only). Shifts start/end times forward. */
    resume(streamId: bigint | string): Promise<string>;
    /** Deposit additional tokens into the stream (sender only). */
    topUp(streamId: bigint | string, amount: bigint): Promise<string>;
    /**
     * Clawback unstreamed tokens (sender; only if enabled at creation).
     * Returns the amount reclaimed (simulated before submission).
     */
    clawback(streamId: bigint | string): Promise<bigint>;
    /**
     * List streams by sender or recipient.
     * Resolves full StreamInfo for each ID — use sparingly with large sets.
     */
    list(params: ListStreamsParams): Promise<StreamInfo[]>;
    /** Subscribe to on-chain stream events via polling. Returns an async subscription handle. */
    subscribeAsync(streamId: bigint | string, handlers: StreamEventHandlers): Promise<Subscription>;
    /** Synchronous subscribe — resolves address lazily on first poll tick. */
    subscribe(streamId: bigint | string, handlers: StreamEventHandlers): Subscription;
    private _server;
    private _resolveAddr;
    private _simulateTx;
    /** Simulate → assemble → sign → submit → poll. Returns txHash. */
    private _invoke;
    private _sendAndPoll;
}
