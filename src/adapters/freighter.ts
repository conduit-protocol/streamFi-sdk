import { Transaction } from '@stellar/stellar-sdk';
import type { WalletAdapter, SignTransactionOptions } from './types.js';
import { NetworkMismatchError, WalletTimeoutError } from '../errors.js';

/** Default time (ms) to wait for Freighter to resolve a `signTransaction` call before rejecting with {@link WalletTimeoutError}. */
export const DEFAULT_FREIGHTER_SIGN_TIMEOUT_MS = 60_000;

/**
 * Races `pending` against a timer so a Freighter popup the user ignores or
 * closes without responding cannot leave `signTransaction`'s caller hanging
 * indefinitely (#970). Set `timeoutMs` to `0` or `Infinity` to disable.
 */
function withWalletTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return pending;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WalletTimeoutError('freighter', timeoutMs)), timeoutMs);
    pending.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export interface FreighterNetworkDetails {
  network?: string;
  networkPassphrase?: string;
  networkUrl?: string;
}

export interface FreighterApi {
  isConnected?: () => Promise<boolean> | boolean;
  isAllowed?: () => Promise<boolean> | boolean;
  requestAccess?: () => Promise<string>;
  getPublicKey?: () => Promise<string>;
  getAddress?: () => Promise<{ address?: string; error?: string } | string>;
  signTransaction?: (
    xdr: string,
    opts?: { network?: string; networkPassphrase?: string; accountToSign?: string },
  ) => Promise<string | { signedTxXdr?: string; error?: string }>;
  getNetwork?: () => Promise<string>;
  getNetworkDetails?: () => Promise<FreighterNetworkDetails>;
  [key: string]: unknown;
}

export interface FreighterWalletAdapterOptions {
  /**
   * Pre-injected or custom Freighter API implementation.
   * If omitted, defaults to `window.freighter` or global `freighter` if available.
   */
  freighter?: FreighterApi | unknown;
  /**
   * Pre-set public key if already authenticated.
   */
  publicKey?: string;
  /**
   * Default Stellar network passphrase.
   */
  networkPassphrase?: string;
  /**
   * Max time (ms) to wait for Freighter's `signTransaction` to resolve
   * before rejecting with {@link WalletTimeoutError} — e.g. the user left
   * the popup open without approving or closing it (#970). Default 60000.
   * Set to `0` or `Infinity` to wait indefinitely.
   */
  signTimeoutMs?: number;
  /**
   * Called when the extension's active account or network changes, or the
   * wallet is locked, while {@link FreighterWalletAdapter.watchWalletChanges}
   * is running (#1078). The adapter's cached public key is already updated.
   */
  onWalletChange?: (change: FreighterWalletChange) => void;
}

/** Default polling interval for {@link FreighterWalletAdapter.watchWalletChanges}. */
export const DEFAULT_FREIGHTER_WATCH_INTERVAL_MS = 3_000;

/** Notification passed to `onWalletChange` (#1078). */
export interface FreighterWalletChange {
  /**
   * `accountChanged`: the user switched accounts. `locked`: Freighter no
   * longer exposes an account (locked, or access revoked). `networkChanged`:
   * the extension switched networks.
   */
  type: 'accountChanged' | 'locked' | 'networkChanged';
  /** The active public key afterwards, or null when locked. */
  publicKey: string | null;
  /** The extension's active network passphrase, when it reports one. */
  networkPassphrase?: string;
}

/**
 * First-party Freighter wallet adapter.
 * Wraps the browser extension or injected `@stellar/freighter-api` instance.
 */
export class FreighterWalletAdapter implements WalletAdapter {
  private freighterClient: FreighterApi | null;
  private pubKey: string | null;
  public networkPassphrase: string | undefined;
  private readonly signTimeoutMs: number;
  private readonly walletChangeListeners = new Set<(change: FreighterWalletChange) => void>();
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private watchInFlight = false;
  private lastWalletNetwork: string | undefined;
  private lockObserved = false;

  constructor(options: FreighterWalletAdapterOptions = {}) {
    this.freighterClient = (options.freighter as FreighterApi) ?? null;
    this.pubKey = options.publicKey ?? null;
    this.networkPassphrase = options.networkPassphrase;
    this.signTimeoutMs = options.signTimeoutMs ?? DEFAULT_FREIGHTER_SIGN_TIMEOUT_MS;
    if (options.onWalletChange) this.walletChangeListeners.add(options.onWalletChange);
  }

