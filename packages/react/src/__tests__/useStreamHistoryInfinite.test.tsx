import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StreamFiProvider, useStreamHistoryInfinite } from '../index.js';

const mockGetHistory = vi.fn();

vi.mock('@conduit-protocol/sdk', () => ({
  SUPPORTED_NETWORKS: ['testnet', 'mainnet', 'local'],
  UnsupportedChainError: class extends Error {},
  InsufficientBalanceError: class extends Error {
    constructor(currentBalance: bigint, requiredBalance: bigint, detail?: string) {
      super(detail ?? `Insufficient balance: ${currentBalance} < ${requiredBalance}`);
      this.name = 'InsufficientBalanceError';
      this.currentBalance = currentBalance;
      this.requiredBalance = requiredBalance;
    }
    currentBalance: bigint;
    requiredBalance: bigint;
  },
  clearServerCache: vi.fn(),
  clearTokenDecimalsCache: vi.fn(),
  ConduitClient: vi.fn(function () {
    return { streams: { getHistory: mockGetHistory } };
  }),
}));

const entry = (id: string, kind = 'withdraw') => ({ id, kind, ledger: 1, timestamp: '', txHash: id, event: {} });

function History({
  id,
  pageSize,
  direction,
  startLedger,
  filterEventTypes,
}: {
  id: string | undefined;
  pageSize?: number;
  direction?: 'forward' | 'backward';
  startLedger?: number;
  filterEventTypes?: ('Deposit' | 'Withdraw' | 'Cancel')[];
}) {
  const h = useStreamHistoryInfinite(id, pageSize, { direction, startLedger, filterEventTypes });
  if (h.error) return <div data-testid="error">{h.error.message}</div>;
  return (
    <div>
      <div data-testid="loading">{String(h.isLoading)}</div>
      <div data-testid="ids">{h.entries.map((e) => e.id).join(',')}</div>
      <div data-testid="more">{String(h.hasNextPage)}</div>
      <button onClick={() => void h.fetchNextPage()}>more</button>
    </div>
  );
}

function renderHistory(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StreamFiProvider config={{ network: 'testnet' as const }}>{ui}</StreamFiProvider>
    </QueryClientProvider>,
  );
}

describe('useStreamHistoryInfinite', () => {
  beforeEach(() => {
    mockGetHistory.mockReset();
  });

  it('loads the first page and appends further pages via the cursor', async () => {
    mockGetHistory
      .mockResolvedValueOnce({ entries: [entry('a'), entry('b')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ entries: [entry('c')], nextCursor: undefined });

    renderHistory(<History id="7" pageSize={2} />);

    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('a,b'));
    expect(screen.getByTestId('more')).toHaveTextContent('true');
    expect(mockGetHistory).toHaveBeenNthCalledWith(1, '7', { limit: 2 });

    fireEvent.click(screen.getByText('more'));

    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('a,b,c'));
    expect(mockGetHistory).toHaveBeenNthCalledWith(2, '7', { limit: 2, cursor: 'c1' });
    expect(screen.getByTestId('more')).toHaveTextContent('false');
  });

  it('supports forward pagination from the earliest ledger', async () => {
    mockGetHistory
      .mockResolvedValueOnce({ entries: [entry('a'), entry('b')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ entries: [entry('c')], nextCursor: undefined });

    renderHistory(<History id="7" pageSize={2} direction="forward" startLedger={100} />);

    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('a,b'));
    expect(mockGetHistory).toHaveBeenNthCalledWith(1, '7', { limit: 2, startLedger: 100 });

    fireEvent.click(screen.getByText('more'));

    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('a,b,c'));
    expect(mockGetHistory).toHaveBeenNthCalledWith(2, '7', { limit: 2, cursor: 'c1' });
  });

  it('does not fetch until a stream id is provided', async () => {
    renderHistory(<History id={undefined} />);
    await waitFor(() => expect(screen.getByTestId('ids')).toBeInTheDocument());
    expect(mockGetHistory).not.toHaveBeenCalled();
  });

  it('surfaces errors', async () => {
    mockGetHistory.mockRejectedValue(new Error('rpc down'));
    renderHistory(<History id="7" />);
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('rpc down'));
  });

  it('filters loaded entries by event type and keeps the requested page size', async () => {
    mockGetHistory.mockResolvedValueOnce({
      entries: [entry('a', 'withdraw'), entry('b', 'top_up'), entry('c', 'created'), entry('d', 'cancel')],
      nextCursor: undefined,
    });

    renderHistory(<History id="7" filterEventTypes={['Deposit', 'Cancel']} />);

    // 'Deposit' covers created and top_up; 'Cancel' covers cancel; withdrawals are dropped.
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('b,c,d'));
    expect(mockGetHistory).toHaveBeenCalledWith('7', { limit: 50 });
  });
});
