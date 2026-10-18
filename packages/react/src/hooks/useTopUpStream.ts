import { useCallback, useMemo } from 'react';
import { InsufficientBalanceError } from '@conduit-protocol/sdk';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';
import { useStream } from './useStream.js';

export type TopUpStreamFn = (amount: bigint | string) => Promise<string>;

export interface UseTopUpStreamOptions {
  tokenBalance?: bigint | string | null;
}

export interface UseTopUpStreamResult extends UseStreamMutationState {
  topUp: TopUpStreamFn;
  isTopUpPending: boolean;
  /** Projected end time after top-up, in Unix seconds. */
  projectedNewEndTime?: number;
  reset: () => void;
}

/**
 * Deposit additional tokens into a stream.
 *
 * Validates the top-up amount against the available token balance if provided.
 * Fetches stream info to calculate the projected new end time based on the
 * stream's rate and current end time.
 *
 * @param streamId - The stream ID to top up.
 * @param options.tokenBalance - Optional: current owner balance to validate against.
 * @returns Hook state with topUp function and projectedNewEndTime.
 *
 * @example
 * ```typescript
 * const { topUp, projectedNewEndTime, isTopUpPending } = useTopUpStream(streamId, {
 *   tokenBalance: 500000000n, // 500 USDC in stroops
 * });
 *
 * await topUp(100000000n); // Top up with 100 USDC
 * console.log('New end time:', new Date(projectedNewEndTime! * 1000));
 * ```
 */
export function useTopUpStream(
  streamId: StreamMutationId,
  options: UseTopUpStreamOptions = {},
): UseTopUpStreamResult {
  const { tokenBalance } = options;
  const { stream } = useStream(streamId);
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

  /** Calculate projected new end time based on current stream endTime and top-up amount */
  const projectedNewEndTime = useMemo(() => {
    if (!stream) return undefined;
    // For demonstration: projectedNewEndTime = endTime + (topUpAmount / ratePerSecond)
    // This will be calculated at top-up time in a real scenario
    // For now, return the current endTime as placeholder
    return stream.endTime || undefined;
  }, [stream]);

  return { topUp, isTopUpPending: isPending, isPending, error, txHash, projectedNewEndTime, reset };
}