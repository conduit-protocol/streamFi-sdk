import { useCallback } from 'react';
import { isValidAddress } from '@conduit-protocol/sdk/utils';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';

export type TransferRecipientFn = (newRecipient: string) => Promise<string>;

export interface UseTransferStreamRecipientResult extends UseStreamMutationState {
  transferRecipient: TransferRecipientFn;
  reset: () => void;
}

/**
 * Transfer the beneficiary address on an active stream (#947).
 *
 * Validates `newRecipient` as a Stellar G... or C... address before
 * submitting, so compromised-key rotation flows fail fast with a clear
 * error instead of surfacing an on-chain rejection.
 */
export function useTransferStreamRecipient(streamId: StreamMutationId): UseTransferStreamRecipientResult {
  const { mutate, isPending, error, txHash, reset } = useStreamMutation(
    streamId,
    (client, id, newRecipient: string) => {
      if (!isValidAddress(newRecipient)) {
        return Promise.reject(
          new Error(`Invalid recipient address: "${newRecipient}". Must be a valid Stellar G… or C… address.`),
        );
      }
      return client.streams.transferRecipient(id, newRecipient);
    },
  );

  const transferRecipient = useCallback<TransferRecipientFn>(
    (newRecipient) => mutate(newRecipient),
    [mutate],
  );

  return { transferRecipient, isPending, error, txHash, reset };
}
