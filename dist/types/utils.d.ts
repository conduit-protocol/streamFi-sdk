import type { StreamInfo } from './types/index.js';
/** Convert a display amount string to stroops (bigint) */
export declare function toStroops(amount: string, decimals?: number): bigint;
/** Convert stroops (bigint) to a display amount string */
export declare function fromStroops(stroops: bigint, decimals?: number): string;
/**
 * Calculate the rate per second (in stroops) from a total deposit and duration.
 *
 * @param depositAmount  Display amount string, e.g. '1000'
 * @param durationSecs   Duration in seconds
 * @param decimals       Token decimal places (default 7 for Stellar assets)
 */
export declare function calculateRate(depositAmount: string, durationSecs: number, decimals?: number): bigint;
/**
 * Current progress fraction (0–1) of a stream.
 * Returns 0 if not started, 1 if ended.
 */
export declare function streamProgress(stream: StreamInfo, nowSec?: number): number;
/**
 * Current withdrawable balance from a StreamInfo snapshot, without a contract call.
 * Accounts for pause state.
 */
export declare function withdrawableLocal(stream: StreamInfo, nowSec?: number): bigint;
