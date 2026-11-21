import { describe, it, expect, vi } from 'vitest';
import {
  BatchTx,
  processBatch,
  chunkItems,
  DEFAULT_CHUNK_SIZE,
  type BatchProgress,
} from '../batch-tx.js';

describe('batch-tx', () => {
  describe('chunkItems', () => {
    it('splits items into consecutive chunks', () => {
      expect(chunkItems([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    it('returns no chunks for an empty input', () => {
      expect(chunkItems([], 2)).toEqual([]);
    });

    it('uses the default chunk size when omitted', () => {
      const items = Array.from({ length: DEFAULT_CHUNK_SIZE + 1 }, (_, i) => i);
      const chunks = chunkItems(items);
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toHaveLength(DEFAULT_CHUNK_SIZE);
      expect(chunks[1]).toHaveLength(1);
    });

    it('rejects non-positive or non-integer chunk sizes', () => {
      expect(() => chunkItems([1], 0)).toThrow(RangeError);
      expect(() => chunkItems([1], -1)).toThrow(RangeError);
      expect(() => chunkItems([1], 1.5)).toThrow(RangeError);
    });
  });

  describe('processBatch', () => {
    it('reports chunk index and completed items after each chunk', async () => {
      const progress: BatchProgress[] = [];
      const result = await processBatch(
        [1, 2, 3, 4, 5],
        async item => item * 2,
        { chunkSize: 2, onProgress: p => progress.push(p) },
      );

      expect(progress.map(p => p.chunkIndex)).toEqual([0, 1, 2]);
      expect(progress.map(p => p.completedItems)).toEqual([2, 4, 5]);
      expect(progress.map(p => p.itemsInChunk)).toEqual([2, 2, 1]);
      expect(progress[2]?.percent).toBe(100);
      expect(progress[0]?.totalChunks).toBe(3);

      expect(result.results).toEqual([2, 4, 6, 8, 10]);
      expect(result.completedItems).toBe(5);
      expect(result.chunksProcessed).toBe(3);
      expect(result.aborted).toBe(false);
    });

    it('records per-item failures and continues processing', async () => {
      const result = await processBatch([1, 2, 3], item => {
        if (item === 2) throw new Error('bad item');
        return item;
      }, { chunkSize: 1 });

      expect(result.results).toEqual([1, 3]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.index).toBe(1);
      expect(result.completedItems).toBe(3);
      expect(result.failedItems).toBe(1);
    });

    it('emits no progress for an empty batch', async () => {
      const onProgress = vi.fn();
      const result = await processBatch([], async item => item, { onProgress });

      expect(onProgress).not.toHaveBeenCalled();
      expect(result.results).toEqual([]);
      expect(result.chunksProcessed).toBe(0);
    });

    it('stops at the next safe boundary when aborted', async () => {
      const controller = new AbortController();
      const chunkIndexes: number[] = [];

      const result = await processBatch(
        [1, 2, 3, 4],
        async item => {
          if (item === 2) controller.abort();
          return item;
        },
        {
          chunkSize: 2,
          signal: controller.signal,
          onProgress: p => chunkIndexes.push(p.chunkIndex),
        },
      );

      expect(chunkIndexes).toEqual([0]);
      expect(result.results).toEqual([1, 2]);
      expect(result.completedItems).toBe(2);
      expect(result.aborted).toBe(true);
    });

    it('rejects an invalid chunk size', async () => {
      await expect(processBatch([1], async item => item, { chunkSize: 0 }))
        .rejects.toThrow(RangeError);
    });

    it('BatchTx holds defaults that can be overridden per run', async () => {
      const onProgress = vi.fn();
      const batcher = new BatchTx({ chunkSize: 1, onProgress });

      const result = await batcher.run([1, 2], async item => item);

      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(result.results).toEqual([1, 2]);

      const override = vi.fn();
      await batcher.run([1, 2, 3], async item => item, { onProgress: override });
      expect(override).toHaveBeenCalledTimes(3);
      expect(onProgress).toHaveBeenCalledTimes(2);
    });
  });
});
