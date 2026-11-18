import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { ConduitClient } from '../client.js';
import type {
  StreamOperation,
  BatchWithdrawItem,
  BatchWithdrawResult,
  FeeEstimate,
  BatchStreamCreationPayload,
  BatchCreateStreamResult,
} from '../types/index.js';
import type { WalletAdapter } from '../adapters/types.js';
import { useConduitClient } from './context.js';

export interface HookOptions {
  client?: ConduitClient;
}

// ── 1. useTransferRecipient ──────────────────────────────────────────────────

export interface UseTransferRecipientResult {
  transferRecipient: (newRecipient: string, overrideStreamId?: bigint | string) => Promise<string>;
  isPending: boolean;
  error: Error | null;
  txHash: string | null;
}

export function useTransferRecipient(
  streamId?: bigint | string,
  options?: HookOptions,
): UseTransferRecipientResult {
  const client = useConduitClient(options?.client);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const transferRecipient = useCallback(
    async (newRecipient: string, overrideStreamId?: bigint | string): Promise<string> => {
      const targetId = overrideStreamId ?? streamId;
      if (targetId == null) {
        throw new Error('streamId is required for transferRecipient');
      }
      setIsPending(true);
      setError(null);
      setTxHash(null);
      try {
        const hash = await client.streams.transferRecipient(targetId, newRecipient);
        setTxHash(hash);
        setIsPending(false);
        return hash;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setIsPending(false);
        throw e;
      }
    },
    [client, streamId],
  );

  return { transferRecipient, isPending, error, txHash };
}

// ── 2. useFeeEstimate ────────────────────────────────────────────────────────

export interface UseFeeEstimateOptions extends HookOptions {
  enabled?: boolean;
}

export interface UseFeeEstimateResult {
  estimate: FeeEstimate | number | null;
  isLoading: boolean;
  error: Error | null;
}

