import { useCallback, useMemo, useState } from 'react';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';
import { useStream, type UseStreamResult } from './useStream.js';
import { useStreamFiClient } from '../context/useStreamFiClient.js';

export interface CancelSettlement {
  senderRefund: string;
  recipientPayout: string;
  senderRefundAmount: bigint;
  recipientPayoutAmount: bigint;
  /** Protocol penalty fee deducted when the stream is cancelled early (#999). */
  cancellationFee?: string;
  /** Raw stroop amount of the cancellation fee; undefined means no fee applies. */
  cancellationFeeAmount?: bigint;
}

export type CancelStreamFn = () => Promise<string>;

export interface UseCancelStreamResult extends UseStreamMutationState {
  /** Opens the in-app confirmation flow; does not contact the wallet. */
  cancel: CancelStreamFn;
  /** Invokes the contract after the user confirms the settlement breakdown. */
  confirmCancel: () => Promise<string>;
  dismissCancel: () => void;
  isConfirming: boolean;
  isCancelling: boolean;
  settlement: CancelSettlement | null;
  /** Unstreamed balance the sender would get back if cancelled now; null when unknown (e.g. open-ended streams). */
  estimatedRefund: bigint | null;
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
  const { stream, setStream } = useStream(streamId) as UseStreamResult;
  const mutation = useStreamMutation(streamId, (client, id) => client.streams.cancel(id));
  const [isConfirming, setIsConfirming] = useState(false);
  const settlement = useMemo(() => stream ? settlementFor(stream) : null, [stream]);

  const cancel = useCallback<CancelStreamFn>(async () => {
    // Keep the hook usable with minimal/mock clients that only implement
    // mutations. A real ConduitClient always exposes streams.get, so browser
    // callers follow the confirmation path above.
    if (typeof client?.streams?.get !== 'function') {
      const previous = stream;
      if (stream) {
        setStream((current) => current ? { ...current, cancelled: true, paused: false, pausedAt: 0 } : current);
      }
      try {
        await mutation.mutate();
      } catch (error) {
        if (previous) setStream(previous);
        throw error;
      }
      return;
    }
    setIsConfirming(true);
  }, [client, mutation, setStream, stream]);
  const dismissCancel = useCallback(() => setIsConfirming(false), []);
  const confirmCancel = useCallback(async () => {
    if (!settlement) throw new Error('Stream settlement is not available yet.');
    const previous = stream;
    if (stream) {
      setStream((current) => current ? { ...current, cancelled: true, paused: false, pausedAt: 0 } : current);
    }
    setIsConfirming(false);
    try {
      return await mutation.mutate();
    } catch (error) {
      if (previous) setStream(previous);
      throw error;
    }
  }, [mutation, setStream, settlement, stream]);
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
    estimatedRefund: settlement?.senderRefundAmount ?? null,
    reset,
  };
}
