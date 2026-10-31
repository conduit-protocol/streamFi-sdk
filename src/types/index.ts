import type { Signer } from "../signer.js";
import type { LedgerGap } from "../indexer.js";

export type Network = "mainnet" | "testnet" | "local";

// ── Branded Types ───────────────────────────────────────────────────────────

/**
 * Branded type for stream IDs. Prevents accidentally passing an AccountId or
 * ContractAddress where a StreamId is expected.
 */
export type StreamId = bigint & { readonly __brand: unique symbol };

/**
 * Branded type for contract addresses (e.g., DripStream or token contracts).
 * Prevents accidentally passing an AccountId where a ContractAddress is expected.
 */
export type ContractAddress = string & { readonly __brand: unique symbol };

/**
 * Branded type for account/wallet addresses (Stellar public keys).
 * Prevents accidentally passing a ContractAddress or StreamId where an AccountId is expected.
 */
export type AccountId = string & { readonly __brand: unique symbol };

/**
 * Type guard to check if a value is a valid StreamId (bigint).
 */
export function isStreamId(value: unknown): value is StreamId {
  return typeof value === "bigint";
}

/**
 * Type guard to check if a value is a valid ContractAddress (non-empty string).
 */
export function isContractAddress(value: unknown): value is ContractAddress {
  return typeof value === "string" && value.length > 0;
}

/**
 * Type guard to check if a value is a valid AccountId (non-empty Stellar address string).
 */
export function isAccountId(value: unknown): value is AccountId {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    (value.startsWith("G") || value === "native")
  );
}

/**
 * Helper to cast a bigint to a StreamId. Use only when you are certain the value is a valid stream ID.
 */
export function asStreamId(value: bigint): StreamId {
  return value as StreamId;
}

/**
 * Helper to cast a string to a ContractAddress. Use only when you are certain the value is a valid contract address.
 */
export function asContractAddress(value: string): ContractAddress {
  return value as ContractAddress;
}

/**
 * Helper to cast a string to an AccountId. Use only when you are certain the value is a valid account ID.
 */
export function asAccountId(value: string): AccountId {
  return value as AccountId;
}

/**
 * Branded type for a content-addressed metadata URI attached to a stream
 * (e.g. an `ipfs://<cid>` URI or IPFS gateway URL) describing off-chain
 * attachments such as invoices. Prevents passing an arbitrary string where a
 * validated metadata URI is expected (#969).
 */
export type StreamMetadataURI = string & { readonly __brand: unique symbol };

/**
 * Type guard to check if a value is a valid StreamMetadataURI (non-empty string).
 */
export function isStreamMetadataURI(value: unknown): value is StreamMetadataURI {
  return typeof value === "string" && value.length > 0;
}

/**
 * Helper to cast a string to a StreamMetadataURI. Use only when you are certain the value is a valid metadata URI.
 */
export function asStreamMetadataURI(value: string): StreamMetadataURI {
  return value as StreamMetadataURI;
}

/**
 * Invoice details attached to a stream as off-chain metadata (#969).
 */
export interface StreamInvoiceMetadata {
  /** Human-readable invoice number assigned by the sender's billing system. */
  invoiceNumber: string;
  /** VAT/tax identifier of the invoicing party, when applicable. */
  vatId?: string;
  /** CID of the pinned invoice document or attachment on IPFS. */
  ipfsCid: string;
}

/**
 * JSON payload pinned to IPFS describing a stream's invoice metadata (#969).
 * `uri` is the resulting content-addressed location once the payload above
 * has been pinned, so a reader can confirm the fetched JSON matches where it
 * was retrieved from.
 */
export interface IPFSInvoicePayload {
  /** Stream this invoice is attached to. */
  streamId: bigint;
  /** The invoice details themselves. */
  invoice: StreamInvoiceMetadata;
  /** Content-addressed URI this payload is (or will be) pinned at. */
  uri?: StreamMetadataURI;
}

/**
 * Enumerates the possible lifecycle states of a stream.
 *
 * - `ACTIVE`   — stream is live and funds are flowing.
 * - `PAUSED`   — stream clock is frozen by the sender.
 * - `CANCELLED`— stream has been cancelled; no further streaming.
 * - `ENDED`    — stream reached its natural end time.
 */
