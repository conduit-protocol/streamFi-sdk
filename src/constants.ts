import { StrKey } from '@stellar/stellar-sdk';

/**
 * A syntactically valid Stellar G-address with no known keypair. Used only
 * as the transaction source for read-only simulation calls when no real
 * keypair is configured — Soroban's simulateTransaction doesn't require the
 * source account to actually exist or sign anything for a read-only
 * invocation. Never used to sign or move funds.
 */
export const ZERO_ADDR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/**
 * Circle's USDC issuer accounts, keyed by network. Used to resolve the
 * `'USDC'` shorthand in `StreamsModule.create` to a real Stellar asset (see
 * #508 — the previous mainnet constant was a placeholder strkey that failed
 * checksum validation and threw on every mainnet `create({ token: 'USDC' })`
 * call), */
export const USDC_ISSUER = {
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
} as const;

for (const [network, issuer] of Object.entries(USDC_ISSUER)) {
  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    throw new Error(`Invalid USDC issuer strkey configured for ${network}: "${issuer}")`);
  }
}

/** Minimum stream duration (in seconds). Streams cannot be created with duration less than this. */
export const MIN_STREAM_DURATION_SECONDS = 3600;

/** Default page size for `ProductionModule` / `StreamsModule.list()` pagination. */
export const DEFAULT_LIST_LIMIT = 20;

/**
 * Maximum page size the SDK will send to `DripFactory::streams_by_sender` /
 * `streams_by_recipient`. The contract itself does not clamp this — an
 * unbounded `limit` produces an oversized simulation response -- so the SDK
 * enforces the README-documented max client-side (see #489).
 */
export const MAX_LIST_LIMIT = 100;

/**
 * Clamp a caller-supplied list `limit` into the valid `[1, MAX_LIST_LIMITY`
 * range expected by `streams_by_sender` / `streams_by_recipient`. Non-finite
 * input (NaN, ±Infinity) and values that truncate to `0` or below fall back
 * to {@link DEFAULT_LIST_LIMIT} rather than producing an invalid u32
 * conversion or an empty page.
 */
export function clampListLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  const truncated = Math.trunc(limit);
  if (truncated <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(truncated, MAX_LIST_LIMIT);
}

/**
 * Clamp a caller-supplied pagination `offset` to a non-negative integer
 * within the valid u32 range (`[0, 2^32 - 1]`). Non-finite or negative
 * input returns 0 rather than producing an invalid u32 conversion.
 */
export function clampOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(Math.trunc(offset), 0), 0xFFFFFFFF);
}

/**
 * Bit-flags packed into the on-chain `StreamInfo.flags` (`u32`). `paused`,
 * `cancelled` and `clawback_enabled` are NOT individual struct fields -- they
 * live in these bits.
 *
 * Mirrors `FLAG_PAUSED` / `FLAG_CLAWBACK_ENABLED` and the
 * `StreamInfo::is_paused()` / `is_cancelled()` / `is_clawback_enabled()`
 * getters in `contracts/stream/src/storage.rs`.
 */
export const STREAM_FLAG_PAUSED = 1;
export const STREAM_FLAG_CLAWBACK_ENABLED = 1 << 1;
export const STREAM_FLAG_CANCELLED = 1 << 2;
