import type { ConduitConfig, CreateStreamParams, CreateStreamResult, ListStreamsParams, PaginatedStreams, StreamEventHandlers, StreamInfo, Subscription, FeeEstimate, StreamOperation } from './types/index.js';
import type { WalletAdapter } from './adapters/types.js';
import { DEFAULT_RPC }               from './soroban.js';
import { StreamsModule }             from './streams.js';
import { FactoryModule }             from './factory.js';
import { GovernorModule }            from './governor.js';
import { SUPPORTED_NETWORKS, UnsupportedChainError, CAIP2_TO_NETWORK } from './errors.js';

/**
 * Validate that `wallet`'s network/chain matches the SDK's configured
 * `network`.  Throws `UnsupportedChainError` when:
 *
 * - The wallet exposes a `chainId` property (WalletConnect CAIP-2 string)
 *   that resolves to a network different from `expectedNetwork`.
 * - The wallet exposes a `chainId` that is not in the supported CAIP-2
 *   mapping at all (i.e. it's an EVM chain or an unknown Stellar variant).
 *
 * If the wallet has no `chainId` the check is skipped — adapters that do
 * not expose chain information (e.g. `KeypairWalletAdapter`) are always
 * accepted, because they sign whatever transaction the SDK constructs and
 * never independently specify a chain.
 */
function assertWalletNetworkMatch(
  wallet: WalletAdapter,
  expectedNetwork: string,
): void {
  const raw = wallet.chainId;
  if (raw === undefined || raw === null) return;

  const caip2 = String(raw);
  const resolved = CAIP2_TO_NETWORK[caip2];

  if (resolved === undefined) {
    throw new UnsupportedChainError(caip2);
  }

  if (resolved !== expectedNetwork) {
    throw new UnsupportedChainError(
      `${caip2} (wallet is on '${resolved}' but client is configured for '${expectedNetwork}')`,
    );
  }
}

/**
 * Main entry point for interacting with the StreamFi protocol.
 *
 * Provides a high-level API to create, manage, and query streams.
 *
 * @example
 * ```typescript
 * import { ConduitClient } from '@conduit/streamfi-sdk';
 * import { Keypair } from '@stellar/stellar-sdk';
 *
 * // Example configuration using variables typically loaded from .env
 * // STELLAR_SECRET=S...
 * // NEXT_PUBLIC_NETWORK=testnet
 * const config = {
 *   network: 'testnet',
 *   keypair: Keypair.fromSecret('STELLAR_SECRET'),
 * };
 *
 * const client = new ConduitClient(config);
 * ```
 */
export class ConduitClient {
  readonly streams:  StreamsModule;
  readonly governor: GovernorModule;

  /**
   * Access the DripFactory read-query module.
   *
   * @throws {Error} if `factoryAddress` was not supplied in `ConduitConfig`.
   *   Pass `factoryAddress` to the constructor to enable factory queries:
   *   ```ts
   *   new ConduitClient({ network: 'testnet', factoryAddress: 'C...' })
   *   ```
   */
  get factory(): FactoryModule {
    if (!this._factory) {
      // Construct lazily so that callers who don't use factory queries
      // (e.g. read-only stream operations) are not forced to supply
      // factoryAddress.  FactoryModule's constructor will throw with a
      // clear error if factoryAddress is missing.
      this._factory = new FactoryModule(this.config);
    }
    return this._factory;
  }
  private _factory: FactoryModule | undefined;

  private readonly config: Required<Pick<ConduitConfig, 'network' | 'rpcUrl'>> & ConduitConfig;

  /**
   * Initializes a new ConduitClient instance.
   *
   * Validates the configured network against supported networks to ensure
   * immediate failure on misconfiguration.
   *
   * @param config - Configuration object for the client.
   * @throws {UnsupportedChainError} If the provided `network` is not supported.
   * @throws {UnsupportedChainError} If a `wallet` is provided and its chain ID does not match the configured `network`.
   */
  constructor(config: ConduitConfig) {
    // Validate the network immediately so developers get a clear error at
    // initialisation time rather than an obscure RPC failure later.
    if (!(SUPPORTED_NETWORKS as readonly string[]).includes(config.network)) {
      throw new UnsupportedChainError(config.network);
    }

    this.config = {
      ...config,
      rpcUrl: config.rpcUrl ?? DEFAULT_RPC[config.network],
    };

    // If a wallet is provided at construction time, validate its chain too.
    if (this.config.wallet) {
      assertWalletNetworkMatch(this.config.wallet, this.config.network);
    }

    this.streams  = new StreamsModule(this.config);
    this.governor = new GovernorModule(this.config);
  }

  /**
   * Pause an active stream (sender only).
   *
   * Freezes the stream clock so no new tokens accrue. The stream can be
   * resumed later with {@link unpauseStream}.
   *
   * @param streamId - The numeric stream ID as a string (e.g. `"42"`).
   * @returns A promise that resolves to the confirmed transaction hash.
   * @throws {Error} If the transaction fails to submit or confirm.
   */
  async pauseStream(streamId: string): Promise<string> {
    return this.streams.pause(streamId);
  }

