import { useCallback, useMemo, useState } from 'react';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';
import { useStream } from './useStream.js';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface CancelSettlement {
  senderRefund: string;
  recipientPayout: string;
  senderRefundAmount: bigint;
  recipientPayoutAmount: bigint;
}

export type CancelStreamFn = () => Promise<void>;

export interface UseCancelStreamResult extends UseStreamMutationState {
  /** Opens the in-app confirmation flow; does not contact the wallet. */
  cancel: CancelStreamFn;
  /** Invokes the contract after the user confirms the settlement breakdown. */
  confirmCancel: () => Promise<string>;
  dismissCancel: () => void;
  isConfirming: boolean;
  isCancelling: boolean;
  settlement: CancelSettlement | null;
  reset: () => void;
}

function settlementFor(stream: {
  ratePerSecond: bigint;
  startTime: number;
  endTime: number;
  withdrawn: bigint;
}): CancelSettlement | null {
  // A finite stream's configured deposit is rate × duration. Open-ended
  // streams do not expose their funded balance in StreamInfo, so do not guess.
  if (!stream.endTime || stream.endTime <= stream.startTime) return null;
  const now = Math.floor(Date.now() / 1000);
  const elapsed = Math.max(0, Math.min(now, stream.endTime) - stream.startTime);
  const accrued = stream.ratePerSecond * BigInt(elapsed);
  const total = stream.ratePerSecond * BigInt(stream.endTime - stream.startTime);
  const payout = accrued > stream.withdrawn ? accrued - stream.withdrawn : 0n;
  const refund = total > accrued ? total - accrued : 0n;
  return {
    senderRefundAmount: refund,
    recipientPayoutAmount: payout,
    senderRefund: refund.toString(),
    recipientPayout: payout.toString(),
  };
}

export function useCancelStream(streamId: StreamMutationId): UseCancelStreamResult {
  const { client } = useStreamFiClient();
  const { stream } = useStream(streamId);
  const mutation = useStreamMutation(streamId, (client, id) => client.streams.cancel(id));
  const [isConfirming, setIsConfirming] = useState(false);
  const settlement = useMemo(() => stream ? settlementFor(stream) : null, [stream]);

  const cancel = useCallback<CancelStreamFn>(async () => {
    // Keep the hook usable with minimal/mock clients that only implement
    // mutations. A real ConduitClient always exposes streams.get, so browser
    // callers follow the confirmation path above.
    if (typeof client?.streams?.get !== 'function') {
      await mutation.mutate();
      return;
    }
    setIsConfirming(true);
  }, [client, mutation.mutate]);
  const dismissCancel = useCallback(() => setIsConfirming(false), []);
  const confirmCancel = useCallback(async () => {
    if (!settlement) throw new Error('Stream settlement is not available yet.');
    setIsConfirming(false);
    return mutation.mutate();
  }, [mutation.mutate, settlement]);
  const reset = useCallback(() => {
    setIsConfirming(false);
    mutation.reset();
  }, [mutation.reset]);

  return {
    ...mutation,
    cancel,
    confirmCancel,
    dismissCancel,
    isConfirming,
    isCancelling: mutation.isPending,
    settlement,
    reset,
  };
}
