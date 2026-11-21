import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { StreamFiProvider, useClawbackStreamMutation } from '../index.js';

const mockClawback = vi.fn();

vi.mock('@conduit-protocol/sdk', () => ({
  ConduitClient: vi.fn(function () {
    return { streams: { clawback: mockClawback } };
  }),
}));

const onError = vi.fn();
const onSuccess = vi.fn();

function Probe() {
  const m = useClawbackStreamMutation(7n, { onMutate: () => 'snapshot', onError, onSuccess });
  return (
    <div>
      <button data-testid="go" onClick={() => m.mutate().catch(() => {})}>go</button>
      <div data-testid="status">{m.status}</div>
      <div data-testid="clawed">{String(m.isClawedBack)}</div>
      <div data-testid="amount">{m.reclaimedAmount?.toString() ?? ''}</div>
      <div data-testid="error">{m.error?.message ?? ''}</div>
    </div>
  );
}

function renderProbe() {
  return render(
    <StreamFiProvider config={{ network: 'testnet' } as never}>
      <Probe />
    </StreamFiProvider>,
  );
}

describe('useClawbackStreamMutation', () => {
  beforeEach(() => {
    mockClawback.mockReset();
    onError.mockReset();
    onSuccess.mockReset();
  });

  it('flips to clawed_back optimistically before the transaction settles', async () => {
    let resolve!: (v: bigint) => void;
    mockClawback.mockReturnValue(new Promise<bigint>((r) => { resolve = r; }));
    renderProbe();
    await act(async () => { screen.getByTestId('go').click(); });
    expect(screen.getByTestId('status').textContent).toBe('clawed_back');
    await act(async () => { resolve(50n); });
    await waitFor(() => expect(screen.getByTestId('amount').textContent).toBe('50'));
    expect(onSuccess).toHaveBeenCalledWith(50n, 7n, 'snapshot');
  });

  it('rolls back and reports the error on failure', async () => {
    mockClawback.mockRejectedValue(new Error('rejected'));
    renderProbe();
    await act(async () => { screen.getByTestId('go').click(); });
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('rejected'));
    expect(screen.getByTestId('clawed').textContent).toBe('false');
    expect(screen.getByTestId('status').textContent).toBe('error');
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 7n, 'snapshot');
  });
});
