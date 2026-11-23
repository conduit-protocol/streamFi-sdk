/**
 * Tests for StreamFiProvider / useStreamFiContext (#1095), useWallet (#1093),
 * useBatchStreams (#1094) and the ContractErrorCode export (#1096).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { Keypair } from '@stellar/stellar-sdk';
import {
  ConduitClient,
  StreamFiProvider,
  useStreamFiContext,
  useConduitClient,
  useWallet,
  useBatchStreams,
  WALLET_STORAGE_KEY,
  DEFAULT_STREAMFI_NETWORK,
} from '../index.js';
import {
  ContractErrorCode,
  StreamErrorCode,
  FactoryErrorCode,
  type AnyContractErrorCode,
} from '../types/index.js';
import type { WalletAdapter } from '../adapters/types.js';

function createClient() {
  return new ConduitClient({
    network: 'testnet',
    factoryAddress: 'CFACTORYPLACEHOLDER',
    keypair: Keypair.random(),
  });
}

function fakeAdapter(publicKey: string, overrides: Partial<WalletAdapter> = {}): WalletAdapter {
  return {
    getPublicKey: vi.fn(async () => publicKey),
    signTransaction: vi.fn(async (tx: Parameters<WalletAdapter['signTransaction']>[0]) => tx),
    connect: vi.fn(async () => publicKey),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('StreamFiProvider & useStreamFiContext (#1095)', () => {
  it('throws outside a provider', () => {
    expect(() => renderHook(() => useStreamFiContext())).toThrow(/StreamFi context not found/);
  });

  it('creates a client on the default network when none is passed', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StreamFiProvider>{children}</StreamFiProvider>
    );
    const { result } = renderHook(() => useStreamFiContext(), { wrapper });
    expect(result.current.client).toBeInstanceOf(ConduitClient);
    expect(result.current.network).toBe(DEFAULT_STREAMFI_NETWORK);
  });

  it('uses a provided client and also feeds the existing hooks', () => {
    const client = createClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StreamFiProvider client={client}>{children}</StreamFiProvider>
    );
    const { result } = renderHook(
      () => ({ ctx: useStreamFiContext(), legacy: useConduitClient() }),
      { wrapper },
    );
    expect(result.current.ctx.client).toBe(client);
    expect(result.current.legacy).toBe(client);
  });

  it('keeps the same client across re-renders with a new inline config', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StreamFiProvider config={{ network: 'testnet', factoryAddress: 'CFACTORYPLACEHOLDER' }}>{children}</StreamFiProvider>
    );
    const { result, rerender } = renderHook(() => useStreamFiContext().client, { wrapper });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('attaches the wallet prop to the client', () => {
    const client = createClient();
    const spy = vi.spyOn(client, 'setWallet').mockImplementation(() => {});
    const wallet = fakeAdapter('GWALLET');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StreamFiProvider client={client} wallet={wallet}>{children}</StreamFiProvider>
    );
    renderHook(() => useStreamFiContext(), { wrapper });
    expect(spy).toHaveBeenCalledWith(wallet);
  });
});

describe('useWallet (#1093)', () => {
  let client: ConduitClient;

  beforeEach(() => {
    window.localStorage.clear();
    client = createClient();
    vi.spyOn(client, 'setWallet').mockImplementation(() => {});
  });

  it('connects, attaches the adapter and remembers only the adapter id', async () => {
    const freighter = fakeAdapter('GUSER');
    const { result } = renderHook(() =>
      useWallet({ client, adapters: { freighter }, autoReconnect: false }),
    );

    await act(async () => {
      await result.current.connect('freighter');
    });

    expect(result.current.publicKey).toBe('GUSER');
    expect(result.current.walletId).toBe('freighter');
    expect(result.current.isConnected).toBe(true);
    expect(client.setWallet).toHaveBeenCalledWith(freighter);
    expect(window.localStorage.getItem(WALLET_STORAGE_KEY)).toBe('freighter');
  });

  it('re-hydrates the remembered wallet after a reload without prompting', async () => {
    window.localStorage.setItem(WALLET_STORAGE_KEY, 'freighter');
    const freighter = fakeAdapter('GUSER');
    const { result } = renderHook(() => useWallet({ client, adapters: { freighter } }));

    await waitFor(() => expect(result.current.publicKey).toBe('GUSER'));
    expect(result.current.walletId).toBe('freighter');
    expect(result.current.isReconnecting).toBe(false);
    expect(freighter.connect).not.toHaveBeenCalled();
    expect(client.setWallet).toHaveBeenCalledWith(freighter);
  });

  it('forgets a remembered wallet that reports it is no longer connected', async () => {
    window.localStorage.setItem(WALLET_STORAGE_KEY, 'freighter');
    const freighter = fakeAdapter('GUSER', { isConnected: () => false });
    const { result } = renderHook(() => useWallet({ client, adapters: { freighter } }));

    await waitFor(() => expect(window.localStorage.getItem(WALLET_STORAGE_KEY)).toBeNull());
    expect(result.current.isConnected).toBe(false);
    expect(freighter.getPublicKey).not.toHaveBeenCalled();
  });

  it('forgets a remembered wallet whose re-hydration fails', async () => {
    window.localStorage.setItem(WALLET_STORAGE_KEY, 'freighter');
    const freighter = fakeAdapter('GUSER', {
      getPublicKey: vi.fn(async () => {
        throw new Error('locked');
      }),
    });
    const { result } = renderHook(() => useWallet({ client, adapters: { freighter } }));

    await waitFor(() => expect(result.current.isReconnecting).toBe(false));
    expect(result.current.isConnected).toBe(false);
    expect(window.localStorage.getItem(WALLET_STORAGE_KEY)).toBeNull();
  });

  it('disconnect clears state and storage and disconnects the adapter', async () => {
    const freighter = fakeAdapter('GUSER');
    const { result } = renderHook(() =>
      useWallet({ client, adapters: { freighter }, autoReconnect: false }),
    );
    await act(async () => {
      await result.current.connect('freighter');
    });
    await act(async () => {
      await result.current.disconnect();
    });

    expect(result.current.isConnected).toBe(false);
    expect(window.localStorage.getItem(WALLET_STORAGE_KEY)).toBeNull();
    expect(freighter.disconnect).toHaveBeenCalled();
  });

  it('rejects an unknown wallet id', async () => {
    const { result } = renderHook(() => useWallet({ client, adapters: {}, autoReconnect: false }));
    await act(async () => {
      await expect(result.current.connect('nope')).rejects.toThrow(/Unknown wallet/);
    });
    expect(result.current.error).toBeInstanceOf(Error);
  });
});

describe('useBatchStreams (#1094)', () => {
  let client: ConduitClient;

  beforeEach(() => {
    client = createClient();
  });

  it('reports per-item outcomes as partial progress for createBatch', async () => {
    vi.spyOn(client.streams, 'createBatchStreams').mockResolvedValue([
      { index: 0, success: true, streamId: 1n },
      { index: 1, success: false, error: 'boom' },
    ]);
    const { result } = renderHook(() => useBatchStreams({ client }));

    await act(async () => {
      await result.current.createBatch([{} as never, {} as never]);
    });

    expect(result.current.progress).toEqual({
      status: 'partial',
      total: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(result.current.createResults).toHaveLength(2);
    expect(result.current.isPending).toBe(false);
  });

  it('reports success for a fully successful withdrawBatch', async () => {
    vi.spyOn(client.streams, 'batchWithdraw').mockResolvedValue([
      { streamId: 1n, success: true, txHash: 'h1' },
      { streamId: 2n, success: true, txHash: 'h2' },
    ]);
    const { result } = renderHook(() => useBatchStreams({ client }));

    await act(async () => {
      await result.current.withdrawBatch([{ streamId: 1n }, { streamId: 2n }]);
    });

    expect(result.current.progress.status).toBe('success');
    expect(result.current.withdrawResults).toHaveLength(2);
  });

  it('marks the whole batch failed when the call itself throws, then resets', async () => {
    vi.spyOn(client.streams, 'batchWithdraw').mockRejectedValue(new Error('rpc down'));
    const { result } = renderHook(() => useBatchStreams({ client }));

    await act(async () => {
      await expect(result.current.withdrawBatch([{ streamId: 1n }])).rejects.toThrow('rpc down');
    });
    expect(result.current.progress).toEqual({ status: 'error', total: 1, succeeded: 0, failed: 1 });
    expect(result.current.error?.message).toBe('rpc down');

    act(() => result.current.reset());
    expect(result.current.progress.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });
});

describe('ContractErrorCode (#1096)', () => {
  it('is the stream contract enum with the Rust numeric codes', () => {
    expect(ContractErrorCode).toBe(StreamErrorCode);
    expect(ContractErrorCode.NotAuthorized).toBe(1);
    expect(ContractErrorCode.NothingToWithdraw).toBe(6);
    expect(ContractErrorCode.InvalidAmount).toBe(15);
  });

  it('keeps per-contract enums distinct where codes overlap', () => {
    const codes: AnyContractErrorCode[] = [StreamErrorCode.NotAuthorized, FactoryErrorCode.NotInitialized];
    expect(codes).toEqual([1, 1]);
    expect(StreamErrorCode[1]).toBe('NotAuthorized');
    expect(FactoryErrorCode[1]).toBe('NotInitialized');
  });
});
