/**
 * FactoryModule — DripFactory read queries.
 */

import type { ConduitConfig } from './types/index.js';

export class FactoryModule {
  constructor(private readonly config: ConduitConfig) {}

  async streamCount(): Promise<bigint> {
    // TODO: simulate factory.stream_count()
    throw new Error('Not implemented');
  }

  async streamAddress(streamId: bigint | string): Promise<string | null> {
    // TODO: simulate factory.stream_address(streamId)
    void streamId;
    throw new Error('Not implemented');
  }

  async protocolFeeBps(): Promise<number> {
    // TODO: simulate factory.protocol_fee_bps()
    throw new Error('Not implemented');
  }
}
