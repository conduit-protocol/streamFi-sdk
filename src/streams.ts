/**
 * StreamsModule - all DripStream + DripFactory operations.
 */

import { SorobanRpc, nativeToScVal, xdr, Address, Transaction, BASE_FEE, Asset } from '@stellar/stellar-sdk';
import type {
  ConduitConfig,
  CreateStreamParams,
  CreateStreamResult,
  ListStreamsParams,
  PaginatedStreams,
  StreamEventHandlers,
  StreamInfo,
  Subscription,
  BatchWithdrawItem,
  BatchWithdrawResult,
  BatchCreateStreamResult,
  StreamConfig,
  StreamOperation,
  FeeEstimate,
} from './types/index.js';
import type { WalletAdapter } from './adapters/types.js';
import type { Signer } from './signer.js';
import { KeypairWalletAdapter } from './adapters/keypair.js';
import { toStroops, calculateRate, bigintSafeStringify } from './utils.js';
import {
  buildContractCallTx,
  scValToI128,
  scValToU64,
  scValToU32,
  boolToScVal,
  getTokenDecimals,
  catchNetworkError,
  queryXlmBalance,
  estimateRequiredFee,
  CREATE_RESOURCE_FEE_ESTIMATE,
  DEFAULT_RPC,
  NETWORK_PASSPHRASE,
  DEFAULT_CONFIRMATION_MAX_ATTEMPTS,
  DEFAULT_CONFIRMATION_POLL_INTERVAL_MS,
  createRpcServer,
  resolveFee,
} from './soroban.js';
import {
  STREAM_FLAG_PAUSED,
  STREAM_FLAG_CANCELLED,
  STREAM_FLAG_CLAWBACK_ENABLED,
} from './constants.js';
import { buildBatchTransactions } from './batch-tx.js';
import type { BatchTransactionContext } from './batch-tx.js';
import { FactoryModule } from './factory.js';
import { ConduitError, RateLimitError, InsufficientBalanceError, StreamErrorCode } from './errors.js';

// Deprecation warnings

/**
 * Tracks which v1-deprecated methods have already warned this session, so
 * repeated calls (e.g. in a hot loop) do not spam the console.
 */
/** Default concurrency limit for bounded page-fetching (Issue #549). */
const DEFAULT_LIST_CONCURRENCY = 8;

/**
 * Runs `fn` over `items` with at most `concurrency` in-flight calls.
 * Preserves result ordering to match a naive `Promise.all` fan-out.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]!);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

const _warnedDeprecations = new Set<string>();

/**
 * Logs a one-time console warning for a deprecated v1 method, suppressed
 * only when the environment is *provably* production. Uses optional chaining
 * so that when `process` is absent (e.g. a plain browser bundle without a
 * bundler shim) the expression evaluates to `undefined !== 'production'`
 * which is `true` — warnings are shown, not silently swallowed.
 *
 * @param methodName - The deprecated method, e.g. 'StreamsModule.create()'.
 * @param replacement - The suggested replacement, e.g. 'StreamBuilder'.
 */
function warnV1Deprecated(methodName: string, replacement: string): void {
  const isDev = process?.env?.NODE_ENV !== 'production';
  if (!isDev) return;
  if (_warnedDeprecations.has(methodName)) return;
  _warnedDeprecations.add(methodName);
  console.warn(
    `[conduit-sdk] ${methodName} is deprecated and will be removed in a future ` +
    `major version. Use ${replacement} instead.`,
  );
}
import { ZERO_ADDR, DEFAULT_LIST_LIMIT, clampListLimit, USDC_ISSUER } from './constants.js';

export class StreamsModule {
  private readonly rpcUrl:     string;
  private readonly passphrase: string;
  private readonly _factory:   FactoryModule;
  private activeWallet?:       WalletAdapter;

  /**
   * Inclusion (bid) fee, in stroops, for transactions this module submits.
   * Resolved once from `config.fee` / `config.feeMultiplier` (see #509).
   */
  private readonly _fee: string;

  /**
   * Session-scoped cache of stream ID → contract address resolutions.
   * Avoids a redundant factory RPC on every get/withdraw/cancel/pause/resume/topUp/clawback call
   * for the same stream within a single StreamsModule lifetime. The cache is
   * intentionally not invalidated on writes — a stream's contract address is
   * immutable once assigned by the factory.
   */
  private readonly _addrCache = new Map<bigint, string>();

  /**
   * Cached rate-limit-retry proxy for this module's RPC URL.
   * createRpcServer() wraps the underlying cached Server in a new Proxy on
   * every call, so we hold one proxy per StreamsModule instance to avoid the
   * per-call Proxy allocation overhead.
   */
  private _rpcServerProxy: SorobanRpc.Server | null = null;

  /**
   * Cached caller address, populated on first resolution and invalidated on
   * setWallet(). Avoids a redundant getPublicKey() call (which may hit a
   * wallet extension / hardware device) on every read/mutating operation.
   */
  private _cachedCallerAddr: string | null = null;

  constructor(private readonly config: ConduitConfig) {
    this.rpcUrl     = config.rpcUrl ?? DEFAULT_RPC[config.network];
    this.passphrase = NETWORK_PASSPHRASE[config.network];
    this._factory   = new FactoryModule(config);
    this._fee       = resolveFee(config);

    if (config.wallet) {
      this.activeWallet = config.wallet;
    } else if (config.keypair) {
      this.activeWallet = new KeypairWalletAdapter(config.keypair);
    }
  }

