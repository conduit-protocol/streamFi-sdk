/**
 * FactoryModule — DripFactory read queries.
 */

import { nativeToScVal, xdr, Address } from '@stellar/stellar-sdk';
import type { ConduitConfig } from './types/index.js';
import type { WalletAdapter } from './adapters/types.js';
import { KeypairWalletAdapter } from './adapters/keypair.js';
import { ZERO_ADDR, DEFAULT_LIST_LIMIT, clampListLimit, clampOffset } from './constants.js';
import {
  buildContractCallTx,
  simulateReadOnly,
  scValToU64,
  scValToU32,
  NETWORK_PASSPHRASE,
  DEFAULT_RPC,
} from './soroban.js';
import { SUPPORTED_NETWORKS, UnsupportedChainError } from './errors.js';

/**
 * A `null` (not-found) `streamAddress` result is cached only briefly — a
 * stream id that is pending or whose `StreamAddr` registry entry is archived
 * (streamFi-contracts #407) may become resolvable later without a
 * `clearAddressCache()` (#568). A *found* address is immutable and cached
 * for the module's lifetime.
 */
const NEGATIVE_ADDRESS_CACHE_TTL_MS = 30_000;

export class FactoryModule {
  private readonly rpcUrl:      string;
  private readonly passphrase:  string;
  private readonly factoryId:   string;

  /**
   * Active wallet adapter, if the client was configured with `wallet` (or a
   * `keypair`, wrapped). Used to resolve the read-simulation source address
   * lazily — see {@link _resolveCallerAddress} (#570).
   */
  private activeWallet?: WalletAdapter;

  /**
   * Cached caller address, populated on first resolution and invalidated on
   * {@link setWallet}. Mirrors `StreamsModule._resolveCallerAddress` so the
   * same logical "who is calling" resolves identically across modules.
   */
  private _cachedCallerAddr: string | null = null;

  // streamId -> contract address. A resolved (non-null) address is immutable
  // and cached for the module's lifetime; a `null` result is cached with a
  // short TTL (see NEGATIVE_ADDRESS_CACHE_TTL_MS) so a dashboard polling
  // list() over a page with a few archived/pending ids does not re-issue a
  // stream_address simulation for each of them on every refresh (#568).
  private readonly addressCache = new Map<string, string | null>();
  private readonly negativeCacheExpiry = new Map<string, number>();
  private _cacheHits = 0;
  private _cacheMisses = 0;

  constructor(private readonly config: ConduitConfig) {
    // Guard against direct construction with an unsupported network, which
    // would bypass the ConduitClient validation gate and produce a confusing
    // StrKey error deep inside stellar-sdk (fixes #157).
    if (!(SUPPORTED_NETWORKS as readonly string[]).includes(config.network)) {
      throw new UnsupportedChainError(config.network);
    }
    this.rpcUrl     = config.rpcUrl     ?? DEFAULT_RPC[config.network];
    this.passphrase = NETWORK_PASSPHRASE[config.network];
    // There is no known default DripFactory deployment for any network —
    // shipping a placeholder string here means callers who forget to set
    // this fail deep inside @stellar/stellar-sdk with a confusing StrKey
    // error instead of a clear one at construction time.
    if (!config.factoryAddress) {
      throw new Error(
        `ConduitConfig.factoryAddress is required (no default DripFactory is known for network "${config.network}").`,
      );
    }
    this.factoryId  = config.factoryAddress;

    if (config.wallet) {
      this.activeWallet = config.wallet;
    } else if (config.keypair) {
      this.activeWallet = new KeypairWalletAdapter(config.keypair);
    }
  }

  /**
   * Dynamically set or update the active wallet adapter, invalidating the
   * cached caller address so it is re-resolved on next use (#570). Mirrors
   * `StreamsModule.setWallet`.
   */
  setWallet(wallet: WalletAdapter): void {
    this.activeWallet = wallet;
    this._cachedCallerAddr = null;
  }

  /**
   * Resolve the read-simulation source address, consulting the wallet
   * adapter (which may be async, e.g. a browser extension or hardware
   * device) rather than pinning `keypair?.publicKey() ?? ZERO_ADDR` at
   * construction time (#570). Cached after first resolution once a valid
   * public key is resolved; does not cache null/ZERO_ADDR (#562);
   * invalidated by {@link setWallet}. Falls back to `ZERO_ADDR` — Soroban
   * does not require a real source account for a read-only simulation.
   */
  private async _resolveCallerAddress(): Promise<string> {
    if (this._cachedCallerAddr !== null) {
      return this._cachedCallerAddr;
    }
    let addr: string;
    if (this.activeWallet) {
      const pk = await this.activeWallet.getPublicKey();
      if (pk && pk !== ZERO_ADDR) {
        this._cachedCallerAddr = pk;
        return pk;
      }
      return ZERO_ADDR;
    } else if (this.config.signer) {
      addr = this.config.signer.publicKey();
    } else if (this.config.keypair) {
      addr = this.config.keypair.publicKey();
    } else {
      addr = ZERO_ADDR;
    }
    if (addr && addr !== ZERO_ADDR) {
      this._cachedCallerAddr = addr;
    }
    return addr;
  }

