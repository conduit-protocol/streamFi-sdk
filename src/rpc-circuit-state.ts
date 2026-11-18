/**
 * Per-endpoint circuit breaker state for RPC calls.
 *
 * #630: Expose circuit state so consumers can show 'RPC degraded' without
 * catching the thrown 'circuit open' error.
 *
 * The circuit tracks consecutive failures per RPC URL. When failures exceed
 * a threshold, the circuit opens (state = 'open'), and callers should expect
 * requests to fail. After a cooldown, the circuit moves to 'half-open',
 * allowing a single probe request. On success it closes; on failure it
 * re-opens.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitStatus {
  state: CircuitState;
  /** Consecutive failures since last success */
  failureCount: number;
  /** Epoch ms of last failure */
  lastFailureAt: number | null;
  /** Epoch ms of last success */
  lastSuccessAt: number | null;
  /** Epoch ms when the circuit will transition from 'open' to 'half-open' */
  cooldownUntil: number | null;
}

interface CircuitEntry extends CircuitStatus {
  scope: string;
}

const circuits = new Map<string, CircuitEntry>();

// #769 — Subscription mechanism so React hooks can react to state changes
// instead of polling getCircuitState on an interval.
type CircuitListener = (scope: string, state: CircuitStatus) => void;
const listeners = new Set<CircuitListener>();

function notifyListeners(scope: string, state: CircuitStatus): void {
  for (const listener of listeners) {
    try {
      listener(scope, state);
    } catch {
      // Listener errors must not break circuit state management.
    }
  }
}

/**
 * Listener invoked on every circuit state transition (e.g. closed -> open).
 * `scope` identifies the RPC endpoint whose circuit changed.
 */
export type CircuitTransitionListener = (from: CircuitState, to: CircuitState, scope: string) => void;
const transitionListeners = new Set<CircuitTransitionListener>();

function emitTransition(scope: string, from: CircuitState, to: CircuitState): void {
  if (from === to) return;
  for (const listener of transitionListeners) {
    try {
      listener(from, to, scope);
    } catch {
      // Listener errors must not break circuit state management.
    }
  }
}

/**
 * Subscribe to every circuit state transition across all scopes, including
 * the cooldown-driven `open` -> `half-open` transition. Returns an
 * unsubscribe function.
 *
 * @example
 * const off = subscribeCircuitTransitions((from, to, scope) => {
 *   if (to === 'open') showBanner(`RPC ${scope} is degraded`);
 * });
 */
export function subscribeCircuitTransitions(listener: CircuitTransitionListener): () => void {
  transitionListeners.add(listener);
  return () => {
    transitionListeners.delete(listener);
  };
}

/**
 * Subscribe to circuit state changes. Returns an unsubscribe function.
 * Called on every `recordSuccess`, `recordFailure`, and `resetCircuit`.
 */
