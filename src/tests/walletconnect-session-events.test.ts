import { describe, it, expect, vi } from 'vitest';
import { WalletConnectAdapter } from '../adapters/walletconnect.js';

const KEY_A = 'GAAZI4TCR3TY5OJHCTJC2A4QSYRZPB26WKP43SXUXZVTYTBAKW7N5B6X';
const KEY_B = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

/** A minimal SignClient with a working event emitter. */
function makeClient() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    off: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener));
    }),
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
  };
}

function makeSession() {
  return {
    topic: 'topic-1',
    namespaces: { stellar: { accounts: [`stellar:testnet:${KEY_A}`] } },
  };
}

describe('WalletConnectAdapter session events (#810)', () => {
  it('subscribes to session events when constructed with a client and session', () => {
    const client = makeClient();
    new WalletConnectAdapter({ chainId: 'stellar:testnet', client, session: makeSession() });
    expect(client.listenerCount('session_event')).toBe(1);
    expect(client.listenerCount('session_delete')).toBe(1);
  });

  it('updates the public key when the wallet emits accountsChanged', async () => {
    const client = makeClient();
    const onSessionChange = vi.fn();
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client,
      session: makeSession(),
      onSessionChange,
    });
    expect(await adapter.getPublicKey()).toBe(KEY_A);

    client.emit('session_event', {
      topic: 'topic-1',
      params: { event: { name: 'accountsChanged', data: [`stellar:testnet:${KEY_B}`] } },
    });

    expect(await adapter.getPublicKey()).toBe(KEY_B);
    expect(onSessionChange).toHaveBeenCalledWith({ type: 'accountsChanged', publicKey: KEY_B });
  });

  it('drops the session when accountsChanged reports no accounts', async () => {
    const client = makeClient();
    const adapter = new WalletConnectAdapter({ chainId: 'stellar:testnet', client, session: makeSession() });

    client.emit('session_event', {
      topic: 'topic-1',
      params: { event: { name: 'accountsChanged', data: [] } },
    });

    expect(adapter.isConnected()).toBe(false);
    await expect(adapter.getPublicKey()).rejects.toThrow(/not connected/i);
  });

  it('drops the session when the wallet moves to a different chain', () => {
    const client = makeClient();
    const onSessionChange = vi.fn();
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client,
      session: makeSession(),
      onSessionChange,
    });

    client.emit('session_event', {
      topic: 'topic-1',
      params: { event: { name: 'chainChanged', data: 'stellar:pubnet' } },
    });

    expect(adapter.isConnected()).toBe(false);
    expect(onSessionChange).toHaveBeenCalledWith({ type: 'chainChanged', publicKey: null });
  });

  it('keeps the session when chainChanged names the configured chain', () => {
    const client = makeClient();
    const adapter = new WalletConnectAdapter({ chainId: 'stellar:testnet', client, session: makeSession() });

    client.emit('session_event', {
      topic: 'topic-1',
      params: { event: { name: 'chainChanged', data: 'stellar:testnet' } },
    });

    expect(adapter.isConnected()).toBe(true);
  });

  it('ignores events for a different session topic', async () => {
    const client = makeClient();
    const adapter = new WalletConnectAdapter({ chainId: 'stellar:testnet', client, session: makeSession() });

    client.emit('session_event', {
      topic: 'other-topic',
      params: { event: { name: 'accountsChanged', data: [`stellar:testnet:${KEY_B}`] } },
    });

    expect(await adapter.getPublicKey()).toBe(KEY_A);
  });

  it('clears the session on session_delete', () => {
    const client = makeClient();
    const onSessionChange = vi.fn();
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client,
      session: makeSession(),
      onSessionChange,
    });

    client.emit('session_delete', { topic: 'topic-1' });

    expect(adapter.isConnected()).toBe(false);
    expect(onSessionChange).toHaveBeenCalledWith({ type: 'disconnected', publicKey: null });
  });

  it('removes its listeners on disconnect', async () => {
    const client = makeClient();
    const adapter = new WalletConnectAdapter({ chainId: 'stellar:testnet', client, session: makeSession() });

    await adapter.disconnect();

    expect(client.listenerCount('session_event')).toBe(0);
    expect(client.listenerCount('session_delete')).toBe(0);
  });

  it('subscribes after a successful connect()', async () => {
    const client = {
      ...makeClient(),
      connect: vi.fn().mockResolvedValue({ session: makeSession() }),
    };
    const adapter = new WalletConnectAdapter({ chainId: 'stellar:testnet', client });

    await adapter.connect();

    expect(client.listenerCount('session_event')).toBe(1);
  });
});
