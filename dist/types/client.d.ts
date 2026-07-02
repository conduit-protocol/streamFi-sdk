import type { ConduitConfig } from './types/index.js';
import { StreamsModule } from './streams.js';
import { FactoryModule } from './factory.js';
import { GovernorModule } from './governor.js';
export declare class ConduitClient {
    readonly streams: StreamsModule;
    readonly factory: FactoryModule;
    readonly governor: GovernorModule;
    private readonly config;
    constructor(config: ConduitConfig);
}