export enum StreamState {
  ACTIVE = "ACTIVE",
  PAUSED = "PAUSED",
  CANCELLED = "CANCELLED",
  ENDED = "ENDED",
}

/**
 * Identifies the vesting schedule shape a stream follows.
 *
 * Numeric (not string) values, since this is meant to be passed across
 * serialization boundaries (indexer payloads, stored UI state) cheaply.
 *
 * - `Linear`          — funds accrue at a constant `ratePerSecond` for the
 *                        whole duration (the only shape the deployed
 *                        DripStream contract currently streams — see
 *                        {@link calculateAccruedAmount}).
 * - `CliffLinear`      — no accrual until a cliff timestamp, then linear
 *                        accrual for the remainder of the duration.
 * - `ExponentialDecay` — accrual rate decreases exponentially over time
 *                        rather than staying constant.
 *
 * `CliffLinear` and `ExponentialDecay` describe schedule shapes the SDK's
 * types can represent for off-chain planning/UI purposes (e.g. a stream
 * builder form, or an indexer that tags streams by intended shape) ahead of
 * on-chain support; only `Linear` is currently enforced by the contract.
 */
export enum StreamScheduleType {
  Linear = 0,
  CliffLinear = 1,
  ExponentialDecay = 2,
}

export interface ConduitConfig {
  /** Network to connect to */
  network: Network;
  /** Signing keypair — required for mutating operations */
  keypair?: import("@stellar/stellar-sdk").Keypair;
  /** Custom wallet adapter (e.g. WalletConnectAdapter) for browser/mobile wallet signing */
  wallet?: import("../adapters/types.js").WalletAdapter;
  /** Custom signer plugin (KMS/HSM). Takes precedence over keypair when set. */
  signer?: Signer;
  /** Signing behaviour for wallet adapters and custom signers (e.g. `signatureTimeoutMs`). */
  signerOptions?: import("../signer.js").SignerOptions;
  /** Override default Soroban RPC URL */
  rpcUrl?: string;
  /**
   * Horizon endpoint to automatically fail over to for the account/sequence
   * lookup when the Soroban RPC endpoint itself is unreachable (network
   * error, HTTP 503, or an open circuit) — see #953. Defaults to the
   * official Horizon endpoint for `network`. Horizon cannot simulate or
   * submit Soroban contract calls, so this only covers the `getAccount`
   * step every contract invocation needs; it does not provide failover for
   * simulation or submission.
   */
  horizonUrl?: string;
  /**
   * Array of Soroban RPC URLs for fallback failover. When provided, takes
   * precedence over `rpcUrl`. Endpoints are tried in order, with automatic
   * failover to the next URL after `rpcUrlFailureThresholdConsecutive`
   * consecutive timeouts on the current endpoint. Default behavior: round-robin
   * with fallback on repeated failures.
   */
  rpcUrls?: string[];
  /**
   * Number of consecutive timeouts before failing over to the next RPC URL
   * in the `rpcUrls` fallback list. Default 3. Only used when `rpcUrls` is
   * configured.
   */
  rpcUrlFailureThresholdConsecutive?: number;
  /** Override deployed DripFactory contract ID */
  factoryAddress?: string;
  /** Override deployed DripGovernor contract ID */
  governorAddress?: string;
  /** Override Soroban confirmation poll interval in ms; default 1000 */
  confirmationPollIntervalMs?: number;
  /** Override Soroban confirmation polling attempts; default 30 */
  confirmationMaxAttempts?: number;
  /**
   * Explicit inclusion (bid) fee in stroops for submitted transactions.
   * Takes precedence over `feeMultiplier`. Defaults to `BASE_FEE` (100
   * stroops) when neither is set, which is the network minimum and is not
   * competitive under inclusion-fee pressure (surge pricing, congested
   * ledgers) — see #509.
   */
  fee?: string;
  /**
   * Multiplier applied to `BASE_FEE` to compute the inclusion fee for
   * submitted transactions, e.g. `10` bids 10x the network minimum.
   * Ignored when `fee` is set. Defaults to `1` (BASE_FEE, unchanged).
   */
  feeMultiplier?: number;
  /**
   * Override the negative address cache TTL in milliseconds. When a stream
   * address is not found, the null result is cached for this duration before
   * retrying. Default 30_000 (30 seconds).
   */
  negativeCacheTtlMs?: number;
  /**
   * How long a `GovernorModule.getConfig()` read is reused, in milliseconds.
   * Protocol parameters only change when a governance proposal passes, so a
   * short window removes the need to re-simulate on every poll. Default
   * 30_000 (30 seconds, ~6 ledgers). Set `0` to disable the cache and
   * re-simulate on every call.
   */
  governorConfigCacheTtlMs?: number;
  /**
   * How long a `FactoryModule.getFactoryConfig()` read (`feeBps`,
   * `feeRecipient`) is reused, in milliseconds (#958). Factory protocol
   * parameters rarely change, so a stream-creation-heavy caller should not
   * pay a simulation per call for data that is almost always unchanged.
   * Default 300_000 (5 minutes). Set `0` to disable the cache and
   * re-simulate on every call.
   */
  factoryConfigCacheTtlMs?: number;
  /**
   * Custom `fetch` used for Soroban RPC requests and for the fee estimator's
   * Horizon `/fee_stats` call — for edge runtimes (Cloudflare Workers),
   * proxies/custom HTTP agents, request-tracing headers, or timeouts that the
   * global `fetch` does not provide.
   *
   * RPC routing is registered per `rpcUrl` and is process-wide, so two
   * clients sharing an `rpcUrl` share the most recently supplied function.
   * Indexer (GraphQL) traffic is configured separately on `GraphQLIndexer`.
   */
  customFetch?: typeof fetch;
  /**
   * Timeout in milliseconds for each Soroban RPC request sent through
   * `customFetch`; the request is aborted via `AbortController` once it
   * elapses. Defaults to 15000. Set to `0` to disable.
   */
  requestTimeoutMs?: number;
}

