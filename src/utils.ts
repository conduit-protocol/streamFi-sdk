import type { StreamInfo } from './types/index.js';
import { StrKey } from '@stellar/stellar-sdk';

const POW10: bigint[] = [
  1n, 10n, 100n, 1000n, 10000n, 100000n, 1000000n, 10000000n,
  100000000n, 1000000000n, 10000000000n, 100000000000n,
  1000000000000n, 10000000000000n, 100000000000000n,
  1000000000000000n, 10000000000000000n, 100000000000000000n,
  1000000000000000000n, 10000000000000000000n,
];

function pow10(decimals: number): bigint {
  return decimals < POW10.length ? POW10[decimals]! : BigInt(10 ** decimals);
}

/** Convert a display amount string to stroops (bigint) */
export function toStroops(amount: string, decimals = 7): bigint {
  if (!/^\d*(\.\d*)?$/.test(amount) || amount === '.' || amount === '') {
    throw new Error(`Invalid amount format: "${amount}"`);
  }
  const dotIndex = amount.indexOf('.');
  const whole = dotIndex === -1 ? amount : amount.slice(0, dotIndex);
  const frac = dotIndex === -1 ? '' : amount.slice(dotIndex + 1);
  const fracLen = frac.length;
  const needed = decimals + 1;
  let fracPadded: string;
  if (fracLen >= needed) {
    fracPadded = frac.slice(0, needed);
  } else {
    fracPadded = frac + '0'.repeat(needed - fracLen);
  }
  const fracValue = BigInt(fracPadded);
  const roundingDigit = fracPadded.charCodeAt(decimals) - 48;
  const roundedFrac = roundingDigit >= 5 ? fracValue / 10n + 1n : fracValue / 10n;
  return BigInt(whole) * pow10(decimals) + roundedFrac;
}

/** Convert stroops (bigint) to a display amount string */
export function fromStroops(stroops: bigint, decimals = 7): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const factor = pow10(decimals);
  const whole = abs / factor;
  const rem = abs % factor;
  const frac = rem.toString().padStart(decimals, '0');
  let end = frac.length;
  while (end > 1 && frac.charCodeAt(end - 1) === 48) {
    end--;
  }
  const trimmed = frac.slice(0, end);
  return `${neg ? '-' : ''}${whole}.${trimmed}`;
}

/**
 * Calculate the rate per second (in stroops) from a total deposit and duration.
 *
 * @param depositAmount  Display amount string, e.g. '1000'
 * @param durationSecs   Duration in seconds
 * @param decimals       Token decimal places (default 7 for Stellar assets)
 */
