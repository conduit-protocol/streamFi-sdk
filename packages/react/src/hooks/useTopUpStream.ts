import { useCallback } from 'react';
import { InsufficientBalanceError } from '@conduit-protocol/sdk';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';

export type TopUpStreamFn = (amount: bigint | string) => Promise<string>;

export interface UseTopUpStreamOptions {
  tokenBalance?: bigint | string | null;
}

export interface UseTopUpStreamResult extends UseStreamMutationState {
  topUp: TopUpStreamFn;
  isTopUpPending: boolean;
  reset: () => void;
}

export function useTopUpStream(
  streamId: StreamMutationId,
  options: UseTopUpStreamOptions = {},
): UseTopUpStreamResult {
  const { tokenBalance } = options;
  const { mutate, isPending, error, txHash, reset } = useStreamMutation(
    streamId,
    (client, id, amount: bigint | string) => client.streams.topUp(id, BigInt(amount)),
  );

  const topUp = useCallback<TopUpStreamFn>(async (amount) => {
    const parsedAmount = BigInt(amount);
    if (tokenBalance !== undefined && tokenBalance !== null) {
      const balance = BigInt(tokenBalance);
      if (balance < parsedAmount) {
        throw new InsufficientBalanceError(balance, parsedAmount, 'Top-up amount exceeds the available token balance.');
      }
    }
    return mutate(amount);
  }, [mutate, tokenBalance]);

  return { topUp, isTopUpPending: isPending, isPending, error, txHash, reset };
}