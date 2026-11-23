import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCircuitState } from '../hooks/useCircuitState.js';
import {
  recordFailure,
  recordSuccess,
  resetCircuit,
  getCircuitState,
} from '../../../../src/rpc-circuit-state.js';

describe('useCircuitState (#995)', () => {
  const scope = 'https://horizon-testnet.stellar.org';

  beforeEach(() => {
    vi.useFakeTimers();
    resetCircuit(scope);
  });

  it('reads initial closed state', () => {
    const { result } = renderHook(() => useCircuitState(scope));
    expect(result.current.status.state).toBe('closed');
    expect(result.current.isDegraded).toBe(false);
  });

  it('manually resets circuit', () => {
    // Drive into open state (default threshold = 5)
    for (let i = 0; i < 5; i++) {
      recordFailure(scope);
    }
    expect(getCircuitState(scope).state).toBe('open');

    const { result } = renderHook(() => useCircuitState(scope));
    expect(result.current.isDegraded).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.status.state).toBe('closed');
    expect(result.current.isDegraded).toBe(false);
  });

  it('auto-resets when circuit enters half-open with probe', async () => {
    // Open the circuit with cooldown
    for (let i = 0; i < 5; i++) {
      recordFailure(scope, { cooldownMs: 10_000 });
    }
    expect(getCircuitState(scope).state).toBe('open');

    const mockProbe = vi.fn().mockResolvedValue(true);

    const { result } = renderHook(() =>
      useCircuitState(scope, {
        autoReset: true,
        probeIntervalMs: 1_000,
        probe: mockProbe,
      }),
    );

    // Fast-forward cooldown to enter half-open
    await act(async () => {
      vi.advanceTimersByTime(10_001);
    });

    expect(result.current.status.state).toBe('half-open');

    // Fast-forward probe timer
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });

    expect(mockProbe).toHaveBeenCalledWith(scope);
    expect(result.current.status.state).toBe('closed');
    expect(result.current.isDegraded).toBe(false);
  });
});
