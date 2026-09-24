import { useCallback } from 'react';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';

export type TopUpStreamFn = (amount: bigint | string) => Promise<string>;

export interface UseTopUpStreamResult extends UseStreamMutationState {
  topUp: TopUpStreamFn;
  isTopUpPending: boolean;
  reset: () => void;
}

export function useTopUpStream(streamId: StreamMutationId): UseTopUpStreamResult {
  const { mutate, isPending, error, txHash, reset } = useStreamMutation(
    streamId,
    (client, id, amount: bigint | string) => client.streams.topUp(id, BigInt(amount)),
  );

  const topUp = useCallback<TopUpStreamFn>((amount) => mutate(amount), [mutate]);

  return { topUp, isTopUpPending: isPending, isPending, error, txHash, reset };
}