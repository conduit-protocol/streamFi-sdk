import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  StreamFiProvider,
  useCancelStream,
  useCreateBatchStreams,
  usePauseStream,
  useResumeStream,
  useTopUpStream,
  useWithdrawStream,
} from '../index.js';

const mockWithdraw = vi.fn();
const mockCancel = vi.fn();
const mockPause = vi.fn();
const mockResume = vi.fn();
const mockTopUp = vi.fn();
const mockCreateBatchStreams = vi.fn();

vi.mock('@conduit-protocol/sdk', () => ({
  SUPPORTED_NETWORKS: ['testnet'],
  UnsupportedChainError: class UnsupportedChainError extends Error {},
  clearServerCache: vi.fn(),
  clearTokenDecimalsCache: vi.fn(),
  ConduitClient: vi.fn(function () {
    return {
      streams: {
        get: vi.fn().mockResolvedValue({
          ratePerSecond: 5n,
          startTime: 0,
          endTime: 100,
          withdrawn: 1n,
        }),
        withdraw: mockWithdraw,
        cancel: mockCancel,
        pause: mockPause,
        resume: mockResume,
        topUp: mockTopUp,
        createBatchStreams: mockCreateBatchStreams,
      },
    };
  }),
}));

function LifecycleActions({ tokenBalance }: { tokenBalance?: bigint | string }) {
  const withdraw = useWithdrawStream(7n);
  const cancel = useCancelStream(7n);
  const pause = usePauseStream(7n);
  const resume = useResumeStream(7n);
  const topUp = useTopUpStream(7n, { tokenBalance });

  return (
    <div>
      <button data-testid="withdraw" onClick={() => withdraw.withdraw().catch(() => {})}>withdraw</button>
      <button data-testid="cancel" onClick={() => cancel.cancel().catch(() => {})}>cancel</button>
      <button data-testid="confirm-cancel" onClick={() => cancel.confirmCancel().catch(() => {})}>confirm cancel</button>
      <button data-testid="pause" onClick={() => pause.pause().catch(() => {})}>pause</button>
      <button data-testid="resume" onClick={() => resume.resume().catch(() => {})}>resume</button>
      <button data-testid="top-up" onClick={() => topUp.topUp('25').catch(() => {})}>top up</button>
      <div data-testid="cancel-confirming">{String(cancel.isConfirming)}</div>
      <div data-testid="cancel-settlement">{String(Boolean(cancel.settlement))}</div>
      <div data-testid="withdraw-hash">{withdraw.txHash ?? ''}</div>
      <div data-testid="cancel-hash">{cancel.txHash ?? ''}</div>
      <div data-testid="pause-hash">{pause.txHash ?? ''}</div>
      <div data-testid="resume-hash">{resume.txHash ?? ''}</div>
      <div data-testid="top-up-hash">{topUp.txHash ?? ''}</div>
    </div>
  );
}

describe('stream lifecycle hooks', () => {
  beforeEach(() => {
    mockWithdraw.mockReset().mockResolvedValue('withdraw-tx');
    mockCancel.mockReset().mockResolvedValue('cancel-tx');
    mockPause.mockReset().mockResolvedValue('pause-tx');
    mockResume.mockReset().mockResolvedValue('resume-tx');
    mockTopUp.mockReset().mockResolvedValue('top-up-tx');
    mockCreateBatchStreams.mockReset().mockResolvedValue([
      { index: 0, success: true, streamId: 1n, txHash: 'batch-tx-1' },
      { index: 1, success: true, streamId: 2n, txHash: 'batch-tx-2' },
    ]);
  });

  it('reports batch creation progress through the hook callback', async () => {
    const onProgress = vi.fn();
    const TestComponent = () => {
      const batch = useCreateBatchStreams();
      return (
        <button
          data-testid="batch-create"
          onClick={() => batch.createBatchStreams([{ recipient: 'GRECIPIENT', token: 'native', depositAmount: '10' }], onProgress)}
        >
          create
        </button>
      );
    };

    render(
      <StreamFiProvider config={{ network: 'testnet' as const }}>
        <TestComponent />
      </StreamFiProvider>,
    );

    screen.getByTestId('batch-create').click();

    await waitFor(() => expect(mockCreateBatchStreams).toHaveBeenCalledTimes(1));
    expect(onProgress).toHaveBeenCalledWith(1, 1);
  });

  it('wraps withdraw, cancel, pause, resume, and top up stream actions', async () => {
    render(
      <StreamFiProvider config={{ network: 'testnet' as const }}>
        <LifecycleActions tokenBalance={100n} />
      </StreamFiProvider>,
    );

    await act(async () => {
      screen.getByTestId('withdraw').click();
      screen.getByTestId('cancel').click();
    });

    await waitFor(() => expect(screen.getByTestId('cancel-confirming')).toHaveTextContent('true'));
    await waitFor(() => expect(screen.getByTestId('cancel-settlement')).toHaveTextContent('true'));

    await act(async () => {
      screen.getByTestId('confirm-cancel').click();
      screen.getByTestId('pause').click();
      screen.getByTestId('resume').click();
      screen.getByTestId('top-up').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('withdraw-hash')).toHaveTextContent('withdraw-tx');
      expect(screen.getByTestId('cancel-hash')).toHaveTextContent('cancel-tx');
      expect(screen.getByTestId('pause-hash')).toHaveTextContent('pause-tx');
      expect(screen.getByTestId('resume-hash')).toHaveTextContent('resume-tx');
      expect(screen.getByTestId('top-up-hash')).toHaveTextContent('top-up-tx');
    });

    expect(mockWithdraw).toHaveBeenCalledWith(7n, undefined);
    expect(mockCancel).toHaveBeenCalledWith(7n);
    expect(mockPause).toHaveBeenCalledWith(7n);
    expect(mockResume).toHaveBeenCalledWith(7n);
    expect(mockTopUp).toHaveBeenCalledWith(7n, 25n);
  });

  it('throws before wallet submission when the top-up exceeds the available token balance', async () => {
    render(
      <StreamFiProvider config={{ network: 'testnet' as const }}>
        <LifecycleActions tokenBalance={10n} />
      </StreamFiProvider>,
    );

    screen.getByTestId('top-up').click();

    await waitFor(() => expect(screen.getByTestId('top-up-hash')).toHaveTextContent(''));
    expect(mockTopUp).not.toHaveBeenCalled();
  });
});