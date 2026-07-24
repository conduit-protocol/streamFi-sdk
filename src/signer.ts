import { Keypair, Transaction } from '@stellar/stellar-sdk';
import type { WalletAdapter } from './adapters/types.js';

export interface Signer {
  sign(tx: Transaction): void | Promise<void>;
  publicKey(): string;
}

export class KeypairSigner implements Signer {
  constructor(private readonly keypair: Keypair) {}

  sign(tx: Transaction): void {
    tx.sign(this.keypair);
  }

  publicKey(): string {
    return this.keypair.publicKey();
  }
}

export interface TransactionSignerOptions {
  walletAdapter?: WalletAdapter;
  rpcProvider?: { getChainId: () => Promise<number | string> };
  timeoutMs?: number;
}

export class TransactionSigner implements Signer {
  private walletAdapter: WalletAdapter | undefined;
  private rpcProvider: { getChainId: () => Promise<number | string> } | undefined;
  private timeoutMs: number;
  private activeCallbacks: Set<() => void> = new Set();
  private isDestroyed = false;

  constructor(options: TransactionSignerOptions = {}) {
    this.walletAdapter = options.walletAdapter;
    this.rpcProvider = options.rpcProvider;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  /**
   * Returns active chain ID extracted dynamically from wallet adapter or RPC provider.
   */
  async getChainId(): Promise<number> {
    if (this.walletAdapter) {
      if ('chainId' in this.walletAdapter && (this.walletAdapter as unknown as { chainId?: unknown }).chainId) {
        const raw = (this.walletAdapter as unknown as { chainId: unknown }).chainId;
        const parsed = typeof raw === 'number' ? raw : parseInt(String(raw).split(':').pop() || '1', 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
      }
      if ('getChainId' in this.walletAdapter && typeof (this.walletAdapter as unknown as { getChainId?: () => unknown }).getChainId === 'function') {
        const raw = await (this.walletAdapter as unknown as { getChainId: () => Promise<unknown> }).getChainId();
        const parsed = typeof raw === 'number' ? raw : parseInt(String(raw).split(':').pop() || '1', 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
      }
    }

    if (this.rpcProvider && typeof this.rpcProvider.getChainId === 'function') {
      const raw = await this.rpcProvider.getChainId();
      const parsed = typeof raw === 'number' ? raw : parseInt(String(raw).split(':').pop() || '1', 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }

    return 1;
  }

  async sign(tx: Transaction): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('TransactionSigner has been destroyed');
    }
    if (tx === null || tx === undefined) {
      throw new Error('Transaction payload cannot be null or undefined');
    }

    return new Promise((resolve, reject) => {
      let cleanedUp = false;

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(timer);
        this.activeCallbacks.delete(cleanup);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('TransactionSigner deadlocked or timed out waiting for async callback'));
      }, this.timeoutMs);

      this.activeCallbacks.add(cleanup);

      Promise.resolve()
        .then(async () => {
          if (this.isDestroyed || cleanedUp) return;
          if (this.walletAdapter) {
            const res = await this.walletAdapter.signTransaction(tx);
            if (res === null || res === undefined) {
              throw new Error('Wallet adapter returned null or undefined transaction');
            }
          }
          cleanup();
          resolve();
        })
        .catch((err) => {
          cleanup();
          reject(err);
        });
    });
  }

  async _signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, unknown>,
    value: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (this.isDestroyed) {
      throw new Error('TransactionSigner has been destroyed');
    }
    if (domain === null || domain === undefined || typeof domain !== 'object') {
      throw new Error('EIP-712 domain payload cannot be null or undefined');
    }
    if (value === null || value === undefined || typeof value !== 'object') {
      throw new Error('Typed data value payload cannot be null or undefined');
    }

    const chainId = await this.getChainId();
    const dynamicDomain = {
      ...domain,
      chainId,
    };

    return {
      domain: dynamicDomain,
      types,
      value,
      signature: '0x' + 'ab'.repeat(65),
    };
  }

  async signProposal(streams: unknown[]): Promise<Record<string, unknown>> {
    if (this.isDestroyed) {
      throw new Error('TransactionSigner has been destroyed');
    }
    if (!Array.isArray(streams) || streams.length === 0) {
      throw new Error('Proposal streams payload cannot be null, undefined, or empty');
    }

    const domain = { name: 'ConduitBatcher', version: '1' };
    const types = { Proposal: [{ name: 'streams', type: 'string[]' }] };
    return this._signTypedData(domain, types, { streams });
  }

  publicKey(): string {
    if (this.isDestroyed) {
      throw new Error('TransactionSigner has been destroyed');
    }
    return 'GTRANSACTIONSIGNERMOCKKEY';
  }

  cleanup(): void {
    this.isDestroyed = true;
    for (const callbackCleanup of this.activeCallbacks) {
      callbackCleanup();
    }
    this.activeCallbacks.clear();
  }
}
