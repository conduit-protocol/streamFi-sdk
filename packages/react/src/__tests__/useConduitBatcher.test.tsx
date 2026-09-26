import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { useConduitBatcher } from '../hooks/useConduitBatcher.js';

const mockExecute = vi.fn();
const mockExecuteAsync = vi.fn();
const mockDestroy = vi.fn();
const mockReset = vi.fn();

vi.mock('@conduit-protocol/sdk', () => ({
  ConduitBatcher: vi.fn(function () {
    return {
      execute: mockExecute,
      executeAsync: mockExecuteAsync,
      destroy: mockDestroy,
      reset: mockReset,
    };
  }),
}));

const ok = { success: true, operations: 1, xdr: 'AAAA', chunks: 1 };

function TestBatcher() {
  const { execute, executeAsync, loading, error, result } = useConduitBatcher({
    context: { sequence: '1' } as never,
  });
  return (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="error">{error?.message ?? ''}</div>
      <div data-testid="result">{result ? String(result.operations) : 'null'}</div>
      <button data-testid="sync" onClick={() => execute([{ recipient: 'G' }])}>
        sync
      </button>
      <button data-testid="async" onClick={() => void executeAsync([{ recipient: 'G' }] as never).catch(() => {})}>
        async
      </button>
    </div>
  );
}

describe('useConduitBatcher', () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockExecuteAsync.mockReset();
    mockDestroy.mockReset();
    mockReset.mockReset();
  });

  it('exposes the batch result from execute', () => {
    mockExecute.mockReturnValue(ok);
    render(<TestBatcher />);

    act(() => screen.getByTestId('sync').click());

    expect(screen.getByTestId('result').textContent).toBe('1');
    expect(screen.getByTestId('error').textContent).toBe('');
    // The default options are merged into each call.
    expect(mockExecute).toHaveBeenCalledWith([{ recipient: 'G' }], { context: { sequence: '1' } });
  });

  it('turns a failed batch into an error while keeping the result', () => {
    mockExecute.mockReturnValue({ success: false, operations: 0, xdr: '', errors: ['bad payload'] });
    render(<TestBatcher />);

    act(() => screen.getByTestId('sync').click());

    expect(screen.getByTestId('error').textContent).toBe('bad payload');
    expect(screen.getByTestId('result').textContent).toBe('0');
  });

  it('tracks loading around executeAsync', async () => {
    let resolve!: (value: unknown) => void;
    mockExecuteAsync.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<TestBatcher />);

    act(() => screen.getByTestId('async').click());
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('true'));

    await act(async () => resolve(ok));
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('result').textContent).toBe('1');
  });

  it('destroys the batcher on unmount', () => {
    const { unmount } = render(<TestBatcher />);
    expect(mockDestroy).not.toHaveBeenCalled();

    unmount();

    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });
});
