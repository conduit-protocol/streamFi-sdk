import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createRpcServer,
  getCircuitState,
  clearCircuitState,
  clearServerCache,
  recordCircuitFailure,
  recordCircuitSuccess,
  CircuitBreakerOpenError,
} from '../soroban.js';

describe('createRpcServer per-endpoint circuit state (Issue #630)', () => {
  const TEST_RPC = 'https://mock-soroban-rpc.test';

  beforeEach(() => {
    clearServerCache();
  });

  it('initial circuit state is closed for unvisited endpoint', () => {
    expect(getCircuitState(TEST_RPC)).toBe('closed');
  });

  it('transitions from closed to open after reaching failure threshold', () => {
    expect(getCircuitState(TEST_RPC)).toBe('closed');

    // 1st failure
    recordCircuitFailure(TEST_RPC, { failureThreshold: 3 });
    expect(getCircuitState(TEST_RPC)).toBe('closed');

    // 2nd failure
    recordCircuitFailure(TEST_RPC, { failureThreshold: 3 });
    expect(getCircuitState(TEST_RPC)).toBe('closed');

    // 3rd failure: trips to open
    recordCircuitFailure(TEST_RPC, { failureThreshold: 3 });
    expect(getCircuitState(TEST_RPC)).toBe('open');
  });

  it('resets back to closed when success is recorded', () => {
    recordCircuitFailure(TEST_RPC, { failureThreshold: 1 });
    expect(getCircuitState(TEST_RPC)).toBe('open');

    recordCircuitSuccess(TEST_RPC);
    expect(getCircuitState(TEST_RPC)).toBe('closed');
  });

  it('automatically transitions to half-open after reset timeout expires', () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(now);

      recordCircuitFailure(TEST_RPC, { failureThreshold: 1, resetTimeoutMs: 10_000 });
      expect(getCircuitState(TEST_RPC, { resetTimeoutMs: 10_000 })).toBe('open');

      // Advance clock past the resetTimeout
      vi.setSystemTime(now + 11_000);
      expect(getCircuitState(TEST_RPC, { resetTimeoutMs: 10_000 })).toBe('half-open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearCircuitState clears state for a specific scope or all scopes', () => {
    const OTHER_RPC = 'https://other-rpc.test';
    recordCircuitFailure(TEST_RPC, { failureThreshold: 1 });
    recordCircuitFailure(OTHER_RPC, { failureThreshold: 1 });

    expect(getCircuitState(TEST_RPC)).toBe('open');
    expect(getCircuitState(OTHER_RPC)).toBe('open');

    // Clear only TEST_RPC
    clearCircuitState(TEST_RPC);
    expect(getCircuitState(TEST_RPC)).toBe('closed');
    expect(getCircuitState(OTHER_RPC)).toBe('open');

    // Clear all
    clearCircuitState();
    expect(getCircuitState(OTHER_RPC)).toBe('closed');
  });

  it('createRpcServer throws CircuitBreakerOpenError when circuit is open', async () => {
    recordCircuitFailure(TEST_RPC, { failureThreshold: 1 });
    expect(getCircuitState(TEST_RPC)).toBe('open');

    const server = createRpcServer(TEST_RPC);

    // Calling any RPC method on the proxied server should immediately throw CircuitBreakerOpenError
    await expect(server.getLatestLedger()).rejects.toThrow(CircuitBreakerOpenError);
  });
});
