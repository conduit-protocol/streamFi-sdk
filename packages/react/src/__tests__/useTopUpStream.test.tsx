import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTopUpStream } from '../hooks/useTopUpStream.js';

const mockGet = vi.fn();
const mockTopUp = vi.fn();
const mockContext = {
  client: {
    streams: {
      get: mockGet,
      topUp: mockTopUp,
    },
  },
  isReady: true,
  error: null,
  connect: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock('../context/useStreamFiClient.js', () => ({
  useStreamFiClient: () => mockContext,
}));

vi.mock('@conduit-protocol/sdk', () => ({
  InsufficientBalanceError: class InsufficientBalanceError extends Error {},
}));

const streamWith = (overrides: { ratePerSecond?: bigint; endTime?: number }) => ({
  id: 7n,
  ratePerSecond: 100n,
  endTime: 5000,
  ...overrides,
});

/** Let the pending `streams.get` resolve and update hook state. */
const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe('useTopUpStream projectNewEndTime', () => {
  beforeEach(() => {
    mockGet.mockReset().mockResolvedValue(streamWith({}));
    mockTopUp.mockReset().mockResolvedValue('top-up-hash');
  });

  it('returns null until the stream rate and end time are loaded', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useTopUpStream(7n));
    expect(result.current.projectNewEndTime('500')).toBeNull();
  });

  it('projects the end date from the top-up amount and stream rate', async () => {
    const { result } = renderHook(() => useTopUpStream(7n));

    await waitFor(() => expect(result.current.projectNewEndTime('500')).not.toBeNull());

    // 500 stroops at 100 stroops/s adds 5 seconds to endTime 5000.
    expect(result.current.projectNewEndTime('500')?.getTime()).toBe(5005_000);
    // A larger top-up pushes the end date further out.
    expect(result.current.projectNewEndTime(50_000n)?.getTime()).toBe(5500_000);
  });

  it('rounds partial seconds up so the projection is never short', async () => {
    const { result } = renderHook(() => useTopUpStream(7n));

    await waitFor(() => expect(result.current.projectNewEndTime('150')).not.toBeNull());

    // 150 / 100 = 1.5 seconds rounds up to 2.
    expect(result.current.projectNewEndTime('150')?.getTime()).toBe(5002_000);
  });

  it('returns null for open-ended streams, zero rates and non-positive amounts', async () => {
    mockGet.mockResolvedValue(streamWith({ endTime: 0 }));
    const open = renderHook(() => useTopUpStream(7n));
    await flush();
    expect(open.result.current.projectNewEndTime('500')).toBeNull();

    mockGet.mockResolvedValue(streamWith({ ratePerSecond: 0n }));
    const zeroRate = renderHook(() => useTopUpStream(7n));
    await flush();
    expect(zeroRate.result.current.projectNewEndTime('500')).toBeNull();

    mockGet.mockResolvedValue(streamWith({}));
    const zeroAmount = renderHook(() => useTopUpStream(7n));
    await flush();
    expect(zeroAmount.result.current.projectNewEndTime('0')).toBeNull();
    expect(zeroAmount.result.current.projectNewEndTime('-5')).toBeNull();
  });

  it('returns null for an amount that is not an integer string', async () => {
    const { result } = renderHook(() => useTopUpStream(7n));
    await flush();
    expect(result.current.projectNewEndTime('1.5')).toBeNull();
  });

  it('refetches the stream after a successful top-up so later projections use the new end time', async () => {
    const { result } = renderHook(() => useTopUpStream(7n));
    await flush();
    expect(mockGet).toHaveBeenCalledTimes(1);

    mockGet.mockResolvedValue(streamWith({ endTime: 6000 }));
    await act(async () => {
      await result.current.topUp('500');
    });

    expect(mockTopUp).toHaveBeenCalledWith(7n, 500n);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.projectNewEndTime('500')?.getTime()).toBe(6005_000));
  });
});