export interface StreamInfo {
  id: bigint;
  /** DripStream contract address */
  address: string;
  sender: string;
  recipient: string;
  /** Token contract address or 'native' */
  token: string;
  /** Tokens released per second, in stroops */
  ratePerSecond: bigint;
  /** Unix timestamp */
  startTime: number;
  /** Unix timestamp; 0 = open-ended */
  endTime: number;
  /** Total withdrawn by recipient so far, in stroops */
  withdrawn: bigint;
  paused: boolean;
  /** Timestamp when stream was last paused; 0 if not paused */
  pausedAt: number;
  cancelled: boolean;
  clawbackEnabled: boolean;
}

export interface CreateStreamParams {
  /** Stellar recipient address */
  recipient: string;
  /** 'native' (XLM), 'USDC', or a contract address */
  token: string;
  /** Total deposit in display units (e.g. '1000') */
  depositAmount: string;
  /** Stream duration in seconds (mutually exclusive with ratePerSecond) */
  durationSeconds?: number;
  /** Unix timestamp; defaults to current ledger time */
  startTime?: number;
  /** Optional stop/end time (Unix timestamp) */
  stopTime?: number;
  /** Optional stop/end time alias (Unix timestamp) */
  endTime?: number;
  /** Optional sender address */
  sender?: string;
  /** Whether the sender can claw back unstreamed tokens */
  clawbackEnabled?: boolean;
  /** Override rate in stroops/s (mutually exclusive with durationSeconds) */
  ratePerSecond?: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  error?: string;
}

export interface CreateStreamResult {
  streamId: bigint;
  streamAddress: string;
  txHash: string;
}

export interface ListStreamsParams {
  sender?: string;
  recipient?: string;
  offset?: number;
  limit?: number;
  /** Opaque pagination cursor from a previous page's `nextCursor`. Takes precedence over `offset` if both are given. */
  cursor?: string;
}

export interface PaginatedStreams {
  /** The stream info results for this page */
  streams: StreamInfo[];
  /** Whether there are more results after this page */
  hasNextPage: boolean;
  /** Number of filtered stream IDs seen through the end of this page */
  totalCount: bigint;
  /** The offset used for this page */
  offset: number;
  /** The limit used for this page */
  limit: number;
  /** Opaque cursor to pass as `cursor` to fetch the next page. Present only when `hasNextPage` is true. */
  nextCursor?: string;
}

