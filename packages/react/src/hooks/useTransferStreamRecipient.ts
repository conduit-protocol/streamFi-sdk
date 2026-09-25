import { useCallback } from 'react';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';

export type TransferRecipientFn = (newRecipient: string) => Promise<string>;

export interface UseTransferStreamRecipientResult extends UseStreamMutationState {
  transferRecipient: TransferRecipientFn;
  reset: () => void;
}

export function useTransferStreamRecipient(streamId: StreamMutationId): UseTransferStreamRecipientResult {
  const { mutate, isPending, error, txHash, reset } = useStreamMutation(
    streamId,
    (client, id, newRecipient: string) => client.streams.transferRecipient(id, newRecipient),
  );

  const transferRecipient = useCallback<TransferRecipientFn>(
    (newRecipient) => mutate(newRecipient),
    [mutate],
  );

  return { transferRecipient, isPending, error, txHash, reset };
}
