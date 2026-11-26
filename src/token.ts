import {
  Address,
  Asset,
  Transaction,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { ConduitConfig } from "./types/index.js";
import type { WalletAdapter } from "./adapters/types.js";
import type { Signer } from "./signer.js";
import { KeypairWalletAdapter } from "./adapters/keypair.js";
import { USDC_ISSUER, ZERO_ADDR } from "./constants.js";
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
} from "./soroban.js";

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

    this.knownDecimals.set(
      Asset.native().contractId(this.passphrase),
      STELLAR_ASSET_DECIMALS,
    );
    if (config.network === "mainnet" || config.network === "testnet") {
      const usdc = new Asset("USDC", USDC_ISSUER[config.network]);
      this.knownDecimals.set(
        usdc.contractId(this.passphrase),
        STELLAR_ASSET_DECIMALS,
      );
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
  async decimals(
    tokenAddress: string,
    callerAddress?: string,
  ): Promise<number> {
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
    return formatTokenAmount(
      rawAmount,
      await this.decimals(tokenAddress),
      locale,
    );
  }

  /**
   * Check if a contract address is a Stellar Asset Contract (SAC).
   * SACs are issued for Stellar Classic assets (native XLM or issued assets like USDC).
   * 
   * @param contractAddress - The contract address to check.
   * @returns Promise resolving to true if the contract is a SAC, false otherwise.
   */
  async isStellarAssetContract(contractAddress: string): Promise<boolean> {
    try {
      // Try to parse as a classic asset
      // SACs have a specific pattern: they can be derived from Asset.contractId()
      // We'll check if the contract implements the standard token interface
      // and has the characteristic properties of a SAC
      
      // First check: Native XLM SAC
      const nativeContractId = Asset.native().contractId(this.passphrase);
      if (contractAddress === nativeContractId) {
        return true;
      }

      // Second check: Try to query contract data that SACs expose
      // SACs store their asset code and issuer in a specific format
      const caller = await this.defaultCaller();
      
      try {
        // Query the contract's admin/issuer - SACs have this, pure Soroban tokens might not
        const tx = await buildContractCallTx(
          this.rpcUrl,
          this.passphrase,
          caller,
          contractAddress,
          "admin",
          [],
          this.fee,
        );
        
        await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
        
        // If admin() succeeded, check for asset() method which is SAC-specific
        const assetTx = await buildContractCallTx(
          this.rpcUrl,
          this.passphrase,
          caller,
          contractAddress,
          "asset",
          [],
          this.fee,
        );
        
        const assetResult = await simulateReadOnly(this.rpcUrl, this.passphrase, assetTx);
        // If we get here, it has both admin() and asset(), strong indicator of SAC
        return scValToNative(assetResult) !== undefined;
      } catch {
        // If these calls fail, it's likely not a SAC
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Parse asset code and issuer from a Stellar Asset Contract.
   * Returns undefined if the contract is not a SAC.
   * 
   * @param contractAddress - The SAC contract address.
   * @returns Promise resolving to { code: string, issuer?: string } or undefined.
   */
  async parseStellarAsset(
    contractAddress: string,
  ): Promise<{ code: string; issuer?: string } | undefined> {
    const isSAC = await this.isStellarAssetContract(contractAddress);
    if (!isSAC) {
      return undefined;
    }

    // Check if it's native XLM
    const nativeContractId = Asset.native().contractId(this.passphrase);
    if (contractAddress === nativeContractId) {
      return { code: "XLM" };
    }

    try {
      const caller = await this.defaultCaller();
      
      // Get the asset details
      const assetTx = await buildContractCallTx(
        this.rpcUrl,
        this.passphrase,
        caller,
        contractAddress,
        "asset",
        [],
        this.fee,
      );
      
      const assetResult = await simulateReadOnly(this.rpcUrl, this.passphrase, assetTx);
      const assetData = scValToNative(assetResult) as { code: string; issuer: string } | undefined;
      
      if (assetData && typeof assetData === "object") {
        return {
          code: assetData.code || "UNKNOWN",
          issuer: assetData.issuer,
        };
      }
      
      return undefined;
    } catch {
      return undefined;
    }
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
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const tx = await buildContractCallTx(
      this.rpcUrl,
      this.passphrase,
      ownerAddress,
      tokenAddress,
      "allowance",
      [
        new Address(ownerAddress).toScVal(),
        new Address(spenderAddress).toScVal(),
      ],
      this.fee,
    );
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
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
    if (amount < 0n)
      throw new RangeError("amount must be greater than or equal to 0");
    if (
      !Number.isInteger(expirationLedger) ||
      expirationLedger < 0 ||
      expirationLedger > 0xffffffff
    ) {
      throw new RangeError("expirationLedger must be a u32 integer");
    }

    const signer = await this.signerFor(ownerAddress);
    const tx = await buildContractCallTx(
      this.rpcUrl,
      this.passphrase,
      ownerAddress,
      tokenAddress,
      "approve",
      [
        new Address(ownerAddress).toScVal(),
        new Address(spenderAddress).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
        nativeToScVal(expirationLedger, { type: "u32" }),
      ],
      this.fee,
    );
    return invokeContract(this.rpcUrl, this.passphrase, signer, tx);
  }

  /**
   * Check token allowance and automatically prompt for approval if insufficient.
   * Returns true if approval was granted or allowance was already sufficient,
   * false if user rejected the approval.
   */
  async checkAndPromptAllowance(
    tokenAddress: string,
    owner: string,
    spender: string,
    amount: bigint,
  ): Promise<boolean> {
    const currentAllowance = await this.allowance(tokenAddress, owner, spender);

    if (currentAllowance >= amount) {
      return true;
    }

    // Prompt for approval
    const approved = await this.promptApproval(
      tokenAddress,
      owner,
      spender,
      amount,
    );
    if (!approved) {
      return false;
    }

    // Execute the approval transaction
    const expirationLedger = 0xffffffff; // Max u32 value for unlimited expiration
    await this.approve(tokenAddress, owner, spender, amount, expirationLedger);
    return true;
  }

  private async promptApproval(
    tokenAddress: string,
    owner: string,
    spender: string,
    amount: bigint,
  ): Promise<boolean> {
    const decimals = await this.decimals(tokenAddress, owner);
    const formattedAmount = formatTokenAmount(amount, decimals);

    // Check if running in browser environment
    const browserWindow = (globalThis as {
      window?: { confirm?: (message: string) => boolean };
    }).window;
    if (browserWindow?.confirm) {
      return browserWindow.confirm(
        `Allow StreamFi contract to transfer ${formattedAmount} tokens on your behalf? Transaction will be required.`,
      );
    }

    // For non-browser environments, default to true (approval will be attempted)
    return true;
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
            throw new Error(
              "Wallet adapter signTransaction returned null or undefined",
            );
          }
          return typeof signed === "string"
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

    throw new Error(
      "keypair, wallet adapter, or signer is required to approve a token allowance",
    );
  }
}

function assertDecimals(decimals: number): void {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new RangeError("decimals must be a non-negative integer");
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
 * @param maxFractionDigits - Maximum number of fractional digits to show (optional, defaults to showing all).
 * @throws {RangeError} If `decimals` is not a non-negative integer.
 * @throws {SyntaxError} If `rawAmount` is a string that is not an integer.
 */
export function formatTokenAmount(
  rawAmount: bigint | string,
  decimals: number,
  locale?: string,
  maxFractionDigits?: number,
): string {
  assertDecimals(decimals);
  const raw =
    typeof rawAmount === "bigint" ? rawAmount : BigInt(rawAmount.trim());
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const factor = 10n ** BigInt(decimals);

  const nf = new Intl.NumberFormat(locale, {
    useGrouping: true,
    maximumFractionDigits: 0,
  });
  const whole = nf.format(abs / factor);
  const sign = negative ? "-" : "";
  if (decimals === 0) return `${sign}${whole}`;

  const minDigits = Math.min(2, decimals);
  let frac = (abs % factor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  if (frac.length < minDigits) frac = frac.padEnd(minDigits, "0");

  // Apply maxFractionDigits if specified
  if (maxFractionDigits !== undefined && maxFractionDigits >= 0) {
    const maxDigits = Math.min(maxFractionDigits, decimals);
    if (frac.length > maxDigits) {
      frac = frac.substring(0, maxDigits);
      // Remove trailing zeros after truncation
      frac = frac.replace(/0+$/, "");
      // But ensure at least minDigits
      if (frac.length < minDigits) frac = frac.padEnd(minDigits, "0");
    }
  }

  const decimalMark =
    new Intl.NumberFormat(locale)
      .formatToParts(1.5)
      .find((p) => p.type === "decimal")?.value ?? ".";
  return `${sign}${whole}${decimalMark}${frac}`;
}
