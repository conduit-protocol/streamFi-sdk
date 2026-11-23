import { describe, it, expect } from 'vitest';
import { chunkBatchOperations } from '../batch-tx.js';
import { BatchBuildError } from '../batch-tx.js';

describe('chunkBatchOperations', () => {
  it('default maxChunkSize is 50 and splits evenly-sized lists', () => {
    const items = Array.from({ length: 125 }, (_, i) => i);
    const chunks = chunkBatchOperations(items);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(50);
    expect(chunks[1]).toHaveLength(50);
    expect(chunks[2]).toHaveLength(25);
  });

  it('honours an explicit maxChunkSize', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    expect(chunkBatchOperations(items, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]]);
  });

  it('returns a single chunk when the list fits one chunk', () => {
    const items = ['a', 'b', 'c'];
    expect(chunkBatchOperations(items, 50)).toEqual([['a', 'b', 'c']]);
    expect(chunkBatchOperations(items, 3)).toEqual([['a', 'b', 'c']]);
  });

  it('returns [] for an empty list (no stray no-op chunk)', () => {
    expect(chunkBatchOperations([])).toEqual([]);
    expect(chunkBatchOperations([], 1)).toEqual([]);
  });

  it('preserves element order across chunks', () => {
    const items = Array.from({ length: 1000 }, (_, i) => `op-${i}`);
    const chunks = chunkBatchOperations(items, 17);
    expect(chunks.flat()).toEqual(items);
  });

  it('works with object items, not just primitives', () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(chunkBatchOperations(items, 2)).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
  });

  it('throws on a non-positive maxChunkSize', () => {
    expect(() => chunkBatchOperations([1, 2], 0)).toThrow(BatchBuildError);
    expect(() => chunkBatchOperations([1, 2], -5)).toThrow(BatchBuildError);
  });

  it('throws on a non-integer maxChunkSize', () => {
    expect(() => chunkBatchOperations([1, 2], 2.5)).toThrow(BatchBuildError);
  });

  it('throws when items is not an array', () => {
    // @ts-expect-error intentional bad input
    expect(() => chunkBatchOperations('nope')).toThrow(BatchBuildError);
  });
});
