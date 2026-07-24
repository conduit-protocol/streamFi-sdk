import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction } from '@stellar/stellar-sdk';
import type { Signer } from '../signer.js';
import type { WalletAdapter } from '../adapters/types.js';

// ── Mocks for streams.ts dependencies ─────────────────────────────────────────

const mockStreamAddress = vi.fn();

vi.mock('../factory.js', () => ({
  FactoryModule: class {
    streamAddress = mockStreamAddress;
  },
}));

vi.mock('../soroban.js', async () => {
  const actual = await vi.importActual<typeof import('../soroban.js')>('../soroban.js');
  return { ...actual, buildContractCallTx: vi.fn() };
});

vi.mock('../events.js', () => ({
  subscribeToStream: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Access private _signTx on StreamsModule for unit testing. */
async function runSignTx(
  sdk: unknown,
  tx: Transaction,
): Promise<Transaction> {
  return (sdk as { _signTx(tx: Transaction): Promise<Transaction> })._signTx(tx);
}

// ── Tests: boundary checks in _signTx ─────────────────────────────────────────

describe('_signTx — null/undefined boundary checks', () => {
  it('throws when wallet signTransaction returns null', async () => {
    const nullWallet: WalletAdapter = {
      getPublicKey: () => 'GAAZI...',
      signTransaction: async () => null as unknown as Transaction,
    };
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({
      network: 'testnet',
      factoryAddress: 'CCWAMYJ...',
      wallet: nullWallet,
    });

    await expect(runSignTx(sdk, {} as Transaction)).rejects.toThrow(
      'Wallet adapter signTransaction returned null or undefined',
    );
  });

  it('throws when wallet signTransaction returns undefined', async () => {
    const undefWallet: WalletAdapter = {
      getPublicKey: () => 'GAAZI...',
      signTransaction: async () => undefined as unknown as Transaction,
    };
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({
      network: 'testnet',
      factoryAddress: 'CCWAMYJ...',
      wallet: undefWallet,
    });

    await expect(runSignTx(sdk, {} as Transaction)).rejects.toThrow(
      'Wallet adapter signTransaction returned null or undefined',
    );
  });
});

// ── Tests: Signer async/sync sign() ───────────────────────────────────────────

describe('_signTx — Signer with async/sync sign()', () => {
  it('handles Signer with async sign (Promise<void>)', async () => {
    let signed = false;
    const asyncSigner: Signer = {
      sign: async (_tx: Transaction) => { signed = true; },
      publicKey: () => 'GAAZI...',
    };
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({
      network: 'testnet',
      factoryAddress: 'CCWAMYJ...',
      signer: asyncSigner,
    });

    const result = await runSignTx(sdk, {} as Transaction);
    expect(result).toBeDefined();
    expect(signed).toBe(true);
  });

  it('handles Signer with sync sign (void)', async () => {
    let signed = false;
    const syncSigner: Signer = {
      sign: (_tx: Transaction) => { signed = true; },
      publicKey: () => 'GAAZI...',
    };
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({
      network: 'testnet',
      factoryAddress: 'CCWAMYJ...',
      signer: syncSigner,
    });

    const result = await runSignTx(sdk, {} as Transaction);
    expect(result).toBeDefined();
    expect(signed).toBe(true);
  });

  it('handles Signer whose sign() returns null (treated as void)', async () => {
    let signed = false;
    const nullSigner: Signer = {
      sign: (_tx: Transaction) => { signed = true; return null as unknown as void; },
      publicKey: () => 'GAAZI...',
    };
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({
      network: 'testnet',
      factoryAddress: 'CCWAMYJ...',
      signer: nullSigner,
    });

    await expect(runSignTx(sdk, {} as Transaction)).resolves.toBeDefined();
    expect(signed).toBe(true);
  });
});

// ── Tests: _resolveCallerAddress ──────────────────────────────────────────────

describe('StreamsModule — _resolveCallerAddress handles async getPublicKey', () => {
  it('resolves async getPublicKey() from wallet adapter', async () => {
    const expectedKey = 'GASYNCKEY...';
    const asyncWallet: WalletAdapter = {
      getPublicKey: async () => expectedKey,
      signTransaction: async (tx) => tx,
    };
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({
      network: 'testnet',
      factoryAddress: 'CCWAMYJ...',
      wallet: asyncWallet,
    });

    const pk = await (sdk as unknown as { _resolveCallerAddress(): Promise<string> })._resolveCallerAddress();
    expect(pk).toBe(expectedKey);
  });

  it('falls back to signer when wallet has no active adapter', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({
      network: 'testnet',
      factoryAddress: 'CCWAMYJ...',
      signer: { sign: () => {}, publicKey: () => 'GSIGNERKEY...' },
    });

    const pk = await (sdk as unknown as { _resolveCallerAddress(): Promise<string> })._resolveCallerAddress();
    expect(pk).toBe('GSIGNERKEY...');
  });

  it('returns ZERO_ADDR when no signer or wallet is configured', async () => {
    const { ZERO_ADDR } = await import('../constants.js');
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({
      network: 'testnet',
      factoryAddress: 'CCWAMYJ...',
    });

    const pk = await (sdk as unknown as { _resolveCallerAddress(): Promise<string> })._resolveCallerAddress();
    expect(pk).toBe(ZERO_ADDR);
  });
});

// ── Tests: subscribe lifecycle cleanup ────────────────────────────────────────

describe('subscribe — lifecycle cleanup', () => {
  beforeEach(() => {
    mockStreamAddress.mockReset().mockResolvedValue('CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM');
  });

  it('calls inner unsubscribe when async init completes after sync unsubscribe', async () => {
    const { subscribeToStream } = await import('../events.js');
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({
      network: 'testnet',
      factoryAddress: 'CCWAMYJ...',
    });

    const sub = sdk.subscribe(1n, {
      onWithdraw: () => {},
    });
    // Unsubscribe synchronously before the async init resolves
    sub.unsubscribe();

    // Allow the async init to complete
    await vi.waitFor(() => {
      expect(subscribeToStream).toHaveBeenCalled();
    });

    // The inner unsubscribe should have been called because the .then()
    // branch for the stopped case calls sub.unsubscribe()
    const innerUnsub = (subscribeToStream as ReturnType<typeof vi.fn>).mock.results[0]?.value?.unsubscribe;
    if (innerUnsub) {
      expect(innerUnsub).toHaveBeenCalled();
    }
  });

  it('returns unsubscribe that works when called after async init', async () => {
    const { StreamsModule } = await import('../streams.js');
    const sdk = new StreamsModule({
      network: 'testnet',
      factoryAddress: 'CCWAMYJ...',
    });

    const sub = sdk.subscribe(1n, {});
    // Wait for async init
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(() => sub.unsubscribe()).not.toThrow();
  });
});
