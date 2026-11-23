import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useCreateStream } from '../hooks/useCreateStream.js';

const mockCreate = vi.fn();
const mockEstimateFee = vi.fn();
// Stable reference so `createStream`'s useCallback deps don't churn every render.
const mockClient: { streams: { create: typeof mockCreate }; estimateFee?: typeof mockEstimateFee } = {
  streams: { create: mockCreate },
};

vi.mock('../context/useStreamFiClient.js', () => ({
  useStreamFiClient: () => ({ client: mockClient, isReady: true }),
}));

const CREATE_PARAMS = {
  recipient: 'G...',
  token: 'native',
  depositAmount: '1000',
  durationSeconds: 86400,
};

function TestCreate() {
  const { createStream, loading, error, result, simulationResult, estimatedFee } = useCreateStream();

  return (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="error">{error?.message ?? ''}</div>
      <div data-testid="result">{result ? String(result.streamId) : 'null'}</div>
      <div data-testid="estimated-fee">{estimatedFee === null ? 'null' : String(estimatedFee)}</div>
      <div data-testid="simulation-result">{simulationResult === null ? 'null' : String(simulationResult.totalFee)}</div>
      <button data-testid="create-btn" onClick={() => { createStream(CREATE_PARAMS).catch(() => {}); }}>
        create
      </button>
    </div>
  );
}

describe('useCreateStream fee estimation (#931)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockEstimateFee.mockReset();
    delete mockClient.estimateFee;
  });

  it('exposes simulationResult and estimatedFee from the dry-run simulation before create resolves', async () => {
    mockClient.estimateFee = mockEstimateFee;
    mockEstimateFee.mockResolvedValue({ totalFee: 12345n, resourceFee: 12000n, baseFee: 345n, instructions: 999n });
    mockCreate.mockResolvedValue({ streamId: 1n, streamAddress: 'C...', txHash: '0x...' });

    render(<TestCreate />);
    screen.getByTestId('create-btn').click();

    await waitFor(() => expect(screen.getByTestId('estimated-fee')).toHaveTextContent('12345'));
    expect(screen.getByTestId('simulation-result')).toHaveTextContent('12345');
    expect(mockEstimateFee).toHaveBeenCalledWith({ type: 'create', params: CREATE_PARAMS });

    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('1'));
  });

  it('does not block creation when the dry-run estimate fails', async () => {
    mockClient.estimateFee = mockEstimateFee;
    mockEstimateFee.mockRejectedValue(new Error('simulation failed'));
    mockCreate.mockResolvedValue({ streamId: 2n, streamAddress: 'C...', txHash: '0x...' });

    render(<TestCreate />);
    screen.getByTestId('create-btn').click();

    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('2'));
    expect(screen.getByTestId('error')).toHaveTextContent('');
    expect(screen.getByTestId('estimated-fee')).toHaveTextContent('null');
  });

  it('skips estimation entirely when the client does not support estimateFee', async () => {
    mockCreate.mockResolvedValue({ streamId: 3n, streamAddress: 'C...', txHash: '0x...' });

    render(<TestCreate />);
    screen.getByTestId('create-btn').click();

    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('3'));
    expect(mockEstimateFee).not.toHaveBeenCalled();
    expect(screen.getByTestId('estimated-fee')).toHaveTextContent('null');
  });
});
