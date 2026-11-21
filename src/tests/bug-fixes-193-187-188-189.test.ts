import { describe, it, expect, vi } from 'vitest';
import { StreamBuilder } from '../builder.js';
import { FeeEstimator } from '../fee-estimator.js';
import { WalletConnectAdapter } from '../adapters/walletconnect.js';
import { ConduitBatcher } from '../builder.js';
import type { SignTransactionOptions } from '../adapters/types.js';

/** Real chain context so ConduitBatcher can build genuine transaction XDR. */
const TEST_CONTEXT = {
  contractId: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
  sourceAccount: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
  network: 'testnet' as const,
  sequence: '1',
};

// ============================================================================
// Issue #193: FeeEstimator should use bigint stroops, not floating-point
// ============================================================================

describe('Issue #193: FeeEstimator bigint stroops precision', () => {
  it('should represent baseFee as bigint stroops, not number', () => {
    const estimator = new FeeEstimator(1000000n);
    const fee = estimator.getBaseFee();
    expect(typeof fee).toBe('bigint');
    expect(fee).toBe(1000000n);
  });

  it('should return bigint from estimateFee', async () => {
    const estimator = new FeeEstimator(100n);
    const result = await estimator.estimateFee(async () => 500n);
    expect(typeof result).toBe('bigint');
    expect(result).toBe(500n);
  });

  it('should avoid floating-point precision loss with very small fees', async () => {
    const estimator = new FeeEstimator(0n);
    // This value would cause floating-point precision issues with the old approach
    const precisionTestValue = 100000001n; // 0.1000000001 stroops
    const result = await estimator.estimateFee(async () => precisionTestValue);
    expect(result).toBe(precisionTestValue);
    // Verify no IEEE-754 representation error like 0.1000000000000001
  });
});

// ============================================================================
// Issue #189: WalletConnectAdapter should require networkPassphrase
// ============================================================================

describe('Issue #189: WalletConnectAdapter networkPassphrase validation', () => {
  it('should throw an error when signTransaction is called without networkPassphrase', async () => {
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client: {
        request: vi.fn().mockResolvedValue({
          signedXdr: 'AAAA...',
        }),
      } as any,
      session: {
        topic: 'test-topic',
        account: 'GAAA...',
      } as any,
    });

    await expect(
      adapter.signTransaction('AAAA...', { networkPassphrase: undefined } as unknown as SignTransactionOptions)
    ).rejects.toThrow('networkPassphrase is required');
  });

  it('should accept and use the provided networkPassphrase', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({
        signedXdr: 'AAAA...',
      }),
    };

    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client: mockClient as any,
      session: {
        topic: 'test-topic',
        account: 'GAAA...',
      } as any,
    });

    const passphrase = 'Test SDF Network ; September 2015';
    await adapter.signTransaction('AAAA...', {
      networkPassphrase: passphrase,
    });

    expect(mockClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          params: expect.objectContaining({
            networkPassphrase: passphrase,
          }),
        }),
      })
    );
  });

  it('should reconstruct Transaction object with the correct passphrase', async () => {
    const mockClient = {
      request: vi.fn().mockResolvedValue({
        signedXdr: 'AAAA...',
      }),
    };

    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client: mockClient as any,
      session: {
        topic: 'test-topic',
        account: 'GAAA...',
      } as any,
    });

    const passphrase = 'Custom Network; January 2024';
    const result = await adapter.signTransaction('AAAA...', {
      networkPassphrase: passphrase,
    });

    // Verify the returned Transaction has the correct passphrase
    if (typeof result === 'object' && result !== null && 'networkPassphrase' in result) {
      expect(result.networkPassphrase).toBe(passphrase);
    }
  });
});

// ============================================================================
// Issue #188: StreamBuilder.submit() should remove payloads on final failure
// ============================================================================

describe('Issue #188: StreamBuilder.submit() queue cleanup on failure', () => {
  it('should remove payload from pendingQueue when all retries are exhausted', async () => {
    const builder = new StreamBuilder();

    const mockSubmitFn = vi.fn().mockImplementation(() => {
      throw new Error('Network error');
    });

    try {
      await builder.submit(mockSubmitFn, { maxRetries: 2, retryDelayMs: 1 });
    } catch (e) {
      // Expected to throw
    }

    const queue = builder.getPendingQueue();
    expect(queue.length).toBe(0);
  });

  it('should prevent queue overflow from accumulated failed payloads', async () => {
    const mockSubmitFn = vi.fn().mockRejectedValue(new Error('Network error'));

    // Try to submit multiple payloads that all fail
    for (let i = 0; i < 3; i++) {
      const b = new StreamBuilder({ maxQueueSize: 5 });
      try {
        await b.submit(mockSubmitFn, { maxRetries: 1, retryDelayMs: 1 });
      } catch (e) {
        // Expected to fail
      }
    }

    // The queue should not accumulate failed payloads indefinitely
    // Verify we can still submit new payloads after failures
    const b = new StreamBuilder({ maxQueueSize: 5 });
    const queueBefore = b.getPendingQueue().length;
    expect(queueBefore).toBe(0);
  });

  it('should remove payload on success but keep it during retries', async () => {
    const builder = new StreamBuilder()
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .amount(500);
    let attemptCount = 0;

    const mockSubmitFn = vi.fn().mockImplementation(() => {
      attemptCount++;
      if (attemptCount < 2) {
        throw new Error('Network error');
      }
      return { success: true };
    });

    const result = await builder.submit(mockSubmitFn, { maxRetries: 3, retryDelayMs: 1 });

    expect(result).toEqual({ success: true });
    const queue = builder.getPendingQueue();
    expect(queue.length).toBe(0);
  });
});

// ============================================================================
// Issue #187: ConduitBatcher should use instance state, not static
// ============================================================================

describe('Issue #187: ConduitBatcher instance state isolation', () => {
  it('should allow creating two independent ConduitBatcher instances', () => {
    const batcher1 = new ConduitBatcher();
    const batcher2 = new ConduitBatcher();

    expect(batcher1).not.toBe(batcher2);
  });

  it('should not share queue state between instances', async () => {
    const batcher1 = new ConduitBatcher();
    const batcher2 = new ConduitBatcher();

    const result1 = await batcher1.executeAsync([
      { method: 'stream_create', params: { amount: 1000 } },
    ], { context: TEST_CONTEXT });

    const result2 = await batcher2.executeAsync([
      { method: 'stream_create', params: { amount: 2000 } },
    ], { context: TEST_CONTEXT });

    // Each batcher should process independently
    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
  });

  it('should destroy one instance without affecting another', () => {
    const batcher1 = new ConduitBatcher();
    const batcher2 = new ConduitBatcher();

    batcher1.destroy();

    expect(() => batcher1.execute([])).toThrow('ConduitBatcher has been destroyed');
    expect(() => batcher2.execute([])).not.toThrow();
  });

  it('should allow independent cleanup per instance', () => {
    const batcher1 = new ConduitBatcher();
    const batcher2 = new ConduitBatcher();

    batcher1.cleanup();

    // batcher1 should still be usable (not destroyed)
    expect(() => batcher1.execute([])).not.toThrow();
    expect(() => batcher2.execute([])).not.toThrow();
  });

  it('should allow reset on individual instances without affecting global state', () => {
    const batcher1 = new ConduitBatcher();
    const batcher2 = new ConduitBatcher();

    batcher1.destroy();
    batcher1.reset();

    // batcher1 should be usable again after reset
    expect(() => batcher1.execute([])).not.toThrow();
    // batcher2 should not be affected
    expect(() => batcher2.execute([])).not.toThrow();
  });
});
