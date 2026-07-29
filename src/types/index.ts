import type { Signer } from '../signer.js';

export type Network = 'mainnet' | 'testnet' | 'local';

export interface ConduitConfig {
  /** Network to connect to */
  network: Network;
  /** Signing keypair — required for mutating operations */
  keypair?: import('@stellar/stellar-sdk').Keypair;
  /** Custom wallet adapter (e.g. WalletConnectAdapter) for browser/mobile wallet signing */
  wallet?: import('../adapters/types.js').WalletAdapter;
  /** Custom signer plugin (KMS/HSM). Takes precedence over keypair when set. */
  signer?: Signer;
  /** Override default Soroban RPC URL */
  rpcUrl?: string;
  /** Override deployed DripFactory contract ID */
  factoryAddress?: string;
  /** Override deployed DripGovernor contract ID */
  governorAddress?: string;
  /** Override Soroban confirmation poll interval in ms; default 1000 */
  confirmationPollIntervalMs?: number;
  /** Override Soroban confirmation polling attempts; default 30 */
  confirmationMaxAttempts?: number;
}

export interface StreamInfo {
  id:              bigint;
  /** DripStream contract address */
  address:         string;
  sender:          string;
  recipient:       string;
  /** Token contract address or 'native' */
  token:           string;
  /** Tokens released per second, in stroops */
  ratePerSecond:   bigint;
  /** Unix timestamp */
  startTime:       number;
  /** Unix timestamp; 0 = open-ended */
  endTime:         number;
  /** Total withdrawn by recipient so far, in stroops */
  withdrawn:       bigint;
  paused:          boolean;
  /** Timestamp when stream was last paused; 0 if not paused */
  pausedAt:        number;
  cancelled:       boolean;
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
  /** Whether the sender can claw back unstreamed tokens */
  clawbackEnabled?: boolean;
  /** Override rate in stroops/s (mutually exclusive with durationSeconds) */
  ratePerSecond?: string;
}

/** Configuration for a single stream in a batch creation. */
export type StreamConfig = CreateStreamParams;

export interface CreateStreamResult {
  streamId:      bigint;
  streamAddress: string;
  txHash:        string;
}

export interface ListStreamsParams {
  sender?:    string;
  recipient?: string;
  offset?:    number;
  limit?:     number;
  /** Opaque pagination cursor from a previous page's `nextCursor`. Takes precedence over `offset` if both are given. */
  cursor?:    string;
}

export interface PaginatedStreams {
  /** The stream info results for this page */
  streams:    StreamInfo[];
  /** Whether there are more results after this page */
  hasNextPage: boolean;
  /** Number of filtered stream IDs seen through the end of this page */
  totalCount:  bigint;
  /** The offset used for this page */
  offset:      number;
  /** The limit used for this page */
  limit:       number;
  /** Opaque cursor to pass as `cursor` to fetch the next page. Present only when `hasNextPage` is true. */
  nextCursor?: string;
}

export interface GovernorConfig {
  feeBps:              number;
  feeRecipient?:       string;
  minDurationSeconds:  number;
  maxRatePerSecond:    bigint;
  factoryAddress?:     string;
}

// ── Events ──────────────────────────────────────────────────────────────────

export interface WithdrawEvent  { amount: bigint; recipient: string; totalWithdrawn: bigint; remaining: bigint; }
export interface CancelEvent    { refundAmount: bigint; withdrawnSoFar: bigint; sender: string; }
export interface PauseEvent     { pausedAt: number; withdrawable: bigint; sender: string; }
export interface ResumeEvent    { resumedAt: number; sender: string; }
export interface TopUpEvent     { amount: bigint; newBalance: bigint; sender: string; }
export interface ClawbackEvent  { amount: bigint; sender: string; }

export interface StreamEventHandlers {
  onWithdraw?: (e: WithdrawEvent)  => void;
  onCancel?:   (e: CancelEvent)    => void;
  onPause?:    (e: PauseEvent)     => void;
  onResume?:   (e: ResumeEvent)    => void;
  onTopUp?:    (e: TopUpEvent)     => void;
  onClawback?: (e: ClawbackEvent)  => void;
  onError?:    (error: Error)      => void;
  /** Polling interval in ms; default 5000 */
  pollInterval?: number;
}

export interface Subscription {
  unsubscribe: () => void;
}

// -- Batch operations ----------------------------------------------------------

export interface BatchWithdrawItem {
  streamId: bigint | string;
  /** Amount in stroops. Defaults to the full withdrawable balance if omitted. */
  amount?: bigint;
}

export interface BatchWithdrawResult {
  streamId: bigint;
  success: boolean;
  txHash?: string;
  error?: string;
}