  /**
   * Resume a paused stream (sender only).
   *
   * Unfreezes the stream clock so tokens begin accruing again. The start
   * and end times are shifted forward by the duration the stream was paused.
   *
   * @param streamId - The numeric stream ID as a string (e.g. `"42"`).
   * @returns A promise that resolves to the confirmed transaction hash.
   * @throws {Error} If the transaction fails to submit or confirm.
   */
  async unpauseStream(streamId: string): Promise<string> {
    return this.streams.resume(streamId);
  }

  // ── Stream operation hoists (fixes #540) ─────────────────────────────────────
  //
  // Every public StreamsModule method is hoisted to the top level so the API
  // surface is consistent — a caller who finds client.pauseStream() can
  // reasonably expect client.create(), client.withdraw(), etc. to exist too.

  /** Create a new payment stream (sender only). */
  async createStream(params: CreateStreamParams): Promise<CreateStreamResult> {
    return this.streams.create(params);
  }

  /** Get stream details by ID. */
  async getStream(streamId: string): Promise<StreamInfo> {
    return this.streams.get(streamId);
  }

  /** List streams with optional filtering. */
  async listStreams(params?: ListStreamsParams): Promise<PaginatedStreams> {
    return this.streams.list(params ?? {});
  }

  /** Get the withdrawable amount for a stream. */
  async withdrawable(streamId: string): Promise<bigint> {
    return this.streams.withdrawable(streamId);
  }

  /** Withdraw available tokens from a stream (recipient only). */
  async withdraw(streamId: string): Promise<string> {
    return this.streams.withdraw(streamId);
  }

  /** Cancel a stream (sender only). */
  async cancelStream(streamId: string): Promise<string> {
    return this.streams.cancel(streamId);
  }

  /** Top up a stream's deposit (sender only). */
  async topUp(streamId: string, amount: bigint): Promise<string> {
    return this.streams.topUp(streamId, amount);
  }

  /** Claw back unstreamed tokens (sender only, if clawback is enabled). */
  async clawback(streamId: string): Promise<bigint> {
    return this.streams.clawback(streamId);
  }

  /** Force-cancel a stream paused beyond the threshold (recipient only). */
  async forceCancel(streamId: string): Promise<string> {
    return this.streams.forceCancel(streamId);
  }

  /** Transfer the recipient role to a new address (recipient only). */
  async transferRecipient(streamId: string, newRecipient: string): Promise<string> {
    return this.streams.transferRecipient(streamId, newRecipient);
  }

  /** Get the cumulative amount streamed since start (regardless of withdrawals). */
  async streamedTotal(streamId: string): Promise<bigint> {
    return this.streams.streamedTotal(streamId);
  }

  /** Estimate the network fee for a stream operation. */
  async estimateFee(operation: StreamOperation): Promise<FeeEstimate> {
    return this.streams.estimateFee(operation);
  }

  /** Subscribe to on-chain events for a stream. */
  subscribe(streamAddress: string, handlers: StreamEventHandlers): Subscription {
    return this.streams.subscribe(streamAddress, handlers);
  }

  /**
   * Dynamically attach or change the active wallet adapter.
   *
   * Validates that the new wallet's chain matches the client's configured
   * network before accepting it — prevents silent cross-chain mismatches
   * from reaching the smart contract (fixes #157).
   *
   * **Wallet propagation contract:**
   * - {@link StreamsModule}: Updated immediately — all subsequent stream
   *   operations (create, withdraw, cancel, etc.) use the new wallet.
   * - {@link FactoryModule}: NOT updated — this module is read-only and
   *   uses `config.keypair` for simulation fee sourcing. It does not hold
   *   a wallet reference and is unaffected by `setWallet()`.
   * - {@link GovernorModule}: NOT updated — this module is read-only and
   *   uses `config.keypair` for simulation fee sourcing. It does not hold
   *   a wallet reference and is unaffected by `setWallet()`.
   *
   * @param wallet - The wallet adapter to use for signing transactions.
   * @throws {UnsupportedChainError} if the wallet's `chainId` is on a
   *   different network than the one this client was initialised with.
   */
  setWallet(wallet: WalletAdapter): void {
    assertWalletNetworkMatch(wallet, this.config.network);
    this.config.wallet = wallet;
    this.streams.setWallet(wallet);
  }

  /**
   * Clear the address cache. Useful for testing or manual memory management.
   * The cache stores stream ID → contract address mappings and is bounded LRU,
   * but can be manually cleared if needed.
   */
  clearAddressCache(): void {
    this.streams.clearAddressCache();
  }

  /**
   * Expose factory address-cache hit/miss counters so consumers can tune
   * cache size and concurrency. Returns `null` when the factory module is
   * not initialized (no factoryAddress was configured).
   */
  getCacheMetrics(): { hits: number; misses: number; size: number } | null {
    return this._factory?.getCacheMetrics() ?? null;
  }
}

