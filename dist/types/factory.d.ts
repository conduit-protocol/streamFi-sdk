/**
 * FactoryModule — DripFactory read queries.
 */
import type { ConduitConfig } from './types/index.js';
export declare class FactoryModule {
    private readonly config;
    private readonly rpcUrl;
    private readonly passphrase;
    private readonly factoryId;
    private readonly callerAddr;
    constructor(config: ConduitConfig);
    /** Total number of streams ever created through this factory. */
    streamCount(): Promise<bigint>;
    /** Resolve a stream ID to its deployed contract address. Returns null if not found. */
    streamAddress(streamId: bigint | string): Promise<string | null>;
    /** List stream IDs where `address` is the sender, paginated. */
    streamsBySender(address: string, offset?: number, limit?: number): Promise<bigint[]>;
    /** List stream IDs where `address` is the recipient, paginated. */
    streamsByRecipient(address: string, offset?: number, limit?: number): Promise<bigint[]>;
    /** Current protocol fee in basis points (e.g. 30 = 0.3%). */
    protocolFeeBps(): Promise<number>;
    private parseU64Vec;
}
