import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TransactionSigner } from './mocks/transaction-signer.js';

describe('TransactionSigner — Bounds & Math Regression Tests', () => {
  let signer: TransactionSigner;

  beforeEach(() => {
    signer = new TransactionSigner({ timeoutMs: 1000 });
  });

  afterEach(() => {
    signer.cleanup();
  });

  it('rejects null transaction payload', async () => {
    await expect(signer.sign(null as any)).rejects.toThrow(
      'Transaction payload cannot be null or undefined',
    );
  });

  it('rejects undefined transaction payload', async () => {
    await expect(signer.sign(undefined as any)).rejects.toThrow(
      'Transaction payload cannot be null or undefined',
    );
  });

  it('validates chainId bounds in getChainId', async () => {
    const chainId = await signer.getChainId();
    expect(chainId).toBeGreaterThan(0);
    expect(chainId).toBeLessThanOrEqual(2147483647);
  });

  it('validates timeoutMs bounds in constructor', () => {
    const s1 = new TransactionSigner({ timeoutMs: -100 });
    expect((s1 as any).timeoutMs).toBe(5000);
    s1.cleanup();

    const s2 = new TransactionSigner({ timeoutMs: 1_000_000 });
    expect((s2 as any).timeoutMs).toBe(300_000);
    s2.cleanup();

    const s3 = new TransactionSigner({ timeoutMs: NaN });
    expect((s3 as any).timeoutMs).toBe(5000);
    s3.cleanup();

    const s4 = new TransactionSigner({ timeoutMs: 5000 });
    expect((s4 as any).timeoutMs).toBe(5000);
    s4.cleanup();
  });

  it('validates maxPayloadSize bounds in constructor', () => {
    const s1 = new TransactionSigner({ maxPayloadSize: -1 });
    expect((s1 as any).maxPayloadSize).toBe(1_048_576);
    s1.cleanup();

    const s2 = new TransactionSigner({ maxPayloadSize: 10_000_000 });
    expect((s2 as any).maxPayloadSize).toBe(1_048_576);
    s2.cleanup();

    const s3 = new TransactionSigner({ maxPayloadSize: 500_000 });
    expect((s3 as any).maxPayloadSize).toBe(500_000);
    s3.cleanup();
  });

  it('rejects sign after cleanup', async () => {
    signer.cleanup();
    await expect(signer.sign({} as any)).rejects.toThrow(
      'TransactionSigner has been destroyed',
    );
  });

  it('handles large chainId from wallet adapter', async () => {
    const hugeChainId = new TransactionSigner({
      walletAdapter: {
        getPublicKey: async () => 'GAA',
        signTransaction: async (tx: any) => tx,
        chainId: '999999999999999999999',
      } as any,
    });

    const chainId = await hugeChainId.getChainId();
    expect(chainId).toBeLessThanOrEqual(2147483647);
    expect(chainId).toBeGreaterThan(0);
    hugeChainId.cleanup();
  });

  it('handles negative chainId from wallet adapter', async () => {
    const negativeChain = new TransactionSigner({
      walletAdapter: {
        getPublicKey: async () => 'GAA',
        signTransaction: async (tx: any) => tx,
        chainId: -5,
      } as any,
    });

    const chainId = await negativeChain.getChainId();
    expect(chainId).toBe(1);
    negativeChain.cleanup();
  });

  it('handles non-numeric chainId from wallet adapter', async () => {
    const nonNumeric = new TransactionSigner({
      walletAdapter: {
        getPublicKey: async () => 'GAA',
        signTransaction: async (tx: any) => tx,
        chainId: 'not-a-number',
      } as any,
    });

    const chainId = await nonNumeric.getChainId();
    expect(chainId).toBe(1);
    nonNumeric.cleanup();
  });

  it('handles colon-separated chainId format', async () => {
    const colonChain = new TransactionSigner({
      walletAdapter: {
        getPublicKey: async () => 'GAA',
        signTransaction: async (tx: any) => tx,
        chainId: 'eip155:1337',
      } as any,
    });

    const chainId = await colonChain.getChainId();
    expect(chainId).toBe(1337);
    colonChain.cleanup();
  });

  it('handles async getChainId returning large value', async () => {
    const asyncChain = new TransactionSigner({
      walletAdapter: {
        getPublicKey: async () => 'GAA',
        signTransaction: async (tx: any) => tx,
        getChainId: async () => 5_000_000_000,
      } as any,
    });

    const chainId = await asyncChain.getChainId();
    expect(chainId).toBeLessThanOrEqual(2147483647);
    asyncChain.cleanup();
  });

  it('handles async getChainId returning negative value', async () => {
    const asyncNeg = new TransactionSigner({
      walletAdapter: {
        getPublicKey: async () => 'GAA',
        signTransaction: async (tx: any) => tx,
        getChainId: async () => -100,
      } as any,
    });

    const chainId = await asyncNeg.getChainId();
    expect(chainId).toBe(1);
    asyncNeg.cleanup();
  });

  it('rejects null domain in _signTypedData', async () => {
    await expect(signer._signTypedData(null as any, {}, {})).rejects.toThrow(
      'EIP-712 domain payload cannot be null or undefined',
    );
  });

  it('rejects undefined domain in _signTypedData', async () => {
    await expect(signer._signTypedData(undefined as any, {}, {})).rejects.toThrow(
      'EIP-712 domain payload cannot be null or undefined',
    );
  });

  it('rejects non-object domain in _signTypedData', async () => {
    await expect(signer._signTypedData('string' as any, {}, {})).rejects.toThrow(
      'EIP-712 domain payload cannot be null or undefined',
    );
  });

  it('rejects null value in _signTypedData', async () => {
    await expect(signer._signTypedData({}, {}, null as any)).rejects.toThrow(
      'Typed data value payload cannot be null or undefined',
    );
  });

  it('rejects undefined value in _signTypedData', async () => {
    await expect(signer._signTypedData({}, {}, undefined as any)).rejects.toThrow(
      'Typed data value payload cannot be null or undefined',
    );
  });

  it('rejects null streams array in signProposal', async () => {
    await expect(signer.signProposal(null as any)).rejects.toThrow(
      'Proposal streams payload cannot be null, undefined, or empty',
    );
  });

  it('rejects undefined streams array in signProposal', async () => {
    await expect(signer.signProposal(undefined as any)).rejects.toThrow(
      'Proposal streams payload cannot be null, undefined, or empty',
    );
  });

  it('rejects empty streams array in signProposal', async () => {
    await expect(signer.signProposal([])).rejects.toThrow(
      'Proposal streams payload cannot be null, undefined, or empty',
    );
  });

  it('handles sequential sign calls without race conditions', async () => {
    const mockWallet = {
      getPublicKey: async () => 'GAA',
      signTransaction: async (tx: any) => {
        await new Promise(r => setTimeout(r, 10));
        return tx;
      },
    };

    const sequentialSigner = new TransactionSigner({ walletAdapter: mockWallet as any, timeoutMs: 5000 });

    for (let i = 0; i < 20; i++) {
      await sequentialSigner.sign({} as any);
    }

    sequentialSigner.cleanup();
  });

  it('times out and cleans up on hanging wallet operation', async () => {
    const hangingWallet = {
      getPublicKey: async () => 'GAA',
      signTransaction: async () => new Promise(() => {}),
    };

    const quickSigner = new TransactionSigner({ walletAdapter: hangingWallet as any, timeoutMs: 100 });

    await expect(quickSigner.sign({} as any)).rejects.toThrow(
      'TransactionSigner deadlocked or timed out waiting for async callback',
    );

    expect(quickSigner.isActive()).toBe(false);
    quickSigner.cleanup();
  });

  it('validates publicKey after cleanup', () => {
    signer.cleanup();
    expect(() => signer.publicKey()).toThrow('TransactionSigner has been destroyed');
  });

  it('validates isActive state', () => {
    expect(signer.isActive()).toBe(true);

    const mockWallet = {
      getPublicKey: async () => 'GAA',
      signTransaction: async (tx: any) => tx,
    } as any;

    const s2 = new TransactionSigner({ walletAdapter: mockWallet });
    s2.cleanup();
    expect(s2.isActive()).toBe(false);
  });
});