import { useCallback } from 'react';
import { InsufficientBalanceError, type StreamInfo } from '@conduit-protocol/sdk';
import { useStreamMutation, type StreamMutationId, type UseStreamMutationState } from './useStreamMutation.js';
import { useStream } from './useStream.js';

export type TopUpStreamFn = (amount: bigint | string) => Promise<string>;

/**
 * Projects the stream's end date after a top-up of `amount`. Returns `null`
 * when the stream is not loaded, is open-ended, has no rate, or the amount is
 * not positive.
 */
export type ProjectNewEndTimeFn = (amount: bigint | string) => Date | null;

export interface UseTopUpStreamOptions {
  tokenBalance?: bigint | string | null;
}

export interface UseTopUpStreamResult extends UseStreamMutationState {
  topUp: TopUpStreamFn;
  isTopUpPending: boolean;
  projectNewEndTime: ProjectNewEndTimeFn;
  reset: () => void;
}

/**
 * Seconds a top-up adds to a stream: `amount / ratePerSecond`, rounded up so a
 * partial second is never under-counted.
 */
function projectEndTime(
  stream: Pick<StreamInfo, 'ratePerSecond' | 'endTime'> | null,
  amount: bigint | string,
): Date | null {
  if (!stream || stream.endTime === 0 || stream.ratePerSecond <= 0n) return null;

  let parsedAmount: bigint;
  try {
    parsedAmount = BigInt(amount);
  } catch {
    return null;
  }
  if (parsedAmount <= 0n) return null;

  const extraSeconds = (parsedAmount + stream.ratePerSecond - 1n) / stream.ratePerSecond;
  if (extraSeconds > BigInt(Number.MAX_SAFE_INTEGER)) return null;

  const projected = new Date((stream.endTime + Number(extraSeconds)) * 1000);
  return Number.isFinite(projected.getTime()) ? projected : null;
}

/**
 * Deposit additional tokens into a stream.
 *
 * Validates the top-up amount against `tokenBalance` when provided. Loads the
 * stream's rate and end time so `projectNewEndTime(amount)` can show how far a
 * top-up extends the stream, assuming the deposit extends `endTime` by
 * `amount / ratePerSecond`. The stream is refetched after each successful
 * top-up so later projections use the new end time.
 *
 * @param streamId - The stream ID to top up.
 * @param options.tokenBalance - Optional: current owner balance to validate against.
 * @returns Hook state with `topUp` and `projectNewEndTime`.
 *
 * @example
 * ```typescript
 * const { topUp, projectNewEndTime } = useTopUpStream(streamId, {
 *   tokenBalance: 500000000n, // 500 USDC in stroops
 * });
 *
 * const end = projectNewEndTime(100000000n); // Date, or null if not yet loaded
 * await topUp(100000000n); // Top up with 100 USDC
 * ```
 */
export function useTopUpStream(
  streamId: StreamMutationId,
  options: UseTopUpStreamOptions = {},
): UseTopUpStreamResult {
  const { tokenBalance } = options;
  const { stream, refetch: refetchStream } = useStream(streamId);
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
    const hash = await mutate(amount);
    refetchStream();
    return hash;
  }, [mutate, refetchStream, tokenBalance]);

  const projectNewEndTime = useCallback<ProjectNewEndTimeFn>(
    (amount) => projectEndTime(stream, amount),
    [stream],
  );

  return { topUp, isTopUpPending: isPending, isPending, error, txHash, projectNewEndTime, reset };
}
