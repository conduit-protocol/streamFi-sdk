import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  WalletConnectAdapter,
  DEFAULT_WALLETCONNECT_PING_INTERVAL_MS,
  DEFAULT_WALLETCONNECT_PING_TIMEOUT_MS,
  DEFAULT_WALLETCONNECT_MAX_MISSED_PINGS,
} from '../adapters/walletconnect.js';

const KEY_A = 'GAAZI4TCR3TY5OJHCTJC2A4QSYRZPB26WKP43SXUXZVTYTBAKW7N5B6X';

function makeSession() {
  return {
    topic: 'session-topic',
    pairingTopic: 'pairing-topic',
    namespaces: { stellar: { accounts: [`stellar:testnet:${KEY_A}`] } },
  };
}

describe('WalletConnectAdapter session ping watchdog (#1080)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is off by default', async () => {
    vi.useFakeTimers();
    const client = { ping: vi.fn().mockResolvedValue(undefined) };
    new WalletConnectAdapter({ chainId: 'stellar:testnet', client, session: makeSession() });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.ping).not.toHaveBeenCalled();
  });

  it('pings the session topic and keeps the session while the wallet answers', async () => {
    vi.useFakeTimers();
    const client = { ping: vi.fn().mockResolvedValue(undefined) };
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client,
      session: makeSession(),
      pingIntervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(3000);
    expect(client.ping).toHaveBeenCalledTimes(3);
    expect(client.ping).toHaveBeenCalledWith({ topic: 'session-topic' });
    expect(adapter.isConnected()).toBe(true);
  });

  it('ends the session after maxMissedPings failures and fires onDisconnect', async () => {
    vi.useFakeTimers();
    const client = { ping: vi.fn().mockRejectedValue(new Error('no peer')) };
    const onDisconnect = vi.fn();
    const onSessionChange = vi.fn();
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client,
      session: makeSession(),
      pingIntervalMs: 1000,
      maxMissedPings: 2,
      onDisconnect,
      onSessionChange,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.isConnected()).toBe(true); // one miss is tolerated
    await vi.advanceTimersByTimeAsync(1000);

    expect(adapter.isConnected()).toBe(false);
    expect(onDisconnect).toHaveBeenCalledWith({ reason: 'ping_timeout', topic: 'session-topic' });
    expect(onSessionChange).toHaveBeenCalledWith({ type: 'disconnected', publicKey: null });

    await vi.advanceTimersByTimeAsync(5000);
    expect(client.ping).toHaveBeenCalledTimes(2); // watchdog stopped
  });

  it('counts a ping that never settles as missed after pingTimeoutMs', async () => {
    vi.useFakeTimers();
    const client = { ping: vi.fn(() => new Promise<void>(() => {})) };
    const onDisconnect = vi.fn();
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client,
      session: makeSession(),
      pingIntervalMs: 1000,
      pingTimeoutMs: 200,
      maxMissedPings: 1,
      onDisconnect,
    });

    await vi.advanceTimersByTimeAsync(1200);
    expect(adapter.isConnected()).toBe(false);
    expect(onDisconnect).toHaveBeenCalledWith({ reason: 'ping_timeout', topic: 'session-topic' });
  });

  it('a successful ping resets the missed-ping count', async () => {
    vi.useFakeTimers();
    const client = {
      ping: vi.fn()
        .mockRejectedValueOnce(new Error('blip'))
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('blip'))
        .mockResolvedValue(undefined),
    };
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client,
      session: makeSession(),
      pingIntervalMs: 1000,
      maxMissedPings: 2,
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(adapter.isConnected()).toBe(true);
  });

  it('falls back to core.pairing.ping with the pairing topic', async () => {
    vi.useFakeTimers();
    const pairingPing = vi.fn().mockResolvedValue(undefined);
    const client = { core: { pairing: { ping: pairingPing } } };
    new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client,
      session: makeSession(),
      pingIntervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(pairingPing).toHaveBeenCalledWith({ topic: 'pairing-topic' });
  });

  it('stops pinging after a local disconnect()', async () => {
    vi.useFakeTimers();
    const client = { ping: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined) };
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client,
      session: makeSession(),
      pingIntervalMs: 1000,
    });
    await adapter.disconnect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.ping).not.toHaveBeenCalled();
  });

  it('exports the documented watchdog defaults (#1189)', () => {
    expect(DEFAULT_WALLETCONNECT_PING_INTERVAL_MS).toBe(30_000);
    expect(DEFAULT_WALLETCONNECT_PING_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_WALLETCONNECT_MAX_MISSED_PINGS).toBe(2);
  });

  it('stops pinging when the wallet ends the session via session_delete (#1189)', async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (payload?: unknown) => void>();
    const client = {
      ping: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, listener: (payload?: unknown) => void) => {
        handlers.set(event, listener);
      }),
      off: vi.fn(),
    };
    new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client,
      session: makeSession(),
      pingIntervalMs: 1000,
    });

    handlers.get('session_delete')?.({ topic: 'session-topic' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.ping).not.toHaveBeenCalled();
  });
});
