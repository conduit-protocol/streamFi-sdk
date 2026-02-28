import type { ConduitConfig } from './types/index.js';
import { DEFAULT_RPC }         from './soroban.js';
import { StreamsModule }       from './streams.js';
import { FactoryModule }       from './factory.js';
import { GovernorModule }      from './governor.js';

export class ConduitClient {
  readonly streams:  StreamsModule;
  readonly factory:  FactoryModule;
  readonly governor: GovernorModule;

  private readonly config: Required<Pick<ConduitConfig, 'network' | 'rpcUrl'>> & ConduitConfig;

  constructor(config: ConduitConfig) {
    this.config = {
      ...config,
      rpcUrl: config.rpcUrl ?? DEFAULT_RPC[config.network],
    };

    this.streams  = new StreamsModule(this.config);
    this.factory  = new FactoryModule(this.config);
    this.governor = new GovernorModule(this.config);
  }
}
