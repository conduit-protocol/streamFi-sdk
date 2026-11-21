import { describe, it, expect } from 'vitest';
import { WalletConnectAdapter } from '../adapters/walletconnect.js';

describe('WalletConnectAdapter public key extraction safety', () => {
  const dummyPubKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSYRZPB26WKP43SXUXZVTYTBAKW7N5B6X';

  it('should safely extract public key from CAIP-10 format without non-null assertion', async () => {
    const session = {
      topic: 'test-topic',
      namespaces: {
        stellar: {
          accounts: [`stellar:pubnet:${dummyPubKey}`],
        },
      },
    };
    const adapter = new WalletConnectAdapter({ session });
    expect(adapter.isConnected()).toBe(true);
    await expect(adapter.getPublicKey()).resolves.toBe(dummyPubKey);
  });

  it('should handle malformed CAIP-10 format gracefully', () => {
    const session = {
      topic: 'test-topic',
      namespaces: {
        stellar: {
          accounts: ['stellar:pubnet:'],  // Missing pubkey part
        },
      },
    };
    const adapter = new WalletConnectAdapter({ session });
    // Should not throw during key extraction
    expect(adapter.isConnected()).toBe(false); // Empty string is falsy
  });

  it('should extract bare public key when CAIP-10 format is absent', async () => {
    const session = {
      topic: 'test-topic',
      account: dummyPubKey,
    };
    const adapter = new WalletConnectAdapter({ session });
    expect(adapter.isConnected()).toBe(true);
    await expect(adapter.getPublicKey()).resolves.toBe(dummyPubKey);
  });

  it('should safely fall back to accounts array without non-null assertion', async () => {
    const session = {
      topic: 'test-topic',
      accounts: [`stellar:testnet:${dummyPubKey}`],
    };
    const adapter = new WalletConnectAdapter({ session });
    expect(adapter.isConnected()).toBe(true);
    await expect(adapter.getPublicKey()).resolves.toBe(dummyPubKey);
  });

  it('should return null for empty accounts array', () => {
    const session = {
      topic: 'test-topic',
      accounts: [],
    };
    const adapter = new WalletConnectAdapter({ session });
    expect(adapter.isConnected()).toBe(false);
  });

  it('should handle session with only topic (no accounts)', () => {
    const session = {
      topic: 'test-topic',
    };
    const adapter = new WalletConnectAdapter({ session });
    expect(adapter.isConnected()).toBe(false);
  });
});
