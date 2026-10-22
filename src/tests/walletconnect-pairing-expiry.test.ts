import { describe, it, expect, vi } from 'vitest';
import { WalletConnectAdapter } from '../adapters/walletconnect.js';

const KEY_A = 'GAAZI4TCR3TY5OJHCTJC2A4QSYRZPB26WKP43SXUXZVTYTBAKW7N5B6X';

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

describe('WalletConnectAdapter pairing expiry (#972)', () => {
  it('automatically re-pairs and succeeds after the first pairing expires', async () => {
    let attempt = 0;
    const client = {
      ...makeClient(),
      connect: vi.fn(() => {
        attempt += 1;
        if (attempt === 1) {
          return Promise.resolve({
            approval: () => {
              // Simulate the wallet never approving the first (expiring) pairing.
              client.emit('pairing_expire', {});
              return Promise.reject(new Error('Proposal expired'));
            },
          });
        }
        return Promise.resolve({ approval: () => Promise.resolve(makeSession()) });
      }),
    };

    const onPairingExpire = vi.fn();
    const onDisplayUri = vi.fn();
    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client,
      onPairingExpire,
      onDisplayUri,
    });

    const pubKey = await adapter.connect();

    expect(pubKey).toBe(KEY_A);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(onPairingExpire).toHaveBeenCalledTimes(1);
  });

  it('rejects once retries are exhausted', async () => {
    const client = {
      ...makeClient(),
      connect: vi.fn(() => Promise.resolve({
        approval: () => {
          client.emit('pairing_expire', {});
          return Promise.reject(new Error('Proposal expired'));
        },
      })),
    };

    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client,
      maxPairingRetries: 1,
    });

    await expect(adapter.connect()).rejects.toThrow('Proposal expired');
    expect(client.connect).toHaveBeenCalledTimes(2); // initial attempt + 1 retry
  });

  it('does not retry when maxPairingRetries is 0', async () => {
    const client = {
      ...makeClient(),
      connect: vi.fn(() => Promise.resolve({
        approval: () => {
          client.emit('pairing_expire', {});
          return Promise.reject(new Error('Proposal expired'));
        },
      })),
    };

    const adapter = new WalletConnectAdapter({
      chainId: 'stellar:testnet',
      client,
      maxPairingRetries: 0,
    });

    await expect(adapter.connect()).rejects.toThrow('Proposal expired');
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-expiry approval rejection without retrying', async () => {
    const client = {
      ...makeClient(),
      connect: vi.fn(() => Promise.resolve({
        approval: () => Promise.reject(new Error('User rejected the session')),
      })),
    };

    const adapter = new WalletConnectAdapter({ chainId: 'stellar:testnet', client });

    await expect(adapter.connect()).rejects.toThrow('User rejected the session');
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('forwards display_uri events to onDisplayUri, including on a refreshed pairing', async () => {
    let attempt = 0;
    const client = {
      ...makeClient(),
      connect: vi.fn(() => {
        attempt += 1;
        if (attempt === 1) {
          return Promise.resolve({
            approval: () => {
              client.emit('display_uri', 'wc:first-uri');
              client.emit('pairing_expire', {});
              return Promise.reject(new Error('Proposal expired'));
            },
          });
        }
        return Promise.resolve({
          approval: () => {
            client.emit('display_uri', 'wc:second-uri');
            return Promise.resolve(makeSession());
          },
        });
      }),
    };

    const onDisplayUri = vi.fn();
    const adapter = new WalletConnectAdapter({ chainId: 'stellar:testnet', client, onDisplayUri });

    await adapter.connect();

    expect(onDisplayUri).toHaveBeenNthCalledWith(1, 'wc:first-uri');
    expect(onDisplayUri).toHaveBeenNthCalledWith(2, 'wc:second-uri');
  });

  it('removes its display_uri/pairing_expire listeners once connect() settles', async () => {
    const client = {
      ...makeClient(),
      connect: vi.fn(() => Promise.resolve({ approval: () => Promise.resolve(makeSession()) })),
    };

    const adapter = new WalletConnectAdapter({ chainId: 'stellar:testnet', client });
    await adapter.connect();

    expect(client.listenerCount('display_uri')).toBe(0);
    expect(client.listenerCount('pairing_expire')).toBe(0);
  });
});
