import { RateLimitError, StreamFiNetworkError, RpcServiceUnavailableError } from './errors.js';

export interface WithRetryOptions {
  /** Maximum number of retry attempts after the initial failure. Default: 3 */
  maxRetries?: number;
  /** Initial backoff delay in milliseconds when Retry-After is absent. Default: 500 */
  baseDelayMs?: number;
  /** Backoff multiplier applied after each retry. Default: 2 */
  backoffFactor?: number;
  /** Maximum delay in milliseconds; exponential growth is clamped here. Default: 30_000 */
  maxDelayMs?: number;
  /** Jitter strategy applied to each delay. Default: 'full' */
  jitter?: 'none' | 'full' | 'equal' | 'decorrelated';
  /** Predicate that decides whether a thrown error is worth retrying. */
  shouldRetry?: (error: unknown) => boolean;
  /** Optional AbortSignal for cancelling pending retries. */
  signal?: AbortSignal;
  /** Optional callback invoked before each retry. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
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
 * The default jitter strategy is 'full' (random value in [0, delay]) which
 * prevents thundering herd problems when multiple clients hit rate limits
 * simultaneously. Other strategies include 'equal' (jitter in [delay/2, delay]),
 * 'decorrelated' (random in [baseDelay, previousDelay * 2]), and 'none'
 * (deterministic delay).
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
  const jitter = options.jitter ?? 'full';
  const shouldRetry = options.shouldRetry ?? isRateLimitError;
  const signal = options.signal;
  const onRetry = options.onRetry;

  if (signal?.aborted) {
    throw new Error('withRetry aborted before first attempt');
  }

  let delay = baseDelayMs;
  let prevDelay = baseDelayMs; // For decorrelated jitter

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
      const waitTime = applyJitter(clampedWait, jitter, prevDelay);

      onRetry?.({ attempt: attempt + 1, delayMs: waitTime, error: classified });
      await sleep(waitTime, signal);

      prevDelay = waitTime;
      delay = Math.min(delay * backoffFactor, maxDelayMs);
    }
  }

  // Unreachable, but satisfies TypeScript flow analysis.
  throw new Error('withRetry exhausted all retries');
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof RateLimitError;
}

function applyJitter(
  delayMs: number,
  strategy: NonNullable<WithRetryOptions['jitter']>,
  prevDelayMs: number,
): number {
  switch (strategy) {
    case 'full':
      return Math.floor(Math.random() * (delayMs + 1));
    case 'equal': {
      const half = delayMs / 2;
      return Math.floor(half + Math.random() * half);
    }
    case 'decorrelated': {
      // Decorrelated jitter: random value between baseDelay and previousDelay * backoffFactor
      // This prevents synchronization while still maintaining exponential growth on average
      const max = Math.max(delayMs, prevDelayMs * 2);
      return Math.floor(Math.random() * (max + 1));
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
