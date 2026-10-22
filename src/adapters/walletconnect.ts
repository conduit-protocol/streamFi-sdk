import { Transaction } from '@stellar/stellar-sdk';
import type { WalletAdapter, SignTransactionOptions } from './types.js';
import { CAIP2_TO_NETWORK } from '../errors.js';

export interface WalletConnectAppMetadata {
  name: string;
  description: string;
  url: string;
  icons: string[];
}

export interface WalletConnectSignClient {
  connect?: (opts: unknown) => Promise<{ session?: WalletConnectSession; approval?: () => Promise<WalletConnectSession> }>;
  disconnect?: (opts: unknown) => Promise<void>;
  request?: (opts: unknown) => Promise<unknown>;
  /** Event emitter surface of a WalletConnect v2 SignClient. */
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  off?: (event: string, listener: (...args: any[]) => void) => unknown;
  [key: string]: unknown;
}

/** Notification passed to `onSessionChange` when the wallet changes the session (#810). */
export interface WalletConnectSessionChange {
  type: 'accountsChanged' | 'chainChanged' | 'disconnected' | 'session_expired';
  /** The active public key afterwards, or null when the session is no longer usable. */
  publicKey: string | null;
}

export interface WalletConnectSession {
  topic?: string;
  account?: string;
  namespaces?: Record<string, { accounts?: string[] }>;
  accounts?: string[];
  [key: string]: unknown;
}

export interface WalletConnectAdapterOptions {
  /** WalletConnect v2 Project ID */
  projectId?: string;
  /**
   * CAIP-2 chain identifier (e.g., 'stellar:pubnet', 'stellar:testnet').
   * Must be one of: 'stellar:pubnet', 'stellar:testnet', 'stellar:local'.
   * Defaults to 'stellar:pubnet'.
   */
  chainId?: string | undefined;
  /** DApp metadata for WalletConnect modal/handshake */
  metadata?: WalletConnectAppMetadata;
  /** Optional pre-existing WalletConnect SignClient or provider instance */
  client?: WalletConnectSignClient | unknown;
  /** Optional active session object or mock session */
  session?: WalletConnectSession | unknown;
  /** Milliseconds to wait for the connect handshake before rejecting. Defaults to 30000. */
  connectTimeoutMs?: number;
  /**
   * Called when the wallet switches account or chain, or ends the session, so
   * an app can refresh its UI. The adapter has already updated (or dropped)
   * its session by the time this runs.
   */
  onSessionChange?: (change: WalletConnectSessionChange) => void;
  /**
   * Called when the wallet ends the session (`session_delete`, e.g. the user
   * disconnected from their mobile wallet) or it expires, so the UI can reset
   * immediately. The adapter's session is already cleared when this runs.
   * Not called for a local {@link WalletConnectAdapter.disconnect}.
   */
  onDisconnect?: (event: WalletConnectDisconnectEvent) => void;
  /**
   * Called with the pairing URI to render as a QR code whenever the client
   * emits `display_uri` — including with a fresh URI after an automatic
   * pairing refresh (#972).
   */
  onDisplayUri?: (uri: string) => void;
  /**
   * Called each time an expired pairing automatically triggers a fresh
   * pairing attempt during `connect()` (#972), so the UI can show that a new
   * QR code is on its way.
   */
  onPairingExpire?: () => void;
  /**
   * Number of times `connect()` automatically re-pairs (minting a fresh URI)
   * after the current pairing expires before the wallet approves it, instead
   * of requiring the caller to reload the page for a new QR code (#972).
   * Default 1. Set 0 to disable auto-refresh and reject immediately.
   */
  maxPairingRetries?: number;
}

/** Payload passed to `onDisconnect` (#918). */
export interface WalletConnectDisconnectEvent {
  reason: 'session_delete' | 'session_expire';
  /** Topic of the session that ended, when the wallet supplied it. */
  topic?: string;
}

/**
 * Native WalletConnect v2 adapter for mobile and browser-based wallet integration.
 * Supports Stellar / Soroban transaction signing via CAIP-2 RPC protocols.
 */
