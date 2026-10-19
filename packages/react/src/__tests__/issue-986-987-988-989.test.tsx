import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { StreamInfo } from '@conduit-protocol/sdk';
import {
  StreamFiProvider,
  useCancelStream,
  useCreateBatchStreams,
  usePauseStream,
  useResumeStream,
} from '../index.js';

const mockGet = vi.fn();
const mockPause = vi.fn();
const mockResume = vi.fn();
const mockCancel = vi.fn();
const mockCreateBatchStreams = vi.fn();

vi.mock('@conduit-protocol/sdk', () => ({
  SUPPORTED_NETWORKS: ['testnet'],
  UnsupportedChainError: class UnsupportedChainError extends Error {},
  clearServerCache: vi.fn(),
  clearTokenDecimalsCache: vi.fn(),
  // Stand-in for the SDK's toStroops (7 decimals) so the batch cost sum can be asserted exactly.
  toStroops: (amount: string) => BigInt(Math.round(Number(amount) * 1e7)),
  ConduitClient: vi.fn(function () {
    return {
      streams: {
        get: mockGet,
        pause: mockPause,
        resume: mockResume,
        cancel: mockCancel,
        createBatchStreams: mockCreateBatchStreams,
      },
    };
  }),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <StreamFiProvider config={{ network: 'testnet' as const }}>{children}</StreamFiProvider>
);

function makeStream(overrides: Partial<StreamInfo> = {}): StreamInfo {
  return {
    id: 7n,
    address: 'CSTREAM',
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    token: 'native',
    ratePerSecond: 5n,
    startTime: 0,
    endTime: 0,
    withdrawn: 0n,
    paused: false,
    pausedAt: 0,
    cancelled: false,
    clawbackEnabled: false,
    ...overrides,
  };
}

/** Lets the hook's initial `streams.get` resolve and commit its state. */
const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

beforeEach(() => {
  mockGet.mockReset();
  mockPause.mockReset().mockResolvedValue('pause-tx');
  mockResume.mockReset().mockResolvedValue('resume-tx');
  mockCancel.mockReset().mockResolvedValue('cancel-tx');
  mockCreateBatchStreams.mockReset().mockResolvedValue([]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #986: useCreateBatchStreams - estimateTotalBatchCost helper
// ═══════════════════════════════════════════════════════════════════════════════

describe('Issue #986 - useCreateBatchStreams.estimateTotalBatchCost', () => {
  it('sums deposit amounts across all configs in stroops', () => {
    const { result } = renderHook(() => useCreateBatchStreams(), { wrapper });

    const total = result.current.estimateTotalBatchCost([
      { recipient: 'GALICE', token: 'native', depositAmount: '10' },
      { recipient: 'GBOB', token: 'native', depositAmount: '2.5' },
    ]);

    expect(total).toBe(125_000_000n);
  });

  it('handles fractional deposit amounts', () => {
    const { result } = renderHook(() => useCreateBatchStreams(), { wrapper });

    expect(result.current.estimateTotalBatchCost([
      { recipient: 'GALICE', token: 'native', depositAmount: '0.5' },
      { recipient: 'GBOB', token: 'native', depositAmount: '1' },
    ])).toBe(15_000_000n);
  });

  it('returns 0n for an empty batch', () => {
    const { result } = renderHook(() => useCreateBatchStreams(), { wrapper });

    expect(result.current.estimateTotalBatchCost([])).toBe(0n);
  });

  it('does not contact the network or change hook state', async () => {
    const { result } = renderHook(() => useCreateBatchStreams(), { wrapper });

    result.current.estimateTotalBatchCost([{ recipient: 'GALICE', token: 'native', depositAmount: '1' }]);

    expect(mockCreateBatchStreams).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.results).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #987: useCancelStream - return estimated refund amount in cancel simulation
// ═══════════════════════════════════════════════════════════════════════════════

describe('Issue #987 - useCancelStream.estimatedRefund', () => {
  it('is null until the stream has loaded', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useCancelStream(7n), { wrapper });

    expect(result.current.estimatedRefund).toBeNull();
  });

  it('equals the unstreamed balance for a stream that has not started yet', async () => {
    // Start is in the future, so nothing has accrued: the full deposit (rate × duration) is refundable.
    const now = Math.floor(Date.now() / 1000);
    mockGet.mockResolvedValue(makeStream({ ratePerSecond: 5n, startTime: now + 1000, endTime: now + 1100 }));
    const { result } = renderHook(() => useCancelStream(7n), { wrapper });

    await waitFor(() => expect(result.current.estimatedRefund).toBe(500n));
  });

  it('reflects accrued time: refund is total minus what has already streamed', async () => {
    const start = 1_700_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue((start + 50) * 1000);
    try {
      // 100s deposit at 5 stroops/s = 500 total; 50s elapsed accrued 250, so 250 is refundable.
      mockGet.mockResolvedValue(makeStream({ ratePerSecond: 5n, startTime: start, endTime: start + 100 }));
      const { result } = renderHook(() => useCancelStream(7n), { wrapper });

      await waitFor(() => expect(result.current.estimatedRefund).toBe(250n));
    } finally {
      now.mockRestore();
    }
  });

  it('is 0n once the stream has fully ended', async () => {
    const start = 1_700_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue((start + 200) * 1000);
    try {
      mockGet.mockResolvedValue(makeStream({ ratePerSecond: 5n, startTime: start, endTime: start + 100 }));
      const { result } = renderHook(() => useCancelStream(7n), { wrapper });

      await waitFor(() => expect(result.current.estimatedRefund).toBe(0n));
    } finally {
      now.mockRestore();
    }
  });

  it('is null for open-ended streams because the funded balance is unknown', async () => {
    mockGet.mockResolvedValue(makeStream({ endTime: 0 }));
    const { result } = renderHook(() => useCancelStream(7n), { wrapper });

    await flush();

    expect(mockGet).toHaveBeenCalledWith(7n);
    expect(result.current.estimatedRefund).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #988: usePauseStream - add isPausing state indicator
// ═══════════════════════════════════════════════════════════════════════════════

describe('Issue #988 - usePauseStream.isPausing', () => {
  it('is true only while the pause transaction is in flight', async () => {
    let resolvePause!: (hash: string) => void;
    mockPause.mockReturnValue(new Promise<string>((resolve) => { resolvePause = resolve; }));
    mockGet.mockResolvedValue(makeStream());
    const { result } = renderHook(() => usePauseStream(7n), { wrapper });
    await flush();

    expect(result.current.isPausing).toBe(false);

    let pending: Promise<string> | undefined;
    act(() => {
      pending = result.current.pause();
    });
    await waitFor(() => expect(result.current.isPausing).toBe(true));

    await act(async () => {
      resolvePause('pause-tx');
      await pending;
    });

    expect(result.current.isPausing).toBe(false);
    expect(result.current.txHash).toBe('pause-tx');
  });

  it('resets isPausing when the pause transaction fails', async () => {
    mockPause.mockRejectedValue(new Error('rejected by wallet'));
    mockGet.mockResolvedValue(makeStream());
    const { result } = renderHook(() => usePauseStream(7n), { wrapper });
    await flush();

    await act(async () => {
      await result.current.pause().catch(() => {});
    });

    expect(result.current.isPausing).toBe(false);
    expect(result.current.error?.message).toBe('rejected by wallet');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Issue #989: useResumeStream - validate stream is Paused before submitting
// ═══════════════════════════════════════════════════════════════════════════════

describe('Issue #989 - useResumeStream pre-submit validation', () => {
  it('rejects resume on an active stream without submitting a transaction', async () => {
    mockGet.mockResolvedValue(makeStream({ paused: false }));
    const { result } = renderHook(() => useResumeStream(7n), { wrapper });
    await flush();

    await expect(result.current.resume()).rejects.toThrow(/not paused/i);
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('rejects resume on a cancelled stream even if its paused flag is set', async () => {
    mockGet.mockResolvedValue(makeStream({ paused: true, cancelled: true }));
    const { result } = renderHook(() => useResumeStream(7n), { wrapper });
    await flush();

    await expect(result.current.resume()).rejects.toThrow(/not paused/i);
    expect(mockResume).not.toHaveBeenCalled();
  });

  it('submits resume when the stream is paused', async () => {
    mockGet.mockResolvedValue(makeStream({ paused: true, pausedAt: 1_700_000_000 }));
    const { result } = renderHook(() => useResumeStream(7n), { wrapper });
    await flush();

    await act(async () => {
      await result.current.resume();
    });

    expect(mockResume).toHaveBeenCalledWith(7n);
    expect(result.current.txHash).toBe('resume-tx');
  });

  it('still submits resume when the stream has not loaded, since its state cannot be known', async () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useResumeStream(7n), { wrapper });

    await act(async () => {
      await result.current.resume();
    });

    expect(mockResume).toHaveBeenCalledWith(7n);
  });
});
