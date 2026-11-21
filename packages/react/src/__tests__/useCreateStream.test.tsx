import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { StreamFiProvider, useCreateStream } from '../index.js';

const mockCreate = vi.fn();

vi.mock('@conduit-protocol/sdk', () => ({
  ConduitClient: vi.fn(function () {
    return { streams: { create: mockCreate } };
  }),
}));

function TestCreate() {
  const { createStream, loading, error, result } = useCreateStream();

  return (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="error">{error?.message ?? ''}</div>
      <div data-testid="result">{result ? String(result.streamId) : 'null'}</div>
      <button
        data-testid="create-btn"
        onClick={() => {
          createStream({
            recipient: 'G...',
            token: 'native',
            depositAmount: '1000',
            durationSeconds: 86400,
          }).catch(() => {});
        }}
      >
        create
      </button>
    </div>
  );
}

describe('useCreateStream', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('creates a stream successfully', async () => {
    mockCreate.mockResolvedValue({ streamId: 1n, streamAddress: 'C...', txHash: '0x...' });

    const config = { network: 'testnet' as const };
    render(
      <StreamFiProvider config={config}>
        <TestCreate />
      </StreamFiProvider>,
    );

    screen.getByTestId('create-btn').click();

    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('1'));
    expect(screen.getByTestId('error')).toHaveTextContent('');
  });

  it('handles creation error', async () => {
    mockCreate.mockRejectedValue(new Error('insufficient balance'));

    const config = { network: 'testnet' as const };
    render(
      <StreamFiProvider config={config}>
        <TestCreate />
      </StreamFiProvider>,
    );

    screen.getByTestId('create-btn').click();

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('insufficient balance'));
    expect(screen.getByTestId('result')).toHaveTextContent('null');
  });
});