export class WalletConnectAdapter implements WalletAdapter {
  private readonly projectId?: string | undefined;
  public readonly chainId: string;
  private readonly metadata?: WalletConnectAppMetadata | undefined;
  private client: WalletConnectSignClient | null;
  private session: WalletConnectSession | null;
  private readonly connectTimeoutMs: number;
  private readonly onSessionChange: ((change: WalletConnectSessionChange) => void) | undefined;
  private readonly onDisplayUri: ((uri: string) => void) | undefined;
  private readonly onPairingExpire: (() => void) | undefined;
  private readonly maxPairingRetries: number;
  private readonly disconnectListeners = new Set<(event: WalletConnectDisconnectEvent) => void>();
  /** Removes the listeners attached by attachSessionListeners(), if any. */
  private detachListeners: (() => void) | null = null;
  private listenedClient: WalletConnectSignClient | null = null;

  constructor(options: WalletConnectAdapterOptions = {}) {
    this.projectId = options.projectId;
    const chainId  = options.chainId ?? 'stellar:pubnet';

    // Validate the CAIP-2 chain identifier at construction time so callers
    // get an immediate, descriptive error instead of a silent cross-chain
    // payload submission later (fixes #157).
    if (!(chainId in CAIP2_TO_NETWORK)) {
      const supported = Object.keys(CAIP2_TO_NETWORK).join(', ');
      throw new Error(
        `WalletConnectAdapter: unsupported chainId '${chainId}'. ` +
        `Supported chains: ${supported}.`,
      );
    }

    this.chainId   = chainId;
    this.metadata  = options.metadata;
    this.client    = (options.client as WalletConnectSignClient) ?? null;
    this.session   = (options.session as WalletConnectSession) ?? null;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30000;
    this.onSessionChange = options.onSessionChange;
    this.onDisplayUri = options.onDisplayUri;
    this.onPairingExpire = options.onPairingExpire;
    this.maxPairingRetries = options.maxPairingRetries ?? 1;
    if (options.onDisconnect) this.disconnectListeners.add(options.onDisconnect);
    if (this.session) this.attachSessionListeners();
  }

  /**
   * Set or update active session.
   */
  setSession(session: WalletConnectSession | unknown): void {
    this.session = (session as WalletConnectSession) ?? null;
    if (this.session) this.attachSessionListeners();
  }

  /**
   * Subscribes to the client's `session_event` (accountsChanged / chainChanged)
   * and `session_delete` events (#810). The connect request asks the wallet
   * for those events, so without listening the adapter would keep returning
   * the original account after the user switched account or network.
   * Idempotent per client.
   */
  private attachSessionListeners(): void {
    const client = this.client;
    if (!client || typeof client.on !== 'function') return;
    if (this.listenedClient === client && this.detachListeners) return;
    this.detachSessionListeners();

    const onSessionEvent = (args: unknown) => this.handleSessionEvent(args);
    const onSessionDelete = (args: unknown) => this.handleSessionDelete(args);
    const onSessionExpire = (args: unknown) => this.handleSessionExpire(args);
    client.on('session_event', onSessionEvent);
    client.on('session_delete', onSessionDelete);
    client.on('session_expire', onSessionExpire);

    this.listenedClient = client;
    this.detachListeners = () => {
      if (typeof client.off === 'function') {
        client.off('session_event', onSessionEvent);
        client.off('session_delete', onSessionDelete);
        client.off('session_expire', onSessionExpire);
      }
    };
  }

  private detachSessionListeners(): void {
    this.detachListeners?.();
    this.detachListeners = null;
    this.listenedClient = null;
  }