  /** Drop all cached stream-address resolutions (positive and negative). */
  clearAddressCache(): void {
    this.addressCache.clear();
    this.negativeCacheExpiry.clear();
    this._cacheHits = 0;
    this._cacheMisses = 0;
  }

  /**
   * Returns address-cache hit/miss metrics so consumers can tune cache size.
   */
  getCacheMetrics(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this._cacheHits + this._cacheMisses;
    return {
      hits:     this._cacheHits,
      misses:   this._cacheMisses,
      size:     this.addressCache.size,
      hitRate:  total > 0 ? this._cacheHits / total : 0,
    };
  }

  /** Total number of streams ever created through this factory. */
  async streamCount(): Promise<bigint> {
    const caller = await this._resolveCallerAddress();
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, caller,
      this.factoryId, 'stream_count', [],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return scValToU64(val);
  }

  /** Resolve a stream ID to its deployed contract address. Returns null if not found. */
  async streamAddress(streamId: bigint | string): Promise<string | null> {
    const id  = BigInt(streamId);
    const key = id.toString();

    const cached = this.addressCache.get(key);
    if (cached !== undefined) {
      if (cached !== null) { this._cacheHits++; return cached; }
      // Negative hit — honour it only while its TTL is live (#568).
      const expiresAt = this.negativeCacheExpiry.get(key) ?? 0;
      if (Date.now() < expiresAt) { this._cacheHits++; return null; }
      this.addressCache.delete(key);
      this.negativeCacheExpiry.delete(key);
    }
    this._cacheMisses++;

    const caller = await this._resolveCallerAddress();
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, caller,
      this.factoryId, 'stream_address',
      [nativeToScVal(id, { type: 'u64' })],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);

    // Contract returns Option<Address> — void = None
    if (val.switch().name === 'scvVoid') {
      this._cacheNegative(key);
      return null;
    }
    try {
      const addr = Address.fromScVal(val).toString();
      this.addressCache.set(key, addr);
      return addr;
    } catch {
      this._cacheNegative(key);
      return null;
    }
  }

  private _cacheNegative(key: string): void {
    this.addressCache.set(key, null);
    this.negativeCacheExpiry.set(key, Date.now() + NEGATIVE_ADDRESS_CACHE_TTL_MS);
  }

  /**
   * List stream IDs where `address` is the sender, paginated.
   * `limit` is clamped to `[0, 100]` (see README) — the contract does not
   * enforce this itself, so an out-of-range value is silently clamped rather
   * than sent through as-is (see #489).
   */
  async streamsBySender(address: string, offset = 0, limit = DEFAULT_LIST_LIMIT): Promise<bigint[]> {
    const caller = await this._resolveCallerAddress();
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, caller,
      this.factoryId, 'streams_by_sender',
      [
        new Address(address).toScVal(),
        nativeToScVal(clampOffset(offset), { type: 'u32' }),
        nativeToScVal(clampListLimit(limit), { type: 'u32' }),
      ],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return this.parseU64Vec(val);
  }

  /**
   * List stream IDs where `address` is the recipient, paginated.
   * `limit` is clamped to `[0, 100]` (see README) — the contract does not
   * enforce this itself, so an out-of-range value is silently clamped rather
   * than sent through as-is (see #489).
   */
  async streamsByRecipient(address: string, offset = 0, limit = DEFAULT_LIST_LIMIT): Promise<bigint[]> {
    const caller = await this._resolveCallerAddress();
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, caller,
      this.factoryId, 'streams_by_recipient',
      [
        new Address(address).toScVal(),
        nativeToScVal(clampOffset(offset), { type: 'u32' }),
        nativeToScVal(clampListLimit(limit), { type: 'u32' }),
      ],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return this.parseU64Vec(val);
  }

  /** Current protocol fee in basis points (e.g. 30 = 0.3%). */
  async protocolFeeBps(): Promise<number> {
    const caller = await this._resolveCallerAddress();
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, caller,
      this.factoryId, 'protocol_fee_bps', [],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return scValToU32(val);
  }

  private parseU64Vec(val: xdr.ScVal): bigint[] {
    const items = val.vec();
    if (!items) return [];
    return items.map(v => scValToU64(v));
  }
}
