import {
  Address,
  Asset,
  Transaction,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import type {
  ConduitConfig,
  TrustlineCheckOptions,
  TrustlineCheckResult,
} from './types/index.js';
import type { WalletAdapter } from './adapters/types.js';
import type { Signer } from './signer.js';
import { KeypairWalletAdapter } from './adapters/keypair.js';
import { USDC_ISSUER, ZERO_ADDR } from './constants.js';
import {
  buildContractCallTx,
  clearTokenDecimalsCache,
  DEFAULT_RPC,
  getServer,
  getTokenDecimals,
  invokeContract,
  NETWORK_PASSPHRASE,
  resolveFee,
  scValToI128,
  scValToString,
  simulateReadOnly,
} from './soroban.js';
import { LruMemoCache } from './lru-memo-cache.js';
import type { MemoCacheMetrics } from './lru-memo-cache.js';
import { MissingTrustlineError } from './errors.js';

/** Default number of token metadata entries kept per LRU cache. */
export const DEFAULT_TOKEN_METADATA_CACHE_SIZE = 256;

/** Optional constructor knobs for {@link TokenModule}. */
export interface TokenModuleOptions {
  /** Max decimals/symbol entries to cache per cache. Defaults to 256. */
  metadataCacheSize?: number;
}

/** Minimal shape of a classic Stellar balance line returned by `getAccount`. */
interface ClassicBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
  limit?: string;
}

/** Stellar Asset Contracts (native XLM, classic assets like USDC) always use 7 decimals. */
const STELLAR_ASSET_DECIMALS = 7;

/** SEP-41 token allowance queries and approvals. */
export class TokenModule {
  private readonly rpcUrl: string;
  private readonly passphrase: string;
  private readonly fee: string;
  private activeWallet?: WalletAdapter;
  /**
   * Decimals known without an RPC call, keyed by token contract id (#1085).
   * Seeded with native XLM and the network's canonical USDC; extend it with
   * {@link registerDecimals}.
   */
  private readonly knownDecimals = new Map<string, number>();

  /**
   * Immutable SEP-41 metadata (`decimals()` / `symbol()`) is queried far more
   * often than it changes. Bounded LRU caches keep repeat lookups off the
   * network without letting a large portfolio grow the cache without limit.
   */
  private readonly decimalsCache: LruMemoCache<string, number>;
  private readonly symbolCache: LruMemoCache<string, string>;

  /**
   * In-flight de-duplication: concurrent lookups for the same token share a
   * single simulation. Entries are removed on settlement (success or failure)
   * so a failed simulation is retried on the next call.
   */
  private readonly decimalsInFlight = new Map<string, Promise<number>>();
  private readonly symbolInFlight = new Map<string, Promise<string>>();

  constructor(private readonly config: ConduitConfig, options: TokenModuleOptions = {}) {
    this.rpcUrl = config.rpcUrl ?? DEFAULT_RPC[config.network];
    this.passphrase = NETWORK_PASSPHRASE[config.network];
    this.fee = resolveFee(config);

    const cacheSize = Math.max(1, Math.floor(options.metadataCacheSize ?? DEFAULT_TOKEN_METADATA_CACHE_SIZE));
    this.decimalsCache = new LruMemoCache<string, number>(cacheSize);
    this.symbolCache = new LruMemoCache<string, string>(cacheSize);

    if (config.wallet) {
      this.activeWallet = config.wallet;
    } else if (config.keypair) {
      this.activeWallet = new KeypairWalletAdapter(config.keypair);
    }

    this.knownDecimals.set(Asset.native().contractId(this.passphrase), STELLAR_ASSET_DECIMALS);
    if (config.network === 'mainnet' || config.network === 'testnet') {
      const usdc = new Asset('USDC', USDC_ISSUER[config.network]);
      this.knownDecimals.set(usdc.contractId(this.passphrase), STELLAR_ASSET_DECIMALS);
    }
  }

  /**
   * Decimals for `tokenAddress` (#1085).
   *
   * Native XLM, the network's USDC, and anything passed to
   * {@link registerDecimals} resolve with no RPC call. Any other token is
   * queried once via its `decimals()` and then served from this module's
   * bounded LRU metadata cache, so repeated balance formatting never
   * re-queries it. Concurrent lookups coalesce onto one in-flight simulation.
   *
   * @param callerAddress - Source account for the read-only simulation.
   *   Defaults to the connected wallet / signer, or a zero address.
   */
  async decimals(tokenAddress: string, callerAddress?: string): Promise<number> {
    const known = this.knownDecimals.get(tokenAddress);
    if (known !== undefined) return known;
    return this.loadMetadata(
      this.decimalsCache,
      this.decimalsInFlight,
      tokenAddress,
      (caller) => getTokenDecimals(this.rpcUrl, this.passphrase, caller, tokenAddress),
      callerAddress,
    );
  }

