import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  recordFailure,
  recordSuccess,
  resetCircuit,
  getCircuitState,
  subscribeCircuitTransitions,
  onCircuitStateChange,
  onCircuitChange,
} from '../rpc-circuit-state.js';

describe('subscribeCircuitTransitions', () => {
  const scope = 'https://rpc.transitions.test';
  beforeEach(() => { vi.useFakeTimers(); resetCircuit(scope); });
  afterEach(() => { vi.useRealTimers(); resetCircuit(scope); });

  it('emits closed -> open -> half-open -> closed', () => {
    const calls: Array<[string, string]> = [];
    const off = subscribeCircuitTransitions((from, to) => calls.push([from, to]));
    for (let i = 0; i < 2; i++) recordFailure(scope, { threshold: 2, cooldownMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(getCircuitState(scope).state).toBe('half-open');
    recordSuccess(scope);
    off();
    expect(calls).toEqual([['closed', 'open'], ['open', 'half-open'], ['half-open', 'closed']]);
  });

  it('stops notifying after unsubscribe', () => {
    const fn = vi.fn();
    subscribeCircuitTransitions(fn)();
    recordFailure(scope, { threshold: 1 });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('onCircuitStateChange (#976)', () => {
  const scope = 'https://rpc.state-change.test';
  const otherScope = 'https://rpc.other-scope.test';
  beforeEach(() => { vi.useFakeTimers(); resetCircuit(scope); resetCircuit(otherScope); });
  afterEach(() => { vi.useRealTimers(); resetCircuit(scope); resetCircuit(otherScope); });

  it('notifies with the full CircuitStatus for the given scope on each transition', () => {
    const states: string[] = [];
    const off = onCircuitStateChange(scope, (status) => states.push(status.state));

    recordFailure(scope, { threshold: 1, cooldownMs: 1000 });
    vi.advanceTimersByTime(1000);
    getCircuitState(scope); // drives the open -> half-open auto-transition
    recordSuccess(scope);

    off();
    expect(states).toEqual(['open', 'half-open', 'closed']);
  });

  it('ignores transitions on other scopes', () => {
    const fn = vi.fn();
    const off = onCircuitStateChange(scope, fn);
    recordFailure(otherScope, { threshold: 1 });
    off();
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const fn = vi.fn();
    onCircuitStateChange(scope, fn)();
    recordFailure(scope, { threshold: 1 });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('onCircuitChange (#976)', () => {
  const scope = 'https://rpc.global-change.test';
  beforeEach(() => resetCircuit(scope));
  afterEach(() => resetCircuit(scope));

  it('notifies with the scope and CircuitStatus across all scopes', () => {
    const calls: Array<[string, string]> = [];
    const off = onCircuitChange((changedScope, status) => calls.push([changedScope, status.state]));
    recordFailure(scope, { threshold: 1 });
    off();
    expect(calls).toEqual([[scope, 'open']]);
  });
});
