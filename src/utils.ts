import type { StreamInfo } from './types/index.js';

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
 * Current progress fraction (0–1) of a stream.
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