export function calculateRate(depositAmount: string, durationSecs: number, decimals = 7): bigint {
  if (!Number.isInteger(durationSecs) || durationSecs <= 0) {
    throw new Error(`durationSecs must be a positive integer, got ${durationSecs}`);
  }
  const stroops = toStroops(depositAmount, decimals);
  const divisor = BigInt(durationSecs);
  if (divisor === 0n) return 0n;
  const quotient = stroops / divisor;
  const remainder = stroops - quotient * divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

/**
 * Calculate the total yield (streamed amount) over a given duration.
 *
 * Uses BigInt throughout to avoid precision loss with large amounts.
 * Returns a formatted display string with 7 decimal places.
 *
 * @param ratePerSecond  Stream rate in stroops per second
 * @param durationSecs   Duration in seconds (default 1 year = 31,536,000)
 * @param decimals       Token decimal places (default 7 for Stellar assets)
 */
export function calculateYield(
  ratePerSecond: bigint,
  durationSecs = 31_536_000,
  decimals = 7,
): string {
  if (!Number.isInteger(durationSecs) || durationSecs <= 0) {
    throw new Error(`durationSecs must be a positive integer, got ${durationSecs}`);
  }
  const totalStroops = ratePerSecond * BigInt(durationSecs);
  return fromStroops(totalStroops, decimals);
}

/**
 * Current progress fraction (0-1) of a stream.
 * Returns 0 if not started, 1 if ended, and NaN for open-ended streams
 * that have started but do not have a finite completion percentage.
 */
export function streamProgress(stream: StreamInfo, nowSec = Math.floor(Date.now() / 1000)): number {
  const { startTime, endTime } = stream;
  if (nowSec < startTime) return 0;
  if (endTime === 0)       return Number.NaN;  // open-ended
  if (nowSec >= endTime)   return 1;
  return (nowSec - startTime) / (endTime - startTime);
}

/** Seconds remaining until a finite stream is fully vested. */
export function remainingTime(stream: StreamInfo, nowSec = Math.floor(Date.now() / 1000)): number {
  if (stream.endTime === 0 || nowSec >= stream.endTime) return 0;
  return stream.endTime - nowSec;
}

/** Estimated wall-clock date at which a stream is fully vested. */
export function estimatedCompletionDate(stream: StreamInfo): Date {
  return new Date(stream.endTime * 1000);
}

/**
 * Normalizes a `streamProgress()` result for display/comparison purposes,
 * mapping the NaN case (open-ended stream that has started) to the
 * midpoint 0.5. Shared by Module36 and Module48 so their progress deltas
 * agree at the edges instead of drifting via independent reimplementations.
 */
export function normalizeProgress(value: number): number {
  return Number.isNaN(value) ? 0.5 : value;
}

/**
 * Current withdrawable balance from a StreamInfo snapshot, without a contract call.
 * Accounts for pause state.
 */
export function withdrawableLocal(stream: StreamInfo, nowSec = Math.floor(Date.now() / 1000)): bigint {
  if (stream.cancelled) return 0n;

  // Mirror the on-chain `math::streamed_amount` clamp order
  // (contracts/stream/src/math.rs): clamp to `endTime` first — a stream that
  // has ended has fully streamed regardless of pause state — then, only while
  // the stream is still running, freeze accrual at `pausedAt`.
  const endClamped =
    stream.endTime > 0 && nowSec > stream.endTime ? stream.endTime : nowSec;
  const effectiveNow =
    stream.paused && stream.pausedAt < endClamped ? stream.pausedAt : endClamped;

  if (effectiveNow < stream.startTime) return 0n;

  const elapsed = effectiveNow - stream.startTime;
  if (elapsed <= 0) return 0n;

  const streamed = stream.ratePerSecond * BigInt(elapsed);
  const available = streamed - stream.withdrawn;
  return available > 0n ? available : 0n;
}

/**
 * Recursively convert all bigint values in a value to their string
 * representation.  Safe for objects, arrays, and primitives.
 *
 * Uses lazy cloning: only allocates a new object or array when at
 * least one descendant value is a bigint that gets converted to a
 * string.  When no bigints are present the original value is returned
 * unchanged, avoiding unnecessary allocations and GC pressure.
 *
 * Safari / WebKit serialises `bigint` values as `{}` inside
 * `JSON.stringify`, which breaks payloads sent to the GraphQL
 * indexer.  Call this before network submission to guarantee
 * interoperability across all browsers.
 */
export function bigintSafeStringify<T>(value: T): T {
  // Primitives: convert bigint, pass everything else through as-is.
  if (value === null || typeof value !== 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof value === 'bigint' ? (value.toString() as any) : value;
  }

  // Arrays: only allocate a new array if at least one element changed.
  if (Array.isArray(value)) {
    let changed = false;
    const arr = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orig = value[i] as any;
      const stringified = bigintSafeStringify(orig);
      if (stringified !== orig) changed = true;
      arr[i] = stringified;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (changed ? arr : value) as any;
  }

  // Plain objects: only allocate a new object if at least one property changed.
  let changed = false;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value);

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const orig = (value as Record<string, unknown>)[k];
    const stringified = bigintSafeStringify(orig);
    if (stringified !== orig) changed = true;
    out[k] = stringified;
  }

  return (changed ? out : value) as unknown as T;
}

/**
 * Validates whether a string is a well-formed Stellar public key
 * (account address, e.g. 'GABC...XYZ') or Soroban contract address ('CABC...XYZ').
 *
 * Performs static format validation only (StrKey encoding, version byte,
 * checksum) -- it does not check whether the account or contract exists on-chain.
 * Use this to fail fast before submission, e.g. before passing a recipient
 * into client.streams.create().
 */
export function isValidAddress(address: string): boolean {
  if (typeof address !== 'string' || address.length === 0) {
    return false;
  }
  return StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address);
}

/**
 * A portable `AbortSignal` that aborts after `ms` milliseconds — pass it as
 * the `signal` option to any SDK method that accepts one, e.g.
 *
 *     await client.streams.withdrawable(id, { signal: timeoutSignal(5_000) });
 *
 * Uses the native `AbortSignal.timeout()` when the runtime provides it
 * (Node >= 17.3 / Deno >= 1.20 / Chrome 103 / Firefox 100 / Safari 15.4) and
 * otherwise falls back to an `AbortController` + `setTimeout`, with `unref()`
 * on Node so a pending timeout does not keep the process alive.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const AS = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof AS.timeout === 'function') {
    return AS.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    ms,
  );
  (timer as unknown as { unref?: () => void }).unref?.();
  return controller.signal;
}
