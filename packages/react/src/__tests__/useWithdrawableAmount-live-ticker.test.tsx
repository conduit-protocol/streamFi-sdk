import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useWithdrawableAmount } from '../hooks/useWithdrawableAmount.js';

const mockWithdrawable = vi.fn();
// Stable reference: `fetch`'s useCallback deps include `client`, so a fresh
// object literal on every call would retrigger the mount effect each render.
const mockClient = { streams: { withdrawable: mockWithdrawable } };

// Mocked directly (bypassing StreamFiProvider) so this test isn't coupled to
// the provider's unrelated setup/teardown behaviour.
vi.mock('../context/useStreamFiClient.js', () => ({
  useStreamFiClient: () => ({
    client: mockClient,
    isReady: true,
  }),
}));

let latestResult: ReturnType<typeof useWithdrawableAmount> | undefined;

function Probe() {
  latestResult = useWithdrawableAmount('1', { intervalMs: 1000 });
  return null;
}

describe('useWithdrawableAmount live ticker (#930)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWithdrawable.mockReset();
    latestResult = undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('estimates ratePerSecond from two consecutive polls', async () => {
    mockWithdrawable.mockResolvedValueOnce(0n).mockResolvedValueOnce(1000n);

    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latestResult?.ratePerSecond).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(latestResult?.ratePerSecond).toBe(1000n);
  });

  it('keeps the previous rate estimate when a withdrawal elsewhere makes the delta negative', async () => {
    mockWithdrawable
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(1000n)
      .mockResolvedValueOnce(200n);

    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(latestResult?.ratePerSecond).toBe(1000n);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(latestResult?.amount).toBe(200n);
    expect(latestResult?.ratePerSecond).toBe(1000n);
  });

  it('ticks the displayed amount upward locally between polls using the estimated rate', async () => {
    mockWithdrawable.mockResolvedValueOnce(0n).mockResolvedValueOnce(1000n);

    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(latestResult?.amount).toBe(1000n);
    expect(latestResult?.ratePerSecond).toBe(1000n);

    // No third poll is queued (mockWithdrawable has only two resolved values),
    // so any further increase in `amount` before the next poll settles must
    // come from the local live ticker interpolating with the estimated rate.
    mockWithdrawable.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(latestResult?.amount).toBeGreaterThan(1000n);
  });

  it('never ticks the displayed amount backward', async () => {
    mockWithdrawable.mockResolvedValueOnce(0n).mockResolvedValueOnce(1000n);
    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    mockWithdrawable.mockImplementation(() => new Promise(() => {}));
    const before = latestResult?.amount;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(latestResult?.amount).toBeGreaterThanOrEqual(before ?? 0n);
  });
});
