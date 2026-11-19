import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { Keypair } from '@stellar/stellar-sdk';
import {
  ConduitClient,
  ConduitProvider,
  useConduitClient,
  useTransferRecipient,
  useFeeEstimate,
  useBatchWithdraw,
  useStreamBalance,
} from '../index.js';
import type { StreamOperation } from '../types/index.js';

function createMockClient() {
  const client = new ConduitClient({
    network: 'testnet',
    factoryAddress: 'CFACTORYPLACEHOLDER',
    keypair: Keypair.random(),
  });
  return client;
}

describe('React Hooks & Context', () => {
  let client: ConduitClient;

  beforeEach(() => {
    client = createMockClient();
  });

  describe('ConduitProvider & useConduitClient', () => {
    it('throws when used outside provider without custom client', () => {
      expect(() => renderHook(() => useConduitClient())).toThrow(
        /ConduitClient not found/,
      );
    });

    it('returns client from provider', () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );
      const { result } = renderHook(() => useConduitClient(), { wrapper });
      expect(result.current).toBe(client);
    });

    it('custom client parameter overrides context client', () => {
      const customClient = createMockClient();
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );
      const { result } = renderHook(() => useConduitClient(customClient), { wrapper });
      expect(result.current).toBe(customClient);
    });
  });

  describe('useTransferRecipient', () => {
    it('successfully transfers recipient and updates state', async () => {
      const spy = vi
        .spyOn(client.streams, 'transferRecipient')
        .mockResolvedValue('tx-hash-transfer-123');

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );

      const { result } = renderHook(() => useTransferRecipient(10n), { wrapper });

      expect(result.current.isPending).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.txHash).toBeNull();

      let txHash: string = '';
      await act(async () => {
        txHash = await result.current.transferRecipient('GNEWRECIPIENT123');
      });

      expect(spy).toHaveBeenCalledWith(10n, 'GNEWRECIPIENT123');
      expect(txHash).toBe('tx-hash-transfer-123');
      expect(result.current.txHash).toBe('tx-hash-transfer-123');
      expect(result.current.isPending).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('supports overrideStreamId parameter at call time', async () => {
      const spy = vi
        .spyOn(client.streams, 'transferRecipient')
        .mockResolvedValue('tx-hash-override');

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );

      const { result } = renderHook(() => useTransferRecipient(10n), { wrapper });

      await act(async () => {
        await result.current.transferRecipient('GNEWRECIPIENT123', 99n);
      });

      expect(spy).toHaveBeenCalledWith(99n, 'GNEWRECIPIENT123');
      expect(result.current.txHash).toBe('tx-hash-override');
    });

    it('throws error when no streamId is provided', async () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );

      const { result } = renderHook(() => useTransferRecipient(), { wrapper });

      await expect(
        act(async () => {
          await result.current.transferRecipient('GNEWRECIPIENT123');
        }),
      ).rejects.toThrow(/streamId is required/);
    });

    it('handles and surfaces transfer error', async () => {
      vi.spyOn(client.streams, 'transferRecipient').mockRejectedValue(
        new Error('NotAuthorized'),
      );

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );

      const { result } = renderHook(() => useTransferRecipient(5n), { wrapper });

      await act(async () => {
        try {
          await result.current.transferRecipient('GNEWRECIPIENT123');
        } catch {
          // Expected error
        }
      });

      expect(result.current.isPending).toBe(false);
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe('NotAuthorized');
    });
  });

  describe('useFeeEstimate', () => {
    it('fetches fee estimate for string operation shapes ("create", "withdraw", etc.)', async () => {
      const spy = vi
        .spyOn(client.streams, 'estimateFee')
        .mockImplementation(async (op) => (op === 'create' ? 500 : 100));

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );

      const { result, rerender } = renderHook(
        ({ op }: { op: StreamOperation }) => useFeeEstimate(op),
        {
          wrapper,
          initialProps: { op: 'create' },
        },
      );

      // Wait for initial fetch
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(spy).toHaveBeenCalledWith('create');
      expect(result.current.estimate).toBe(500);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();

      // Rerender with 'withdraw' operation shape
      rerender({ op: 'withdraw' });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(spy).toHaveBeenCalledWith('withdraw');
      expect(result.current.estimate).toBe(100);
    });

    it('works for every StreamOperation variant supported (object shapes: create, withdraw, cancel, pause, resume, topUp, transferRecipient, batchWithdraw)', async () => {
      const spy = vi
        .spyOn(client.streams, 'estimateFee')
        .mockImplementation(async (op) => {
          const type = typeof op === 'string' ? op : op?.type;
          if (type === 'create') return 500;
          if (type === 'batchWithdraw') return 300;
          return 100;
        });

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );

      const operations: StreamOperation[] = [
        { type: 'create', params: { recipient: 'G1', token: 'native', depositAmount: '100' } },
        { type: 'withdraw', streamId: 1n, amount: 50n },
        { type: 'cancel', streamId: 2n },
        { type: 'pause', streamId: 3n },
        { type: 'resume', streamId: 4n },
        { type: 'topUp', streamId: 5n, amount: 10n },
        { type: 'transferRecipient', streamId: 6n, newRecipient: 'G2' },
        { type: 'batchWithdraw', items: [{ streamId: 7n }, { streamId: 8n }, { streamId: 9n }] },
      ];

      for (const op of operations) {
        const { result } = renderHook(() => useFeeEstimate(op), { wrapper });
        await act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
        expect(result.current.isLoading).toBe(false);
        expect(result.current.error).toBeNull();
        expect(result.current.estimate).toBeGreaterThan(0);
      }

      expect(spy).toHaveBeenCalledTimes(operations.length);
    });

    it('handles estimation errors cleanly', async () => {
      vi.spyOn(client.streams, 'estimateFee').mockRejectedValue(
        new Error('Fee estimation failed'),
      );

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );

      const { result } = renderHook(() => useFeeEstimate('create'), { wrapper });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.estimate).toBeNull();
      expect(result.current.error?.message).toBe('Fee estimation failed');
    });

    it('returns null estimate when operation is null or enabled is false', async () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );

      const { result } = renderHook(
        () => useFeeEstimate('create', { enabled: false }),
        { wrapper },
      );

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(result.current.estimate).toBeNull();
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('useBatchWithdraw', () => {
    it('surfaces partial failures in results array without collapsing into a single boolean', async () => {
      vi.spyOn(client.streams, 'batchWithdraw').mockResolvedValue([
        { streamId: 1n, success: true, txHash: 'hash-success-1' },
        { streamId: 2n, success: false, error: 'StreamNotFound' },
        { streamId: 3n, success: true, txHash: 'hash-success-3' },
      ]);

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );

      const { result } = renderHook(() => useBatchWithdraw(), { wrapper });

      expect(result.current.isPending).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.results).toEqual([]);

      let batchResults: unknown;
      await act(async () => {
        batchResults = await result.current.batchWithdraw([
          { streamId: 1n },
          { streamId: 2n },
          { streamId: 3n },
        ]);
      });

      expect(batchResults).toEqual([
        { streamId: 1n, success: true, txHash: 'hash-success-1' },
        { streamId: 2n, success: false, error: 'StreamNotFound' },
        { streamId: 3n, success: true, txHash: 'hash-success-3' },
      ]);

      expect(result.current.results).toEqual([
        { streamId: 1n, success: true, txHash: 'hash-success-1' },
        { streamId: 2n, success: false, error: 'StreamNotFound' },
        { streamId: 3n, success: true, txHash: 'hash-success-3' },
      ]);

      // Assert partial failures are surfaced in the per-item results
      expect(result.current.results[1]?.success).toBe(false);
      expect(result.current.results[1]?.error).toBe('StreamNotFound');
      expect(result.current.results[0]?.success).toBe(true);
      expect(result.current.isPending).toBe(false);
    });

    it('handles top-level execution errors (e.g. missing wallet/signer)', async () => {
      vi.spyOn(client.streams, 'batchWithdraw').mockRejectedValue(
        new Error('keypair, wallet adapter, or signer is required'),
      );

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );

      const { result } = renderHook(() => useBatchWithdraw(), { wrapper });

      await act(async () => {
        try {
          await result.current.batchWithdraw([{ streamId: 1n }]);
        } catch {
          // Expected error
        }
      });

      expect(result.current.isPending).toBe(false);
      expect(result.current.error?.message).toMatch(/keypair, wallet adapter, or signer/);
    });
  });

  describe('useStreamBalance', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('polls stream balance periodically and clears interval on unmount', async () => {
      const spy = vi
        .spyOn(client.streams, 'withdrawable')
        .mockResolvedValueOnce(100n)
        .mockResolvedValueOnce(200n)
        .mockResolvedValueOnce(300n);

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );

      const { result, unmount } = renderHook(
        () => useStreamBalance(42n, { intervalMs: 1000 }),
        { wrapper },
      );

      // Initial call on mount
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.current.withdrawable).toBe(100n);
      expect(result.current.isLoading).toBe(false);

      // Advance timer by 1 interval tick (1000ms)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(spy).toHaveBeenCalledTimes(2);
      expect(result.current.withdrawable).toBe(200n);

      // Advance timer by another 1 interval tick
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(spy).toHaveBeenCalledTimes(3);
      expect(result.current.withdrawable).toBe(300n);

      const callCountBeforeUnmount = spy.mock.calls.length;

      // UNMOUNT COMPONENT
      unmount();

      // Advance timer by 5000ms after unmount
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      // ASSERT: No polling occurs after unmount (call count remains unchanged)
      expect(spy.mock.calls.length).toBe(callCountBeforeUnmount);
    });

    it('handles balance fetch error', async () => {
      vi.spyOn(client.streams, 'withdrawable').mockRejectedValue(
        new Error('Stream not found'),
      );

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ConduitProvider client={client}>{children}</ConduitProvider>
      );

      const { result } = renderHook(
        () => useStreamBalance(99n, { intervalMs: 1000 }),
        { wrapper },
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.error?.message).toBe('Stream not found');
    });
  });
});
