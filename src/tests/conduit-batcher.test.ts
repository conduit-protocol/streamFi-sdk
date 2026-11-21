import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConduitBatcher, StreamBuilder, type BatchOperation } from '../builder.js';
import { TransactionBuilder, Networks } from '@stellar/stellar-sdk';

/** Real chain context so the batcher can build genuine transaction XDR. */

/**
 * Assert the batch produced genuine, decodable transaction XDR — one
 * transaction per operation, since Soroban allows a single host-function
 * invocation per transaction.
 */
function expectRealXdr(result: { xdr: string; xdrs?: string[]; operations: number }) {
  expect(result.xdr).not.toBe('');
  expect(result.xdr).not.toContain('mock');
  expect(result.xdrs).toHaveLength(result.operations);

  for (const envelope of result.xdrs ?? []) {
    // Round-trips through the real XDR codec, which a placeholder cannot do.
    const tx = TransactionBuilder.fromXDR(envelope, Networks.TESTNET);
    expect(tx.toXDR()).toBe(envelope);
  }
}

const TEST_CONTEXT = {
  contractId: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
  sourceAccount: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
  network: 'testnet' as const,
  sequence: '1',
};


describe('ConduitBatcher', () => {
  let batcher: ConduitBatcher;

  beforeEach(() => {
    batcher = new ConduitBatcher();
  });

  describe('execute — payload validation', () => {
    it('returns error result for null payload', () => {
      const result = batcher.execute(null as unknown as Record<string, unknown>[]);

      expect(result.success).toBe(false);
      expect(result.operations).toBe(0);
      expect(result.xdr).toBe('');
      expect(result.errors).toContain('Batch payload cannot be null or undefined');
    });

    it('returns error result for undefined payload', () => {
      const result = batcher.execute(undefined as unknown as Record<string, unknown>[]);

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Batch payload cannot be null or undefined');
    });

    it('returns error result for non-array payload', () => {
      expect(batcher.execute({} as unknown as Record<string, unknown>[]).errors).toContain(
        'Batch payload must be an array',
      );
      expect(batcher.execute(123 as unknown as Record<string, unknown>[]).success).toBe(false);
      expect(batcher.execute('bad' as unknown as Record<string, unknown>[]).success).toBe(false);
      expect(batcher.execute(true as unknown as Record<string, unknown>[]).success).toBe(false);
    });

    it('returns error result for array containing null items', () => {
      const result = batcher.execute([null as unknown as Record<string, unknown>], { context: TEST_CONTEXT });

      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('cannot be null or undefined');
    });

    it('returns error result for array containing undefined items', () => {
      const result = batcher.execute([undefined as unknown as Record<string, unknown>], { context: TEST_CONTEXT });

      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('cannot be null or undefined');
    });

    it('returns error result for array containing non-object items', () => {
      const result = batcher.execute(['string' as unknown as Record<string, unknown>], { context: TEST_CONTEXT });

      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('must be an object');
    });

    it('reports validation errors for the first invalid item index', () => {
      const valid = { token: 'CD1' };
      const result = batcher.execute([
        valid,
        null as unknown as Record<string, unknown>,
        'bad' as unknown as Record<string, unknown>,
      ], { context: TEST_CONTEXT });

      expect(result.success).toBe(false);
      expect(result.errors!.some(e => e.includes('index 1'))).toBe(true);
    });

    it('accepts an empty array as a valid no-op batch', () => {
      const result = batcher.execute([], { context: TEST_CONTEXT });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(0);
      expect(result.chunks).toBe(0);
      expect(result.xdr).toBe('');
      expect(result.xdrs).toEqual([]);
      expect(result.errors).toBeUndefined();
    });

    it('accepts Soroban contract IDs (C...) for sender and recipient in payload (#512)', () => {
      const contractSender = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
      const contractRecipient = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
      const token = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

      const result = batcher.execute([
        { token, sender: contractSender, recipient: contractRecipient, amount: 100n },
      ], { context: TEST_CONTEXT });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });
  });

  describe('execute — successful batch compilation', () => {
    it('executes a batch of StreamBuilder outputs', () => {
      const stream1 = new StreamBuilder()
        .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
        .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
        .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
        .amount(100)
        .build();

      const stream2 = new StreamBuilder()
        .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
        .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
        .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
        .amount(200)
        .build();

      const result = batcher.execute([stream1, stream2], { context: TEST_CONTEXT });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(2);
      expect(result.chunks).toBe(1);
      expectRealXdr(result);
    });

    it('returns the correct operation count for arbitrary record payloads', () => {
      const result = batcher.execute([
        { method: 'create', params: { token: 'CD1' } },
        { method: 'withdraw', params: { streamId: 1n } },
      ], { context: TEST_CONTEXT });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(2);
    });

    it('handles a single-item batch', () => {
      const result = batcher.execute([{ token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526', amount: 100n }], { context: TEST_CONTEXT });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
      expect(result.chunks).toBe(1);
    });
  });

  describe('execute — bigint serialization', () => {
    it('accepts payloads with top-level bigint fields', () => {
      const result = batcher.execute([
        {
          token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
          sender: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
          recipient: 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA',
          rate: BigInt('9007199254740993'),
          deposit: 50000n,
        },
      ], { context: TEST_CONTEXT });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });

    it('accepts deeply nested bigint values', () => {
      const result = batcher.execute([
        {
          id: 1,
          metadata: { nested: { value: 9007199254740993n } },
        },
      ], { context: TEST_CONTEXT });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });

    it('accepts mixed bigint and primitive fields', () => {
      const result = batcher.execute([
        { id: 1n, rate: 2n, name: 'stream-a' },
        { id: 3, rate: 4, name: 'stream-b' },
        { nested: { deep: { val: 99n } } },
      ], { context: TEST_CONTEXT });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(3);
    });

    it('accepts payloads with null nested values alongside bigints', () => {
      const result = batcher.execute([
        { a: 1n, b: 'hello', c: true, d: null, e: { f: 2n } },
      ] as Record<string, unknown>[], { context: TEST_CONTEXT });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });

    it('accepts payloads containing symbols without throwing', () => {
      const sym = Symbol('test');
      const result = batcher.execute([
        { key: sym as unknown as string, token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526' },
      ], { context: TEST_CONTEXT });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });
  });

  describe('execute — chunking', () => {
    it('uses a single chunk when batch size is within the default limit', () => {
      const streams = Array.from({ length: 2 }, (_, i) => ({ id: i, name: `stream-${i}` }));
      const result = batcher.execute(streams, { context: TEST_CONTEXT });

      expect(result.chunks).toBe(1);
      expect(result.operations).toBe(2);
    });

    it('uses the default batch size of 50', () => {
      const streams = Array.from({ length: 55 }, (_, i) => ({
        id: BigInt(i),
        name: `stream-${i}`,
      }));

      const result = batcher.execute(streams, { context: TEST_CONTEXT });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(55);
      expect(result.chunks).toBe(2);
    });

    it('respects a custom maxBatchSize option', () => {
      const streams = Array.from({ length: 120 }, (_, i) => ({
        id: BigInt(i),
        name: `stream-${i}`,
      }));

      const result = batcher.execute(streams, { context: TEST_CONTEXT, maxBatchSize: 50 });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(120);
      expect(result.chunks).toBe(3);
    });

    it('creates one chunk per item when maxBatchSize is 1', () => {
      const streams = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const result = batcher.execute(streams, { context: TEST_CONTEXT, maxBatchSize: 1 });

      expect(result.chunks).toBe(3);
      expect(result.operations).toBe(3);
    });

    it('creates a single chunk when maxBatchSize exceeds the payload length', () => {
      const streams = [{ id: 1 }, { id: 2 }];
      const result = batcher.execute(streams, { context: TEST_CONTEXT, maxBatchSize: 100 });

      expect(result.chunks).toBe(1);
      expect(result.operations).toBe(2);
    });

    it('creates exactly one chunk when length equals maxBatchSize', () => {
      const streams = Array.from({ length: 50 }, (_, i) => ({ id: i }));
      const result = batcher.execute(streams, { context: TEST_CONTEXT, maxBatchSize: 50 });

      expect(result.chunks).toBe(1);
      expect(result.operations).toBe(50);
    });
  });

  describe('execute — destroyed state', () => {
    it('throws when execute is called after destroy', () => {
      batcher.destroy();

      expect(() => batcher.execute([{ token: 'CD1' }], { context: TEST_CONTEXT })).toThrow(
        'ConduitBatcher has been destroyed',
      );
    });
  });

  describe('executeAsync', () => {
    it('resolves successfully with valid operations', async () => {
      const result = await batcher.executeAsync([
        { method: 'create', params: { token: 'CD1', amount: 100n } },
      ], { context: TEST_CONTEXT });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
      expectRealXdr(result);
    });

    it('returns error result for null operations', async () => {
      const result = await batcher.executeAsync(null as unknown as BatchOperation[], { context: TEST_CONTEXT });

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('returns error result for invalid operation items', async () => {
      const result = await batcher.executeAsync([
        null as unknown as BatchOperation,
      ], { context: TEST_CONTEXT });

      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('cannot be null or undefined');
    });

    it('accepts an abort signal and returns a cancellation error', async () => {
      const ac = new AbortController();
      ac.abort();

      const result = await batcher.executeAsync(
        [{ method: 'create', params: { token: 'CD1' } }],
        ac.signal,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Operation aborted');
    });

    it('rejects when called after destroy', async () => {
      batcher.destroy();

      await expect(
        batcher.executeAsync([{ method: 'create', params: { token: 'CD1' } }], { context: TEST_CONTEXT }),
      ).rejects.toThrow('ConduitBatcher has been destroyed');
    });

    it('processes multiple queued executeAsync calls', async () => {
      const results = await Promise.all([
        batcher.executeAsync([{ method: 'op1', params: { id: 1 } }], { context: TEST_CONTEXT }),
        batcher.executeAsync([{ method: 'op2', params: { id: 2 } }], { context: TEST_CONTEXT }),
        batcher.executeAsync([{ method: 'op3', params: { id: 3 } }], { context: TEST_CONTEXT }),
      ]);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.success).toBe(true);
        expect(result.operations).toBe(1);
      }
    });

    it('handles rapid concurrent executeAsync calls without error', async () => {
      const promises = Array.from({ length: 50 }, (_, i) =>
        batcher.executeAsync([{ method: 'rapid', params: { index: i } }], { context: TEST_CONTEXT }),
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(50);
      for (const result of results) {
        expect(result.success).toBe(true);
        expect(result.operations).toBe(1);
      }
    });

    it('sanitizes bigint values inside operation params', async () => {
      const result = await batcher.executeAsync([
        { method: 'topUp', params: { streamId: 1n, amount: 9007199254740993n } },
      ], { context: TEST_CONTEXT });

      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });
  });

  describe('cleanup, destroy, and reset', () => {
    it('cleanup resolves pending executeAsync calls with an error', async () => {
      const processQueueSpy = vi
        .spyOn(batcher as unknown as { processQueue: () => Promise<void> }, 'processQueue')
        .mockImplementation(() => Promise.resolve());

      const pending = batcher.executeAsync([
        { method: 'create', params: { token: 'CD1' } },
      ], { context: TEST_CONTEXT });

      batcher.cleanup();
      processQueueSpy.mockRestore();

      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.errors).toContain('ConduitBatcher cleaned up');
    });

    it('reset clears the destroyed flag so execute works again', () => {
      batcher.destroy();
      batcher.reset();

      const result = batcher.execute([{ token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526' }], { context: TEST_CONTEXT });
      expect(result.success).toBe(true);
      expect(result.operations).toBe(1);
    });

    it('reset clears the destroyed flag so executeAsync works again', async () => {
      batcher.destroy();
      batcher.reset();

      const result = await batcher.executeAsync([
        { method: 'create', params: { token: 'CD1' } },
      ], { context: TEST_CONTEXT });
      expect(result.success).toBe(true);
    });
  });
});
