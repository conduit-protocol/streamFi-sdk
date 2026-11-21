import { SorobanRpc, Transaction } from '@stellar/stellar-sdk';
import { createRpcServer } from './soroban.js';

/** Inclusion-fee priority tier used by {@link FeeEstimator.getDynamicFee}. */
export type FeePriority = 'low' | 'standard' | 'urgent';

/**
 * Resource-fee components reported by a Soroban simulation (#906).
 *
 * Unlike the inclusion fee (see {@link FeeEstimator.getDynamicFee}, which
 * comes from Horizon's `/fee_stats`), these come from `simulateTransaction`
 * and represent what the network will actually charge to run the invocation:
 *
 * - `resourceFee` — total resource fee in stroops (CPU + RAM + storage
 *   footprint), as `SimulateTransactionResponse.minResourceFee`.
 * - `cpuInstructions` — instruction budget the invocation is scheduled for.
 * - `readBytes` / `writeBytes` — storage footprint (read/write) bytes.
 */
export interface SorobanResourceFees {
  resourceFee:     bigint;
  cpuInstructions: bigint;
  readBytes:       bigint;
  writeBytes:      bigint;
}

/**
 * Pull the resource-fee components out of a `simulateTransaction` result.
 *
 * `minResourceFee` is the network's single number for the whole invocation;
 * the per-host-function `transactionData.resources()` breaks that down into
 * the CPU instruction budget and the storage read/write footprint so a caller
 * can see *why* a fee is high (a big read footprint, say) and trim it. Pure
 * and side-effect free, so it can be unit-tested without a live RPC.
 *
 * @param simulation - The `SimulateTransactionResponse` to read.
 * @returns Aggregated resource-fee components; `0n` for any field the
 *   simulation did not populate (e.g. an error simulation with no results).
 */
export function extractResourceFees(
  simulation: SorobanRpc.Api.SimulateTransactionResponse,
): SorobanResourceFees {
  // The installed SDK's `SimulateTransactionResponse` type lags the live RPC
  // shape, which always carries `minResourceFee` and `results[].transactionData`;
  // read them through a loose cast (same defensiveness the SDK uses elsewhere
  // for fields its own types omit).
  const sim = simulation as unknown as {
    minResourceFee?: string;
    results?: Array<{ transactionData?: { resources?: () => { instructions?: bigint; diskReadBytes?: bigint; writeBytes?: bigint } } }>;
  };
  const resourceFee = sim.minResourceFee ? BigInt(sim.minResourceFee) : 0n;
  let cpuInstructions = 0n;
  let readBytes = 0n;
  let writeBytes = 0n;
  for (const result of sim.results ?? []) {
    const resources = result.transactionData?.resources?.();
    if (resources) {
      cpuInstructions += resources.instructions ?? 0n;
      readBytes += resources.diskReadBytes ?? 0n;
      writeBytes += resources.writeBytes ?? 0n;
    }
  }
  return { resourceFee, cpuInstructions, readBytes, writeBytes };
}

const DEFAULT_PRIORITY_MULTIPLIERS: Record<FeePriority, number> = {
  low: 1,
  standard: 1.5,
  urgent: 3,
};

const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org';

/**
 * Default inclusion-fee headroom (#1073): fees can rise between estimation and
 * submission during busy ledgers, so estimates carry a 20% buffer unless the
 * caller opts out with `feeMultiplier: 1`.
 */
export const DEFAULT_FEE_MULTIPLIER = 1.2;

/**
 * Default lifetime of a cached fee estimate (#1074). Several transactions
 * assembled together reuse one network fee lookup instead of each issuing
 * its own request.
 */
export const DEFAULT_FEE_CACHE_TTL_MS = 5_000;

/** Soroban's per-transaction CPU instruction ceiling on Stellar mainnet. */
export const DEFAULT_CPU_INSTRUCTION_LIMIT = 100_000_000;

/**
 * Estimated CPU instructions consumed by one batched withdraw operation
 * (contract invocation, auth verification, storage read/write), calibrated
 * from observed mainnet simulation results for `withdraw`.
 */