  /**
   * Dynamically set or update the active wallet adapter.
   * Invalidates the cached caller address so it is re-resolved on next use.
   */
  setWallet(wallet: WalletAdapter): void {
    this.activeWallet = wallet;
    this._cachedCallerAddr = null;
  }

  private _signer(): Signer | null {
    return this.config.signer ?? null;
  }

  /**
   * Resolve the caller address, handling both sync and async getPublicKey().
   * Safe when the wallet adapter returns a promise — but it MUST only be
   * called from async contexts. Results are cached per wallet configuration
   * once a valid public key is resolved (does not cache null/ZERO_ADDR #562)
   * and invalidated on setWallet().
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

  /**
  /**
   * Deploy a new DripStream via DripFactory.
   *
   * Simulates first to extract the assigned stream ID from the return value,
   * then signs and submits the assembled transaction.
   *
   * @deprecated Use {@link StreamBuilder} instead (see `builder.ts`), which
   * provides a fluent `.token().sender().recipient().amount().ratePerSecond()`
   * config API plus `.build()` / `.submit()` with built-in concurrency and
   * backpressure handling. This method will be removed in a future major
   * version. In development mode (`NODE_ENV !== 'production'`) this method
   * logs a one-time console warning when invoked.
   */
  async create(params: CreateStreamParams): Promise<CreateStreamResult> {
    warnV1Deprecated('StreamsModule.create()', 'StreamBuilder');
    const senderAddr = await this._getSenderAddress();
    const {
      recipient, token, depositAmount,
      durationSeconds, ratePerSecond,
      startTime, clawbackEnabled = false,
    } = params;

    // Client-side validation to prevent invalid payloads
    if (!recipient || typeof recipient !== 'string' || !recipient.trim()) {
      throw new Error('Invalid recipient address: must be a non-empty string');
    }
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new Error('Invalid token address: must be a non-empty string');
    }
    if (!depositAmount || typeof depositAmount !== 'string' || !depositAmount.trim()) {
      throw new Error('Invalid deposit amount: must be a non-empty string');
    }
    if (durationSeconds !== undefined && (typeof durationSeconds !== 'number' || durationSeconds <= 0)) {
      throw new Error('Invalid durationSeconds: must be a positive number');
    }
    if (ratePerSecond !== undefined && (typeof ratePerSecond !== 'string' || !ratePerSecond.trim())) {
      throw new Error('Invalid ratePerSecond: must be a non-empty string');
    }
    if (!durationSeconds && !ratePerSecond) {
      throw new Error('Either durationSeconds or ratePerSecond must be provided');
    }

    const factoryId = this.config.factoryAddress ?? '';

    
    const now = Math.floor(Date.now() / 1000);
    if (startTime !== undefined && startTime < now) {
      throw new Error('Invalid startTime: cannot be in the past');
    }

    let resolvedToken = token;
    if (token === 'native') {
      resolvedToken = Asset.native().contractId(this.passphrase);
    } else if (token === 'USDC') {
      const issuer = this.passphrase.includes('Test SDF Network')
        ? USDC_ISSUER.testnet
        : USDC_ISSUER.mainnet;
      resolvedToken = new Asset('USDC', issuer).contractId(this.passphrase);
    }

    // Query token decimals
    const decimals = await getTokenDecimals(this.rpcUrl, this.passphrase, senderAddr, resolvedToken);


    const depositStroops = toStroops(depositAmount, decimals);
    const rateStroops    = ratePerSecond
      ? BigInt(ratePerSecond)
      : calculateRate(depositAmount, durationSeconds!, decimals);
    const start = startTime ?? Math.floor(Date.now() / 1000);
    const end   = durationSeconds ? start + durationSeconds : 0;

    const args = [
      new Address(senderAddr).toScVal(),
      new Address(recipient).toScVal(),
      new Address(resolvedToken).toScVal(),
      nativeToScVal(depositStroops, { type: 'i128' }),
      nativeToScVal(rateStroops,    { type: 'i128' }),
      nativeToScVal(start,          { type: 'u64'  }),
      nativeToScVal(end,            { type: 'u64'  }),
      boolToScVal(clawbackEnabled),
    ];

    const tx     = await buildContractCallTx(this.rpcUrl, this.passphrase, senderAddr, factoryId, 'create_stream', args, this._fee);
    const server = this._server();
    const sim    = await catchNetworkError('simulateTransaction (create)', server.simulateTransaction(tx));

    if (SorobanRpc.Api.isSimulationError(sim)) {
      const err = ConduitError.fromSorobanMessage('factory', sim.error);
      // If it's an InsufficientBalanceError with placeholder values, try to
      // query the actual XLM balance and estimate the required fee.
      if (err instanceof InsufficientBalanceError && err.currentBalance === 0n && err.requiredBalance === 0n) {
        const xlmBalance = await queryXlmBalance(this.rpcUrl, this.passphrase, senderAddr).catch(() => 0n);
        const requiredFee = estimateRequiredFee(sim, CREATE_RESOURCE_FEE_ESTIMATE);
        const required = depositStroops + requiredFee;
        throw new InsufficientBalanceError(xlmBalance, required, sim.error);
      }
      throw err;
    }

