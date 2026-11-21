import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConduitBatcher } from '../builder.js';

/** Real chain context so the batcher can build genuine transaction XDR. */
const TEST_CONTEXT = {
  contractId: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
  sourceAccount: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
  network: 'testnet' as const,
  sequence: '1',
};


describe('ConduitBatcher edge cases', () => {
  let batcher: ConduitBatcher;

  beforeEach(() => {
    batcher = new ConduitBatcher();
  });

  afterEach(() => {
    batcher.reset();
  });

  describe('empty array handling', () => {
    it('should handle empty array payload', () => {
      const result = batcher.execute([], { context: TEST_CONTEXT });
      expect(result.success).toBe(true);
      expect(result.operations).toBe(0);
    });
  });

  describe('large payload handling', () => {
    it('should process large batch without truncation', () => {
      const largePayload = Array(100).fill(null).map((_, i) => ({
        method: 'create',
        params: { id: i, amount: 1000n },
      }));
      const result = batcher.execute(largePayload, { context: TEST_CONTEXT });
      expect(result.success).toBe(true);
      expect(result.operations).toBe(100);
    });
  });

  describe('mixed type payloads', () => {
    it('should handle mixed numeric types in params', () => {
      const payload = [
        { method: 'create', params: { amountNum: 1000, amountBig: 1000n } },
      ];
      const result = batcher.execute(payload, { context: TEST_CONTEXT });
      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });

    it('should handle nested objects in params', () => {
      const payload = [
        { method: 'create', params: { config: { nested: { value: 100n } } } },
      ];
      const result = batcher.execute(payload, { context: TEST_CONTEXT });
      expect(result.success).toBe(true);
    });
  });

  describe('state management', () => {
    it('should reset state after destroy', () => {
      batcher.destroy();
      batcher.reset();
      const result = batcher.execute([{ method: 'create', params: {} }], { context: TEST_CONTEXT });
      expect(result.success).toBe(true);
    });

    it('should prevent execution during destroyed state', () => {
      batcher.destroy();
      expect(() => {
        batcher.execute([], { context: TEST_CONTEXT });
      }).toThrow(/destroyed/i);
    });
  });
});

describe('ConduitBatcher async execution', () => {
  let batcher: ConduitBatcher;

  beforeEach(() => {
    batcher = new ConduitBatcher();
  });

  afterEach(() => {
    batcher.reset();
  });

  it('should validate operations in async context', async () => {
    const result = await batcher.executeAsync([
      { method: 'create', params: { amount: 100 } },
    ], { context: TEST_CONTEXT });
    expect(result.success).toBe(true);
    expect(result.operations).toBe(1);
  });

  it('should respect abort signal during async execution', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await batcher.executeAsync(
      [{ method: 'create', params: { amount: 100 } }],
      controller.signal
    );
    expect(result.success).toBe(false);
    expect(result.errors?.some(e => e.includes('aborted'))).toBe(true);
  });

  it('should handle validation errors in async context', async () => {
    const result = await batcher.executeAsync(null as any, { context: TEST_CONTEXT });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
  });
});