export const DEFAULT_INSTRUCTIONS_PER_BATCH_ITEM = 4_000_000;

/**
 * Fixed per-transaction CPU overhead (envelope decoding, auth-entry
 * verification, footprint merge) that doesn't scale with batch size.
 */
export const DEFAULT_BATCH_FIXED_OVERHEAD_INSTRUCTIONS = 2_000_000;

/** Default fraction of {@link DEFAULT_CPU_INSTRUCTION_LIMIT} at which {@link estimateBatchFootprint} flags a batch. */
export const DEFAULT_BATCH_WARN_THRESHOLD = 0.9;

export interface BatchFootprintOptions {
  /** CPU instructions consumed per batch item. Default {@link DEFAULT_INSTRUCTIONS_PER_BATCH_ITEM}. */
  instructionsPerItem?: number;
  /** Fixed per-transaction overhead instructions. Default {@link DEFAULT_BATCH_FIXED_OVERHEAD_INSTRUCTIONS}. */
  fixedOverheadInstructions?: number;
  /** Network CPU instruction ceiling per transaction. Default {@link DEFAULT_CPU_INSTRUCTION_LIMIT}. */
  cpuInstructionLimit?: number;
  /** Utilization fraction (0-1] above which `exceedsThreshold` is set. Default {@link DEFAULT_BATCH_WARN_THRESHOLD}. */
  warnThreshold?: number;
}

/** Pre-execution estimate of a batch's Soroban CPU instruction footprint. */
export interface ResourceEstimate {
  /** The `itemCount` the estimate was computed for. */
  itemCount: number;
  /** Estimated total CPU instructions the batch will consume. */
  cpuInstructions: number;
  /** The CPU instruction ceiling the estimate was computed against. */
  cpuInstructionLimit: number;
  /** `cpuInstructions / cpuInstructionLimit`. Can exceed 1 for a batch that will not fit in a single transaction. */
  utilizationRatio: number;
  /** `true` once `utilizationRatio` passes the configured `warnThreshold`. */
  exceedsThreshold: boolean;
  /** The largest `itemCount` that stays at or under `warnThreshold`, for splitting an oversized batch. */
  recommendedMaxItems: number;
}

/**
 * Estimates the Soroban CPU instruction footprint of a multi-stream batch
 * withdrawal, without submitting or simulating anything on-chain.
 *
 * Soroban caps CPU instructions per transaction; a batch sized without
 * regard for that limit fails simulation only after the caller has already
 * built it. This gives clients a cheap, synchronous pre-flight check so they
 * can split an oversized batch — e.g. 25 withdrawals — before submission.
 *
 * The per-item and overhead costs are heuristics (see
 * {@link DEFAULT_INSTRUCTIONS_PER_BATCH_ITEM}); pass `options` to recalibrate
 * them against your own contract's measured simulation footprint.
 *
 * @example
 * const estimate = estimateBatchFootprint(25);
 * if (estimate.exceedsThreshold) {
 *   // split into chunks of estimate.recommendedMaxItems
 * }
 */