  /**
   * Register a listener for account/network/lock changes (see
   * {@link FreighterWalletAdapterOptions.onWalletChange}). Returns an unsubscribe function.
   */
  onWalletChange(listener: (change: FreighterWalletChange) => void): () => void {
    this.walletChangeListeners.add(listener);
    return () => {
      this.walletChangeListeners.delete(listener);
    };
  }

  private notifyWalletChange(change: FreighterWalletChange): void {
    for (const listener of this.walletChangeListeners) {
      try {
        listener(change);
      } catch (handlerError) {
        console.warn('[conduit-sdk] Freighter onWalletChange handler error:', handlerError);
      }
    }
  }

  /**
   * Start polling the extension for account and network changes (#1078).
   *
   * Freighter does not push events to the page when the user locks the
   * extension or switches accounts, so without this the adapter keeps its
   * cached public key and later signs for an account the wallet no longer
   * has active — failing with a signature mismatch. Each poll re-reads the
   * active address and network; on a change the cached key is updated (or
   * cleared when locked) and `onWalletChange` listeners are notified.
   *
   * Idempotent. Returns a function that stops watching.
   */
  watchWalletChanges(intervalMs: number = DEFAULT_FREIGHTER_WATCH_INTERVAL_MS): () => void {
    if (!this.watchTimer) {
      this.watchTimer = setInterval(() => {
        void this.syncWalletState();
      }, intervalMs);
    }
    return () => this.stopWatchingWalletChanges();
  }

