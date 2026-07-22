import type { ConduitConfig } from './types/index.js';
import type { WalletAdapter } from './adapters/types.js';
import { DEFAULT_RPC }               from './soroban.js';
import { StreamsModule }             from './streams.js';
import { FactoryModule }             from './factory.js';
import { GovernorModule }            from './governor.js';
import { SUPPORTED_NETWORKS, UnsupportedChainError } from './errors.js';

export class ConduitClient {
  readonly streams:  StreamsModule;
  readonly factory:  FactoryModule;
  readonly governor: GovernorModule;

  private readonly config: Required<Pick<ConduitConfig, 'network' | 'rpcUrl'>> & ConduitConfig;

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

    this.streams  = new StreamsModule(this.config);
    this.factory  = new FactoryModule(this.config);
    this.governor = new GovernorModule(this.config);
  }

  /**
   * Dynamically attach or change the active wallet adapter.
   */
  setWallet(wallet: WalletAdapter): void {
    this.config.wallet = wallet;
    this.streams.setWallet(wallet);
  }
}

