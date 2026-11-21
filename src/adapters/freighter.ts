import { Transaction } from '@stellar/stellar-sdk';
import type { WalletAdapter, SignTransactionOptions } from './types.js';

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
  /**
   * Pushed wallet events, on injected clients that support them. Older
   * Freighter builds do not, in which case `watchWalletChanges()` polling is
   * used instead (#1187).
   */
  on?: (event: string, listener: (payload?: unknown) => void) => unknown;
  off?: (event: string, listener: (payload?: unknown) => void) => unknown;
  addEventListener?: (event: string, listener: (payload?: unknown) => void) => unknown;
  removeEventListener?: (event: string, listener: (payload?: unknown) => void) => unknown;
  onAccountChange?: (listener: (payload?: unknown) => void) => unknown;
  onNetworkChange?: (listener: (payload?: unknown) => void) => unknown;
  [key: string]: unknown;
}

/** Default polling interval for {@link FreighterWalletAdapter.watchWalletChanges}. */
export const DEFAULT_FREIGHTER_WATCH_INTERVAL_MS = 3_000;

/** Notification passed to `onWalletChange` listeners (#1187). */
export interface FreighterWalletChange {
  /**
   * `accountChanged`: the user switched accounts (or unlocked the wallet).
   * `locked`: Freighter no longer exposes an account. `networkChanged`: the
   * extension switched networks.
   */
  type: 'accountChanged' | 'locked' | 'networkChanged';
  /** The active public key afterwards, or null when the wallet is locked. */
  publicKey: string | null;
  /** The extension's active network passphrase, when it reports one. */
  networkPassphrase?: string;
}

export type FreighterAccountChangeListener = (publicKey: string | null) => void;
export type FreighterNetworkChangeListener = (
  networkPassphrase: string | null,
  details?: FreighterNetworkDetails,
) => void;

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
   * Called when the extension's active account or network changes, or the
   * wallet is locked. The adapter's cached state is already updated.
   */
  onWalletChange?: (change: FreighterWalletChange) => void;
  /** Convenience hook for account changes only. */
  onAccountChange?: FreighterAccountChangeListener;
  /** Convenience hook for network changes only. */
  onNetworkChange?: FreighterNetworkChangeListener;
}

/**
 * Normalizes the many payload shapes injected wallet events use into a G-address,
 * `null` when the wallet reports no account (locked / access revoked), or
 * `undefined` when the payload carries no usable signal.
 */
function normalizeAccountPayload(payload: unknown): string | null | undefined {
  if (typeof payload === 'string') return payload || null;
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (record['error'] || record['message']) return null;
  for (const key of ['address', 'publicKey', 'account']) {
    const value = record[key];
    if (typeof value === 'string') return value || null;
  }
  return undefined;
}

