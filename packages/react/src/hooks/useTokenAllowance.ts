import { useCallback, useEffect, useRef, useState } from 'react';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export type ApproveTokenAllowanceFn = (
  amount: bigint | string,
  expirationLedger: number,
) => Promise<string>;

export interface UseTokenAllowanceResult {
  allowance: bigint | null;
  loading: boolean;
  isPending: boolean;
  error: Error | null;
  txHash: string | null;
  approve: ApproveTokenAllowanceFn;
  refetch: () => void;
  reset: () => void;
}

/**
 * Read and update a spender's SEP-41 token allowance.
 *
 * The connected wallet or signer must own `ownerAddress` before `approve`
 * can submit a transaction.
 */
export function useTokenAllowance(
  tokenAddress: string | null | undefined,
  ownerAddress: string | null | undefined,
  spenderAddress: string | null | undefined,
): UseTokenAllowanceResult {
  const { client, isReady } = useStreamFiClient();
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refetch = useCallback(() => {
    const requestId = ++requestIdRef.current;
    if (!isReady || !client || !tokenAddress || !ownerAddress || !spenderAddress) {
      setAllowance(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    client.tokens
      .allowance(tokenAddress, ownerAddress, spenderAddress)
      .then((value) => {
        if (!mountedRef.current || requestIdRef.current !== requestId) return;
        setAllowance(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, [client, isReady, ownerAddress, spenderAddress, tokenAddress]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const approve = useCallback<ApproveTokenAllowanceFn>(
    async (amount, expirationLedger) => {
      if (!isReady || !client) {
        const err = new Error('ConduitClient is not connected. Wrap your component with <StreamFiProvider>.');
        setError(err);
        throw err;
      }
      if (!tokenAddress || !ownerAddress || !spenderAddress) {
        const err = new Error('tokenAddress, ownerAddress, and spenderAddress are required.');
        setError(err);
        throw err;
      }

      let parsedAmount: bigint;
      try {
        parsedAmount = BigInt(amount);
      } catch {
        const err = new TypeError('amount must be a bigint-compatible integer');
        setError(err);
        throw err;
      }

      setIsPending(true);
      setError(null);
      setTxHash(null);
      try {
        const hash = await client.tokens.approve(
          tokenAddress,
          ownerAddress,
          spenderAddress,
          parsedAmount,
          expirationLedger,
        );
        if (mountedRef.current) {
          setAllowance(parsedAmount);
          setIsPending(false);
          setTxHash(hash);
        }
        return hash;
      } catch (err: unknown) {
        const typed = err instanceof Error ? err : new Error(String(err));
        if (mountedRef.current) {
          setIsPending(false);
          setError(typed);
        }
        throw typed;
      }
    },
    [client, isReady, ownerAddress, spenderAddress, tokenAddress],
  );

  const reset = useCallback(() => {
    ++requestIdRef.current;
    setAllowance(null);
    setLoading(false);
    setIsPending(false);
    setError(null);
    setTxHash(null);
  }, []);

  return { allowance, loading, isPending, error, txHash, approve, refetch, reset };
}