export interface GetStreamInfosOptions {
  /** Maximum number of concurrent RPC simulations. Defaults to 8. */
  maxConcurrency?: number;
}

export interface BatchGetStreamsOptions extends GetStreamInfosOptions {
  /** Number of stream IDs read per chunk. Defaults to 20. */
  chunkSize?: number;
  /** Pause in milliseconds between chunks, to stay under RPC rate limits. Defaults to 0. */
  chunkDelayMs?: number;
}

export interface GetStreamInfosFailure {
  id: bigint;
  error: string;
}

export interface GetStreamInfosResult {
  results: StreamInfo[];
  failures: GetStreamInfosFailure[];
}

export interface GovernorConfig {
  feeBps: number;
  feeRecipient?: string;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  maxRatePerSecond: bigint;
  factoryAddress?: string;
  votingDelay?: number;
  votingPeriod?: number;
  proposalThreshold?: bigint;
}

/** Cached result of `FactoryModule.getFactoryConfig()` (#958). */
export interface FactoryConfig {
  /** Current protocol fee in basis points (e.g. 30 = 0.3%). */
  feeBps: number;
  /** Address the protocol fee is paid to, when the factory reports one. */
  feeRecipient?: string;
}

// ── Events ──────────────────────────────────────────────────────────────────

export interface WithdrawEvent {
  amount: bigint;
  recipient: string;
  totalWithdrawn: bigint;
  remaining: bigint;
  sequence?: bigint;
}
export interface CancelEvent {
  refundAmount: bigint;
  withdrawnSoFar: bigint;
  sender: string;
  sequence?: bigint;
}
export interface PauseEvent {
  pausedAt: number;
  withdrawable: bigint;
  sender: string;
  sequence?: bigint;
}
export interface ResumeEvent {
  resumedAt: number;
  sender: string;
  sequence?: bigint;
}
/** Published when the sender tops up a stream (`topped_up` topic). */
export interface StreamTopUpEvent {
  /** Amount added to the stream's deposit. */
  amount: bigint;
  /** Stream balance after the top-up. */
  newBalance: bigint;
  /** The address that funded the top-up (topics[1] actor). */
  sender: string;
  sequence?: bigint;
}

/** Published when the sender claws back unstreamed funds (`clawback` topic). */
export interface StreamClawbackedEvent {
  /** Amount clawed back to the sender. */
  amount: bigint;
  /** The address that initiated the clawback (topics[1] actor). */
  sender: string;
  sequence?: bigint;
}

/** @deprecated Use {@link StreamTopUpEvent}. */
export type TopUpEvent = StreamTopUpEvent;
/** @deprecated Use {@link StreamClawbackedEvent}. */
export type ClawbackEvent = StreamClawbackedEvent;

/** Published once when the factory deploys a new DripStream (`created` topic). */
export interface CreatedEvent {
  /** The stream's sender (topics[1] actor). */
  sender: string;
  recipient: string;
  token: string;
  depositAmount: bigint;
  ratePerSecond: bigint;
  startTime: number;
  endTime: number;
  sequence?: bigint;
}

/**
 * Published when the recipient force-cancels a paused stream after the
 * pause threshold has elapsed (`force_cxl` topic). Settles atomically like
 * `cancelled`, but is recipient-initiated rather than sender-initiated.
 */
export interface ForceCancelEvent {
  /** The recipient who force-cancelled (topics[1] actor). */
  recipient: string;
  /** Earned-but-unwithdrawn amount paid out to the recipient. */
  payoutAmount: bigint;
  /** Unstreamed remainder refunded to the sender. */
  refundAmount: bigint;
  sequence?: bigint;
}

/** Published when the recipient role is transferred to a new address (`xfer_rec` topic). */
export interface RecipientTransferEvent {
  /** The outgoing recipient who initiated the transfer (topics[1] actor). */
  previousRecipient: string;
  newRecipient: string;
  sequence?: bigint;
}

/** Published when an operator is delegated on the stream (`set_op` topic). */
export interface OperatorSetEvent {
  /** The address that granted the operator role (topics[1] actor). */
  sender: string;
  operator: string;
  sequence?: bigint;
}