/** Extracts a network passphrase from a pushed event payload. */
function normalizeNetworkPayload(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload || undefined;
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ['networkPassphrase', 'passphrase', 'network']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * First-party Freighter wallet adapter.
 * Wraps the browser extension or injected `@stellar/freighter-api` instance.
 */
export class FreighterWalletAdapter implements WalletAdapter {
  private freighterClient: FreighterApi | null;
  private pubKey: string | null;
  public networkPassphrase: string | undefined;

  private readonly walletChangeListeners = new Set<(change: FreighterWalletChange) => void>();
  private readonly accountListeners = new Set<FreighterAccountChangeListener>();
  private readonly networkListeners = new Set<FreighterNetworkChangeListener>();
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private watchInFlight = false;
  private lastWalletNetwork: string | undefined;
  private lockObserved = false;
  private listenedClient: FreighterApi | null = null;
  private detachEventListeners: (() => void) | null = null;

  constructor(options: FreighterWalletAdapterOptions = {}) {
    this.freighterClient = (options.freighter as FreighterApi) ?? null;
    this.pubKey = options.publicKey ?? null;
    this.networkPassphrase = options.networkPassphrase;
    if (options.onWalletChange) this.walletChangeListeners.add(options.onWalletChange);
    if (options.onAccountChange) this.accountListeners.add(options.onAccountChange);
    if (options.onNetworkChange) this.networkListeners.add(options.onNetworkChange);
    if (this.freighterClient) this.attachWalletEventListeners();
  }

  /** Subscribe to account/network/lock changes. Returns an unsubscribe function. */
  onWalletChange(listener: (change: FreighterWalletChange) => void): () => void {
    this.walletChangeListeners.add(listener);
    return () => {
      this.walletChangeListeners.delete(listener);
    };
  }

  /** Subscribe to account changes only. Returns an unsubscribe function. */
  onAccountChange(listener: FreighterAccountChangeListener): () => void {
    this.accountListeners.add(listener);
    return () => {
      this.accountListeners.delete(listener);
    };
  }

  /** Subscribe to network changes only. Returns an unsubscribe function. */
  onNetworkChange(listener: FreighterNetworkChangeListener): () => void {
    this.networkListeners.add(listener);
    return () => {
      this.networkListeners.delete(listener);
    };
  }

  private notifyWalletChange(change: FreighterWalletChange): void {
    // Keep the adapter's own signing passphrase in step with the extension so
    // a subsequent signTransaction() cannot sign for the wrong network (#1187).
    if (change.type === 'networkChanged' && change.networkPassphrase) {
      this.networkPassphrase = change.networkPassphrase;
    }

    for (const listener of this.walletChangeListeners) {
      try {
        listener(change);
      } catch (handlerError) {
        console.warn('[conduit-sdk] Freighter onWalletChange handler error:', handlerError);
      }
    }

    if (change.type === 'accountChanged' || change.type === 'locked') {
      for (const listener of this.accountListeners) {
        try {
          listener(change.publicKey);
        } catch (handlerError) {
          console.warn('[conduit-sdk] Freighter onAccountChange handler error:', handlerError);
        }
      }
    } else {
      for (const listener of this.networkListeners) {
        try {
          listener(change.networkPassphrase ?? null);
        } catch (handlerError) {
          console.warn('[conduit-sdk] Freighter onNetworkChange handler error:', handlerError);
        }
      }
    }
  }

  /**
   * Start detecting wallet changes (#1187).
   *
   * Freighter does not reliably push account/network changes to the page, so
   * this polls the extension on an interval. If the injected client does
   * expose `accountChanged` / `networkChanged` events, those are subscribed to
   * as well for immediate notification. On any change the cached key and
   * passphrase are updated and listeners are notified.
   *
   * Idempotent. Returns a function that stops watching.
   */
  watchWalletChanges(intervalMs: number = DEFAULT_FREIGHTER_WATCH_INTERVAL_MS): () => void {
    this.attachWalletEventListeners();
    if (!this.watchTimer) {
      this.watchTimer = setInterval(() => {
        void this.syncWalletState();
      }, intervalMs);
    }
    return () => this.stopWatchingWalletChanges();
  }

  /** Stop the watcher started by {@link watchWalletChanges}. */
  stopWatchingWalletChanges(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    this.detachWalletEventListeners();
  }

  /**
   * Re-read the extension's active account and network once, updating cached
   * state and notifying listeners on any change. Called by the watcher on
   * every tick; safe to call directly (e.g. on window focus).
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
      if (address === undefined) return; // this Freighter version can't report it silently

      if (address === null) {
        if (this.pubKey !== null) {
          this.pubKey = null;
          this.lockObserved = true;
          this.notifyWalletChange({ type: 'locked', publicKey: null });
        }
        return;
      }

      if (address !== this.pubKey) {
        // A switch away from a known key, or an unlock after a lock, is a
        // change; the first silent read of an already-authorized key is not.
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

  /**
   * Subscribe to pushed `accountChanged` / `networkChanged` events when the
   * injected client supports them. Idempotent per client.
   */
  private attachWalletEventListeners(): void {
    let client = this.freighterClient;
    if (!client) {
      try {
        client = this.getClient();
      } catch {
        return;
      }
    }
    if (!client) return;
    if (this.listenedClient === client && this.detachEventListeners) return;

    const hasOn = typeof client.on === 'function';
    const hasAddEventListener = typeof client.addEventListener === 'function';
    const hasAccountHook = typeof client.onAccountChange === 'function';
    const hasNetworkHook = typeof client.onNetworkChange === 'function';
    if (!hasOn && !hasAddEventListener && !hasAccountHook && !hasNetworkHook) return;

    this.detachWalletEventListeners();

    const onAccount = (payload: unknown): void => {
      const address = normalizeAccountPayload(payload);
      if (address === null) {
        if (this.pubKey !== null) {
          this.pubKey = null;
          this.lockObserved = true;
          this.notifyWalletChange({ type: 'locked', publicKey: null });
        }
        return;
      }
      if (address && address !== this.pubKey) {
        this.pubKey = address;
        this.lockObserved = false;
        this.notifyWalletChange({ type: 'accountChanged', publicKey: address });
      }
    };

    const onNetwork = (payload: unknown): void => {
      const passphrase = normalizeNetworkPayload(payload);
      if (!passphrase) return;
      const changed = Boolean(this.lastWalletNetwork && passphrase !== this.lastWalletNetwork);
      this.lastWalletNetwork = passphrase;
      this.networkPassphrase = passphrase;
      if (changed) {
        this.notifyWalletChange({
          type: 'networkChanged',
          publicKey: this.pubKey,
          networkPassphrase: passphrase,
        });
      }
    };

    const unsubscribe: Array<() => void> = [];
    if (hasOn) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const on = client.on!;
      on.call(client, 'accountChanged', onAccount);
      on.call(client, 'networkChanged', onNetwork);
      unsubscribe.push(() => {
        if (typeof client.off === 'function') {
          client.off.call(client, 'accountChanged', onAccount);
          client.off.call(client, 'networkChanged', onNetwork);
        }
      });
    } else if (hasAddEventListener) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const add = client.addEventListener!;
      add.call(client, 'accountChanged', onAccount);
      add.call(client, 'networkChanged', onNetwork);
      unsubscribe.push(() => {
        if (typeof client.removeEventListener === 'function') {
          client.removeEventListener.call(client, 'accountChanged', onAccount);
          client.removeEventListener.call(client, 'networkChanged', onNetwork);
        }
      });
    }
    if (hasAccountHook) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      client.onAccountChange!(onAccount);
      unsubscribe.push(() => {
        // Freighter's hook API has no off(); nothing to clean up.
      });
    }
    if (hasNetworkHook) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      client.onNetworkChange!(onNetwork);
    }

    this.listenedClient = client;
    this.detachEventListeners = () => {
      for (const off of unsubscribe) off();
    };
  }

  private detachWalletEventListeners(): void {
    this.detachEventListeners?.();
    this.detachEventListeners = null;
    this.listenedClient = null;
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
    this.attachWalletEventListeners();
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

    if (!passphrase && typeof client.getNetworkDetails === 'function') {
      try {
        const details = await client.getNetworkDetails();
        passphrase = details?.networkPassphrase;
      } catch {
        // Ignore fallback error
      }
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
    const signResult = await client.signTransaction(xdrString, {
      networkPassphrase: passphrase,
      ...(accountToSign ? { accountToSign } : {}),
    });

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