export function onCircuitChange(listener: CircuitListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribe to circuit state changes for a specific scope. Returns an
 * unsubscribe function. The callback is invoked only when the circuit's
 * state actually transitions (e.g. closed -> open), not on every call.
 */
export function onCircuitStateChange(
  scope: string,
  callback: (state: CircuitStatus) => void,
): () => void {
  const listener: CircuitListener = (scopedScope, state) => {
    if (scopedScope === scope) {
      callback(state);
    }
  };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const DEFAULT_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * Get the current circuit state for an RPC endpoint.
 *
 * @example
 * const state = getCircuitState(rpcUrl);
 * if (state.state === 'open') {
 *   showBanner('RPC endpoint is degraded. Retrying in 30s.');
 * }
 */
export function getCircuitState(scope: string): CircuitStatus {
  const entry = circuits.get(scope);
  if (!entry) {
    return {
      state: 'closed',
      failureCount: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      cooldownUntil: null,
    };
  }

  // Auto-transition from 'open' to 'half-open' after cooldown
  if (entry.state === 'open' && entry.cooldownUntil && Date.now() >= entry.cooldownUntil) {
    entry.state = 'half-open';
    const status = {
      state: entry.state,
      failureCount: entry.failureCount,
      lastFailureAt: entry.lastFailureAt,
      lastSuccessAt: entry.lastSuccessAt,
      cooldownUntil: entry.cooldownUntil,
    };
    // `onCircuitStateChange`/`onCircuitChange` must see this transition too —
    // not just `subscribeCircuitTransitions` — since it's reachable purely by
    // calling this getter (e.g. a UI polling `state` or `getCircuitState`),
    // with no intervening recordSuccess/recordFailure call to notify from.
    notifyListeners(scope, status);
    emitTransition(scope, 'open', 'half-open');
  }

  return {
    state: entry.state,
    failureCount: entry.failureCount,
    lastFailureAt: entry.lastFailureAt,
    lastSuccessAt: entry.lastSuccessAt,
    cooldownUntil: entry.cooldownUntil,
  };
}

/**
 * Record a successful RPC call. Resets the failure counter and closes
 * the circuit.
 */
export function recordSuccess(scope: string): void {
  const entry = circuits.get(scope);
  if (!entry) return;
  const previousState = getCircuitState(scope).state;
  entry.failureCount = 0;
  entry.lastSuccessAt = Date.now();
  entry.state = 'closed';
  entry.cooldownUntil = null;
  if (previousState !== 'closed') {
    notifyListeners(scope, getCircuitState(scope));
    emitTransition(scope, previousState, 'closed');
  }
}

/**
 * Record a failed RPC call. Increments the failure counter and opens
 * the circuit if the threshold is exceeded.
 */
export function recordFailure(
  scope: string,
  options?: { threshold?: number; cooldownMs?: number },
): void {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = Date.now();

  let entry = circuits.get(scope);
  if (!entry) {
    entry = {
      scope,
      state: 'closed',
      failureCount: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      cooldownUntil: null,
    };
    circuits.set(scope, entry);
  }

  const previousState = getCircuitState(scope).state;

  // In half-open state, any failure re-opens the circuit
  if (entry.state === 'half-open') {
    entry.state = 'open';
    entry.failureCount += 1;
    entry.lastFailureAt = now;
    entry.cooldownUntil = now + cooldownMs;
    if (previousState !== 'open') {
      notifyListeners(scope, getCircuitState(scope));
    }
    emitTransition(scope, previousState, 'open');
    return;
  }

  entry.failureCount += 1;
  entry.lastFailureAt = now;

  if (entry.failureCount >= threshold) {
    entry.state = 'open';
    entry.cooldownUntil = now + cooldownMs;
  }
  if (entry.state !== previousState) {
    notifyListeners(scope, getCircuitState(scope));
    emitTransition(scope, previousState, entry.state);
  }
}

/**
 * Reset the circuit for a given scope (e.g. on manual retry).
 */
export function resetCircuit(scope: string): void {
  const hadEntry = circuits.has(scope);
  const previousState = hadEntry ? getCircuitState(scope).state : 'closed';
  circuits.delete(scope);
  if (hadEntry) {
    notifyListeners(scope, getCircuitState(scope));
    emitTransition(scope, previousState, 'closed');
  }
}

/**
 * Get all known circuit states (useful for dashboards).
 */
export function getAllCircuitStates(): CircuitStatus[] {
  return Array.from(circuits.values()).map(({ scope: _, ...rest }) => rest);
}

/** Thrown by {@link RpcCircuitBreaker.execute} when a call exceeds its timeout. */
export class RpcTimeoutError extends Error {
  constructor(scope: string, timeoutMs: number) {
    super(`RPC ${scope} timed out after ${timeoutMs}ms`);
    this.name = 'RpcTimeoutError';
  }
}

export interface RpcCircuitBreakerOptions {
  /** Consecutive timeouts before the circuit opens. Default: 3. */
  failureThreshold?: number;
  /** How long the circuit stays open before a half-open probe. Default: 30000. */
  cooldownMs?: number;
}

const DEFAULT_TIMEOUT_THRESHOLD = 3;
const DEFAULT_TIMEOUT_COOLDOWN_MS = 30_000;

/**
 * Circuit breaker for one RPC endpoint that counts consecutive timeouts.
 *
 * Opens after `failureThreshold` consecutive timeouts, so calls fail fast
 * instead of each hanging for the full timeout. After `cooldownMs` the
 * circuit goes half-open and lets one probe through. Any response that is not
 * a timeout (a success or an ordinary error) counts as the endpoint being
 * reachable and closes the circuit.
 *
 * @example
 * const breaker = new RpcCircuitBreaker(rpcUrl);
 * const info = await breaker.execute(() => server.getLedgerEntries(key), 5_000);
 */
export class RpcCircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly scope: string,
    options: RpcCircuitBreakerOptions = {},
  ) {
    this.threshold = options.failureThreshold ?? DEFAULT_TIMEOUT_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_TIMEOUT_COOLDOWN_MS;
  }

  /** Current circuit state for this endpoint. */
  get state(): CircuitStatus {
    return getCircuitState(this.scope);
  }

  /**
   * Run `fn` under the circuit. Throws immediately while the circuit is open.
   * If `fn` does not settle within `timeoutMs`, rejects with
   * {@link RpcTimeoutError} and counts a failure.
   */
  async execute<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (getCircuitState(this.scope).state === 'open') {
      throw new Error(`RPC circuit open for ${this.scope}`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RpcTimeoutError(this.scope, timeoutMs)), timeoutMs);
    });

    try {
      const result = await Promise.race([fn(), timeout]);
      recordSuccess(this.scope);
      return result;
    } catch (error) {
      if (error instanceof RpcTimeoutError) {
        recordFailure(this.scope, { threshold: this.threshold, cooldownMs: this.cooldownMs });
      } else {
        recordSuccess(this.scope);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
