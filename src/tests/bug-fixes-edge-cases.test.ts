import { describe, it, expect, vi } from 'vitest';
import { StreamBuilder } from '../builder.js';
import { FeeEstimator } from '../fee-estimator.js';
import { WalletConnectAdapter } from '../adapters/walletconnect.js';
import { ConduitBatcher } from '../builder.js';

/** Real chain context so ConduitBatcher can build genuine transaction XDR. */
const TEST_CONTEXT = {
  contractId: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
  sourceAccount: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
  network: 'testnet' as const,
  sequence: '1',
};

// ============================================================================
// Issue #193: FeeEstimator edge cases
// ============================================================================

describe('Issue #193: FeeEstimator edge cases', () => {
  it('should handle very large bigint fees', async () => {
    const estimator = new FeeEstimator(0n);
    const largeFee = BigInt('9007199254740991'); // MAX_SAFE_INTEGER as bigint
    const result = await estimator.estimateFee(async () => largeFee);
    expect(result).toBe(largeFee);
  });

  it('should reject negative bigint fees', async () => {
    // estimateFee() never throws — invalid responses fall back to the
    // previous baseFee and surface via lastError/onError instead.
    const estimator = new FeeEstimator(100n);
    const onError = vi.fn();
    const result = await estimator.estimateFee(async () => -100n, { onError });
    expect(result).toBe(100n);
    expect(estimator.lastError).toEqual(new Error('Invalid network fee response'));
    expect(onError).toHaveBeenCalledWith(new Error('Invalid network fee response'));
  });

  it('should handle zero fee', async () => {
    const estimator = new FeeEstimator(100n);
    const result = await estimator.estimateFee(async () => 0n);
    expect(result).toBe(0n);
  });

  it('should maintain cached fee within refetch interval', async () => {
    const estimator = new FeeEstimator(100n, { minRefetchIntervalMs: 10000 });
    const fetchSpy = vi.fn().mockResolvedValue(500n);

    const first = await estimator.estimateFee(fetchSpy);
    const second = await estimator.estimateFee(fetchSpy);

    expect(first).toBe(500n);
    expect(second).toBe(500n);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('should return stale fee on network error with fallback', async () => {
    const estimator = new FeeEstimator(100n);
    const errorFn = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await estimator.estimateFee(errorFn);
    expect(result).toBe(100n); // Returns initial/last known fee
    expect(estimator.lastError).not.toBeNull();
    expect(estimator.isStale).toBe(true);
  });

  it('should report staleness after error', async () => {
    const estimator = new FeeEstimator(100n);
    expect(estimator.isStale).toBe(false);

    await estimator.estimateFee(async () => {
      throw new Error('Network error');
    }).catch(() => {});

    expect(estimator.isStale).toBe(true);
    expect(estimator.lastError?.message).toBe('Network error');
  });
});

// ============================================================================
// Issue #189: WalletConnectAdapter edge cases
// ============================================================================

describe('Issue #189: WalletConnectAdapter edge cases', () => {
  it('should reject empty string networkPassphrase', async () => {
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client: {} as any,
      session: { topic: 'test-topic', account: 'GAAA...' } as any,
    });

    await expect(
      adapter.signTransaction('AAAA...', { networkPassphrase: '' })
    ).rejects.toThrow('networkPassphrase is required');
  });

  it('should include passphrase in RPC request params', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({ signedXdr: 'AAAA...' }),
    };

    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client: mockClient as any,
      session: { topic: 'test-topic', account: 'GAAA...' } as any,
    });

    const passphrase = 'Test SDF Network ; September 2015';
    await adapter.signTransaction('AAAA...', { networkPassphrase: passphrase });

    const callArgs = mockClient.request.mock.calls[0]![0];
    expect(callArgs.request.params.networkPassphrase).toBe(passphrase);
  });

  it('should handle different RPC response formats', async () => {
    const testCases = [
      { signedXdr: 'AAAA...' },
      { xdr: 'AAAA...' },
      'AAAA...',
    ];

    for (const responseFormat of testCases) {
      const mockClient = {
        request: vi.fn().mockResolvedValue(responseFormat),
      };

      const adapter = new WalletConnectAdapter({
        chainId: 'stellar:testnet',
        client: mockClient as any,
        session: { topic: 'test-topic', account: 'GAAA...' } as any,
      });

      const result = await adapter.signTransaction('AAAA...', {
        networkPassphrase: 'Test SDF Network ; September 2015',
      });

      if (typeof result !== 'string') {
        expect(result).toHaveProperty('networkPassphrase');
      }
    }
  });

  it('should return signed XDR string when input is string', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({ signedXdr: 'SIGNED...' }),
    };

    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client: mockClient as any,
      session: { topic: 'test-topic', account: 'GAAA...' } as any,
    });

    const result = await adapter.signTransaction('AAAA...', {
      networkPassphrase: 'Test Network',
    });

    expect(typeof result).toBe('string');
    expect(result).toBe('SIGNED...');
  });
});

// ============================================================================
// Issue #188: StreamBuilder edge cases
// ============================================================================

