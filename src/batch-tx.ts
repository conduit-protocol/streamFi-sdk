/**
 * Chunked batch transaction processing with progress reporting.
 *
 * Large payroll batches are split into smaller transaction chunks so that a
 * UI can render progress bars / stage indicators while the batch is being
 * submitted. Each chunk is processed in order and an `onProgress` callback
 * is invoked once the chunk completes.
 */

export interface BatchProgress {
  /** Zero-based index of the chunk that was just completed. */
  chunkIndex: number;
  /** Total number of chunks the batch was split into. */
  totalChunks: number;
  /** Cumulative number of items processed (including failures). */
  completedItems: number;
  /** Total number of items in the batch. */
  totalItems: number;
  /** Number of items that belonged to the just-completed chunk. */
  itemsInChunk: number;
  /** Completion percentage in the range 0-100. */
  percent: number;
}

export interface BatchItemError {
  /** Index of the item in the original input array. */
  index: number;
  /** The error thrown while processing that item. */
  error: unknown;
}

export interface BatchTxResult<R> {
  /** Successful handler results, in input order. */
  results: R[];
  /** Per-item failures; their presence does not abort the batch. */
  errors: BatchItemError[];
  completedItems: number;
  failedItems: number;
  totalItems: number;
  chunksProcessed: number;
  aborted: boolean;
}

export interface BatchTxOptions {
  /** Maximum number of items per transaction chunk. Default: 50. */
  chunkSize?: number;
  /** Invoked once after every completed chunk. */
  onProgress?: (progress: BatchProgress) => void;
  /** Allows a caller to stop processing between chunks. */
  signal?: AbortSignal;
}

export const DEFAULT_CHUNK_SIZE = 50;

/** Split an array into consecutive chunks of at most `chunkSize` items. */
export function chunkItems<T>(items: readonly T[], chunkSize: number = DEFAULT_CHUNK_SIZE): T[][] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError('chunkSize must be a positive integer');
  }

  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Process a batch in chunks, reporting progress after each chunk.
 *
 * The handler runs sequentially so progress reflects work that has actually
 * completed. A failing item is recorded in `errors` and processing continues
 * with the next item, ensuring one bad transaction cannot stall a payroll
 * run. If the abort signal fires, processing stops at the next safe boundary
 * and the partial result is returned with `aborted: true`.
 */
export async function processBatch<T, R>(
  items: readonly T[],
  handler: (item: T, index: number) => R | Promise<R>,
  options: BatchTxOptions = {},
): Promise<BatchTxResult<R>> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError('chunkSize must be a positive integer');
  }

  const onProgress = options.onProgress;
  const signal = options.signal;
  const chunks = chunkItems(items, chunkSize);
  const results: R[] = [];
  const errors: BatchItemError[] = [];
  let completedItems = 0;
  let chunksProcessed = 0;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    if (signal?.aborted) break;

    const chunk = chunks[chunkIndex]!;
    const startIndex = chunkIndex * chunkSize;

    for (let i = 0; i < chunk.length; i++) {
      if (signal?.aborted) break;

      const index = startIndex + i;
      try {
        results.push(await handler(chunk[i]!, index));
      } catch (error) {
        errors.push({ index, error });
      }
      completedItems++;
    }

    chunksProcessed++;
    if (onProgress) {
      onProgress({
        chunkIndex,
        totalChunks: chunks.length,
        completedItems,
        totalItems: items.length,
        itemsInChunk: chunk.length,
        percent: items.length === 0 ? 100 : Math.round((completedItems / items.length) * 100),
      });
    }
  }

  return {
    results,
    errors,
    completedItems,
    failedItems: errors.length,
    totalItems: items.length,
    chunksProcessed,
    aborted: signal?.aborted === true,
  };
}

/** Reusable batch processor that holds default options (e.g. a shared onProgress callback). */
export class BatchTx {
  private readonly defaults: BatchTxOptions;

  constructor(defaults: BatchTxOptions = {}) {
    this.defaults = defaults;
  }

  run<T, R>(
    items: readonly T[],
    handler: (item: T, index: number) => R | Promise<R>,
    overrides: BatchTxOptions = {},
  ): Promise<BatchTxResult<R>> {
    const chunkSize = overrides.chunkSize ?? this.defaults.chunkSize;
    const onProgress = overrides.onProgress ?? this.defaults.onProgress;
    const signal = overrides.signal ?? this.defaults.signal;

    const options: BatchTxOptions = {};
    if (chunkSize !== undefined) options.chunkSize = chunkSize;
    if (onProgress !== undefined) options.onProgress = onProgress;
    if (signal !== undefined) options.signal = signal;

    return processBatch(items, handler, options);
  }
}
