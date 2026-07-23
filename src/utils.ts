import type { StreamInfo } from './types/index.js';
import { StrKey } from '@stellar/stellar-sdk';

/** Convert a display amount string to stroops (bigint) */
export function toStroops(amount: string, decimals = 7): bigint {
  const [whole = '0', frac = ''] = amount.split('.');
  const fracPadded = frac.slice(0, decimals).padEnd(decimals, '0');
  return BigInt(whole) * BigInt(10 ** decimals) + BigInt(fracPadded);
}

/** Convert stroops (bigint) to a display amount string */
export function fromStroops(stroops: bigint, decimals = 7): string {
  const factor  = BigInt(10 ** decimals);
  const whole   = stroops / factor;
  const frac    = (stroops % factor).toString().padStart(decimals, '0');
  const trimmed = frac.replace(/0+$/, '') || '0';
  return `${whole}.${trimmed}`;
}

/**
 * Calculate the rate per second (in stroops) from a total deposit and duration.
 *
 * @param depositAmount  Display amount string, e.g. '1000'
 * @param durationSecs   Duration in seconds
 * @param decimals       Token decimal places (default 7 for Stellar assets)
 */
export function calculateRate(depositAmount: string, durationSecs: number, decimals = 7): bigint {
  const stroops = toStroops(depositAmount, decimals);
  return stroops / BigInt(durationSecs);
}

/**
 * Current progress fraction (0-1) of a stream.
 * Returns 0 if not started, 1 if ended.
 */
export function streamProgress(stream: StreamInfo, nowSec = Math.floor(Date.now() / 1000)): number {
  const { startTime, endTime } = stream;
  if (nowSec < startTime) return 0;
  if (endTime === 0)       return 0;  // open-ended
  if (nowSec >= endTime)   return 1;
  return (nowSec - startTime) / (endTime - startTime);
}

/**
 * Current withdrawable balance from a StreamInfo snapshot, without a contract call.
 * Accounts for pause state.
 */
export function withdrawableLocal(stream: StreamInfo, nowSec = Math.floor(Date.now() / 1000)): bigint {
  if (stream.cancelled) return 0n;

  const effectiveNow = stream.paused
    ? stream.pausedAt
    : stream.endTime > 0 && nowSec > stream.endTime
    ? stream.endTime
    : nowSec;

  if (effectiveNow < stream.startTime) return 0n;

  const elapsed  = BigInt(effectiveNow - stream.startTime);
  const streamed = stream.ratePerSecond * elapsed;
  const available = streamed - stream.withdrawn;
  return available > 0n ? available : 0n;
}

/**
 * Recursively convert all bigint values in a value to their string
 * representation.  Safe for objects, arrays, and primitives.
 *
 * Safari / WebKit serialises `bigint` values as `{}` inside
 * `JSON.stringify`, which breaks payloads sent to the GraphQL
 * indexer.  Call this before network submission to guarantee
 * interoperability across all browsers.
 */
export function bigintSafeStringify<T>(value: T): T {
  if (typeof value === 'bigint') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return value.toString() as any;
  }
  if (Array.isArray(value)) {
    return value.map(bigintSafeStringify) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = bigintSafeStringify(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Validates whether a string is a well-formed Stellar public key
 * (account address, e.g. 'GABC...XYZ').
 *
 * Performs static format validation only (StrKey encoding, version byte,
 * checksum) -- it does not check whether the account exists on-chain.
 * Use this to fail fast before submission, e.g. before passing a recipient
 * into client.streams.create().
 */
export function isValidAddress(address: string): boolean {
  if (typeof address !== 'string' || address.length === 0) {
    return false;
  }
  return StrKey.isValidEd25519PublicKey(address);
}