export function estimateBatchFootprint(
  itemCount: number,
  options: BatchFootprintOptions = {},
): ResourceEstimate {
  if (!Number.isInteger(itemCount) || itemCount < 1) {
    throw new Error(`itemCount must be a positive integer, got ${String(itemCount)}`);
  }

  const instructionsPerItem = options.instructionsPerItem ?? DEFAULT_INSTRUCTIONS_PER_BATCH_ITEM;
  const fixedOverheadInstructions = options.fixedOverheadInstructions ?? DEFAULT_BATCH_FIXED_OVERHEAD_INSTRUCTIONS;
  const cpuInstructionLimit = options.cpuInstructionLimit ?? DEFAULT_CPU_INSTRUCTION_LIMIT;
  const warnThreshold = options.warnThreshold ?? DEFAULT_BATCH_WARN_THRESHOLD;

  if (!Number.isFinite(instructionsPerItem) || instructionsPerItem < 0) {
    throw new Error(`instructionsPerItem must be a non-negative finite number, got ${String(instructionsPerItem)}`);
  }
  if (!Number.isFinite(fixedOverheadInstructions) || fixedOverheadInstructions < 0) {
    throw new Error(`fixedOverheadInstructions must be a non-negative finite number, got ${String(fixedOverheadInstructions)}`);
  }
  if (!Number.isFinite(cpuInstructionLimit) || cpuInstructionLimit <= 0) {
    throw new Error(`cpuInstructionLimit must be a positive finite number, got ${String(cpuInstructionLimit)}`);
  }
  if (!Number.isFinite(warnThreshold) || warnThreshold <= 0 || warnThreshold > 1) {
    throw new Error(`warnThreshold must be a finite number in (0, 1], got ${String(warnThreshold)}`);
  }

  const cpuInstructions = fixedOverheadInstructions + instructionsPerItem * itemCount;
  const utilizationRatio = cpuInstructions / cpuInstructionLimit;
  const exceedsThreshold = utilizationRatio > warnThreshold;

  const usableInstructions = Math.max(0, cpuInstructionLimit * warnThreshold - fixedOverheadInstructions);
  const recommendedMaxItems = instructionsPerItem > 0
    ? Math.max(1, Math.floor(usableInstructions / instructionsPerItem))
    : itemCount;

  return {
    itemCount,
    cpuInstructions,
    cpuInstructionLimit,
    utilizationRatio,
    exceedsThreshold,
    recommendedMaxItems,
  };
}

export interface DynamicFeeOptions extends FeeEstimateOptions {
  /** Priority tier, or a custom numeric multiplier (>= 1). Defaults to `'standard'`. */
  priority?: FeePriority | number;
}

/**
 * Recent-ledger inclusion-fee percentiles (stroops per operation) from
 * Horizon's `/fee_stats` (#960). `p75`/`p95` are what Horizon reports was
 * actually charged to land in the 75th/95th percentile of recent ledgers —
 * unlike {@link FeeEstimator.getDynamicFee}, which scales the *modal* fee by
 * a fixed multiplier, these move with real congestion, including spikes a
 * fixed multiplier would under- or over-shoot.
 */
export interface LedgerFeeStats {
  /** 75th-percentile fee charged in recent ledgers. Suitable for standard-priority inclusion. */
  p75: bigint;
  /** 95th-percentile fee charged in recent ledgers. Suitable for urgent inclusion during congestion. */
  p95: bigint;
}

export interface FeeEstimatorOptions {
  /** Horizon base URL queried for `/fee_stats`. Defaults to Stellar mainnet Horizon. */
  horizonUrl?: string;
  /** `fetch` implementation used for Horizon requests. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Override the multipliers applied per priority tier. */
  priorityMultipliers?: Partial<Record<FeePriority, number>>;
  /**
   * Minimum interval in milliseconds between network fetches.
   * Within this window, `estimateFee` serves the cached `baseFee`
   * instead of calling `networkFetcher` again. Default: no interval (every call fetches).
   */
  minRefetchIntervalMs?: number;
  /**
   * Inclusion-fee buffer multiplier applied to dynamic and percentile fee
   * estimates to resist out-bidding during high-congestion ledger periods.
   * Defaults to {@link DEFAULT_FEE_MULTIPLIER} (`1.2`, a 20% margin); pass `1`
   * to disable the buffer. Must be a finite number `>= 1`.
   */
  feeMultiplier?: number;
  /**
   * How long, in milliseconds, a fetched fee estimate is reused before the
   * network is queried again. Defaults to {@link DEFAULT_FEE_CACHE_TTL_MS}
   * (5s). `0` disables result caching (concurrent calls are still
   * de-duplicated). Must be a finite number `>= 0`.
   */
  cacheTtlMs?: number;
}

/**
 * Options for fee estimation with error handling callback.
 */

export interface FeeEstimateOptions {
  onError?: (error: Error) => void;
  /** Stable operation key. Entries with the same key share a short-lived estimate. */
  cacheKey?: string;
  /** Contract method used to derive a cache key when `cacheKey` is omitted. */
  method?: string;
  /** Contract arguments used to derive a cache key when `cacheKey` is omitted. */
  args?: unknown[];
}