  /**
   * Register a listener for wallet-initiated disconnects (see
   * {@link WalletConnectAdapterOptions.onDisconnect}). Returns an unsubscribe function.
   */
  onDisconnect(listener: (event: WalletConnectDisconnectEvent) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  private notifyDisconnect(event: WalletConnectDisconnectEvent): void {
    for (const listener of this.disconnectListeners) {
      try {
        listener(event);
      } catch (handlerError) {
        console.warn('[conduit-sdk] WalletConnect onDisconnect handler error:', handlerError);
      }
    }
  }

  private notifySessionChange(change: WalletConnectSessionChange): void {
    try {
      this.onSessionChange?.(change);
    } catch (handlerError) {
      console.warn('[conduit-sdk] WalletConnect onSessionChange handler error:', handlerError);
    }
  }

  private handleSessionEvent(payload: unknown): void {
    const { topic, params } = (payload ?? {}) as {
      topic?: string;
      params?: { event?: { name?: string; data?: unknown } };
    };
    if (!this.session) return;
    // Ignore events for a different session.
    if (topic && this.session.topic && topic !== this.session.topic) return;

    const name = params?.event?.name;
    const data = params?.event?.data;

    if (name === 'accountsChanged') {
      const accounts = Array.isArray(data)
        ? data.filter((account): account is string => typeof account === 'string')
        : [];
      if (accounts.length === 0) {
        // The wallet revoked every account: the session is no longer usable.
        this.session = null;
        this.notifySessionChange({ type: 'accountsChanged', publicKey: null });
        return;
      }
      const stellar = this.session.namespaces?.['stellar'];
      this.session = {
        ...this.session,
        account: accounts[0] as string,
        accounts,
        namespaces: {
          ...this.session.namespaces,
          stellar: { ...stellar, accounts },
        },
      };
      this.notifySessionChange({
        type: 'accountsChanged',
        publicKey: this.getPublicKeyFromSession(),
      });
      return;
    }

    if (name === 'chainChanged') {
      // The adapter was validated for one chain; a session now on another chain
      // must not keep signing for it, so the session is dropped.
      if (typeof data === 'string' && data !== this.chainId) {
        this.session = null;
        this.notifySessionChange({ type: 'chainChanged', publicKey: null });
      }
    }
  }

  private handleSessionDelete(payload: unknown): void {
    const { topic } = (payload ?? {}) as { topic?: string };
    if (!this.session) return;
    if (topic && this.session.topic && topic !== this.session.topic) return;
    const endedTopic = topic ?? this.session.topic;
    this.session = null;
    this.notifySessionChange({ type: 'disconnected', publicKey: null });
    this.notifyDisconnect({ reason: 'session_delete', ...(endedTopic ? { topic: endedTopic } : {}) });
  }

  private handleSessionExpire(payload: unknown): void {
    const { topic } = (payload ?? {}) as { topic?: string };
    if (!this.session) return;
    if (topic && this.session.topic && topic !== this.session.topic) return;
    const endedTopic = topic ?? this.session.topic;
    this.session = null;
    this.notifySessionChange({ type: 'session_expired', publicKey: null });
    this.notifyDisconnect({ reason: 'session_expire', ...(endedTopic ? { topic: endedTopic } : {}) });
  }

  /**
   * Returns true if an active WalletConnect session exists.
   */
  isConnected(): boolean {
    return Boolean(this.session && this.getPublicKeyFromSession());
  }

  /**
   * Gets active public key from session or throws error if not connected.
   */
  async getPublicKey(): Promise<string> {
    const pubKey = this.getPublicKeyFromSession();
    if (!pubKey) {
      throw new Error('WalletConnect adapter is not connected. Call connect() first.');
    }
    return pubKey;
  }

  /**
   * Connect to wallet via WalletConnect v2 handshake or pairing.
   */
  async connect(): Promise<string> {
    if (this.isConnected()) {
      return this.getPublicKey();
    }

    if (this.client && typeof this.client.connect === 'function') {
      this.session = await this._connectWithPairingRefresh(this.maxPairingRetries);
    }

    const pubKey = this.getPublicKeyFromSession();
    if (!pubKey) {
      throw new Error('Failed to establish WalletConnect session or obtain public key.');
    }

    this.attachSessionListeners();

    return pubKey;
  }

  /**
   * Runs the connect handshake once, mints a fresh pairing (and URI) and
   * retries automatically if the current pairing expires before the wallet
   * approves it (#972) — up to `retriesRemaining` times — instead of leaving
   * the caller stuck on a dead QR code until `connectTimeoutMs` elapses.
   */
  private async _connectWithPairingRefresh(retriesRemaining: number): Promise<WalletConnectSession | null> {
    const client = this.client;
    if (!client || typeof client.connect !== 'function') return null;

    const hasEmitter = typeof client.on === 'function';
    const onUri = (uri: unknown) => {
      if (typeof uri === 'string') this._notifyDisplayUri(uri);
    };
    let pairingExpired = false;
    const onExpire = () => { pairingExpired = true; };

    if (hasEmitter) {
      client.on!('display_uri', onUri);
      client.on!('pairing_expire', onExpire);
    }

    try {
      const connectResult = await this._withTimeout(
        client.connect({
          requiredNamespaces: {
            stellar: {
              methods: ['stellar_signTransaction', 'stellar_signXdr', 'soroban_signTransaction'],
              chains: [this.chainId],
              events: ['accountsChanged', 'chainChanged'],
            },
          },
        }),
        'WalletConnect connect() handshake'
      );

      if (connectResult.session) {
        return connectResult.session;
      }
      if (!connectResult.approval) {
        return null;
      }

      try {
        return await this._withTimeout(connectResult.approval(), 'WalletConnect approval()');
      } catch (err) {
        if (pairingExpired && retriesRemaining > 0) {
          this.onPairingExpire?.();
          return this._connectWithPairingRefresh(retriesRemaining - 1);
        }
        throw err;
      }
    } finally {
      if (hasEmitter) {
        client.off?.('display_uri', onUri);
        client.off?.('pairing_expire', onExpire);
      }
    }
  }

  private _notifyDisplayUri(uri: string): void {
    try {
      this.onDisplayUri?.(uri);
    } catch (handlerError) {
      console.warn('[conduit-sdk] WalletConnect onDisplayUri handler error:', handlerError);
    }
  }

  /**
   * Races a network-bound promise against a timeout so that a dropped
   * connection during the handshake rejects cleanly instead of hanging
   * the init promise indefinitely (see #116).
   */
  private _withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${this.connectTimeoutMs}ms (possible network interruption)`));
      }, this.connectTimeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Disconnect the WalletConnect session.
   */
  async disconnect(): Promise<void> {
    const session = this.session;
    try {
      if (this.client && session && typeof this.client.disconnect === 'function') {
        await this._withTimeout(
          this.client.disconnect({
            topic: session.topic,
            reason: { code: 6000, message: 'User disconnected' },
          }),
          'WalletConnect disconnect()'
        );
      }
    } finally {
      this.session = null;
      this.detachSessionListeners();
    }
  }

  /**
   * Sign a transaction using WalletConnect v2 RPC call.
   *
   * @throws {Error} if networkPassphrase is not provided in opts
   */
  async signTransaction(
    tx: Transaction | string,
    opts?: SignTransactionOptions,
  ): Promise<Transaction | string> {
    const pubKey = await this.getPublicKey();
    const xdrString = typeof tx === 'string' ? tx : tx.toXDR();
    const passphrase = opts?.networkPassphrase;

    if (!passphrase) {
      throw new Error(
        'networkPassphrase is required for signTransaction. ' +
        'Pass it via opts.networkPassphrase or configure it at adapter construction time.'
      );
    }

    if (!this.client || typeof this.client.request !== 'function') {
      throw new Error('WalletConnect SignClient request handler is not available.');
    }

    const topic = this.session?.topic;
    if (!topic) {
      throw new Error('No active WalletConnect session topic found.');
    }

    // Send RPC request via WalletConnect v2
    const result = await this.client.request({
      topic,
      chainId: this.chainId,
      request: {
        method: 'stellar_signTransaction',
        params: {
          xdr: xdrString,
          accountToSign: opts?.accountToSign ?? pubKey,
          networkPassphrase: passphrase,
        },
      },
    });

    const resRecord = result as Record<string, unknown> | string | undefined;
    const signedXdr = typeof resRecord === 'string'
      ? resRecord
      : (resRecord?.['signedXdr'] ?? resRecord?.['xdr'] ?? resRecord);

    if (typeof signedXdr !== 'string') {
      throw new Error('WalletConnect response did not return valid signed XDR.');
    }

    if (typeof tx === 'string') {
      return signedXdr;
    }

    return new Transaction(signedXdr, passphrase);
  }

  /**
   * Extract account public key from CAIP-10 address format in WalletConnect session.
   * e.g., 'stellar:pubnet:GABC123...' -> 'GABC123...'
   * Uses safe fallback handling with nullish coalescing to prevent crashes from malformed formats.
   */
  private getPublicKeyFromSession(): string | null {
    if (!this.session) return null;

    // Direct account string on session
    if (typeof this.session.account === 'string') {
      return this.session.account.includes(':')
        ? this.session.account.split(':').at(-1) ?? this.session.account
        : this.session.account;
    }

    // CAIP-10 accounts in namespaces
    const namespaces = this.session.namespaces;
    if (namespaces && namespaces['stellar'] && Array.isArray(namespaces['stellar'].accounts)) {
      const fullAccount = namespaces['stellar'].accounts[0];
      if (fullAccount) {
        return fullAccount.includes(':') ? fullAccount.split(':').at(-1) ?? fullAccount : fullAccount;
      }
    }

    // Fallback: direct accounts array
    if (Array.isArray(this.session.accounts) && this.session.accounts[0]) {
      const fullAccount = this.session.accounts[0];
      return fullAccount.includes(':') ? fullAccount.split(':').at(-1) ?? fullAccount : fullAccount;
    }

    return null;
  }
}
