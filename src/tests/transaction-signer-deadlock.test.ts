import { describe, it, expect } from 'vitest';
import { TransactionSigner } from '../signer.js';

describe('TransactionSigner Deadlock & Callback Cleanup Regression Tests', () => {
  it('throws boundary check error when payload is null or undefined', async () => {
    const signer = new TransactionSigner();

    await expect(signer.sign(null as any)).rejects.toThrow(
      'Transaction payload cannot be null or undefined'
    );
    await expect(signer.sign(undefined as any)).rejects.toThrow(
      'Transaction payload cannot be null or undefined'
    );

    signer.cleanup();
  });

  it('cleans up callbacks and resolves cleanly when async wallet operation succeeds', async () => {
    let signed = false;
    const mockWallet = {
      getPublicKey: async () => 'GMOCKKEY',
      signTransaction: async (tx: any) => {
        signed = true;
        return tx;
      },
    };

    const signer = new TransactionSigner({ walletAdapter: mockWallet as any, timeoutMs: 1000 });
    await signer.sign({} as any);

    expect(signed).toBe(true);
    signer.cleanup();
  });

  it('cleans up active callbacks and rejects when signer is destroyed during pending async call', async () => {
    const slowWallet = {
      getPublicKey: async () => 'GMOCKKEY',
      signTransaction: () => new Promise((resolve) => setTimeout(() => resolve({} as any), 500)),
    };

    const signer = new TransactionSigner({ walletAdapter: slowWallet as any, timeoutMs: 1000 });
    const signPromise = signer.sign({} as any);

    // Destroy signer while callback is pending
    signer.cleanup();

    await expect(signer.sign({} as any)).rejects.toThrow(
      'TransactionSigner has been destroyed'
    );
  });

  it('times out and cleans up callbacks without thread deadlock when async callback hangs', async () => {
    const hangingWallet = {
      getPublicKey: async () => 'GMOCKKEY',
      signTransaction: () => new Promise(() => {}), // never resolves
    };

    const signer = new TransactionSigner({ walletAdapter: hangingWallet as any, timeoutMs: 100 });

    await expect(signer.sign({} as any)).rejects.toThrow(
      'TransactionSigner deadlocked or timed out waiting for async callback'
    );

    signer.cleanup();
  });
});