/**
 * Estimates Soroban fees with caching and fallback behavior.
 * Represents all fees as bigint stroops to maintain precision and avoid IEEE-754 rounding errors.
 * Consistent with the SDK's bigint-stroops convention used for all on-chain monetary amounts.
 */
export class FeeEstimator {
  private baseFee: bigint;
  private isEstimating: boolean = false;
  private currentPromises = new Map<string, Promise<bigint>>();
  private readonly minRefetchIntervalMs: number;
  private lastSuccessfulFetchAtValue: number | null = null;
  private lastErrorValue: Error | null = null;
  private readonly cache = new Map<string, { fee: bigint; fetchedAt: number }>();
  private readonly cacheTtlMs: number;
  private readonly horizonUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly priorityMultipliers: Record<FeePriority, number>;
  private readonly feeMultiplier: number;
  private ledgerFeeStatsCache: { value: LedgerFeeStats; fetchedAt: number } | null = null;
  private ledgerFeeStatsPromise: Promise<LedgerFeeStats> | null = null;

  /**
   * Creates a new FeeEstimator instance.
   *
   * @param initialFee - Starting fee in stroops (bigint). Defaults to 100n stroops.
   * @param options - Configuration options for caching behavior.
   */
  constructor(initialFee: bigint = 100n, options?: FeeEstimatorOptions) {
    this.baseFee = initialFee;
    this.minRefetchIntervalMs = options?.minRefetchIntervalMs ?? 0;
    this.horizonUrl = (options?.horizonUrl ?? DEFAULT_HORIZON_URL).replace(/\/+$/, '');
    this.fetchImpl = options?.fetch;
    this.priorityMultipliers = { ...DEFAULT_PRIORITY_MULTIPLIERS, ...options?.priorityMultipliers };
    const feeMultiplier = options?.feeMultiplier ?? DEFAULT_FEE_MULTIPLIER;
    if (!Number.isFinite(feeMultiplier) || feeMultiplier < 1) {
      throw new Error(`Invalid feeMultiplier: must be a finite number >= 1, got ${String(feeMultiplier)}`);
    }
    this.feeMultiplier = feeMultiplier;
    const cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_FEE_CACHE_TTL_MS;
    if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) {
      throw new Error(`Invalid cacheTtlMs: must be a finite number >= 0, got ${String(cacheTtlMs)}`);
    }
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Estimates an inclusion fee (stroops per operation) from live network
   * congestion by querying Horizon's `/fee_stats`, then scales it by the
   * requested priority multiplier.
   *
   * The base is the modal fee charged in recent ledgers (falling back to
   * `last_ledger_base_fee`). Result caching, request de-duplication and the
   * last-known-fee fallback on network errors are shared with `estimateFee`.
   *
   * @example
   * const fee = await estimator.getDynamicFee({ priority: 'urgent' });
   */
  async getDynamicFee(options: DynamicFeeOptions = {}): Promise<bigint> {
    const { priority = 'standard', ...rest } = options;
    const multiplier = typeof priority === 'number' ? priority : this.priorityMultipliers[priority];
    if (!Number.isFinite(multiplier) || multiplier < 1) {
      throw new Error(`Invalid fee priority multiplier: ${String(priority)}`);
    }

    const fee = await this.estimateFee(async () => {
      const doFetch = this.fetchImpl ?? globalThis.fetch;
      const res = await doFetch(`${this.horizonUrl}/fee_stats`);
      if (!res.ok) throw new Error(`Horizon fee_stats request failed: ${res.status}`);
      const stats = (await res.json()) as {
        last_ledger_base_fee?: string;
        fee_charged?: { mode?: string };
      };
      const raw = stats.fee_charged?.mode ?? stats.last_ledger_base_fee;
      if (raw === undefined || !/^\d+$/.test(raw)) throw new Error('Invalid network fee response');
      // Basis-point math keeps the result an exact bigint.
      return (BigInt(raw) * BigInt(Math.round(multiplier * 100)) + 99n) / 100n;
    }, { cacheKey: `dynamic:${String(priority)}`, ...rest });

    return this.applyBuffer(fee);
  }

