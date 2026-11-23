import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  recordFailure,
  recordSuccess,
  resetCircuit,
  getCircuitState,
  getCircuitMetrics,
  getAllCircuitMetrics,
  resetCircuitMetrics,
  onStateTransition,
  subscribeCircuitTransitions,
  type CircuitMetrics,
} from '../rpc-circuit-state.js';

describe('circuit breaker metrics (#1077)', () => {
  const scope = 'https://rpc.metrics.test';
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetCircuit(scope);
    resetCircuitMetrics();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetCircuit(scope);
    resetCircuitMetrics();
  });

  it('starts zeroed for an endpoint that never transitioned', () => {
    expect(getCircuitMetrics(scope)).toEqual({
      scope,
      tripCount: 0,
      recoveryCount: 0,
      lastTripAt: null,
      lastRecoveryAt: null,
      lastRecoveryTimeMs: null,
      totalRecoveryTimeMs: 0,
    });
  });

  it('counts trips and measures recovery time from the first trip', () => {
    recordFailure(scope, { threshold: 1, cooldownMs: 1000 });
    vi.advanceTimersByTime(1000);
    getCircuitState(scope); // open -> half-open
    recordFailure(scope, { threshold: 1, cooldownMs: 1000 }); // half-open -> open (same outage)
    vi.advanceTimersByTime(1000);
    getCircuitState(scope);
    vi.advanceTimersByTime(500);
    recordSuccess(scope); // half-open -> closed

    const m = getCircuitMetrics(scope);
    expect(m.tripCount).toBe(2);
    expect(m.recoveryCount).toBe(1);
    expect(m.lastTripAt).toBe(1000);
    expect(m.lastRecoveryAt).toBe(2500);
    expect(m.lastRecoveryTimeMs).toBe(2500);
    expect(m.totalRecoveryTimeMs).toBe(2500);
  });

  it('accumulates recovery time across outages', () => {
    recordFailure(scope, { threshold: 1, cooldownMs: 100 });
    vi.advanceTimersByTime(100);
    getCircuitState(scope);
    recordSuccess(scope); // outage 1: 100ms
    recordFailure(scope, { threshold: 1, cooldownMs: 300 });
    vi.advanceTimersByTime(300);
    getCircuitState(scope);
    recordSuccess(scope); // outage 2: 300ms

    const m = getCircuitMetrics(scope);
    expect(m.tripCount).toBe(2);
    expect(m.recoveryCount).toBe(2);
    expect(m.lastRecoveryTimeMs).toBe(300);
    expect(m.totalRecoveryTimeMs).toBe(400);
  });

  it('survives resetCircuit and can be cleared separately', () => {
    recordFailure(scope, { threshold: 1 });
    resetCircuit(scope);
    expect(getCircuitMetrics(scope).tripCount).toBe(1);
    expect(getAllCircuitMetrics().map((m) => m.scope)).toContain(scope);
    resetCircuitMetrics(scope);
    expect(getCircuitMetrics(scope).tripCount).toBe(0);
  });

  it('passes the post-transition stats to onStateTransition and subscribeCircuitTransitions', () => {
    const viaOnState: Array<[string, string, CircuitMetrics]> = [];
    const viaSubscribe: CircuitMetrics[] = [];
    const off1 = onStateTransition((from, to, stats) => viaOnState.push([from, to, stats]));
    const off2 = subscribeCircuitTransitions((_from, _to, _scope, stats) => viaSubscribe.push(stats));

    recordFailure(scope, { threshold: 1, cooldownMs: 1000 });
    off1();
    off2();

    expect(viaOnState).toHaveLength(1);
    const [from, to, stats] = viaOnState[0]!;
    expect([from, to]).toEqual(['closed', 'open']);
    expect(stats.scope).toBe(scope);
    expect(stats.tripCount).toBe(1);
    expect(viaSubscribe[0]?.tripCount).toBe(1);
  });

  it('stats handed to listeners are snapshots, not live objects', () => {
    let seen: CircuitMetrics | undefined;
    const off = onStateTransition((_from, _to, stats) => { seen = stats; });
    recordFailure(scope, { threshold: 1 });
    off();
    recordSuccess(scope);
    expect(seen?.recoveryCount).toBe(0);
  });
});
