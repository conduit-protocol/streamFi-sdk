/**
 * Tests for StreamFiProvider connection tracking and last-adapter persistence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { Keypair } from '@stellar/stellar-sdk';
import {
  ConduitClient,
  StreamFiProvider,
  useStreamFiContext,
  LAST_ADAPTER_STORAGE_KEY,
} from '../index.js';
import type { WalletAdapter } from '../adapters/types.js';

function createClient(): ConduitClient {
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

describe('StreamFiProvider connection status + adapter persistence', () => {
  let client: ConduitClient;

  beforeEach(() => {
    window.localStorage.clear();
    client = createClient();
    vi.spyOn(client, 'setWallet').mockImplementation(() => {});
  });

  it('tracks connecting -> connected and persists the last adapter id', async () => {
    const adapter = fakeAdapter('GWALLET1');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StreamFiProvider client={client} adapters={{ freighter: adapter }}>
        {children}
      </StreamFiProvider>
    );
    const { result } = renderHook(() => useStreamFiContext(), { wrapper });

    expect(result.current.connectionStatus).toBe('disconnected');
    await act(async () => {
      await result.current.connect('freighter');
    });
    expect(result.current.connectionStatus).toBe('connected');
    expect(result.current.walletId).toBe('freighter');
    expect(window.localStorage.getItem(LAST_ADAPTER_STORAGE_KEY)).toBe('freighter');
    expect(client.setWallet).toHaveBeenCalledWith(adapter);
  });

  it('restores the previous provider after a reload', async () => {
    window.localStorage.setItem(LAST_ADAPTER_STORAGE_KEY, 'freighter');
    const adapter = fakeAdapter('GWALLET2');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StreamFiProvider client={client} adapters={{ freighter: adapter }}>
        {children}
      </StreamFiProvider>
    );
    const { result } = renderHook(() => useStreamFiContext(), { wrapper });

    await waitFor(() => expect(result.current.connectionStatus).toBe('connected'));
    expect(result.current.walletId).toBe('freighter');
    expect(client.setWallet).toHaveBeenCalledWith(adapter);
    expect(adapter.connect).not.toHaveBeenCalled();
  });

  it('forgets an adapter that revoked its session', async () => {
    window.localStorage.setItem(LAST_ADAPTER_STORAGE_KEY, 'freighter');
    const adapter = fakeAdapter('GWALLET3', { isConnected: () => false });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StreamFiProvider client={client} adapters={{ freighter: adapter }}>
        {children}
      </StreamFiProvider>
    );
    renderHook(() => useStreamFiContext(), { wrapper });
    await waitFor(() =>
      expect(window.localStorage.getItem(LAST_ADAPTER_STORAGE_KEY)).toBeNull(),
    );
  });

  it('reports an error for an unknown adapter id', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StreamFiProvider client={client} adapters={{ freighter: fakeAdapter('G') }}>
        {children}
      </StreamFiProvider>
    );
    const { result } = renderHook(() => useStreamFiContext(), { wrapper });
    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.connect('missing');
      } catch (err) {
        thrown = err;
      }
    });
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/Unknown wallet/);
    expect(result.current.connectionStatus).toBe('error');
    expect(result.current.error?.message).toMatch(/Unknown wallet/);
  });

  it('disconnect clears status and the persisted adapter', async () => {
    const adapter = fakeAdapter('GWALLET4');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StreamFiProvider client={client} adapters={{ freighter: adapter }}>
        {children}
      </StreamFiProvider>
    );
    const { result } = renderHook(() => useStreamFiContext(), { wrapper });
    await act(async () => {
      await result.current.connect('freighter');
    });
    await act(async () => {
      await result.current.disconnect();
    });
    expect(result.current.connectionStatus).toBe('disconnected');
    expect(result.current.walletId).toBeNull();
    expect(window.localStorage.getItem(LAST_ADAPTER_STORAGE_KEY)).toBeNull();
    expect(adapter.disconnect).toHaveBeenCalled();
  });

  it('marks a wallet prop as connected without an adapters map', () => {
    const wallet = fakeAdapter('GWALLET5');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StreamFiProvider client={client} wallet={wallet}>
        {children}
      </StreamFiProvider>
    );
    const { result } = renderHook(() => useStreamFiContext(), { wrapper });
    expect(result.current.connectionStatus).toBe('connected');
    expect(client.setWallet).toHaveBeenCalledWith(wallet);
  });
});
