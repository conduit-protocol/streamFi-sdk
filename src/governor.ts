/**
 * GovernorModule — DripGovernor config reads.
 */

import type { ConduitConfig, GovernorConfig } from './types/index.js';

export class GovernorModule {
  constructor(private readonly config: ConduitConfig) {}

  async config(): Promise<GovernorConfig> {
    // TODO: simulate governor.config()
    throw new Error('Not implemented');
  }
}
