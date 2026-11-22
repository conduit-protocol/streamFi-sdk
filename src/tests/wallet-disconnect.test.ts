/**
 * Wallet disconnect cleanup (#1168).
 *
 * Disconnecting a wallet must stop every poller and listener the adapter
 * started, so long-running browser sessions do not accumulate zombie
 * timers, event listeners or network requests.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Networks } from '@stellar/stellar-sdk';
import { WalletConnectAdapter, type WalletConnectSignClient } from '../adapters/walletconnect.js';
import { FreighterWalletAdapter } from '../adapters/freighter.js';
import { ConduitClient, useWallet, WALLET_STORAGE_KEY } from '../index.js';

const KEY_A = 'GAAZI4TCR3TY5OJHCTJC2A4QSYRZPB26WKP43SXUXZVTYTBAKW7N5B6X';

/** A SignClient stub that records listeners, pings and disconnect requests. */
function makeWcClient(options: { disconnectRejects?: boolean } = {}) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const client = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener));
    }),
    ping: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => {
      if (options.disconnectRejects) throw new Error('relay unreachable');
    }),
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
  };
  return client;
}

function makeWcSession() {
  return {
    topic: 'topic-1',
    namespaces: { stellar: { accounts: [`stellar:testnet:${KEY_A}`] } },
  };
}

/** A Freighter stub that counts how often the adapter polls it. */
function makeFreighter(address: string) {
  return {
    getAddress: vi.fn(async () => ({ address })),
    getNetworkDetails: vi.fn(async () => ({ networkPassphrase: Networks.TESTNET })),
  };
}

/** The adapter's remembered-wallet storage (jsdom's localStorage). */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}
function localStorageLike(): StorageLike {
  return (globalThis as unknown as { localStorage: StorageLike }).localStorage;
}

describe('WalletConnectAdapter disconnect cleanup (#1168)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the session ping watchdog so no pings fire after disconnect()', async () => {
    vi.useFakeTimers();
    const client = makeWcClient();
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client: client as unknown as WalletConnectSignClient,
      session: makeWcSession(),
      pingIntervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.ping).toHaveBeenCalledTimes(1);

    await adapter.disconnect();
    const pingsAtDisconnect = client.ping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.ping.mock.calls.length).toBe(pingsAtDisconnect);
  });

  it('detaches session event listeners on disconnect()', async () => {
    const client = makeWcClient();
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client: client as unknown as WalletConnectSignClient,
      session: makeWcSession(),
    });
    expect(client.listenerCount('session_event')).toBe(1);
    expect(client.listenerCount('session_delete')).toBe(1);
    expect(client.listenerCount('session_expire')).toBe(1);

    await adapter.disconnect();

    expect(client.listenerCount('session_event')).toBe(0);
    expect(client.listenerCount('session_delete')).toBe(0);
    expect(client.listenerCount('session_expire')).toBe(0);
  });

  it('ignores wallet session events that arrive after disconnect()', async () => {
    const client = makeWcClient();
    const onSessionChange = vi.fn();
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client: client as unknown as WalletConnectSignClient,
      session: makeWcSession(),
      onSessionChange,
    });

    await adapter.disconnect();
    client.emit('session_event', {
      topic: 'topic-1',
      params: { event: { name: 'accountsChanged', data: [`stellar:testnet:${KEY_A}`] } },
    });

    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it('still stops the watchdog when the wallet rejects the disconnect request', async () => {
    vi.useFakeTimers();
    const client = makeWcClient({ disconnectRejects: true });
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client: client as unknown as WalletConnectSignClient,
      session: makeWcSession(),
      pingIntervalMs: 1_000,
    });

    await expect(adapter.disconnect()).rejects.toThrow('relay unreachable');
    const pingsAfterFailure = client.ping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.ping.mock.calls.length).toBe(pingsAfterFailure);
    expect(client.listenerCount('session_event')).toBe(0);
  });
});

describe('all wallet pollers stop on disconnect (#1168)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops both the Freighter watcher and the WalletConnect watchdog together', async () => {
    vi.useFakeTimers();
    const freighter = makeFreighter(KEY_A);
    const freighterAdapter = new FreighterWalletAdapter({ freighter, publicKey: KEY_A });
    const wcClient = makeWcClient();
    const wcAdapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client: wcClient as unknown as WalletConnectSignClient,
      session: makeWcSession(),
      pingIntervalMs: 1_000,
    });

    freighterAdapter.watchWalletChanges(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(freighter.getAddress).toHaveBeenCalled();

    await freighterAdapter.disconnect();
    await wcAdapter.disconnect();

    const freighterCalls = vi.mocked(freighter.getAddress).mock.calls.length;
    const pings = wcClient.ping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);

    expect(vi.mocked(freighter.getAddress).mock.calls.length).toBe(freighterCalls);
    expect(wcClient.ping.mock.calls.length).toBe(pings);
  });

  it('useWallet().disconnect() clears the remembered wallet and stops the Freighter watcher', async () => {
    vi.useFakeTimers();
    localStorageLike().clear();
    localStorageLike().setItem(WALLET_STORAGE_KEY, 'freighter');
    const client = new ConduitClient({
      network: 'testnet',
      factoryAddress: 'CFACTORYPLACEHOLDER',
    });
    vi.spyOn(client, 'setWallet').mockImplementation(() => {});

    const freighter = makeFreighter(KEY_A);
    const adapter = new FreighterWalletAdapter({ freighter, publicKey: KEY_A });
    adapter.watchWalletChanges(1_000);

    const { result } = renderHook(() =>
      useWallet({ client, adapters: { freighter: adapter } }),
    );
    await vi.waitFor(() => expect(result.current.isConnected).toBe(true));

    await act(async () => {
      await result.current.disconnect();
    });

    expect(result.current.isConnected).toBe(false);
    expect(localStorageLike().getItem(WALLET_STORAGE_KEY)).toBeNull();

    const callsAtDisconnect = vi.mocked(freighter.getAddress).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(freighter.getAddress).mock.calls.length).toBe(callsAtDisconnect);
  });
});