describe('Issue #188: StreamBuilder edge cases', () => {
  it('should remove payload from queue on abort signal', async () => {
    const builder = new StreamBuilder();
    const controller = new AbortController();

    const mockSubmitFn = vi.fn(async () => {
      controller.abort();
      throw new Error('Aborted');
    });

    try {
      await builder.submit(mockSubmitFn, {
        signal: controller.signal,
        maxRetries: 0,
        retryDelayMs: 1,
      });
    } catch (e) {
      // Expected to fail
    }

    const queue = builder.getPendingQueue();
    expect(queue.length).toBe(0);
  });

  it('should handle concurrent submissions with proper queue cleanup', async () => {
    const builder = new StreamBuilder({ maxQueueSize: 10 })
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .amount(100);
    const mockSubmitFn = vi.fn(async () => ({ success: true }));

    // Submit multiple concurrent operations
    const submissions = Array.from({ length: 5 }, () =>
      builder.submit(mockSubmitFn, { maxRetries: 0, retryDelayMs: 1 })
    );

    await Promise.all(submissions);

    const queue = builder.getPendingQueue();
    expect(queue.length).toBe(0);
  });

  it('should enforce maxQueueSize limit', async () => {
    const builder = new StreamBuilder({ maxQueueSize: 2 })
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .amount(100);
    const mockSubmitFn = vi.fn(async () => {
      // Simulate slow response to fill queue
      await new Promise(resolve => setTimeout(resolve, 100));
      return { success: true };
    });

    // Fire more submissions than maxQueueSize at once (each is a Promise, not
    // awaited individually — Promise.allSettled avoids unhandled rejections
    // while still letting us inspect which ones were rejected for backpressure).
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => builder.submit(mockSubmitFn, { maxRetries: 0, retryDelayMs: 1 })),
    );

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) {
      expect(r.reason).toEqual(expect.objectContaining({
        message: expect.stringContaining('queue is full'),
      }));
    }
  });

  it('should retry with exponential backoff', async () => {
    const builder = new StreamBuilder()
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .amount(250);
    let attemptCount = 0;

    const mockSubmitFn = vi.fn(async () => {
      attemptCount++;
      if (attemptCount < 3) {
        throw new Error('Temporary error');
      }
      return { success: true };
    });

    const startTime = Date.now();
    const result = await builder.submit(mockSubmitFn, {
      maxRetries: 3,
      retryDelayMs: 10,
    });

    const elapsed = Date.now() - startTime;
    // Should have delays: 0 (first attempt), 10ms, 20ms = ~30ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(result).toEqual({ success: true });
    expect(attemptCount).toBe(3);
  });

  it('should cleanup timers on abort', async () => {
    const builder = new StreamBuilder();
    const controller = new AbortController();

    const mockSubmitFn = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return { success: true };
    });

    const submitPromise = builder.submit(mockSubmitFn, {
      signal: controller.signal,
      maxRetries: 3,
      retryDelayMs: 100,
    });

    // Abort immediately
    setTimeout(() => controller.abort(), 10);

    try {
      await submitPromise;
    } catch (e) {
      // Expected abort error
    }

    // Queue should be cleaned up
    const queue = builder.getPendingQueue();
    expect(queue.length).toBe(0);
  });
});

// ============================================================================
// Issue #187: ConduitBatcher edge cases
// ============================================================================

describe('Issue #187: ConduitBatcher edge cases', () => {
  it('should handle many independent batcher instances', () => {
    const batchers = Array.from({ length: 10 }, () => new ConduitBatcher());

    expect(batchers).toHaveLength(10);
    for (let i = 0; i < batchers.length; i++) {
      for (let j = i + 1; j < batchers.length; j++) {
        expect(batchers[i]).not.toBe(batchers[j]);
      }
    }
  });

  it('should process batches independently for each instance', async () => {
    const batcher1 = new ConduitBatcher();
    const batcher2 = new ConduitBatcher();

    const result1 = batcher1.execute([
      { method: 'create', params: { amount: 1000 } },
    ], { context: TEST_CONTEXT });

    const result2 = batcher2.execute([
      { method: 'create', params: { amount: 2000 } },
    ], { context: TEST_CONTEXT });

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(result1.operations).toBe(1);
    expect(result2.operations).toBe(1);
  });

  it('should not share destroyed state between instances', () => {
    const batcher1 = new ConduitBatcher();
    const batcher2 = new ConduitBatcher();
    const batcher3 = new ConduitBatcher();

    batcher1.destroy();
    batcher2.destroy();

    expect(() => batcher1.execute([])).toThrow('ConduitBatcher has been destroyed');
    expect(() => batcher2.execute([])).toThrow('ConduitBatcher has been destroyed');
    expect(() => batcher3.execute([])).not.toThrow();
  });

  it('should handle cleanup independently', () => {
    const batcher1 = new ConduitBatcher();
    const batcher2 = new ConduitBatcher();

    batcher1.cleanup();

    expect(() => batcher1.execute([])).not.toThrow();
    expect(() => batcher2.execute([])).not.toThrow();
  });

  it('should handle validation independently per instance', () => {
    const batcher1 = new ConduitBatcher();
    const batcher2 = new ConduitBatcher();

    const invalidPayload = [{ invalid: 'data' }];

    const result1 = batcher1.execute(invalidPayload);
    const result2 = batcher2.execute(invalidPayload);

    expect(result1.success).toBe(false);
    expect(result2.success).toBe(false);
    expect(result1.errors).toBeDefined();
    expect(result2.errors).toBeDefined();
  });

  it('should allow reset after destroy for individual instances', () => {
    const batcher1 = new ConduitBatcher();
    const batcher2 = new ConduitBatcher();

    batcher1.destroy();
    expect(() => batcher1.execute([])).toThrow('ConduitBatcher has been destroyed');

    batcher1.reset();
    expect(() => batcher1.execute([])).not.toThrow();
    expect(() => batcher2.execute([])).not.toThrow();
  });
});
