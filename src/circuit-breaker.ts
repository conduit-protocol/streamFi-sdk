/**
 * Lightweight per-scope circuit breaker for RPC calls.
 *
 * Tracks failure/success per scope (e.g. RPC URL). After `failureThreshold`
 * consecutive failures within `resetTimeoutMs`, the circuit opens and all
 * calls for that scope fast-fail until `halfOpenAfterMs` elapses, at which
 * point a single probe call is allowed. If the probe succeeds the circuit
 * closes; if it fails the circuit stays open for another `halfOpenAfterMs`.
 */

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening the circuit. Default: 5 */
  failureThreshold?: number;
  /** Time window in which failures must occur to count. Default: 30_000 */
  resetTimeoutMs?: number;
  /** Milliseconds to wait before allowing a probe call. Default: 15_000 */
  halfOpenAfterMs?: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

interface ScopeState {
  failures: number;
  lastFailureAt: number;
  state: CircuitState;
  openedAt?: number;
}

const _scopes = new Map<string, ScopeState>();

function getOrCreateState(scope: string): ScopeState {
  let s = _scopes.get(scope);
  if (!s) {
    s = { failures: 0, lastFailureAt: 0, state: 'closed' };
    _scopes.set(scope, s);
  }
  return s;
}

export function getCircuitState(scope: string): CircuitState {
  const s = _scopes.get(scope);
  if (!s) return 'closed';

  if (s.state === 'open') {
    const opts = getDefaultOptions();
    const elapsed = Date.now() - (s.openedAt ?? 0);
    if (elapsed >= opts.halfOpenAfterMs!) {
      s.state = 'half-open';
    }
  }

  return s.state;
}

export class CircuitOpenError extends Error {
  readonly scope: string;
  constructor(scope: string) {
    super(`Circuit open for scope: ${scope}`);
    this.name = 'CircuitOpenError';
    this.scope = scope;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

let _defaultOptions: Required<CircuitBreakerOptions> = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenAfterMs: 15_000,
};

export function configureCircuitBreaker(options: CircuitBreakerOptions): void {
  _defaultOptions = { ..._defaultOptions, ...options };
}

function getDefaultOptions(): Required<CircuitBreakerOptions> {
  return _defaultOptions;
}

/**
 * Wraps an operation with circuit-breaker protection for the given scope.
 * When the circuit is open, the wrapper throws {@link CircuitOpenError}
 * immediately without invoking the operation.
 */
export async function withCircuitBreaker<T>(
  scope: string,
  operation: () => Promise<T>,
): Promise<T> {
  const state = getOrCreateState(scope);
  const opts = getDefaultOptions();

  // Age out stale failures
  if (state.lastFailureAt > 0 && Date.now() - state.lastFailureAt > opts.resetTimeoutMs) {
    state.failures = 0;
    state.state = 'closed';
  }

  // Transition open -> half-open after timeout
  if (state.state === 'open') {
    const elapsed = Date.now() - (state.openedAt ?? 0);
    if (elapsed >= opts.halfOpenAfterMs!) {
      state.state = 'half-open';
    } else {
      throw new CircuitOpenError(scope);
    }
  }

  try {
    const result = await operation();
    // Success: reset failures and close circuit
    state.failures = 0;
    state.state = 'closed';
    return result;
  } catch (err) {
    state.failures++;
    state.lastFailureAt = Date.now();
    if (state.failures >= opts.failureThreshold) {
      state.state = 'open';
      state.openedAt = Date.now();
    }
    throw err;
  }
}