export function useFeeEstimate(
  operation?: StreamOperation | null,
  options?: UseFeeEstimateOptions,
): UseFeeEstimateResult {
  const client = useConduitClient(options?.client);
  const enabled = options?.enabled ?? true;
  const [estimate, setEstimate] = useState<FeeEstimate | number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const opKey = useMemo(() => {
    if (operation == null) return null;
    return typeof operation === 'string'
      ? operation
      : JSON.stringify(operation, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  }, [operation]);

  useEffect(() => {
    if (!enabled || opKey == null || operation == null) {
      setEstimate(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let isMounted = true;
    setIsLoading(true);
    setError(null);

    client.streams
      .estimateFee(operation)
      .then(fee => {
        if (isMounted) {
          setEstimate(fee);
          setIsLoading(false);
        }
      })
      .catch(err => {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [client, enabled, opKey]);

  return { estimate, isLoading, error };
}

// ── 3. useBatchWithdraw ──────────────────────────────────────────────────────

export interface UseBatchWithdrawResult {
  batchWithdraw: (withdrawals: BatchWithdrawItem[]) => Promise<BatchWithdrawResult[]>;
  isPending: boolean;
  error: Error | null;
  results: BatchWithdrawResult[];
}

export function useBatchWithdraw(options?: HookOptions): UseBatchWithdrawResult {
  const client = useConduitClient(options?.client);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [results, setResults] = useState<BatchWithdrawResult[]>([]);

  const batchWithdraw = useCallback(
    async (withdrawals: BatchWithdrawItem[]): Promise<BatchWithdrawResult[]> => {
      setIsPending(true);
      setError(null);
      try {
        const res = await client.streams.batchWithdraw(withdrawals);
        setResults(res);
        setIsPending(false);
        return res;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setIsPending(false);
        throw e;
      }
    },
    [client],
  );

  return { batchWithdraw, isPending, error, results };
}

// ── 4. useStreamBalance ──────────────────────────────────────────────────────

export interface UseStreamBalanceOptions extends HookOptions {
  intervalMs?: number;
  enabled?: boolean;
}

export interface UseStreamBalanceResult {
  withdrawable: bigint | null;
  isLoading: boolean;
  error: Error | null;
}

export function useStreamBalance(
  streamId?: bigint | string | null,
  options?: UseStreamBalanceOptions,
): UseStreamBalanceResult {
  const client = useConduitClient(options?.client);
  const intervalMs = options?.intervalMs ?? 5000;
  const enabled = options?.enabled ?? true;

  const [withdrawable, setWithdrawable] = useState<bigint | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(streamId != null && enabled);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (streamId == null || !enabled) {
      setWithdrawable(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let isMounted = true;
    setIsLoading(true);

    const fetchBalance = async () => {
      try {
        const val = await client.streams.withdrawable(streamId);
        if (isMounted) {
          setWithdrawable(val);
          setError(null);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    fetchBalance();

    const intervalId = setInterval(fetchBalance, intervalMs);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [client, streamId, intervalMs, enabled]);

  return { withdrawable, isLoading, error };
}

// ── 5. useWallet (#1093) ─────────────────────────────────────────────────────

/** localStorage key {@link useWallet} remembers the connected wallet under. */
export const WALLET_STORAGE_KEY = 'streamfi:wallet';

export interface UseWalletOptions extends HookOptions {
  /**
   * Adapters the user can pick from, keyed by a stable id (e.g.
   * `{ freighter: new FreighterWalletAdapter() }`). The id is what gets
   * persisted, so it must stay the same across page loads.
   */
  adapters: Record<string, WalletAdapter>;
  /** Re-attach the last connected wallet on mount. Defaults to `true`. */
  autoReconnect?: boolean;
  /** Override {@link WALLET_STORAGE_KEY}. */
  storageKey?: string;
}

export interface UseWalletResult {
  publicKey: string | null;
  walletId: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  /** True while the remembered wallet is being re-attached after a reload. */
  isReconnecting: boolean;
  error: Error | null;
  connect: (walletId: string) => Promise<string>;
  disconnect: () => Promise<void>;
}

function walletStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Connects a wallet adapter to the client and remembers the choice in
 * localStorage, so the session is re-hydrated after a page reload instead of
 * being lost. Only the adapter id is stored — never keys or signatures.
 */
export function useWallet(options: UseWalletOptions): UseWalletResult {
  const client = useConduitClient(options.client);
  const storageKey = options.storageKey ?? WALLET_STORAGE_KEY;
  const autoReconnect = options.autoReconnect ?? true;
  const adaptersRef = useRef(options.adapters);
  adaptersRef.current = options.adapters;

  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const connect = useCallback(
    async (id: string): Promise<string> => {
      const adapter = adaptersRef.current[id];
      if (!adapter) {
        const e = new Error(`Unknown wallet "${id}"`);
        setError(e);
        throw e;
      }
      setIsConnecting(true);
      setError(null);
      try {
        const key = adapter.connect ? await adapter.connect() : await adapter.getPublicKey();
        client.setWallet(adapter);
        walletStorage()?.setItem(storageKey, id);
        setPublicKey(key);
        setWalletId(id);
        return key;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        throw e;
      } finally {
        setIsConnecting(false);
      }
    },
    [client, storageKey],
  );

  const disconnect = useCallback(async (): Promise<void> => {
    const adapter = walletId ? adaptersRef.current[walletId] : undefined;
    walletStorage()?.removeItem(storageKey);
    setPublicKey(null);
    setWalletId(null);
    setError(null);
    await adapter?.disconnect?.();
  }, [walletId, storageKey]);

  useEffect(() => {
    if (!autoReconnect) return;
    const storage = walletStorage();
    const savedId = storage?.getItem(storageKey) ?? null;
    if (!savedId) return;
    const adapter = adaptersRef.current[savedId];
    if (!adapter || adapter.isConnected?.() === false) {
      // The remembered wallet is gone or has revoked the session: forget it
      // rather than prompting the user on every load.
      storage?.removeItem(storageKey);
      return;
    }

    let isMounted = true;
    setIsReconnecting(true);
    Promise.resolve(adapter.getPublicKey())
      .then(key => {
        if (!isMounted) return;
        client.setWallet(adapter);
        setPublicKey(key);
        setWalletId(savedId);
      })
      .catch(() => {
        storage?.removeItem(storageKey);
      })
      .finally(() => {
        if (isMounted) setIsReconnecting(false);
      });

    return () => {
      isMounted = false;
    };
  }, [client, storageKey, autoReconnect]);

  return {
    publicKey,
    walletId,
    isConnected: publicKey !== null,
    isConnecting,
    isReconnecting,
    error,
    connect,
    disconnect,
  };
}

// ── 6. useBatchStreams (#1094) ───────────────────────────────────────────────

export type BatchStatus = 'idle' | 'pending' | 'success' | 'partial' | 'error';

export interface BatchProgress {
  status: BatchStatus;
  /** Items in the batch currently (or last) submitted. */
  total: number;
  succeeded: number;
  failed: number;
}

export interface UseBatchStreamsResult {
  createBatch: (configs: BatchStreamCreationPayload[]) => Promise<BatchCreateStreamResult[]>;
  withdrawBatch: (withdrawals: BatchWithdrawItem[]) => Promise<BatchWithdrawResult[]>;
  progress: BatchProgress;
  isPending: boolean;
  error: Error | null;
  createResults: BatchCreateStreamResult[];
  withdrawResults: BatchWithdrawResult[];
  reset: () => void;
}

const IDLE_PROGRESS: BatchProgress = { status: 'idle', total: 0, succeeded: 0, failed: 0 };

function settledProgress(results: Array<{ success: boolean }>): BatchProgress {
  const succeeded = results.filter(r => r.success).length;
  const failed = results.length - succeeded;
  const status: BatchStatus = failed === 0 ? 'success' : succeeded === 0 ? 'error' : 'partial';
  return { status, total: results.length, succeeded, failed };
}

/**
 * Declarative wrapper around `client.streams.createBatchStreams` and
 * `client.streams.batchWithdraw` for payroll-style batch operations. Each
 * item's outcome is reported individually (`partial` when some fail), since
 * the client isolates per-item failures instead of failing the whole batch.
 */
export function useBatchStreams(options?: HookOptions): UseBatchStreamsResult {
  const client = useConduitClient(options?.client);
  const [progress, setProgress] = useState<BatchProgress>(IDLE_PROGRESS);
  const [error, setError] = useState<Error | null>(null);
  const [createResults, setCreateResults] = useState<BatchCreateStreamResult[]>([]);
  const [withdrawResults, setWithdrawResults] = useState<BatchWithdrawResult[]>([]);

  const createBatch = useCallback(
    async (configs: BatchStreamCreationPayload[]): Promise<BatchCreateStreamResult[]> => {
      setProgress({ status: 'pending', total: configs.length, succeeded: 0, failed: 0 });
      setError(null);
      try {
        const results = await client.streams.createBatchStreams(configs);
        setCreateResults(results);
        setProgress(settledProgress(results));
        return results;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setProgress({ status: 'error', total: configs.length, succeeded: 0, failed: configs.length });
        throw e;
      }
    },
    [client],
  );

  const withdrawBatch = useCallback(
    async (withdrawals: BatchWithdrawItem[]): Promise<BatchWithdrawResult[]> => {
      setProgress({ status: 'pending', total: withdrawals.length, succeeded: 0, failed: 0 });
      setError(null);
      try {
        const results = await client.streams.batchWithdraw(withdrawals);
        setWithdrawResults(results);
        setProgress(settledProgress(results));
        return results;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setProgress({
          status: 'error',
          total: withdrawals.length,
          succeeded: 0,
          failed: withdrawals.length,
        });
        throw e;
      }
    },
    [client],
  );

  const reset = useCallback(() => {
    setProgress(IDLE_PROGRESS);
    setError(null);
    setCreateResults([]);
    setWithdrawResults([]);
  }, []);

  return {
    createBatch,
    withdrawBatch,
    progress,
    isPending: progress.status === 'pending',
    error,
    createResults,
    withdrawResults,
    reset,
  };
}
