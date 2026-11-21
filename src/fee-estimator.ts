/** A snapshot of fee pressure from a recent ledger. */
export interface LedgerFeeStats {
  /** Number of operations included in the ledger. */
  operations: number;
  /** Optional ledger sequence number, useful when tracking history. */
  ledger?: number;
  /** Optional observed base fee (in stroops) for that ledger. */
  baseFee?: number;
}

export interface CongestionOptions {
  /** Maximum operations a single ledger can hold. Default: 1000. */
  ledgerCapacity?: number;
  /** Utilization at which congestion pricing begins (0-1). Default: 0.5. */
  congestionThreshold?: number;
  /** Upper bound applied to the congestion multiplier. Default: 3. */
  maxMultiplier?: number;
  /** Number of recent ledgers averaged into the multiplier. Default: 5. */
  historySize?: number;
}

export interface EstimateOptions {
  /** Multiply the fetched fee by the current congestion multiplier. Default: false. */
  applyCongestion?: boolean;
}

interface ResolvedCongestionOptions {
  ledgerCapacity: number;
  congestionThreshold: number;
  maxMultiplier: number;
  historySize: number;
}

const DEFAULT_CONGESTION_OPTIONS: ResolvedCongestionOptions = {
  ledgerCapacity: 1000,
  congestionThreshold: 0.5,
  maxMultiplier: 3,
  historySize: 5,
};

function resolveCongestionOptions(options: CongestionOptions): ResolvedCongestionOptions {
  const ledgerCapacity = options.ledgerCapacity ?? DEFAULT_CONGESTION_OPTIONS.ledgerCapacity;
  const congestionThreshold = options.congestionThreshold ?? DEFAULT_CONGESTION_OPTIONS.congestionThreshold;
  const maxMultiplier = options.maxMultiplier ?? DEFAULT_CONGESTION_OPTIONS.maxMultiplier;
  const historySize = options.historySize ?? DEFAULT_CONGESTION_OPTIONS.historySize;

  if (!Number.isFinite(ledgerCapacity) || ledgerCapacity <= 0) {
    throw new RangeError('ledgerCapacity must be a positive number');
  }
  if (!Number.isFinite(congestionThreshold) || congestionThreshold < 0 || congestionThreshold >= 1) {
    throw new RangeError('congestionThreshold must be in the range [0, 1)');
  }
  if (!Number.isFinite(maxMultiplier) || maxMultiplier < 1) {
    throw new RangeError('maxMultiplier must be greater than or equal to 1');
  }
  if (!Number.isInteger(historySize) || historySize <= 0) {
    throw new RangeError('historySize must be a positive integer');
  }

  return { ledgerCapacity, congestionThreshold, maxMultiplier, historySize };
}

function roundToSevenDecimals(value: number): number {
  return Math.round(value * 10000000) / 10000000;
}

export class FeeEstimator {
  private baseFee: number;
  private isEstimating: boolean = false;
  private currentPromise: Promise<number> | null = null;

  private readonly congestion: ResolvedCongestionOptions;
  private ledgerStats: LedgerFeeStats[] = [];

  constructor(initialFee: number = 100, congestionOptions: CongestionOptions = {}) {
    this.baseFee = initialFee;
    this.congestion = resolveCongestionOptions(congestionOptions);
  }

  /**
   * Safely estimates the fee by fetching it asynchronously.
   * Utilizes an atomic state transition / locking mechanism to prevent race conditions
   * when multiple async hooks fire simultaneously.
   *
   * Congestion adjustment is opt-in: without `applyCongestion`, behavior is
   * unchanged from the plain network-fee estimate.
   */
  async estimateFee(
    networkFetcher: () => Promise<number>,
    options: EstimateOptions = {},
  ): Promise<number> {
    if (this.currentPromise) {
      return this.currentPromise;
    }

    this.currentPromise = (async () => {
      try {
        this.isEstimating = true;
        const rawFee = await networkFetcher();

        // Ensure floating point math precision and error-boundary handler
        if (typeof rawFee !== 'number' || !Number.isFinite(rawFee) || rawFee < 0) {
            throw new Error("Invalid network fee response");
        }

        // Round to 7 decimal places for precision handling
        this.baseFee = roundToSevenDecimals(rawFee);
        return options.applyCongestion ? this.getEffectiveFee() : this.baseFee;
      } catch (error) {
        // Fallback sequence: return the last known base fee
        return options.applyCongestion ? this.getEffectiveFee() : this.baseFee;
      } finally {
        this.isEstimating = false;
        this.currentPromise = null;
      }
    })();

    return this.currentPromise;
  }

  // Exposed for testing internal state
  get _isEstimating(): boolean {
    return this.isEstimating;
  }

  getBaseFee(): number {
    return this.baseFee;
  }

  /** Record the operation count (and optionally the fee) of a recent ledger. */
  recordLedgerStats(stats: LedgerFeeStats): void {
    if (!stats || typeof stats.operations !== 'number'
        || !Number.isFinite(stats.operations) || stats.operations < 0) {
      throw new RangeError('stats.operations must be a finite, non-negative number');
    }
    if (stats.ledger !== undefined
        && (!Number.isFinite(stats.ledger) || stats.ledger < 0)) {
      throw new RangeError('stats.ledger must be a non-negative number');
    }
    if (stats.baseFee !== undefined
        && (!Number.isFinite(stats.baseFee) || stats.baseFee < 0)) {
      throw new RangeError('stats.baseFee must be a non-negative number');
    }

    this.ledgerStats.push({ ...stats });
    if (this.ledgerStats.length > this.congestion.historySize) {
      this.ledgerStats.splice(0, this.ledgerStats.length - this.congestion.historySize);
    }
  }

  /** Average ledger utilization (0-1) across the retained history. */
  getUtilization(): number {
    if (this.ledgerStats.length === 0) return 0;

    const total = this.ledgerStats.reduce((sum, stats) => {
      const ratio = stats.operations / this.congestion.ledgerCapacity;
      return sum + Math.max(0, Math.min(1, ratio));
    }, 0);
    return total / this.ledgerStats.length;
  }

  /**
   * Congestion multiplier derived from recent ledger utilization.
   * Ramps linearly from 1x at the configured threshold to `maxMultiplier`
   * at full utilization, so busy ledgers push fees high enough for streaming
   * transactions to confirm promptly during peak network traffic.
   */
  getCongestionMultiplier(): number {
    const { congestionThreshold, maxMultiplier } = this.congestion;
    const utilization = this.getUtilization();
    if (utilization <= congestionThreshold) return 1;

    const excess = (utilization - congestionThreshold) / (1 - congestionThreshold);
    return Math.min(maxMultiplier, 1 + excess * (maxMultiplier - 1));
  }

  /** Base fee adjusted by the current congestion multiplier. */
  getEffectiveFee(): number {
    return roundToSevenDecimals(this.baseFee * this.getCongestionMultiplier());
  }

  getCongestionConfig(): Readonly<ResolvedCongestionOptions> {
    return { ...this.congestion };
  }

  /** Forget recorded ledger statistics. */
  clearLedgerStats(): void {
    this.ledgerStats = [];
  }
}