/** Published when a previously-delegated operator is revoked (`rm_op` topic). */
export interface OperatorRevokedEvent {
  /** The address that revoked the operator role (topics[1] actor). */
  sender: string;
  operator: string;
  sequence?: bigint;
}

/** A gap detected in the per-contract event sequence — see `DataKey::EventSequence` in contracts/stream/src/events.rs. */
export interface EventGap {
  /** The sequence number that should have come next. */
  expected: bigint;
  /** The sequence number actually observed. */
  actual: bigint;
}

/**
 * Payload delivered by `onStreamEvent(..., 'CliffReached', ...)`.
 *
 * Unlike the other event payloads, this has no on-chain topic: the stream
 * contract does not emit a cliff event, since "cliff" is a vesting-schedule
 * convention (see `examples/vesting-schedule.ts`) rather than contract
 * state — a vesting cliff is just a stream whose `startTime` is set to the
 * cliff end, so nothing accrues before it. `cliffTime` is the caller-supplied
 * timestamp this notification fired against.
 */
export interface CliffReachedEvent {
  /** Unix timestamp (seconds) at which the cliff was reached. */
  cliffTime: number;
}

/** Maps each handler-facing event name to its decoded payload type. */
export interface EventPayloadMap {
  withdraw: WithdrawEvent;
  cancel: CancelEvent;
  pause: PauseEvent;
  resume: ResumeEvent;
  topUp: StreamTopUpEvent;
  clawback: StreamClawbackedEvent;
  created: CreatedEvent;
  forceCancel: ForceCancelEvent;
  recipientTransfer: RecipientTransferEvent;
  operatorSet: OperatorSetEvent;
  operatorRevoke: OperatorRevokedEvent;
}

/** Union of every decoded stream event payload. */
export type StreamEventPayload = EventPayloadMap[keyof EventPayloadMap];

export interface StreamEventHandlers {
  onWithdraw?: (e: WithdrawEvent) => void;
  onCancel?: (e: CancelEvent) => void;
  onPause?: (e: PauseEvent) => void;
  onResume?: (e: ResumeEvent) => void;
  onTopUp?: (e: StreamTopUpEvent) => void;
  onClawback?: (e: StreamClawbackedEvent) => void;
  /** Called when the factory deploys a new stream. Optional — most subscribers attach after a stream already exists. */
  onCreated?: (e: CreatedEvent) => void;
  /** Called when the recipient force-cancels a paused stream. */
  onForceCancel?: (e: ForceCancelEvent) => void;
  /** Called when the recipient role is transferred to a new address — the current subscriber may have just lost the stream. */
  onRecipientTransfer?: (e: RecipientTransferEvent) => void;
  /** Called when an operator is delegated on the stream. */
  onOperatorSet?: (e: OperatorSetEvent) => void;
  /** Called when a delegated operator is revoked. */
  onOperatorRevoke?: (e: OperatorRevokedEvent) => void;
  /**
   * Called when an event polling request fails. Polling continues
   * afterward — unless this failure reaches `maxConsecutiveFailures`, in
   * which case this is the last call before the subscription stops.
   */
  onError?: (error: Error) => void;
  /** Called when a non-contiguous event sequence is observed (missed events across a poll gap or reconnect). */
  onGap?: (gap: EventGap) => void;
  /**
   * Called when two consecutively dispatched events are not from
   * consecutive ledgers, i.e. `nextLedger !== currentLedger + 1`. Unlike
   * `onGap` (keyed on the contract's own `topics[2]` sequence), this is
   * derived from Soroban's `event.ledger` field, so it also catches skips
   * for event types that don't carry a sequence topic. A detected gap
   * triggers an automatic backfill fetch for the missed ledger range.
   */
  onLedgerGap?: (gap: LedgerGap) => void;
  /** Polling interval in ms; default 5000 */
  pollInterval?: number;
  /**
   * Number of recent event IDs remembered to drop duplicates delivered by
   * overlapping `getEvents` ledger ranges. Default 1000; `0` disables.
   */
  dedupWindowSize?: number;
  /**
   * Upper bound (ms) for the exponential backoff delay applied between
   * retries after consecutive polling failures. Default 60000.
   */
  maxBackoffMs?: number;
  /**
   * Number of consecutive polling failures after which the subscription
   * gives up and stops polling (the timer is not rescheduled). A
   * successful poll resets the counter. Default 10.
   */
  maxConsecutiveFailures?: number;
}

