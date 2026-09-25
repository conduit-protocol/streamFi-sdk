import { useEffect, useState, useCallback } from 'react';
import {
  getCircuitState,
  onCircuitChange,
  resetCircuit,
  type CircuitStatus,
} from '../../src/rpc-circuit-state.js';

export interface UseCircuitStateResult {
  /** Current circuit status for the given scope. */
  status: CircuitStatus;
  /** Whether the circuit is currently open (degraded). */
  isDegraded: boolean;
  /** Manually reset the circuit for this scope. */
  reset: () => void;
}

/**
 * #769 — Hook that reads the current RPC circuit-breaker state and
 * subscribes to changes, so React components can react immediately
 * when a circuit opens or closes instead of polling on an interval.
 */
export function useCircuitState(scope: string): UseCircuitStateResult {
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

  const reset = useCallback(() => {
    resetCircuit(scope);
  }, [scope]);

  return {
    status,
    isDegraded: status.state === 'open',
    reset,
  };
}
