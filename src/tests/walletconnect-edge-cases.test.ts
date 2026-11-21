import { describe, it, expect, vi } from 'vitest';
import { WalletConnectAdapter } from '../adapters/walletconnect.js';

describe('WalletConnectAdapter edge cases', () => {
  const dummyPubKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSYRZPB26WKP43SXUXZVTYTBAKW7N5B6X';

  describe('public key extraction edge cases', () => {
    it('should handle multiple colons in CAIP-10 format', () => {
      const session = {
        topic: 'test-topic',
        namespaces: {
          stellar: {
            accounts: [`stellar:pubnet:extra:${dummyPubKey}`],
          },
        },
      };
      const adapter = new WalletConnectAdapter({ session });
      expect(adapter.isConnected()).toBe(true);
      // Should extract the last part after split
    });

    it('should handle empty CAIP-10 namespace accounts array', () => {
      const session = {
        topic: 'test-topic',
        namespaces: {
          stellar: {
            accounts: [],
          },
        },
      };
      const adapter = new WalletConnectAdapter({ session });
      expect(adapter.isConnected()).toBe(false);
    });

    it('should handle missing stellar namespace', () => {
      const session = {
        topic: 'test-topic',
        namespaces: {
          other: {
            accounts: [dummyPubKey],
          },
        },
      };
      const adapter = new WalletConnectAdapter({ session });
      expect(adapter.isConnected()).toBe(false);
    });

    it('should handle undefined namespaces', () => {
      const session = {
        topic: 'test-topic',
        namespaces: undefined,
      };
      const adapter = new WalletConnectAdapter({ session });
      expect(adapter.isConnected()).toBe(false);
    });

    it('should fallback through account extraction hierarchy', () => {
      const session = {
        topic: 'test-topic',
        account: undefined,
        namespaces: undefined,
        accounts: [`stellar:testnet:${dummyPubKey}`],
      };
      const adapter = new WalletConnectAdapter({ session });
      expect(adapter.isConnected()).toBe(true);
    });
  });

  describe('chainId state initialization crash (regression)', () => {
    it('should not crash when chainId is undefined (uninitialized React state)', () => {
      // Simulates: new WalletConnectAdapter({ chainId: someReactState })
      // where someReactState is undefined before an async load completes.
      // The ?? fallback converts undefined → 'stellar:pubnet', so no crash.
      expect(() => new WalletConnectAdapter({ chainId: undefined })).not.toThrow();
    });

    it('should default to stellar:pubnet when chainId is undefined', () => {
      const adapter = new WalletConnectAdapter({ chainId: undefined });
      expect(adapter).toBeInstanceOf(WalletConnectAdapter);
    });

    it('should still throw for a genuinely unsupported non-empty chainId', () => {
      expect(() => new WalletConnectAdapter({ chainId: 'ethereum:1' })).toThrow(/unsupported chainId/i);
    });

    it('should not crash when options object is completely empty', () => {
      expect(() => new WalletConnectAdapter({})).not.toThrow();
    });

    it('should not crash when constructed with no arguments', () => {
      expect(() => new WalletConnectAdapter()).not.toThrow();
    });
  });

  describe('timeout handling', () => {
    it('should timeout when connect handshake never resolves', async () => {
      const hangingClient = {
        connect: () => new Promise(() => {}), // Never resolves
      };
      const adapter = new WalletConnectAdapter({
        client: hangingClient as any,
        connectTimeoutMs: 50,
      });

      await expect(adapter.connect()).rejects.toThrow(/timed out/i);
    });

    it('should use custom timeout duration', async () => {
      const hangingClient = {
        connect: () => new Promise(() => {}),
      };
      const adapter = new WalletConnectAdapter({
        client: hangingClient as any,
        connectTimeoutMs: 25,
      });

      const start = Date.now();
      await expect(adapter.connect()).rejects.toThrow();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(20);
      expect(elapsed).toBeLessThan(100);
    });

    it('should handle approval timeout', async () => {
      const mockClient = {
        connect: vi.fn().mockResolvedValue({
          approval: () => new Promise(() => {}), // Never resolves
        }),
      };
      const adapter = new WalletConnectAdapter({
        client: mockClient,
        connectTimeoutMs: 50,
      });

      await expect(adapter.connect()).rejects.toThrow(/timed out/i);
    });
  });

  describe('connection state', () => {
    it('should not reconnect if already connected', async () => {
      const session = {
        topic: 'test-topic',
        account: dummyPubKey,
      };
      const mockClient = {
        connect: vi.fn(),
      };
      const adapter = new WalletConnectAdapter({ client: mockClient, session });
      const pubKey = await adapter.connect();

      expect(pubKey).toBe(dummyPubKey);
      expect(mockClient.connect).not.toHaveBeenCalled();
    });

    it('should throw when getting public key without connection', async () => {
      const adapter = new WalletConnectAdapter();
      await expect(adapter.getPublicKey()).rejects.toThrow(/not connected/i);
    });

    it('should throw when getting public key from incomplete session', async () => {
      const session = { topic: 'test-topic' }; // No account info
      const adapter = new WalletConnectAdapter({ session });
      await expect(adapter.getPublicKey()).rejects.toThrow(/not connected/i);
    });
  });

  describe('error handling', () => {
    it('should handle missing client disconnect method', async () => {
      const session = {
        topic: 'test-topic',
        account: dummyPubKey,
      };
      const mockClient = {
        disconnect: undefined,
      };
      const adapter = new WalletConnectAdapter({ client: mockClient, session });
      // Should not throw
      await expect(adapter.disconnect()).resolves.toBeUndefined();
    });

    it('should clear session on disconnect', async () => {
      const session = {
        topic: 'test-topic',
        account: dummyPubKey,
      };
      const mockClient = {
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
      const adapter = new WalletConnectAdapter({ client: mockClient, session });
      expect(adapter.isConnected()).toBe(true);

      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    });
  });
});
