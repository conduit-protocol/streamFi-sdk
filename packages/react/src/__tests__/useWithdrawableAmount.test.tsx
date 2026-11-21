import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { StreamFiProvider, useWithdrawableAmount } from '../index.js';

const mockWithdrawable = vi.fn();

vi.mock('@conduit-protocol/sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ConduitClient: vi.fn(function () {
    return { streams: { withdrawable: mockWithdrawable } };
  }),
}));

function Probe({ intervalMs }: { intervalMs?: number }) {
  useWithdrawableAmount('1', intervalMs === undefined ? {} : { intervalMs });
  return null;
}

function setHidden(value: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useWithdrawableAmount polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockWithdrawable.mockReset().mockResolvedValue(5n);
  });
  afterEach(() => {
    setHidden(false);
    vi.useRealTimers();
  });

  const mount = (intervalMs?: number) =>
    render(
      <StreamFiProvider config={{ network: 'testnet' as const }}>
        <Probe intervalMs={intervalMs} />
      </StreamFiProvider>,
    );

  it('polls at the configured interval and pauses while hidden', async () => {
    mount(100);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    const polled = mockWithdrawable.mock.calls.length;
    expect(polled).toBeGreaterThanOrEqual(4);

    await act(async () => { setHidden(true); await vi.advanceTimersByTimeAsync(1000); });
    expect(mockWithdrawable).toHaveBeenCalledTimes(polled);

    await act(async () => { setHidden(false); });
    expect(mockWithdrawable).toHaveBeenCalledTimes(polled + 1);
  });

  it('defaults to 1000ms and disables polling when intervalMs is 0', async () => {
    const { unmount } = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(mockWithdrawable).toHaveBeenCalledTimes(3);
    unmount();

    mockWithdrawable.mockClear();
    mount(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(mockWithdrawable).toHaveBeenCalledTimes(1);
  });
});
