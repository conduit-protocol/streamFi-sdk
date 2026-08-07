import type { ConduitConfig } from './types/index.js';
import type { WalletAdapter } from './adapters/types.js';
import { DEFAULT_RPC }               from './soroban.js';
import { StreamsModule }             from './streams.js';
import { FactoryModule }             from './factory.js';
import { GovernorModule }            from './governor.js';
import { SUPPORTED_NETWORKS, UnsupportedChainError } from './errors.js';

/**
 * Map from CAIP-2 chain identifiers used by WalletConnect adapters to the
 * canonical SDK network names they correspond to.  Any CAIP-2 value not
 * present here is considered unsupported and will be rejected by
 * `assertWalletNetworkMatch`.
 */
const CAIP2_TO_NETWORK: Readonly<Record<string, string>> = {
  'stellar:pubnet':  'mainnet',
  'stellar:testnet': 'testnet',
  'stellar:local':   'local',
};

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
  readonly factory:  FactoryModule;
  readonly governor: GovernorModule;

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
    this.factory  = new FactoryModule(this.config);
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
}