  /** Record `decimals` for `tokenAddress` so {@link decimals} never queries the RPC for it. */
  registerDecimals(tokenAddress: string, decimals: number): void {
    assertDecimals(decimals);
    this.knownDecimals.set(tokenAddress, decimals);
  }

  /**
   * Format a raw on-chain balance of `tokenAddress` for display, looking up
   * its decimals via {@link decimals} (cached) and formatting with
   * {@link formatTokenAmount}.
   */
  async formatBalance(
    rawAmount: bigint | string,
    tokenAddress: string,
    locale?: string,
  ): Promise<string> {
    return formatTokenAmount(rawAmount, await this.decimals(tokenAddress), locale);
  }

  private async defaultCaller(): Promise<string> {
    if (this.activeWallet) return this.activeWallet.getPublicKey();
    if (this.config.signer) return this.config.signer.publicKey();
    return ZERO_ADDR;
  }

  /** Replace the wallet used to sign future token approvals. */
  setWallet(wallet: WalletAdapter): void {
    this.activeWallet = wallet;
  }

  /** Read the amount `spenderAddress` may transfer from `ownerAddress`. */
  async allowance(
    tokenAddress: string,
    ownerAddress: string,
    spenderAddress: string,
    signal?: AbortSignal,
  ): Promise<bigint> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const tx = await buildContractCallTx(
      this.rpcUrl,
      this.passphrase,
      ownerAddress,
      tokenAddress,
      'allowance',
      [new Address(ownerAddress).toScVal(), new Address(spenderAddress).toScVal()],
      this.fee,
    );
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const value = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return scValToI128(value);
  }

  /**
   * Set the SEP-41 allowance for `spenderAddress`.
   *
   * `expirationLedger` is the last ledger on which the allowance remains
   * valid. Pass `0` only when setting `amount` to `0` to revoke an allowance.
   */
  async approve(
    tokenAddress: string,
    ownerAddress: string,
    spenderAddress: string,
    amount: bigint,
    expirationLedger: number,
  ): Promise<string> {
    if (amount < 0n) throw new RangeError('amount must be greater than or equal to 0');
    if (!Number.isInteger(expirationLedger) || expirationLedger < 0 || expirationLedger > 0xFFFFFFFF) {
      throw new RangeError('expirationLedger must be a u32 integer');
    }

    const signer = await this.signerFor(ownerAddress);
    const tx = await buildContractCallTx(
      this.rpcUrl,
      this.passphrase,
      ownerAddress,
      tokenAddress,
      'approve',
      [
        new Address(ownerAddress).toScVal(),
        new Address(spenderAddress).toScVal(),
        nativeToScVal(amount, { type: 'i128' }),
        nativeToScVal(expirationLedger, { type: 'u32' }),
      ],
      this.fee,
    );
    return invokeContract(this.rpcUrl, this.passphrase, signer, tx);
  }

  // ── Cached token metadata ──────────────────────────────────────────────────

  /** Read a token's `symbol()` from the bounded LRU cache (or RPC). */
  async symbol(tokenAddress: string, callerAddress?: string): Promise<string> {
    return this.loadMetadata(
      this.symbolCache,
      this.symbolInFlight,
      tokenAddress,
      async (caller) => {
        const tx = await buildContractCallTx(
          this.rpcUrl,
          this.passphrase,
          caller,
          tokenAddress,
          'symbol',
          [],
          this.fee,
        );
        return scValToString(await simulateReadOnly(this.rpcUrl, this.passphrase, tx));
      },
      callerAddress,
    );
  }

  /** Named aliases for callers that prefer explicit getter naming. */
  async getDecimals(tokenAddress: string, callerAddress?: string): Promise<number> {
    return this.decimals(tokenAddress, callerAddress);
  }

  /** Named alias for {@link symbol}. */
  async getSymbol(tokenAddress: string, callerAddress?: string): Promise<string> {
    return this.symbol(tokenAddress, callerAddress);
  }

  /** Named alias for {@link decimals} matching the low-level helper name. */
  async getTokenDecimals(tokenAddress: string, callerAddress?: string): Promise<number> {
    return this.decimals(tokenAddress, callerAddress);
  }

  /** Named alias for {@link symbol} matching the low-level helper name. */
  async getTokenSymbol(tokenAddress: string, callerAddress?: string): Promise<string> {
    return this.symbol(tokenAddress, callerAddress);
  }

  /** Clear both metadata caches and any in-flight de-duplication entries. */
  clearMetadataCache(): void {
    this.decimalsCache.clear();
    this.symbolCache.clear();
    this.decimalsInFlight.clear();
    this.symbolInFlight.clear();
    // Decimals also live in the process-wide soroban cache; clear it as well
    // so the next lookup really goes back to the network.
    clearTokenDecimalsCache();
  }

  /** Hit/miss metrics for the two metadata LRU caches. */
  getMetadataCacheMetrics(): { decimals: MemoCacheMetrics; symbol: MemoCacheMetrics } {
    return {
      decimals: this.decimalsCache.metrics(),
      symbol: this.symbolCache.metrics(),
    };
  }

  /**
   * Generic cached read for immutable SEP-41 metadata. Hits refresh the LRU
   * position; concurrent misses coalesce onto the same in-flight promise;
   * failures are not cached so the next call retries the network.
   */
  private async loadMetadata<V>(
    cache: LruMemoCache<string, V>,
    inFlight: Map<string, Promise<V>>,
    tokenAddress: string,
    load: (caller: string) => Promise<V>,
    callerAddress?: string,
  ): Promise<V> {
    if (!tokenAddress || typeof tokenAddress !== 'string') {
      throw new Error('Invalid token address: must be a non-empty string');
    }

    const cacheKey = `${this.rpcUrl}:${tokenAddress}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      cache.recordHit(0);
      return cached;
    }
    const pending = inFlight.get(cacheKey);
    if (pending) return pending;

    const startedAt = Date.now();
    const promise = (async () => {
      try {
        const caller = callerAddress ?? (await this.defaultCaller());
        const value = await load(caller);
        cache.set(cacheKey, value);
        cache.recordMiss(Date.now() - startedAt);
        return value;
      } catch (err) {
        cache.recordMiss(Date.now() - startedAt);
        throw err;
      } finally {
        inFlight.delete(cacheKey);
      }
    })();

    inFlight.set(cacheKey, promise);
    return promise;
  }

  // ── Trustline pre-flight validation ───────────────────────────────────────

  /**
   * Check whether `accountAddress` can receive a (non-native) token before a
   * transaction is submitted. On Stellar a trustline must already exist for
   * every non-native asset an account holds; letting the contract revert with
   * an opaque error code is a poor user experience, so this performs the
   * check up front and exposes an actionable result.
   *
   * The check compares the token's Stellar Asset Contract ID against the
   * contract IDs derived from the account's classic asset balance lines, so
   * it works for both contract addresses and `CODE:ISSUER` identifiers.
   *
   * @param token - `native`, `USDC`, a `CODE:ISSUER` pair, or a contract ID.
   * @param accountAddress - The account that will receive the asset.
   * @param options - Optional abort signal and `throwOnMissing` behaviour.
   */
  async checkTrustline(
    token: string,
    accountAddress: string,
    options: TrustlineCheckOptions = {},
  ): Promise<TrustlineCheckResult> {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!accountAddress || typeof accountAddress !== 'string') {
      throw new Error('Invalid account address: must be a non-empty string');
    }

    // Native XLM is the one asset that never needs a trustline.
    if (token === 'native') {
      return {
        hasTrustline: true,
        account: accountAddress,
        token,
        message: 'Native XLM does not require a trustline.',
      };
    }

    const target = this.resolveAsset(token);
    let balances: ClassicBalance[];
    try {
      const account = await getServer(this.rpcUrl).getAccount(accountAddress);
      balances = (account as unknown as { balances?: ClassicBalance[] }).balances ?? [];
    } catch (err) {
      throw new Error(
        `Unable to verify trustline for ${target.code ?? token} on account ${accountAddress}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const match = balances.find((balance) => {
      if (balance.asset_type === 'native' || !balance.asset_code || !balance.asset_issuer) return false;
      try {
        return new Asset(balance.asset_code, balance.asset_issuer).contractId(this.passphrase) === target.contractId;
      } catch {
        // A malformed balance line never matches; keep scanning the others.
        return false;
      }
    });

    // When the caller passed a bare contract ID, use the matched balance
    // line to fill in the human-readable asset code/issuer.
    const matchedCode = match?.asset_code ?? target.code;
    const matchedIssuer = match?.asset_issuer ?? target.issuer;
    const label = matchedCode ?? token;
    const result: TrustlineCheckResult = {
      hasTrustline: match !== undefined,
      account: accountAddress,
      token,
      assetCode: matchedCode,
      assetIssuer: matchedIssuer,
      contractId: target.contractId,
      message: match !== undefined
        ? `Account ${accountAddress} has a trustline for ${label}.`
        : `Account ${accountAddress} has no trustline for ${label}. ` +
          'Add the trustline before depositing or receiving this asset.',
    };

    if (!result.hasTrustline && options.throwOnMissing) {
      throw new MissingTrustlineError({
        account: accountAddress,
        token,
        assetCode: matchedCode,
        assetIssuer: matchedIssuer,
      });
    }
    return result;
  }

  /**
   * Strict variant of {@link checkTrustline} that throws
   * `MissingTrustlineError` when the trustline is absent, for call sites that
   * want to abort a transaction before submission.
   */
  async requireTrustline(
    token: string,
    accountAddress: string,
    signal?: AbortSignal,
  ): Promise<TrustlineCheckResult> {
    return this.checkTrustline(token, accountAddress, { signal, throwOnMissing: true });
  }

  /** Resolve a supported token identifier to its Stellar Asset Contract ID. */
  private resolveAsset(token: string): { code?: string; issuer?: string; contractId: string } {
    if (!token || typeof token !== 'string') {
      throw new Error('Invalid token identifier: must be a non-empty string');
    }

    if (token === 'USDC') {
      const issuer = USDC_ISSUER[this.config.network];
      return { code: 'USDC', issuer, contractId: new Asset('USDC', issuer).contractId(this.passphrase) };
    }

    if (token.includes(':')) {
      const parts = token.split(':');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid asset identifier "${token}". Expected "CODE:ISSUER".`);
      }
      const [code, issuer] = parts as [string, string];
      return { code, issuer, contractId: new Asset(code, issuer).contractId(this.passphrase) };
    }

    if (/^C[A-Z2-7]{55}$/.test(token)) {
      return { contractId: token };
    }

    throw new Error(
      `Unsupported token identifier "${token}". Pass 'native', 'USDC', a "CODE:ISSUER" pair, ` +
      'or a Stellar Asset Contract address.',
    );
  }

  private async signerFor(ownerAddress: string): Promise<Signer> {
    if (this.activeWallet) {
      const wallet = this.activeWallet;
      const signingAddress = await wallet.getPublicKey();
      if (signingAddress !== ownerAddress) {
        throw new Error(
          `Token allowance owner ${ownerAddress} does not match the connected wallet ${signingAddress}`,
        );
      }
      return {
        publicKey: () => signingAddress,
        sign: async (tx: Transaction): Promise<Transaction> => {
          const signed = await wallet.signTransaction(tx, {
            networkPassphrase: this.passphrase,
            accountToSign: signingAddress,
          });
          if (signed == null) {
            throw new Error('Wallet adapter signTransaction returned null or undefined');
          }
          return typeof signed === 'string'
            ? new Transaction(signed, this.passphrase)
            : signed;
        },
      };
    }

    if (this.config.signer) {
      const signingAddress = this.config.signer.publicKey();
      if (signingAddress !== ownerAddress) {
        throw new Error(
          `Token allowance owner ${ownerAddress} does not match the configured signer ${signingAddress}`,
        );
      }
      return this.config.signer;
    }

    throw new Error('keypair, wallet adapter, or signer is required to approve a token allowance');
  }
}

function assertDecimals(decimals: number): void {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new RangeError('decimals must be a non-negative integer');
  }
}

/**
 * Format a raw integer token amount for display, with the locale's thousands
 * separator and decimal mark (#1086).
 *
 * Exact for any size: the integer part is formatted as a `bigint`, so no
 * precision is lost to floating point. At least two fractional digits are
 * shown (fewer only when the token has fewer decimals) and trailing zeros
 * beyond that are trimmed: `formatTokenAmount(10000000n, 7)` → `"1.00"`,
 * `formatTokenAmount(12345678901234n, 7, 'de-DE')` → `"1.234.567,8901234"`.
 *
 * @param rawAmount - Amount in the token's smallest unit, as a bigint or an integer string.
 * @param decimals - The token's decimals.
 * @param locale - BCP 47 locale; defaults to the runtime's locale.
 * @throws {RangeError} If `decimals` is not a non-negative integer.
 * @throws {SyntaxError} If `rawAmount` is a string that is not an integer.
 */
export function formatTokenAmount(
  rawAmount: bigint | string,
  decimals: number,
  locale?: string,
): string {
  assertDecimals(decimals);
  const raw = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount.trim());
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const factor = 10n ** BigInt(decimals);

  const nf = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 });
  const whole = nf.format(abs / factor);
  const sign = negative ? '-' : '';
  if (decimals === 0) return `${sign}${whole}`;

  const minDigits = Math.min(2, decimals);
  let frac = (abs % factor).toString().padStart(decimals, '0').replace(/0+$/, '');
  if (frac.length < minDigits) frac = frac.padEnd(minDigits, '0');

  const decimalMark =
    new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.';
  return `${sign}${whole}${decimalMark}${frac}`;
}
