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
  entry.failureCount = 0;
  entry.lastSuccessAt = Date.now();
  entry.state = 'closed';
  entry.cooldownUntil = null;
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

  // In half-open state, any failure re-opens the circuit
  if (entry.state === 'half-open') {
    entry.state = 'open';
    entry.failureCount += 1;
    entry.lastFailureAt = now;
    entry.cooldownUntil = now + cooldownMs;
    return;
  }

  entry.failureCount += 1;
  entry.lastFailureAt = now;

  if (entry.failureCount >= threshold) {
    entry.state = 'open';
    entry.cooldownUntil = now + cooldownMs;
  }
}

/**
 * Reset the circuit for a given scope (e.g. on manual retry).
 */
export function resetCircuit(scope: string): void {
  circuits.delete(scope);
}

/**
 * Get all known circuit states (useful for dashboards).
 */
export function getAllCircuitStates(): CircuitStatus[] {
  return Array.from(circuits.values()).map(({ scope: _, ...rest }) => rest);
}
