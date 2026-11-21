import { useCallback } from 'react';
import { isValidAddress } from '@conduit-protocol/sdk/utils';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';

export type TransferRecipientFn = (newRecipient: string) => Promise<string>;

export interface UseTransferStreamRecipientResult extends UseStreamMutationState {
  transferRecipient: TransferRecipientFn;
  /**
   * Two-step transfer: call `initiateTransfer(newRecipient)` to stage the
   * address, then `confirmTransfer(newRecipient)` with the same address to
   * submit (#1001). The re-entry requirement prevents accidental transfers
   * from a mistyped address in an irreversible ownership change.
   */
  initiateTransfer: (newRecipient: string) => void;
  confirmTransfer: (confirmedRecipient: string) => Promise<string>;
  cancelTransfer: () => void;
  /** The staged recipient address waiting for confirmation, or null. */
  pendingRecipient: string | null;
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
  const { mutate, isPending, error, txHash, reset: mutateReset } = useStreamMutation(
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

  const [pendingRecipient, setPendingRecipient] = useState<string | null>(null);

  const transferRecipient = useCallback<TransferRecipientFn>(
    (newRecipient) => mutate(newRecipient),
    [mutate],
  );

  const initiateTransfer = useCallback((newRecipient: string) => {
    if (!isValidAddress(newRecipient)) {
      throw new Error(`Invalid recipient address: "${newRecipient}". Must be a valid Stellar G… or C… address.`);
    }
    setPendingRecipient(newRecipient);
  }, []);

  const confirmTransfer = useCallback(
    (confirmedRecipient: string): Promise<string> => {
      if (!pendingRecipient) {
        return Promise.reject(new Error('No transfer is pending. Call initiateTransfer first.'));
      }
      if (confirmedRecipient !== pendingRecipient) {
        return Promise.reject(
          new Error('Confirmation address does not match. Re-enter the recipient address exactly to confirm the transfer.'),
        );
      }
      setPendingRecipient(null);
      return mutate(confirmedRecipient);
    },
    [mutate, pendingRecipient],
  );

  const cancelTransfer = useCallback(() => {
    setPendingRecipient(null);
  }, []);

  const reset = useCallback(() => {
    setPendingRecipient(null);
    mutateReset();
  }, [mutateReset]);

  return { transferRecipient, initiateTransfer, confirmTransfer, cancelTransfer, pendingRecipient, isPending, error, txHash, reset };
}
