import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { StreamFiProvider, useStream } from '../index.js';
import type { StreamInfo } from '@conduit-protocol/sdk';

const mockGet = vi.fn();

vi.mock('@conduit-protocol/sdk', () => ({
  ConduitClient: vi.fn(function () {
    return { streams: { get: mockGet } };
  }),
}));

function TestStream({ id }: { id: string }) {
  const { stream, loading, error } = useStream(id);
  if (loading) return <div data-testid="loading">loading</div>;
  if (error) return <div data-testid="error">{error.message}</div>;
  if (!stream) return <div data-testid="empty">no-stream</div>;
  return (
    <div>
      <div data-testid="stream-id">{String(stream.id)}</div>
      <div data-testid="stream-token">{stream.token}</div>
    </div>
  );
}

describe('useStream', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('shows loading then data', async () => {
    const fakeStream: StreamInfo = {
      id: 42n,
      address: 'C...',
      sender: 'G...',
      recipient: 'G...',
      token: 'native',
      ratePerSecond: 100n,
      startTime: 1000,
      endTime: 2000,
      withdrawn: 0n,
      paused: false,
      pausedAt: 0,
      cancelled: false,
      clawbackEnabled: false,
    };
    mockGet.mockResolvedValue(fakeStream);

    const config = { network: 'testnet' as const };
    render(
      <StreamFiProvider config={config}>
        <TestStream id="42" />
      </StreamFiProvider>,
    );

    expect(screen.getByTestId('loading')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('stream-id')).toHaveTextContent('42'));
    expect(screen.getByTestId('stream-token')).toHaveTextContent('native');
  });

  it('shows error on failure', async () => {
    mockGet.mockRejectedValue(new Error('not found'));

    const config = { network: 'testnet' as const };
    render(
      <StreamFiProvider config={config}>
        <TestStream id="99" />
      </StreamFiProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('not found'));
  });
});
