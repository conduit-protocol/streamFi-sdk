/**
 * GovernorModule — DripGovernor config reads.
 */
import type { ConduitConfig, GovernorConfig } from './types/index.js';
export declare class GovernorModule {
    private readonly rpcUrl;
    private readonly passphrase;
    private readonly governorId;
    private readonly callerAddr;
    constructor(cfg: ConduitConfig);
    /** Fetch the current protocol config from the DripGovernor contract. */
    getConfig(): Promise<GovernorConfig>;
}