  /**
   * Fetches the 75th/95th-percentile inclusion fee charged in recent Stellar
   * ledgers from Horizon's `/fee_stats` (#960), as an alternative to
   * {@link getDynamicFee}'s fixed-multiplier-on-modal-fee approach.
   *
   * Cached for `cacheTtlMs` (default 5s, shared with `estimateFee`'s
   * caching window) and request-deduplicated the same way `estimateFee`
   * is — concurrent callers during a cold cache share one Horizon request
   * instead of issuing one each. On a network error, falls back to the
   * last successfully fetched stats (via `onError`) and only throws if none
   * exist yet.
   *
   * The configured {@link FeeEstimatorOptions.feeMultiplier} buffer is
   * applied to both percentiles, consistent with `getDynamicFee`.
   *
   * @example
   * const { p95 } = await estimator.getLedgerFeeStats();
   */
  async getLedgerFeeStats(options: FeeEstimateOptions = {}): Promise<LedgerFeeStats> {
    const cached = this.ledgerFeeStatsCache;
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.value;
    }
    if (this.ledgerFeeStatsPromise) {
      return this.ledgerFeeStatsPromise;
    }

    const promise = (async (): Promise<LedgerFeeStats> => {
      try {
        const doFetch = this.fetchImpl ?? globalThis.fetch;
        const res = await doFetch(`${this.horizonUrl}/fee_stats`);
        if (!res.ok) throw new Error(`Horizon fee_stats request failed: ${res.status}`);
        const stats = (await res.json()) as {
          last_ledger_base_fee?: string;
          fee_charged?: { mode?: string; p75?: string; p95?: string };
        };
        // Horizon omits percentile fields when recent ledgers are empty — fall
        // back to the modal/last-ledger-base fee so a quiet network still
        // yields a usable (if conservative) estimate rather than an error.
        const fallback = stats.fee_charged?.mode ?? stats.last_ledger_base_fee;
        const p75raw = stats.fee_charged?.p75 ?? fallback;
        const p95raw = stats.fee_charged?.p95 ?? fallback;
        if (p75raw === undefined || !/^\d+$/.test(p75raw) || p95raw === undefined || !/^\d+$/.test(p95raw)) {
          throw new Error('Invalid network fee response');
        }
        const value: LedgerFeeStats = {
          p75: this.applyBuffer(BigInt(p75raw)),
          p95: this.applyBuffer(BigInt(p95raw)),
        };
        this.ledgerFeeStatsCache = { value, fetchedAt: Date.now() };
        return value;
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        options.onError?.(normalizedError);
        if (this.ledgerFeeStatsCache) return this.ledgerFeeStatsCache.value;
        throw normalizedError;
      } finally {
        this.ledgerFeeStatsPromise = null;
      }
    })();
    this.ledgerFeeStatsPromise = promise;
    return promise;
  }

  /**
   * Applies the configured inclusion-fee buffer multiplier (see
   * {@link FeeEstimatorOptions.feeMultiplier}) to a computed fee so urgent
   * transactions resist out-bidding during high-congestion ledger periods.
   * Uses basis-point math to keep the result an exact bigint stroops value.
   */
  private applyBuffer(fee: bigint): bigint {
    if (this.feeMultiplier === 1) return fee;
    return (fee * BigInt(Math.round(this.feeMultiplier * 100)) + 99n) / 100n;
  }

  /**
   * Safely estimates the fee by fetching it asynchronously.
   * Utilizes an atomic state transition / locking mechanism to prevent race conditions
   * when multiple async hooks fire simultaneously.
   *
   * If `minRefetchIntervalMs` was configured, returns the cached `baseFee` when
   * called within that window after the last successful fetch.
   *
   * Returns fee as bigint stroops to avoid IEEE-754 floating-point precision loss.
   */
  async estimateFee(
    networkFetcher: () => Promise<bigint>,
    options: FeeEstimateOptions = {}
  ): Promise<bigint> {
    const cacheKey = options.cacheKey ?? (options.method
      ? `${options.method}:${JSON.stringify(options.args ?? [], (_key, value) =>
        typeof value === 'bigint' ? `${value}n` : value,
      )}`
      : undefined);
    const cached = cacheKey ? this.cache.get(cacheKey) : undefined;
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.fee;
    }

    const promiseKey = cacheKey ?? '__uncached__';
    const currentPromise = this.currentPromises.get(promiseKey);
    if (currentPromise) {
      return currentPromise;
    }

    // Return cached fee if within the minimum re-fetch interval
    if (this.minRefetchIntervalMs > 0) {
      const elapsed = Date.now() - (this.lastSuccessfulFetchAtValue ?? 0);
      if (elapsed < this.minRefetchIntervalMs) {
        // Surface the last error if one exists, instead of silently returning stale fee
        if (this.lastErrorValue) {
          options.onError?.(this.lastErrorValue);
          throw this.lastErrorValue;
        }
        return this.baseFee;
      }
    }

    const promise = (async () => {
      try {
        this.isEstimating = true;
        const rawFee = await networkFetcher();

        // Ensure bigint is valid and non-negative
        if (typeof rawFee !== 'bigint' || rawFee < 0n) {
            throw new Error("Invalid network fee response");
        }

        this.baseFee = rawFee;
        this.lastSuccessfulFetchAtValue = Date.now();
        this.lastErrorValue = null;
        if (cacheKey) this.cache.set(cacheKey, { fee: rawFee, fetchedAt: this.lastSuccessfulFetchAtValue });
        return this.baseFee;
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.lastErrorValue = normalizedError;
        options.onError?.(normalizedError);

        // Fallback sequence: return the last known base fee
        return this.baseFee;
      } finally {
        this.isEstimating = false;
        this.currentPromises.delete(promiseKey);
      }
    })();
    this.currentPromises.set(promiseKey, promise);

    return promise;
  }

  get _isEstimating(): boolean {
    return this.isEstimating;
  }

  /**
   * Returns the current base fee in stroops (bigint).
   * This is either the last successfully fetched value or the initial/fallback fee.
   *
   * @returns The base fee as bigint stroops.
   */
  getBaseFee(): bigint {
    return this.baseFee;
  }

  get lastSuccessfulFetchAt(): number | null {
    return this.lastSuccessfulFetchAtValue;
  }

  get lastError(): Error | null {
    return this.lastErrorValue;
  }

  get isStale(): boolean {
    return this.lastErrorValue !== null;
  }

  /**
   * Estimate the Soroban resource fee for a transaction by simulating it.
   *
   * Inclusion fee (`getDynamicFee`) tells you what the network charges to
   * *include* the transaction; this tells you what the invocation itself
   * costs in CPU/RAM/footprint — the component that spikes during fee surges
   * and causes "insufficient fee" rejections (#906). The breakdown comes from
   * {@link extractResourceFees}.
   *
   * @param transaction - The (unsigned) transaction to simulate.
   * @param options.simulate - Inject a simulator for testing; defaults to
   *   `sorobanServer.simulateTransaction(tx)` against `options.rpcUrl`.
   * @param options.rpcUrl - RPC endpoint used when no `simulate` is supplied.
   * @example
   * ```ts
   * const fees = await estimator.estimateResourceFees(tx, { rpcUrl });
   * console.log(`resource fee: ${fees.resourceFee} stroops, CPU: ${fees.cpuInstructions}`);
   * ```
   */
  async estimateResourceFees(
    transaction: Transaction,
    options: {
      rpcUrl?: string;
      simulate?: (tx: Transaction) => Promise<SorobanRpc.Api.SimulateTransactionResponse>;
    } = {},
  ): Promise<SorobanResourceFees> {
    const simulate = options.simulate ?? (async (tx) => {
      if (!options.rpcUrl) {
        throw new Error('estimateResourceFees requires rpcUrl or a simulate callback');
      }
      return createRpcServer(options.rpcUrl).simulateTransaction(tx);
    });
    const simulation = await simulate(transaction);
    return extractResourceFees(simulation);
  }
}
