import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act, renderHook } from '@testing-library/react';
import { useTokenAllowance } from '../hooks/useTokenAllowance.js';

const mockAllowance = vi.fn();
const mockApprove = vi.fn();
const mockContext = {
  client: {
    tokens: {
      allowance: mockAllowance,
      approve: mockApprove,
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

function TokenAllowance() {
  const state = useTokenAllowance('CTOKEN', 'GOWNER', 'CSPENDER');
  return (
    <div>
      <div data-testid="allowance">{state.allowance?.toString() ?? 'null'}</div>
      <div data-testid="loading">{String(state.loading)}</div>
      <div data-testid="pending">{String(state.isPending)}</div>
      <div data-testid="error">{state.error?.message ?? ''}</div>
      <div data-testid="hash">{state.txHash ?? ''}</div>
      <button onClick={() => void state.approve(250n, 12345).catch(() => {})}>approve</button>
    </div>
  );
}

describe('useTokenAllowance', () => {
  beforeEach(() => {
    mockAllowance.mockReset().mockResolvedValue(100n);
    mockApprove.mockReset().mockResolvedValue('approve-hash');
  });

  it('loads the current allowance', async () => {
    render(<TokenAllowance />);

    await waitFor(() => {
      expect(screen.getByTestId('allowance')).toHaveTextContent('100');
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });
    expect(mockAllowance).toHaveBeenCalledWith('CTOKEN', 'GOWNER', 'CSPENDER');
    expect(screen.getByTestId('error')).toHaveTextContent('');
  });

  it('approves an allowance and exposes the transaction hash', async () => {
    render(<TokenAllowance />);
    await waitFor(() => expect(screen.getByTestId('allowance')).toHaveTextContent('100'));

    fireEvent.click(screen.getByRole('button', { name: 'approve' }));

    await waitFor(() => {
      expect(screen.getByTestId('hash')).toHaveTextContent('approve-hash');
      expect(screen.getByTestId('allowance')).toHaveTextContent('250');
    });
    expect(mockApprove).toHaveBeenCalledWith('CTOKEN', 'GOWNER', 'CSPENDER', 250n, 12345);
    expect(screen.getByTestId('pending')).toHaveTextContent('false');
  });

  it('checks and approves only when the current allowance is insufficient', async () => {
    const { result } = renderHook(() => useTokenAllowance('CTOKEN', 'GOWNER', 'CSPENDER'));

    await waitFor(() => expect(result.current.allowance).toBe(100n));

    await act(async () => {
      const hash = await result.current.checkAndApprove(50n);
      expect(hash).toBeNull();
    });
    expect(mockApprove).not.toHaveBeenCalled();

    await act(async () => {
      const hash = await result.current.checkAndApprove(150n);
      expect(hash).toBe('approve-hash');
    });
    expect(mockApprove).toHaveBeenCalledWith('CTOKEN', 'GOWNER', 'CSPENDER', 150n, 0);
  });

  it('surfaces approval errors', async () => {
    mockApprove.mockRejectedValue(new Error('approval rejected'));
    render(<TokenAllowance />);
    await waitFor(() => expect(screen.getByTestId('allowance')).toHaveTextContent('100'));

    fireEvent.click(screen.getByRole('button', { name: 'approve' }));

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('approval rejected'));
    expect(screen.getByTestId('pending')).toHaveTextContent('false');
    expect(screen.getByTestId('hash')).toHaveTextContent('');
  });

  it('approveInfinite approves i128::MAX with the caller-supplied expiration ledger', async () => {
    const I128_MAX = (1n << 127n) - 1n;
    const { result } = renderHook(() => useTokenAllowance('CTOKEN', 'GOWNER', 'CSPENDER'));
    await waitFor(() => expect(result.current.allowance).toBe(100n));

    await act(async () => {
      await result.current.approveInfinite(4_000_000);
    });

    expect(mockApprove).toHaveBeenCalledWith('CTOKEN', 'GOWNER', 'CSPENDER', I128_MAX, 4_000_000);
    expect(result.current.allowance).toBe(I128_MAX);
    expect(result.current.txHash).toBe('approve-hash');
  });
});
