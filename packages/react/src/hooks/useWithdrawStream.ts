import { useCallback } from 'react';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';

export type WithdrawStreamFn = (amount?: bigint | string) => Promise<string>;

export interface UseWithdrawStreamResult extends UseStreamMutationState {
  withdraw: WithdrawStreamFn;
  isWithdrawing: boolean;
  reset: () => void;
}

export function useWithdrawStream(streamId: StreamMutationId): UseWithdrawStreamResult {
  const { mutate, isPending, error, txHash, reset } = useStreamMutation(
    streamId,
    (client, id, amount?: bigint | string) =>
      client.streams.withdraw(id, amount === undefined ? undefined : BigInt(amount)),
  );

  const withdraw = useCallback<WithdrawStreamFn>((amount) => mutate(amount), [mutate]);

  return { withdraw, isWithdrawing: isPending, isPending, error, txHash, reset };
}