export interface Subscription {
  unsubscribe: () => void;
}

// -- Batch operations ----------------------------------------------------------

/**
 * A single stream to create as part of a batch creation.
 *
 * This is the strongly typed counterpart of the loosely-shaped objects that
 * batch creation used to accept: `recipient`, `token` and `depositAmount` are
 * required, so a missing recipient or a misformatted amount is caught by the
 * compiler instead of at runtime.
 *
 * @example
 * ```ts
 * const payloads: BatchStreamCreationPayload[] = [
 *   { recipient: 'G...', token: 'native', depositAmount: '100' },
 * ];
 * await client.streams.createBatchStreams(payloads);
 * ```
 */
export interface BatchStreamCreationPayload {
  /** Stellar recipient address. */
  recipient: string;
  /** 'native' (XLM), 'USDC', or a contract address. */
  token: string;
  /** Total deposit in display units (e.g. '1000'). */
  depositAmount: string;
  /** Stream duration in seconds (mutually exclusive with `ratePerSecond`). */
  durationSeconds?: number;
  /** Override rate in stroops/s (mutually exclusive with `durationSeconds`). */
  ratePerSecond?: string;
  /** Unix timestamp; defaults to current ledger time. */
  startTime?: number;
  /** Optional stop/end time (Unix timestamp). */
  stopTime?: number;
  /** Optional stop/end time alias (Unix timestamp). */
  endTime?: number;
  /** Optional sender address. */
  sender?: string;
  /** Whether the sender can claw back unstreamed tokens. */
  clawbackEnabled?: boolean;
}

/**
 * A single withdrawal to perform as part of a batch withdraw.
 *
 * `streamId` is required, so a batch can no longer contain an entry that
 * silently targets nothing.
 *
 * @example
 * ```ts
 * const payloads: BatchWithdrawPayload[] = [{ streamId: 1n }];
 * await client.streams.batchWithdraw(payloads);
 * ```
 */
export interface BatchWithdrawPayload {
  /** The stream to withdraw from. */
  streamId: bigint | string;
  /** Amount in stroops. Defaults to the full withdrawable balance if omitted. */
  amount?: bigint;
}

/**
 * Configuration for a single stream in a batch creation.
 *
 * Alias of {@link BatchStreamCreationPayload}, kept for backwards
 * compatibility with existing callers.
 */
export type StreamConfig = BatchStreamCreationPayload;

export interface BatchWithdrawItem extends BatchWithdrawPayload {}

export interface BatchWithdrawResult {
  streamId: bigint;
  success: boolean;
  txHash?: string;
  error?: string;
}

export interface BatchCreateStreamResult {
  index: number;
  success: boolean;
  streamId?: bigint;
  streamAddress?: string;
  txHash?: string;
  error?: string;
}

// -- Stream Operations & Fee Estimation ---------------------------------------

export interface FeeEstimate {
  totalFee: bigint;
  resourceFee: bigint;
  baseFee: bigint;
  instructions: bigint;
}

export type StreamOperationType =
  | "create"
  | "withdraw"
  | "cancel"
  | "pause"
  | "resume"
  | "topUp"
  | "transferRecipient"
  | "batchWithdraw";

export type StreamOperation =
  | StreamOperationType
  | { type: "create"; params?: CreateStreamParams }
  | { type: "withdraw"; streamId?: bigint | string; amount?: bigint }
  | { type: "cancel"; streamId?: bigint | string }
  | { type: "pause"; streamId?: bigint | string }
  | { type: "resume"; streamId?: bigint | string }
  | { type: "topUp"; streamId?: bigint | string; amount?: bigint }
  | {
      type: "transferRecipient";
      streamId?: bigint | string;
      newRecipient?: string;
    }
  | { type: "batchWithdraw"; items?: BatchWithdrawItem[] }
  | { type: string; [key: string]: unknown };

/**
 * Human-readable breakdown of remaining stream duration.
 */
export interface DurationBreakdown {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  totalSeconds: number;
}
