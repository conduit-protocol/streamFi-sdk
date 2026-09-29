import { RateLimitError, StreamFiNetworkError, RpcServiceUnavailableError, CircuitOpenError } from './errors.js';
import { getCircuitState } from './rpc-circuit-state.js';

export interface WithRetryOptions {
  /** Maximum number of retry attempts after the initial failure. Default: 3 */
  maxRetries?: number;
  /** Initial backoff delay in milliseconds when Retry-After is absent. Default: 500 */
  baseDelayMs?: number;
  /** Backoff multiplier applied after each retry. Default: 2 */
  backoffFactor?: number;
  /** Maximum delay in milliseconds; exponential growth is clamped here. Default: 30_000 */
  maxDelayMs?: number;
  /** Jitter strategy applied to each delay. Default: 'none' */
  jitter?: 'none' | 'full' | 'equal';
  /** Predicate that decides whether a thrown error is worth retrying. */
  shouldRetry?: (error: unknown) => boolean;
  /** Optional AbortSignal for cancelling pending retries. */
  signal?: AbortSignal;
  /** Optional callback invoked before each retry. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /**
   * Optional `rpc-circuit-state.ts` scope (typically an RPC URL) to consult
   * before attempting the operation. If that scope's circuit is already
   * `'open'`, `withRetry` throws a {@link CircuitOpenError} immediately
   * instead of entering the retry loop, avoiding wasted backoff time
   * against an endpoint the SDK has already determined is down. See #787.
   */
  circuitScope?: string;
}

/**
 * Retry an async operation with exponential backoff and optional jitter.
 *
 * By default the helper retries only {@link RateLimitError}, honouring the
 * server's `Retry-After` header (exposed on the error as `retryAfterMs`) by
 * waiting at least that long before the next attempt. When no `Retry-After`
 * is provided, it falls back to exponential backoff starting at
 * `baseDelayMs`.
 *
 * The predicate, jitter strategy, delay cap, and `AbortSignal` make the
 * helper usable beyond the SDK's RPC proxy — for example, for transient
 * network errors or any caller-defined retryable condition.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const backoffFactor = options.backoffFactor ?? 2;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const jitter = options.jitter ?? 'none';
  const shouldRetry = options.shouldRetry ?? isRateLimitError;
  const signal = options.signal;
  const onRetry = options.onRetry;
  const circuitScope = options.circuitScope;

  if (signal?.aborted) {
    throw new Error('withRetry aborted before first attempt');
  }

  if (circuitScope !== undefined) {
    const circuit = getCircuitState(circuitScope);
    if (circuit.state === 'open') {
      throw new CircuitOpenError(circuitScope, circuit.cooldownUntil);
    }
  }

  let delay = baseDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) {
      throw new Error('withRetry aborted');
    }

    try {
      return await operation();
    } catch (err) {
      // Classify raw RPC errors so the default predicate and callers receive
      // typed RateLimitError / RpcServiceUnavailableError instances.
      const classified = RateLimitError.fromRpcError(err) ?? err;

      if (attempt === maxRetries || !shouldRetry(classified)) {
        throw classified;
      }

      const retryAfterMs = classified instanceof RateLimitError ? classified.retryAfterMs : undefined;
      const baseWait = retryAfterMs ?? delay;
      const clampedWait = Math.min(baseWait, maxDelayMs);
      const waitTime = applyJitter(clampedWait, jitter);

      onRetry?.({ attempt: attempt + 1, delayMs: waitTime, error: classified });
      await sleep(waitTime, signal);

      delay = Math.min(delay * backoffFactor, maxDelayMs);
    }
  }

  // Unreachable, but satisfies TypeScript flow analysis.
  throw new Error('withRetry exhausted all retries');
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof RateLimitError;
}

function applyJitter(delayMs: number, strategy: NonNullable<WithRetryOptions['jitter']>): number {
  switch (strategy) {
    case 'full':
      return Math.floor(Math.random() * (delayMs + 1));
    case 'equal': {
      const half = delayMs / 2;
      return Math.floor(half + Math.random() * half);
    }
    case 'none':
    default:
      return delayMs;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('withRetry sleep aborted'));
    }, { once: true });
  });
}

/**
 * Convenience predicate: retry transient network-level failures.
 *
 * Matches {@link RateLimitError}, {@link StreamFiNetworkError}, and
 * {@link RpcServiceUnavailableError} so callers can compose a retry
 * policy for RPC calls without hard-coding error classes.
 */
export function isTransientRpcError(err: unknown): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof StreamFiNetworkError ||
    err instanceof RpcServiceUnavailableError
  );
}