    const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
    const signed    = await this._signTx(assembled);
    const { hash: txHash, returnValue } = await this._sendAndPoll(server, signed);

    if (!returnValue) {
      throw new Error(`Transaction ${txHash} succeeded but returned no value`);
    }
    const streamId = scValToU64(returnValue);

    const streamAddress = await this._factory.streamAddress(streamId) ?? '';
    return { streamId, streamAddress, txHash };
  }

  /** Fetch full stream state from the deployed DripStream contract. */
  async get(streamId: bigint | string): Promise<StreamInfo> {
    const id   = BigInt(streamId);
    const addr = await this._resolveAddr(id);
    const caller = await this._resolveCallerAddress();
    const tx   = await buildContractCallTx(this.rpcUrl, this.passphrase, caller, addr, 'info', []);
    const val  = await this._simulateTx(tx);
    return parseStreamInfo(id, addr, val);
  }

  /**
   * Fetch full stream state for many stream IDs with bounded concurrency.
   *
   * Returns both successful results and per-id failures so one missing or
   * broken stream does not fail the whole fan-out. Order of `results` and
   * `failures` matches the input order.
   */
  async getStreamInfos(
    streamIds: (bigint | string)[],
    options: import('./types/index.js').GetStreamInfosOptions = {},
  ): Promise<import('./types/index.js').GetStreamInfosResult> {
    const ids = streamIds.map(id => BigInt(id));
    const concurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_LIST_CONCURRENCY);

    const outcomes = await mapWithConcurrency(ids, concurrency, async (id) => {
      try {
        const info = await this.get(id);
        return { ok: true as const, id, info };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { ok: false as const, id, error };
      }
    });

    return {
      results: outcomes.filter(o => o.ok).map(o => o.info),
      failures: outcomes.filter(o => !o.ok).map(o => ({ id: o.id, error: o.error })),
    };
  }

  /** Get withdrawable balance - read-only, no transaction. */
  async withdrawable(streamId: bigint | string): Promise<bigint> {
    const id   = BigInt(streamId);
    const addr = await this._resolveAddr(id);
    const caller = await this._resolveCallerAddress();
    const tx   = await buildContractCallTx(this.rpcUrl, this.passphrase, caller, addr, 'withdrawable', []);
    const val  = await this._simulateTx(tx);
    return scValToI128(val);
  }

  /**
   * Get the cumulative amount streamed since the stream started, in stroops.
   *
   * Unlike {@link withdrawable}, which reflects only the unwithdrawn portion,
   * this exposes the total amount that has vested regardless of withdrawals —
   * useful for progress displays that shouldn't reset visually after a
   * withdrawal. Read-only, no transaction.
   */
  async streamedTotal(streamId: bigint | string): Promise<bigint> {
    const id   = BigInt(streamId);
    const addr = await this._resolveAddr(id);
    const caller = await this._resolveCallerAddress();
    const tx   = await buildContractCallTx(this.rpcUrl, this.passphrase, caller, addr, 'streamed_total', []);
    const val  = await this._simulateTx(tx);
    return scValToI128(val);
  }

  /** Withdraw tokens as the recipient. Defaults to full available balance. */
  async withdraw(streamId: bigint | string, amount?: bigint): Promise<string> {
    this._ensureCanMutate();
    const id  = BigInt(streamId);
    // Fail fast on invalid amounts, the same way create() validates its
    // payload client-side, instead of paying for a full simulate+reject
    // cycle that surfaces StreamErrorCode.InvalidAmount from the contract.
    // Only applies when the caller passes an explicit amount — omitting it
    // (defaulting to the full withdrawable balance) is always valid, and a
    // zero balance there correctly surfaces NothingToWithdraw instead.
    if (amount !== undefined && amount <= 0n) {
      throw new Error('Invalid amount: must be greater than zero');
    }
    const qty = amount ?? await this.withdrawable(id);
    return this._invoke(await this._resolveAddr(id), 'withdraw', [
      nativeToScVal(qty, { type: 'i128' }),
    ]);
  }

  /**
   * Withdraw from multiple streams.
   *
   * Note: Soroban currently permits only one invoke_host_function
   * operation per transaction, so this cannot be assembled into a single
   * atomic transaction the way classic Stellar payment operations can.
   * Each withdrawal is submitted as its own transaction; they are reported
   * independently so a failure on one streamId (e.g. StreamNotFound,
   * insufficient balance) does not block or fail the others.
   *
   * Withdrawals are submitted one at a time, not concurrently. Each
   * withdraw() -> _invoke() -> buildContractCallTx() reads the caller
   * account's current sequence number via getAccount() and builds a
   * transaction on top of it. Firing all N withdrawals at once means every
   * one of them reads the same sequence number and builds a transaction
   * with the same value, so with a single keypair/wallet at most one
   * submission can ever land — the rest fail with txBAD_SEQ (see #504).
   * Awaiting each withdrawal (submit + confirm) before starting the next
   * guarantees getAccount() only observes the sequence after the previous
   * transaction has landed, so every submission gets a distinct, ordered
   * sequence number.
   */
  async batchWithdraw(withdrawals: BatchWithdrawItem[]): Promise<BatchWithdrawResult[]> {
    this._ensureCanMutate();

    const results: BatchWithdrawResult[] = [];
    for (const w of withdrawals) {
      const streamId = BigInt(w.streamId);
      try {
        const txHash = await this.withdraw(w.streamId, w.amount);
        results.push({ streamId, success: true, txHash });
      } catch (err) {
        results.push({
          streamId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  /**
   * Create multiple streams in bulk.
   *
   * Soroban permits only one invoke_host_function operation per transaction
   * (see {@link buildBatchTransactions}), so this builds and submits one
   * transaction per config. Each transaction consumes the sender's next
   * sequence number in order, so every config remains independently
   * submittable regardless of how many configs are in the batch — unlike
   * fetching a fresh account/sequence per config, which would hand out the
   * same sequence number to more than one transaction once submitted out of
   * order.
   *
   * Per-config client-side validation failures do not block or roll back the
   * rest of the batch — each config is reported independently by its
   * original index, mirroring {@link batchWithdraw}. Note this isolation
   * does not extend to on-chain simulation: {@link buildBatchTransactions}
   * simulates every config's transaction in parallel via `Promise.all`, so
   * one config's simulation being rejected currently fails building the
   * whole batch, not just that config.
   */
  async createBatchStreams(configs: StreamConfig[]): Promise<BatchCreateStreamResult[]> {
    this._ensureCanMutate();
    if (!Array.isArray(configs) || configs.length === 0) return [];

    const senderAddr = await this._getSenderAddress();
    const factoryId  = this.config.factoryAddress ?? '';

    const built = await Promise.all(configs.map(async (params, index) => {
      try {
        const {
          recipient, token, depositAmount,
          durationSeconds, ratePerSecond,
          startTime, clawbackEnabled = false,
        } = params;

        if (!recipient || typeof recipient !== 'string' || !recipient.trim()) {
          throw new Error('Invalid recipient address: must be a non-empty string');
        }
        if (!token || typeof token !== 'string' || !token.trim()) {
          throw new Error('Invalid token address: must be a non-empty string');
        }
        if (!depositAmount || typeof depositAmount !== 'string' || !depositAmount.trim()) {
          throw new Error('Invalid deposit amount: must be a non-empty string');
        }
        if (durationSeconds !== undefined && (typeof durationSeconds !== 'number' || durationSeconds <= 0)) {
          throw new Error('Invalid durationSeconds: must be a positive number');
        }
        if (ratePerSecond !== undefined && (typeof ratePerSecond !== 'string' || !ratePerSecond.trim())) {
          throw new Error('Invalid ratePerSecond: must be a non-empty string');
        }
        if (!durationSeconds && !ratePerSecond) {
          throw new Error('Either durationSeconds or ratePerSecond must be provided');
        }

        const decimals = await getTokenDecimals(this.rpcUrl, this.passphrase, senderAddr, token);
        const depositStroops = toStroops(depositAmount, decimals);
        const rateStroops    = ratePerSecond
          ? BigInt(ratePerSecond)
          : calculateRate(depositAmount, durationSeconds!, decimals);
        const start = startTime ?? Math.floor(Date.now() / 1000);
        const end   = durationSeconds ? start + durationSeconds : 0;

        const args = [
          new Address(senderAddr).toScVal(),
          new Address(recipient).toScVal(),
          new Address(token).toScVal(),
          nativeToScVal(depositStroops, { type: 'i128' }),
          nativeToScVal(rateStroops,    { type: 'i128' }),
          nativeToScVal(start,          { type: 'u64'  }),
          nativeToScVal(end,            { type: 'u64'  }),
          boolToScVal(clawbackEnabled),
        ];
        return { index, args, error: undefined as string | undefined };
      } catch (err) {
        return { index, args: undefined, error: err instanceof Error ? err.message : String(err) };
      }
    }));

    const results = new Map<number, BatchCreateStreamResult>();
    for (const b of built) {
      if (b.error !== undefined) {
        results.set(b.index, { index: b.index, success: false, error: b.error });
      }
    }

    const validEntries = built.filter(
      (b): b is { index: number; args: xdr.ScVal[]; error: undefined } => b.args !== undefined,
    );

    if (validEntries.length > 0) {
      const context: BatchTransactionContext = {
        contractId: factoryId,
        sourceAccount: senderAddr,
        networkPassphrase: this.passphrase,
        rpcUrl: this.rpcUrl,
      };

      let builtTxs: Awaited<ReturnType<typeof buildBatchTransactions>>;
      try {
        const operations = validEntries.map(b => ({ method: 'create_stream', args: b.args }));
        builtTxs = await buildBatchTransactions(operations, context);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const b of validEntries) {
          results.set(b.index, { index: b.index, success: false, error: message });
        }
        builtTxs = [];
      }

      const server = this._server();
      const settled = await Promise.allSettled(
        builtTxs.map(async (bt) => {
          const tx      = new Transaction(bt.xdr, this.passphrase);
          const signed  = await this._signTx(tx);
          const { hash: txHash, returnValue } = await this._sendAndPoll(server, signed);
          if (!returnValue) {
            throw new Error(`Transaction ${txHash} succeeded but returned no value`);
          }
          const streamId      = scValToU64(returnValue);
          const streamAddress = await this._factory.streamAddress(streamId) ?? '';
          return { streamId, streamAddress, txHash };
        }),
      );

      settled.forEach((result, i) => {
        const originalIndex = validEntries[i]!.index;
        if (result.status === 'fulfilled') {
          results.set(originalIndex, {
            index: originalIndex,
            success: true,
            streamId: result.value.streamId,
            streamAddress: result.value.streamAddress,
            txHash: result.value.txHash,
          });
        } else {
          const err = result.reason;
          results.set(originalIndex, {
            index: originalIndex,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }

    return configs.map((_, i) => results.get(i)!);
  }

  /** Cancel the stream (sender only). Settles all balances atomically. */
  async cancel(streamId: bigint | string): Promise<string> {
    this._ensureCanMutate();
    return this._invoke(await this._resolveAddr(BigInt(streamId)), 'cancel', []);
  }

  /** Pause the stream (sender only). */
  async pause(streamId: bigint | string): Promise<string> {
    this._ensureCanMutate();
    return this._invoke(await this._resolveAddr(BigInt(streamId)), 'pause', []);
  }

  /** Resume a paused stream (sender only). Shifts start/end times forward. */
  async resume(streamId: bigint | string): Promise<string> {
    this._ensureCanMutate();
    return this._invoke(await this._resolveAddr(BigInt(streamId)), 'resume', []);
  }

  /** Deposit additional tokens into the stream (sender only). */
  async topUp(streamId: bigint | string, amount: bigint): Promise<string> {
    this._ensureCanMutate();
    // Client-side guard mirroring the contract's StreamErrorCode.InvalidAmount
    // so a zero/negative top-up fails fast instead of round-tripping.
    if (amount <= 0n) {
      throw new Error('Invalid amount: must be greater than zero');
    }
    return this._invoke(await this._resolveAddr(BigInt(streamId)), 'top_up', [
      nativeToScVal(amount, { type: 'i128' }),
    ]);
  }

  /** Top up a stream using string parameters (convenience wrapper). */
  async topUpStream(streamId: string, amount: string): Promise<string> {
    return this.topUp(streamId, BigInt(amount));
  }

  /**
   * Force-cancel a paused stream as the recipient once the 30-day pause
   * threshold has elapsed (recipient only). Settles atomically like
   * cancel(): the recipient's earned-but-unwithdrawn tokens are paid out
   * and the unstreamed remainder is refunded to the sender. Prevents a
   * sender from indefinitely pausing a stream to hold unstreamed tokens
   * hostage.
   */
  async forceCancel(streamId: bigint | string): Promise<string> {
    this._ensureCanMutate();
    return this._invoke(await this._resolveAddr(BigInt(streamId)), 'force_cancel', []);
  }

  /**
   * Transfer the recipient role to a new address (current recipient only).
   * The new recipient inherits all rights, including the withdrawable
   * balance accrued up to the moment of transfer.
   */
  async transferRecipient(streamId: bigint | string, newRecipient: string): Promise<string> {
    this._ensureCanMutate();
    if (!newRecipient || typeof newRecipient !== 'string' || !newRecipient.trim()) {
      throw new Error('Invalid recipient address: must be a non-empty string');
    }
    return this._invoke(await this._resolveAddr(BigInt(streamId)), 'transfer_recipient', [
      new Address(newRecipient).toScVal(),
    ]);
  }

  /**
   * Clawback unstreamed tokens (sender; only if enabled at creation).
   * Returns the amount reclaimed (simulated before submission).
   */
  async clawback(streamId: bigint | string): Promise<bigint> {
    this._ensureCanMutate();
    const addr   = await this._resolveAddr(BigInt(streamId));
    const caller = await this._getSenderAddress();
    const tx     = await buildContractCallTx(this.rpcUrl, this.passphrase, caller, addr, 'clawback', [], this._fee);
    const server = this._server();
    const sim    = await catchNetworkError('simulateTransaction (clawback)', server.simulateTransaction(tx));

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw ConduitError.fromSorobanMessage('stream', sim.error);
    }

    const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
    const signed    = await this._signTx(assembled);
    const { hash, returnValue } = await this._sendAndPoll(server, signed);

    if (!returnValue) {
      throw new Error(`Transaction ${hash} succeeded but returned no value`);
    }
    return scValToI128(returnValue);
  }

  /**
   * Estimate the network fee for a given stream operation by running a
   * Soroban simulation. Returns the resource fee (CPU/RAM), base fee, and
   * total estimated fee in stroops.
   */
  async estimateFee(operation: StreamOperation): Promise<FeeEstimate> {
    const callerAddr = await this._getSenderAddress();
    const server = this._server();

    let tx: Transaction;

    switch (operation.type) {
      case 'create': {
        const decimals = await getTokenDecimals(this.rpcUrl, this.passphrase, callerAddr, operation.token);
        const depositStroops = toStroops(operation.depositAmount, decimals);
        const rateStroops = operation.ratePerSecond
          ? BigInt(operation.ratePerSecond)
          : calculateRate(operation.depositAmount, operation.durationSeconds!, decimals);
        const start = operation.startTime ?? Math.floor(Date.now() / 1000);
        const end = operation.durationSeconds ? start + operation.durationSeconds : 0;

        const args = [
          new Address(callerAddr).toScVal(),
          new Address(operation.recipient).toScVal(),
          new Address(operation.token).toScVal(),
          nativeToScVal(depositStroops, { type: 'i128' }),
          nativeToScVal(rateStroops, { type: 'i128' }),
          nativeToScVal(start, { type: 'u64' }),
          nativeToScVal(end, { type: 'u64' }),
          boolToScVal(operation.clawbackEnabled ?? false),
        ];

        tx = await buildContractCallTx(this.rpcUrl, this.passphrase, callerAddr, this.config.factoryAddress ?? '', 'create_stream', args);
        break;
      }
      case 'withdraw': {
        const addr = await this._resolveAddr(BigInt(operation.streamId));
        const qty = operation.amount ?? 0n;
        tx = await buildContractCallTx(this.rpcUrl, this.passphrase, callerAddr, addr, 'withdraw', [
          nativeToScVal(qty, { type: 'i128' }),
        ]);
        break;
      }
      case 'cancel': {
        const addr = await this._resolveAddr(BigInt(operation.streamId));
        tx = await buildContractCallTx(this.rpcUrl, this.passphrase, callerAddr, addr, 'cancel', []);
        break;
      }
      case 'pause': {
        const addr = await this._resolveAddr(BigInt(operation.streamId));
        tx = await buildContractCallTx(this.rpcUrl, this.passphrase, callerAddr, addr, 'pause', []);
        break;
      }
      case 'resume': {
        const addr = await this._resolveAddr(BigInt(operation.streamId));
        tx = await buildContractCallTx(this.rpcUrl, this.passphrase, callerAddr, addr, 'resume', []);
        break;
      }
      case 'topUp': {
        const addr = await this._resolveAddr(BigInt(operation.streamId));
        tx = await buildContractCallTx(this.rpcUrl, this.passphrase, callerAddr, addr, 'top_up', [
          nativeToScVal(operation.amount, { type: 'i128' }),
        ]);
        break;
      }
      case 'clawback': {
        const addr = await this._resolveAddr(BigInt(operation.streamId));
        tx = await buildContractCallTx(this.rpcUrl, this.passphrase, callerAddr, addr, 'clawback', []);
        break;
      }
    }

    let simResult;
    try {
      simResult = await server.simulateTransaction(tx);
    } catch (err) {
      throw RateLimitError.fromRpcError(err) ?? err;
    }

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    // All fees are bigint stroops — consistent with FeeEstimator and the
    // rest of the SDK — so large resource fees never lose precision to
    // IEEE-754 rounding (see #447). `estimateRequiredFee` handles the
    // minResourceFee/fee extraction with the same fallback used elsewhere.
    const resourceFee = estimateRequiredFee(simResult);
    const cpuInstructions = BigInt(simResult.cost?.cpuInsns ?? 0);

    return {
      totalFee: BigInt(BASE_FEE) + resourceFee,
      resourceFee,
      baseFee: BigInt(BASE_FEE),
      instructions: cpuInstructions,
    };
  }

  /**
   * List streams by sender and/or recipient with pagination metadata.
   * When both `sender` and `recipient` are given, the result is the union
   * of the two filters (streams where the address is either sender or
   * recipient), de-duplicated — neither filter is silently dropped.
   * Returns a page of StreamInfo along with pagination metadata so the
   * frontend can implement infinite scrolling.
   */
  async list(params: ListStreamsParams): Promise<PaginatedStreams> {
    const { sender, recipient } = params;
    // Clamp here (not just in FactoryModule) so hasNextPage/nextCursor math
    // below stays consistent with the limit actually sent to the contract —
    // otherwise a caller-supplied limit above the max would silently break
    // pagination even though the contract call itself was clamped (see #489).
    const limit = clampListLimit(params.limit ?? DEFAULT_LIST_LIMIT);
    let offset = params.offset ?? 0;

    // A cursor from a previous page's nextCursor takes precedence over a
    // manually-supplied offset. Cursors are opaque base64-encoded offset
    // strings; anything that doesn't decode to a non-negative integer is
    // rejected rather than silently falling back to page 1 (see #124).
    if (params.cursor !== undefined) {
      let decoded: string;
      try {
        decoded = Buffer.from(params.cursor, 'base64').toString('utf8');
      } catch {
        throw new Error(`Invalid cursor: "${params.cursor}"`);
      }
      if (!/^\d+$/.test(decoded)) {
        throw new Error(`Invalid cursor: "${params.cursor}"`);
      }
      offset = Number(decoded);
    }

    const encodeCursor = (nextOffset: number): string =>
      Buffer.from(String(nextOffset), 'utf8').toString('base64');

    let ids: bigint[] = [];

    const pageFromFilteredIds = async (
      filteredIds: bigint[],
      hasNextPageOverride?: boolean,
    ): Promise<PaginatedStreams> => {
      ids = filteredIds;
      // Pre-warm the address cache for all IDs in this page concurrently,
      // then fetch stream info in parallel. Without this, each this.get(id)
      // call would serially resolve the address and then simulate — 2 serial
      // RPCs per stream. Pre-warming collapses the address lookups into a
      // single parallel fan-out before the info simulations begin.
      // Bounded concurrency (#549) avoids hammering the RPC endpoint with
      // up to 100 simultaneous simulateTransaction requests.
      await mapWithConcurrency(ids, DEFAULT_LIST_CONCURRENCY, (id) => this._resolveAddr(id));
      const streams = await mapWithConcurrency(ids, DEFAULT_LIST_CONCURRENCY, (id) => this.get(id));
      const hasNextPage = hasNextPageOverride ?? ids.length === limit;
      const totalCount = BigInt(offset + ids.length);
      return {
        streams,
        hasNextPage,
        totalCount,
        offset,
        limit,
        ...(hasNextPage ? { nextCursor: encodeCursor(offset + limit) } : {}),
      };
    };

    // Sender/recipient contract queries already return the filtered page.
    // There is no scoped count method, so do not mix in global stream_count().
    if (sender && recipient) {
      // When both filters are given, merge the sender- and recipient-filtered
      // streams into one ordered, de-duplicated list *before* paging it,
      // rather than unioning two independently-paged sub-pages — the union
      // of two limit-sized pages can be up to 2x the requested page size,
      // and its length has no honest relationship to hasNextPage/nextCursor
      // (see #507). There's no merged server-side index, so this re-fetches
      // everything from offset 0 up through offset+limit on both
      // sub-indices on every call — cost grows with offset, but the result
      // is a correct page rather than a fast wrong one.
      const window = clampListLimit(offset + limit + 1);
      const [senderIds, recipientIds] = await Promise.all([
        this._factory.streamsBySender(sender, 0, window),
        this._factory.streamsByRecipient(recipient, 0, window),
      ]);
      const merged = [...new Set([...senderIds, ...recipientIds])]
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const hasNextPage = merged.length > offset + limit;
      return pageFromFilteredIds(merged.slice(offset, offset + limit), hasNextPage);
    }
    if (sender) {
      return pageFromFilteredIds(await this._factory.streamsBySender(sender, offset, limit));
    }
    if (recipient) {
      return pageFromFilteredIds(await this._factory.streamsByRecipient(recipient, offset, limit));
    }

   // Neither sender nor recipient - return empty page
    return { streams: [], hasNextPage: false, totalCount: 0n, offset, limit };
  }

  /** Subscribe to on-chain stream events via polling. Returns an async subscription handle. */
  async subscribeAsync(
    streamId: bigint | string,
    handlers: StreamEventHandlers,
  ): Promise<Subscription> {
    const address = await this._factory.streamAddress(BigInt(streamId));
    if (!address) throw new Error(`Stream ${streamId} not found`);
    const { subscribeToStream } = await import('./events.js');
    // Use the resolved `this.rpcUrl` (constructor: `config.rpcUrl ??
    // DEFAULT_RPC[config.network]`), not the raw optional `config.rpcUrl` —
    // otherwise a client built without an explicit rpcUrl passes `undefined`
    // to `createRpcServer`, which throws / never connects.
    return subscribeToStream(this.rpcUrl, address, handlers);
  }

  /** Clear the address cache. Useful for testing or manual memory management. */
  clearAddressCache(): void {
    this._factory.clearAddressCache();
  }

  /** Returns address-cache hit/miss metrics (delegates to FactoryModule). */
  getCacheMetrics(): { hits: number; misses: number; size: number; hitRate: number } {
    return this._factory.getCacheMetrics();
  }

  /** Synchronous subscribe - resolves address lazily on first poll tick. */
  subscribe(streamId: bigint | string, handlers: StreamEventHandlers): Subscription {
    let inner: Subscription | null = null;
    let stopped = false;

    this.subscribeAsync(streamId, handlers)
      .then(sub => { if (!stopped) inner = sub; else sub.unsubscribe(); })
      .catch(err => {
        const error = err instanceof Error ? err : new Error(String(err));
        handlers.onError?.(error);
        console.warn('[conduit-sdk] subscribe error:', error);
      });

    return {
      unsubscribe: () => {
        stopped = true;
        if (inner) {
          inner.unsubscribe();
          inner = null;
        }
        // Release handler references to prevent memory leaks
        handlers = {};
      },
    };
  }

  // Private helpers

  private _ensureCanMutate(): void {
    if (!this.activeWallet && !this._signer() && !this.config.keypair) {
      throw new Error('keypair, wallet adapter, or signer is required for mutating operations');
    }
  }

  private async _getSenderAddress(): Promise<string> {
    if (this.activeWallet) {
      return this.activeWallet.getPublicKey();
    }
    const signer = this._signer();
    if (signer) {
      return signer.publicKey();
    }
    if (this.config.keypair) {
      return this.config.keypair.publicKey();
    }
    throw new Error('keypair, wallet adapter, or signer is required for mutating operations');
  }

  private async _signTx(tx: Transaction): Promise<Transaction> {
    if (this.activeWallet) {
      const signed = await this.activeWallet.signTransaction(tx, {
        networkPassphrase: this.passphrase,
      });
      if (signed == null) {
        throw new Error('Wallet adapter signTransaction returned null or undefined');
      }
      if (typeof signed === 'string') {
        return new Transaction(signed, this.passphrase);
      }
      return signed;
    }
    const signer = this._signer();
    if (signer) {
      // A Signer may mutate `tx` in place and return void, or return a new
      // signed Transaction. Honour the return value when it is a Transaction;
      // returning `tx` unconditionally dropped the signature for
      // immutable-style signers, submitting an unsigned transaction (#519).
      const result = await signer.sign(tx);
      return result instanceof Transaction ? result : tx;
    }
    if (this.config.keypair) {
      tx.sign(this.config.keypair);
      return tx;
    }
    throw new Error('keypair, wallet adapter, or signer is required for mutating operations');
  }

  private _server(): SorobanRpc.Server {
    // Reuse the same Proxy wrapper for the lifetime of this module instance.
    // createRpcServer() always constructs a new Proxy object even though the
    // underlying SorobanRpc.Server is already cached — memoizing here avoids
    // the redundant Proxy allocation on every RPC call.
    if (!this._rpcServerProxy) {
      this._rpcServerProxy = createRpcServer(this.rpcUrl);
    }
    return this._rpcServerProxy;
  }

  private async _resolveAddr(id: bigint): Promise<string> {
    // Use the factory's bounded LRU cache for address resolution.
    // Stream contract addresses are immutable once assigned by the factory,
    // so the cache never needs invalidation.
    const addr = await this._factory.streamAddress(id);
    if (!addr) throw new ConduitError('stream', StreamErrorCode.StreamNotFound, `Stream ${id} not found`);
    return addr;
  }

  private async _simulateTx(tx: Transaction): Promise<xdr.ScVal> {
    const server = this._server();
    const result = await catchNetworkError('simulateTransaction', server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw ConduitError.fromSorobanMessage('stream', result.error);
    }
    if (!result.result) throw new Error('Simulation returned no result');
    return xdr.ScVal.fromXDR(result.result.retval.toXDR());
  }

  /** Simulate -> assemble -> sign -> submit -> poll. Returns txHash. */
  private async _invoke(contractId: string, method: string, args: xdr.ScVal[]): Promise<string> {
    const senderAddr = await this._getSenderAddress();
    const tx         = await buildContractCallTx(this.rpcUrl, this.passphrase, senderAddr, contractId, method, args, this._fee);
    const server     = this._server();
    const sim        = await catchNetworkError('simulateTransaction (invoke)', server.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw ConduitError.fromSorobanMessage('stream', sim.error);
    }
    const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
    const signed    = await this._signTx(assembled);
    const { hash }  = await this._sendAndPoll(server, signed);
    return hash;
  }

  private async _sendAndPoll(
    server: SorobanRpc.Server,
    tx: Transaction,
  ): Promise<{ hash: string; returnValue: xdr.ScVal | undefined }> {
    let sent;
    try {
      sent = await catchNetworkError('sendTransaction', server.sendTransaction(tx));
    } catch (err) {
      throw RateLimitError.fromRpcError(err) ?? err;
    }
    if (sent.status === 'ERROR') {
      throw new Error(`Transaction rejected: ${JSON.stringify(sent.errorResult)}`);
    }
    const hash = sent.hash;
    const maxAttempts = this.config.confirmationMaxAttempts ?? DEFAULT_CONFIRMATION_MAX_ATTEMPTS;
    const pollIntervalMs = this.config.confirmationPollIntervalMs ?? DEFAULT_CONFIRMATION_POLL_INTERVAL_MS;
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(pollIntervalMs);
      let s;
      try {
        s = await catchNetworkError('getTransaction', server.getTransaction(hash));
      } catch (err) {
        throw RateLimitError.fromRpcError(err) ?? err;
      }
      if (s.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return { hash, returnValue: s.returnValue };
      }
      if (s.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed: ${hash}`);
      }
    }
    throw new Error(`Transaction timed out: ${hash}`);
  }
}

// Parsing

function parseStreamInfo(id: bigint, address: string, val: xdr.ScVal): StreamInfo {
  const entries = val.map() ?? [];
  const m: Record<string, xdr.ScVal> = {};
  for (const e of entries) {
    const k = e.key().sym()?.toString('utf8') ?? e.key().str()?.toString('utf8') ?? '';
    m[k] = e.val();
  }
  // `paused`, `cancelled` and `clawback_enabled` are NOT fields on the
  // on-chain `StreamInfo` struct — they are bits packed into `flags: u32`
  // (see contracts/stream/src/storage.rs). Reading `m['paused']` etc. always
  // yields `undefined`; derive the booleans by masking `flags`, mirroring
  // `StreamInfo::is_paused()` / `is_cancelled()` / `is_clawback_enabled()`.
  const flags = m['flags'] ? scValToU32(m['flags']) : 0;

  const info: StreamInfo = {
    id,
    address,
    sender:          m['sender']          ? Address.fromScVal(m['sender']).toString()          : '',
    recipient:       m['recipient']       ? Address.fromScVal(m['recipient']).toString()       : '',
    token:           m['token']           ? Address.fromScVal(m['token']).toString()           : '',
    ratePerSecond:   m['rate_per_second'] ? scValToI128(m['rate_per_second'])                 : 0n,
    startTime:       m['start_time']      ? Number(scValToU64(m['start_time']))               : 0,
    endTime:         m['end_time']        ? Number(scValToU64(m['end_time']))                 : 0,
    withdrawn:       m['withdrawn']       ? scValToI128(m['withdrawn'])                       : 0n,
    paused:          (flags & STREAM_FLAG_PAUSED) !== 0,
    pausedAt:        m['paused_at']       ? Number(scValToU64(m['paused_at']))                : 0,
    cancelled:       (flags & STREAM_FLAG_CANCELLED) !== 0,
    clawbackEnabled: (flags & STREAM_FLAG_CLAWBACK_ENABLED) !== 0,
  };
  (info as StreamInfo & { toJSON(): Record<string, unknown> }).toJSON = () => bigintSafeStringify(info as unknown as Record<string, unknown>);
  return info;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