  /** Stop the poller started by {@link watchWalletChanges}. */
  stopWatchingWalletChanges(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  /**
   * Re-read the extension's active account and network once, updating the
   * cached public key and notifying listeners on any change. Called by the
   * watcher on every tick; safe to call directly (e.g. on window focus).
   */
  async syncWalletState(): Promise<void> {
    if (this.watchInFlight) return;
    this.watchInFlight = true;
    try {
      let client: FreighterApi;
      try {
        client = this.getClient();
      } catch {
        return;
      }

      const address = await this.readActiveAddress(client);
      if (address === undefined) return; // the extension can't report it: no signal

      if (address === null) {
        if (this.pubKey !== null) {
          this.pubKey = null;
          this.lockObserved = true;
          this.notifyWalletChange({ type: 'locked', publicKey: null });
        }
        return;
      }

      if (address !== this.pubKey) {
        // Announce a switch away from a known key, or an unlock after a lock;
        // the very first silent read of an already-authorised key is not a change.
        const announce = this.pubKey !== null || this.lockObserved;
        this.pubKey = address;
        this.lockObserved = false;
        if (announce) this.notifyWalletChange({ type: 'accountChanged', publicKey: address });
      }

      if (typeof client.getNetworkDetails === 'function') {
        let walletNetwork: string | undefined;
        try {
          walletNetwork = (await client.getNetworkDetails())?.networkPassphrase;
        } catch {
          walletNetwork = undefined;
        }
        if (walletNetwork && this.lastWalletNetwork && walletNetwork !== this.lastWalletNetwork) {
          this.notifyWalletChange({
            type: 'networkChanged',
            publicKey: this.pubKey,
            networkPassphrase: walletNetwork,
          });
        }
        if (walletNetwork) this.lastWalletNetwork = walletNetwork;
      }
    } finally {
      this.watchInFlight = false;
    }
  }

  /**
   * The extension's active address without prompting the user: a G-address,
   * `null` when it reports no account (locked / access revoked), or
   * `undefined` when this Freighter version can't be queried silently.
   */
  private async readActiveAddress(client: FreighterApi): Promise<string | null | undefined> {
    if (typeof client.getAddress === 'function') {
      try {
        const res = await client.getAddress();
        if (typeof res === 'string') return res || null;
        if (res?.error) return null;
        return res?.address || null;
      } catch {
        return null;
      }
    }
    if (typeof client.getPublicKey === 'function') {
      try {
        return (await client.getPublicKey()) || null;
      } catch {
        return null;
      }
    }
    return undefined;
  }

  private getClient(): FreighterApi {
    if (this.freighterClient) {
      return this.freighterClient;
    }

    if (typeof globalThis !== 'undefined') {
      const win = globalThis as unknown as { freighter?: FreighterApi; stellar?: FreighterApi };
      if (win.freighter) {
        return win.freighter;
      }
      if (win.stellar) {
        return win.stellar;
      }
    }

    if (typeof globalThis !== 'undefined') {
      const glob = globalThis as unknown as { freighter?: FreighterApi };
      if (glob.freighter) return glob.freighter;
    }

    throw new Error('Freighter wallet API not detected. Please install Freighter browser extension.');
  }

  /**
   * Checks if Freighter is currently connected / active account is known.
   */
  isConnected(): boolean {
    return Boolean(this.pubKey);
  }

  /**
   * Returns the Stellar public key / G-address of the active account.
   */
  async getPublicKey(): Promise<string> {
    if (this.pubKey) {
      return this.pubKey;
    }

    const client = this.getClient();
    let key: string | undefined;

    if (typeof client.getPublicKey === 'function') {
      try {
        key = await client.getPublicKey();
      } catch {
        // Fall back to getAddress or requestAccess
      }
    }

    if (!key && typeof client.getAddress === 'function') {
      try {
        const res = await client.getAddress();
        key = typeof res === 'string' ? res : res?.address;
      } catch {
        // Fall back to requestAccess
      }
    }

    if (!key && typeof client.requestAccess === 'function') {
      try {
        key = await client.requestAccess();
      } catch {
        // No access granted yet
      }
    }

    if (!key) {
      throw new Error('Freighter wallet is not connected. Call connect() first.');
    }

    this.pubKey = key;
    return key;
  }

  /**
   * Connects to Freighter by requesting access from the extension.
   */
  async connect(): Promise<string> {
    const client = this.getClient();

    let key: string | undefined;
    if (typeof client.requestAccess === 'function') {
      key = await client.requestAccess();
    } else if (typeof client.getPublicKey === 'function') {
      key = await client.getPublicKey();
    } else if (typeof client.getAddress === 'function') {
      const res = await client.getAddress();
      key = typeof res === 'string' ? res : res?.address;
    }

    if (!key) {
      throw new Error('Failed to obtain public key from Freighter wallet.');
    }

    this.pubKey = key;
    return key;
  }

  /**
   * Disconnects the wallet adapter session.
   */
  async disconnect(): Promise<void> {
    this.stopWatchingWalletChanges();
    this.pubKey = null;
  }

  /**
   * Signs a Soroban/Stellar transaction via Freighter extension.
   *
   * @throws {NetworkMismatchError} if Freighter's active network passphrase
   *   differs from the one the transaction is being signed for.
   */
  async signTransaction(
    tx: Transaction | string,
    opts?: SignTransactionOptions,
  ): Promise<Transaction | string> {
    const client = this.getClient();
    const xdrString = typeof tx === 'string' ? tx : tx.toXDR();

    let passphrase = opts?.networkPassphrase ?? this.networkPassphrase;
    if (!passphrase && typeof tx !== 'string' && tx.networkPassphrase) {
      passphrase = tx.networkPassphrase;
    }

    // The wallet's active network: used as a fallback passphrase, and to catch
    // a wallet on Testnet while the client targets Mainnet (or vice versa)
    // before the user is prompted to sign (#916).
    let walletPassphrase: string | undefined;
    if (typeof client.getNetworkDetails === 'function') {
      try {
        const details = await client.getNetworkDetails();
        walletPassphrase = details?.networkPassphrase;
      } catch {
        // Older Freighter versions / restricted contexts: skip the check
      }
    }

    if (!passphrase) {
      passphrase = walletPassphrase;
    } else if (walletPassphrase && walletPassphrase !== passphrase) {
      throw new NetworkMismatchError(passphrase, walletPassphrase);
    }

    if (!passphrase) {
      throw new Error(
        'networkPassphrase is required to sign transactions with Freighter. ' +
        'Pass { networkPassphrase } in opts or constructor options.',
      );
    }

    if (typeof client.signTransaction !== 'function') {
      throw new Error('Freighter client does not support signTransaction.');
    }

    const accountToSign = opts?.accountToSign ?? this.pubKey;
    const signResult = await withWalletTimeout(
      client.signTransaction(xdrString, {
        networkPassphrase: passphrase,
        ...(accountToSign ? { accountToSign } : {}),
      }),
      this.signTimeoutMs,
    );

    let signedXdr: string | undefined;
    if (typeof signResult === 'string') {
      signedXdr = signResult;
    } else if (signResult && typeof signResult === 'object') {
      if (signResult.error) {
        throw new Error(`Freighter signing failed: ${signResult.error}`);
      }
      signedXdr = signResult.signedTxXdr;
    }

    if (!signedXdr || typeof signedXdr !== 'string') {
      throw new Error('Freighter signing did not return valid signed XDR.');
    }

    if (typeof tx === 'string') {
      return signedXdr;
    }

    return new Transaction(signedXdr, passphrase);
  }
}
