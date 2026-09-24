import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  StreamFiProvider,
  useCancelStream,
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

vi.mock('@conduit-protocol/sdk', () => ({
  ConduitClient: vi.fn(function () {
    return {
      streams: {
        withdraw: mockWithdraw,
        cancel: mockCancel,
        pause: mockPause,
        resume: mockResume,
        topUp: mockTopUp,
      },
    };
  }),
}));

function LifecycleActions() {
  const withdraw = useWithdrawStream(7n);
  const cancel = useCancelStream(7n);
  const pause = usePauseStream(7n);
  const resume = useResumeStream(7n);
  const topUp = useTopUpStream(7n);

  return (
    <div>
      <button data-testid="withdraw" onClick={() => withdraw.withdraw().catch(() => {})}>withdraw</button>
      <button data-testid="cancel" onClick={() => cancel.cancel().catch(() => {})}>cancel</button>
      <button data-testid="pause" onClick={() => pause.pause().catch(() => {})}>pause</button>
      <button data-testid="resume" onClick={() => resume.resume().catch(() => {})}>resume</button>
      <button data-testid="top-up" onClick={() => topUp.topUp('25').catch(() => {})}>top up</button>
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
  });

  it('wraps withdraw, cancel, pause, resume, and top up stream actions', async () => {
    render(
      <StreamFiProvider config={{ network: 'testnet' as const }}>
        <LifecycleActions />
      </StreamFiProvider>,
    );

    screen.getByTestId('withdraw').click();
    screen.getByTestId('cancel').click();
    screen.getByTestId('pause').click();
    screen.getByTestId('resume').click();
    screen.getByTestId('top-up').click();

    await waitFor(() => expect(screen.getByTestId('withdraw-hash')).toHaveTextContent('withdraw-tx'));
    expect(screen.getByTestId('cancel-hash')).toHaveTextContent('cancel-tx');
    expect(screen.getByTestId('pause-hash')).toHaveTextContent('pause-tx');
    expect(screen.getByTestId('resume-hash')).toHaveTextContent('resume-tx');
    expect(screen.getByTestId('top-up-hash')).toHaveTextContent('top-up-tx');

    expect(mockWithdraw).toHaveBeenCalledWith(7n, undefined);
    expect(mockCancel).toHaveBeenCalledWith(7n);
    expect(mockPause).toHaveBeenCalledWith(7n);
    expect(mockResume).toHaveBeenCalledWith(7n);
    expect(mockTopUp).toHaveBeenCalledWith(7n, 25n);
  });
});