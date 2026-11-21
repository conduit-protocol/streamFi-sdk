import { useEffect, useState, useCallback } from 'react';
import {
  getCircuitState,
  onCircuitChange,
  resetCircuit,
  recordSuccess,
  recordFailure,
  type CircuitStatus,
} from '../../../../src/rpc-circuit-state.js';

export interface UseCircuitStateOptions {
  /** Whether to automatically run a background heartbeat / probe when the circuit enters 'half-open'. Defaults to true. */
  autoReset?: boolean;
  /** Heartbeat probe interval / delay in milliseconds when checking for recovery. Defaults to 5000ms. */
  probeIntervalMs?: number;
  /** Optional custom heartbeat probe to test RPC reachability. Resolving to true recovers the circuit; false or throwing re-opens it. */
  probe?: (scope: string) => Promise<boolean> | boolean;
}

export interface UseCircuitStateResult {
  /** Current circuit status for the given scope. */
  status: CircuitStatus;
  /** Whether the circuit is currently open (degraded). */
  isDegraded: boolean;
  /** The active RPC URL (scope) being monitored. */
  activeRpcUrl: string;
  /** Manually reset the circuit for this scope. */
  reset: () => void;
}

/**
 * #769 — Hook that reads the current RPC circuit-breaker state and
 * subscribes to changes, so React components can react immediately
 * when a circuit opens or closes instead of polling on an interval.
 *
 * #995 — Automatically triggers background heartbeat probes when the
 * circuit breaker enters half-open state, auto-resetting when healthy.
 */
export function useCircuitState(
  scope: string,
  options?: UseCircuitStateOptions,
): UseCircuitStateResult {
  const [status, setStatus] = useState<CircuitStatus>(() => getCircuitState(scope));

  useEffect(() => {
    // Sync with current state on scope change
    setStatus(getCircuitState(scope));

    const unsubscribe = onCircuitChange((changedScope, state) => {
      if (changedScope === scope) {
        setStatus(state);
      }
    });

    return unsubscribe;
  }, [scope]);

  // Handle transition from open to half-open when cooldown expires
  useEffect(() => {
    if (status.state === 'open' && status.cooldownUntil) {
      const remainingMs = Math.max(0, status.cooldownUntil - Date.now());
      const timer = setTimeout(() => {
        setStatus(getCircuitState(scope));
      }, remainingMs);
      return () => clearTimeout(timer);
    }
  }, [status.state, status.cooldownUntil, scope]);

  // Auto-reset heartbeat probe when in half-open state
  useEffect(() => {
    if (status.state !== 'half-open' || options?.autoReset === false) {
      return;
    }

    const intervalMs = options?.probeIntervalMs ?? 5_000;
    let cancelled = false;

    const timer = setTimeout(async () => {
      try {
        let isHealthy = true;
        if (options?.probe) {
          isHealthy = await options.probe(scope);
        } else if (
          typeof fetch !== 'undefined' &&
          (scope.startsWith('http://') || scope.startsWith('https://'))
        ) {
          try {
            const res = await fetch(scope, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
            });
            isHealthy = res.ok;
          } catch {
            isHealthy = false;
          }
        }

        if (cancelled) return;

        if (isHealthy) {
          recordSuccess(scope);
          setStatus(getCircuitState(scope));
        } else {
          recordFailure(scope);
          setStatus(getCircuitState(scope));
        }
      } catch {
        if (!cancelled) {
          recordFailure(scope);
          setStatus(getCircuitState(scope));
        }
      }
    }, intervalMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status.state, scope, options?.autoReset, options?.probeIntervalMs, options?.probe]);

  const reset = useCallback(() => {
    resetCircuit(scope);
  }, [scope]);

  return {
    status,
    isDegraded: status.state === 'open',
    activeRpcUrl: scope,
    reset,
  };
}
