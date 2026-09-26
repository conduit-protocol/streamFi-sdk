import { useState, useCallback, useEffect, useRef } from 'react';
import { ConduitBatcher } from '@conduit-protocol/sdk';
import type {
  BatchExecuteOptions,
  BatchExecuteAsyncOptions,
  BatchOperation,
  BatchResult,
} from '@conduit-protocol/sdk';

export interface UseConduitBatcherState {
  loading: boolean;
  error: Error | null;
  result: BatchResult | null;
}

export type BatcherExecuteFn = (
  streams: Record<string, unknown>[],
  options?: BatchExecuteOptions,
) => BatchResult;

export type BatcherExecuteAsyncFn = (
  operations: BatchOperation[],
  options?: BatchExecuteAsyncOptions,
) => Promise<BatchResult>;

export interface UseConduitBatcherResult extends UseConduitBatcherState {
  /** Build the batch synchronously. Needs `context.sequence`; otherwise use `executeAsync`. */
  execute: BatcherExecuteFn;
  /** Build the batch asynchronously, fetching the sequence number via RPC when needed. */
  executeAsync: BatcherExecuteAsyncFn;
  reset: () => void;
}

function failureError(result: BatchResult): Error {
  return new Error(result.errors?.join('; ') || 'Batch execution failed');
}

/**
 * Wraps a {@link ConduitBatcher} for bulk create/withdraw UIs (#770).
 *
 * One batcher lives for the component's lifetime and is destroyed on unmount,
 * which rejects any queued batches. `defaultOptions` (for example the chain
 * `context`) apply to every call and can be overridden per call. A failed
 * batch (`success: false`) sets `error`; the result is always kept in `result`.
 */
export function useConduitBatcher(
  defaultOptions?: BatchExecuteOptions,
): UseConduitBatcherResult {
  const batcherRef = useRef<ConduitBatcher | null>(null);
  if (batcherRef.current === null) {
    batcherRef.current = new ConduitBatcher();
  }
  const optionsRef = useRef(defaultOptions);
  optionsRef.current = defaultOptions;
  const mountedRef = useRef(true);

  const [state, setState] = useState<UseConduitBatcherState>({
    loading: false,
    error: null,
    result: null,
  });

  useEffect(() => {
    mountedRef.current = true;
    const batcher = batcherRef.current!;
    // reset() re-enables a batcher destroyed by a previous unmount, so React
    // StrictMode's mount -> unmount -> mount cycle leaves it usable.
    batcher.reset();
    return () => {
      mountedRef.current = false;
      batcher.destroy();
    };
  }, []);

  const safeSetState = useCallback((next: UseConduitBatcherState) => {
    if (mountedRef.current) setState(next);
  }, []);

  const reset = useCallback(() => {
    safeSetState({ loading: false, error: null, result: null });
  }, [safeSetState]);

  const execute = useCallback<BatcherExecuteFn>(
    (streams, options) => {
      try {
        const result = batcherRef.current!.execute(streams, {
          ...optionsRef.current,
          ...options,
        });
        safeSetState({
          loading: false,
          error: result.success ? null : failureError(result),
          result,
        });
        return result;
      } catch (err: unknown) {
        const typed = err instanceof Error ? err : new Error(String(err));
        safeSetState({ loading: false, error: typed, result: null });
        throw typed;
      }
    },
    [safeSetState],
  );

  const executeAsync = useCallback<BatcherExecuteAsyncFn>(
    async (operations, options) => {
      safeSetState({ loading: true, error: null, result: null });
      try {
        const context = options?.context ?? optionsRef.current?.context;
        const result = await batcherRef.current!.executeAsync(operations, {
          ...options,
          ...(context ? { context } : {}),
        });
        safeSetState({
          loading: false,
          error: result.success ? null : failureError(result),
          result,
        });
        return result;
      } catch (err: unknown) {
        const typed = err instanceof Error ? err : new Error(String(err));
        safeSetState({ loading: false, error: typed, result: null });
        throw typed;
      }
    },
    [safeSetState],
  );

  return { ...state, execute, executeAsync, reset };
}
