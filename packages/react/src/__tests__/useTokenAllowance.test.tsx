import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('surfaces approval errors', async () => {
    mockApprove.mockRejectedValue(new Error('approval rejected'));
    render(<TokenAllowance />);
    await waitFor(() => expect(screen.getByTestId('allowance')).toHaveTextContent('100'));

    fireEvent.click(screen.getByRole('button', { name: 'approve' }));

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('approval rejected'));
    expect(screen.getByTestId('pending')).toHaveTextContent('false');
    expect(screen.getByTestId('hash')).toHaveTextContent('');
  });
});
