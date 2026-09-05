import { describe, it, expect, beforeEach } from 'vitest';
import {
  withCircuitBreaker,
  getCircuitState,
  CircuitOpenError,
  configureCircuitBreaker,
} from '../circuit-breaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    configureCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 10_000,
      halfOpenAfterMs: 5_000,
    });
  });

  it('returns closed state for unknown scopes', () => {
    expect(getCircuitState('nonexistent')).toBe('closed');
  });

  it('closes circuit on success', async () => {
    const result = await withCircuitBreaker('scope-a', async () => 'ok');
    expect(result).toBe('ok');
    expect(getCircuitState('scope-a')).toBe('closed');
  });

  it('opens circuit after threshold failures', async () => {
    const fail = async () => {
      throw new Error('boom');
    };

    // 3 failures should open the circuit
    for (let i = 0; i < 3; i++) {
      try { await withCircuitBreaker('scope-b', fail); } catch {}
    }

    expect(getCircuitState('scope-b')).toBe('open');

    // Next call should fast-fail with CircuitOpenError
    await expect(withCircuitBreaker('scope-b', async () => 'ok')).rejects.toThrow(CircuitOpenError);
  });

  it('resets failures after success', async () => {
    const fail = async () => { throw new Error('boom'); };

    // 2 failures — not enough to open
    for (let i = 0; i < 2; i++) {
      try { await withCircuitBreaker('scope-c', fail); } catch {}
    }

    expect(getCircuitState('scope-c')).toBe('closed');

    // Success resets counter
    await withCircuitBreaker('scope-c', async () => 'ok');

    // 2 more failures should still not open because counter was reset
    for (let i = 0; i < 2; i++) {
      try { await withCircuitBreaker('scope-c', fail); } catch {}
    }

    expect(getCircuitState('scope-c')).toBe('closed');
  });

  it('carries scope on CircuitOpenError', async () => {
    const fail = async () => { throw new Error('boom'); };
    for (let i = 0; i < 3; i++) {
      try { await withCircuitBreaker('scope-d', fail); } catch {}
    }

    try {
      await withCircuitBreaker('scope-d', async () => 'ok');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect(err.scope).toBe('scope-d');
    }
  });
});
