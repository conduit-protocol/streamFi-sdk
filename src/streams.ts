/**
 * StreamsModule - all DripStream + DripFactory operations.
 */

import { SorobanRpc, nativeToScVal, xdr, Address, Transaction } from '@stellar/stellar-sdk';
import type { Signer } from './signer.js';
import type {
  ConduitConfig,
  CreateStreamParams,
  CreateStreamResult,
  ListStreamsParams,
  PaginatedStreams,
  StreamEventHandlers,
  StreamInfo,
  StreamConfig,
  Subscription,
  BatchWithdrawItem,
  BatchWithdrawResult,
} from './types/index.js';
import type { WalletAdapter } from './adapters/types.js';
import { KeypairWalletAdapter } from './adapters/keypair.js';
import { toStroops, calculateRate, bigintSafeStringify } from './utils.js';
import {
  buildContractCallTx,
  buildBatchContractCallTx,
  scValToI128,
  scValToU64,
  boolToScVal,
  getTokenDecimals,
  DEFAULT_RPC,
  NETWORK_PASSPHRASE,
  DEFAULT_CONFIRMATION_MAX_ATTEMPTS,
  DEFAULT_CONFIRMATION_POLL_INTERVAL_MS,
} from './soroban.js';
import { FactoryModule } from './factory.js';
import { ConduitError, RateLimitError, StreamErrorCode } from './errors.js';

// Deprecation warnings

/**
 * Maximum number of stream-create operations per Soroban transaction.
 * Soroban's transaction size limit restricts this to roughly 10-15
 * operations per tx; 10 is a conservative default.
 */
const MAX_BATCH_SIZE = 10;

/**
 * Tracks which v1-deprecated methods have already warned this session, so
 * repeated calls (e.g. in a hot loop) do not spam the console.
 */
const _warnedDeprecations = new Set<string>();

/**
 * Logs a one-time console warning for a deprecated v1 method, but only in
 * development mode. Safe to call in browser bundles: guards `process` with
 * a `typeof` check since it is not guaranteed to exist outside Node/bundlers
 * that define it at build time.
 *
 * @param methodName - The deprecated method, e.g. 'StreamsModule.create()'.
 * @param replacement - The suggested replacement, e.g. 'StreamBuilder'.
 */
function warnV1Deprecated(methodName: string, replacement: string): void {
  const isDev =
    typeof process !== 'undefined' &&
    typeof process.env !== 'undefined' &&
    process.env.NODE_ENV !== 'production';
  if (!isDev) return;
  if (_warnedDeprecations.has(methodName)) return;
  _warnedDeprecations.add(methodName);
  console.warn(
    `[conduit-sdk] ${methodName} is deprecated and will be removed in a future ` +
    `major version. Use ${replacement} instead.`,
  );
}
import { ZERO_ADDR } from './constants.js';

export class StreamsModule {
  private readonly rpcUrl:     string;
  private readonly passphrase: string;
  private readonly callerAddr: string;
  private readonly _factory:   FactoryModule;
  private activeWallet?:       WalletAdapter;

  constructor(private readonly config: ConduitConfig) {
    this.rpcUrl     = config.rpcUrl ?? DEFAULT_RPC[config.network];
    this.passphrase = NETWORK_PASSPHRASE[config.network];
    this.callerAddr = this._signerPublicKey();
    this._factory   = new FactoryModule(config);

    if (config.wallet) {
      this.activeWallet = config.wallet;
    } else if (config.keypair) {
      this.activeWallet = new KeypairWalletAdapter(config.keypair);
    }
  }

  /**
   * Dynamically set or update the active wallet adapter.
   */
  setWallet(wallet: WalletAdapter): void {
    this.activeWallet = wallet;
  }

  private _signer(): Signer | null {
    return this.config.signer ?? null;
  }

  private _signerPublicKey(): string {
    if (this.activeWallet) {
      const pk = this.activeWallet.getPublicKey();
      if (typeof pk === 'string') return pk;
    }
    if (this.config.signer) return this.config.signer.publicKey();
    if (this.config.keypair) return this.config.keypair.publicKey();
    return ZERO_ADDR;
  }

  /**
   * Resolve the caller address, handling both sync and async getPublicKey().
   * Unlike _signerPublicKey(), this can be used when the wallet adapter
   * returns a promise - but it MUST only be called from async contexts.
   */
  private async _resolveCallerAddress(): Promise<string> {
    if (this.activeWallet) {
      const pk = await this.activeWallet.getPublicKey();
      if (pk) return pk;
    }
    if (this.config.signer) return this.config.signer.publicKey();
    if (this.config.keypair) return this.config.keypair.publicKey();
    return ZERO_ADDR;
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

    // Query token decimals
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

    const tx     = await buildContractCallTx(this.rpcUrl, this.passphrase, senderAddr, factoryId, 'create_stream', args);
    const server = this._server();
    const sim    = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw ConduitError.fromSorobanMessage('factory', sim.error);
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

  /**
   * Create multiple streams in a single batch.
   *
   * Configs are chunked into groups of up to {@link MAX_BATCH_SIZE} to
   * respect Soroban's transaction size limit. Each chunk is assembled
   * into a single transaction containing multiple `invokeHostFunction`
   * operations (one per stream config). The method simulates and
   * assembles each transaction, returning an array of prepared
   * transactions that are ready to be signed and submitted.
   *
   * @param configs - Array of stream creation configurations.
   * @returns Array of assembled, prepared transactions (one per chunk).
   */
  async createBatchStreams(configs: StreamConfig[]): Promise<Transaction[]> {
    this._ensureCanMutate();

    if (!Array.isArray(configs)) {
      throw new Error('Batch configs must be an array');
    }

    if (configs.length === 0) {
      return [];
    }

    const senderAddr = await this._getSenderAddress();
    const factoryId = this.config.factoryAddress ?? '';

    // Validate every config before starting any work
    for (let i = 0; i < configs.length; i++) {
      const params = configs[i]!;
      if (!params.recipient || typeof params.recipient !== 'string' || !params.recipient.trim()) {
        throw new Error(`Invalid recipient address at index ${i}: must be a non-empty string`);
      }
      if (!params.token || typeof params.token !== 'string' || !params.token.trim()) {
        throw new Error(`Invalid token address at index ${i}: must be a non-empty string`);
      }
      if (!params.depositAmount || typeof params.depositAmount !== 'string' || !params.depositAmount.trim()) {
        throw new Error(`Invalid deposit amount at index ${i}: must be a non-empty string`);
      }
      if (params.durationSeconds !== undefined && (typeof params.durationSeconds !== 'number' || params.durationSeconds <= 0)) {
        throw new Error(`Invalid durationSeconds at index ${i}: must be a positive number`);
      }
      if (params.ratePerSecond !== undefined && (typeof params.ratePerSecond !== 'string' || !params.ratePerSecond.trim())) {
        throw new Error(`Invalid ratePerSecond at index ${i}: must be a non-empty string`);
      }
      if (!params.durationSeconds && !params.ratePerSecond) {
        throw new Error(`Either durationSeconds or ratePerSecond must be provided at index ${i}`);
      }
    }

    const chunks = this._chunkArray(configs, MAX_BATCH_SIZE);
    const transactions: Transaction[] = [];

    for (const chunk of chunks) {
      const argsArray: xdr.ScVal[][] = [];

      for (const params of chunk) {
        const decimals = await getTokenDecimals(this.rpcUrl, this.passphrase, senderAddr, params.token);
        const depositStroops = toStroops(params.depositAmount, decimals);
        const rateStroops = params.ratePerSecond
          ? BigInt(params.ratePerSecond)
          : calculateRate(params.depositAmount, params.durationSeconds!, decimals);
        const start = params.startTime ?? Math.floor(Date.now() / 1000);
        const end = params.durationSeconds ? start + params.durationSeconds : 0;

        argsArray.push([
          new Address(senderAddr).toScVal(),
          new Address(params.recipient).toScVal(),
          new Address(params.token).toScVal(),
          nativeToScVal(depositStroops, { type: 'i128' }),
          nativeToScVal(rateStroops,    { type: 'i128' }),
          nativeToScVal(start,          { type: 'u64'  }),
          nativeToScVal(end,            { type: 'u64'  }),
          boolToScVal(params.clawbackEnabled ?? false),
        ]);
      }

      const tx = await buildBatchContractCallTx(
        this.rpcUrl, this.passphrase, senderAddr, factoryId,
        'create_stream', argsArray,
      );

      const server = this._server();
      const sim = await server.simulateTransaction(tx);

      if (SorobanRpc.Api.isSimulationError(sim)) {
        throw ConduitError.fromSorobanMessage('factory', sim.error);
      }

      const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
      transactions.push(assembled);
    }

    return transactions;
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

  /** Get withdrawable balance - read-only, no transaction. */
  async withdrawable(streamId: bigint | string): Promise<bigint> {
    const id   = BigInt(streamId);
    const addr = await this._resolveAddr(id);
    const caller = await this._resolveCallerAddress();
    const tx   = await buildContractCallTx(this.rpcUrl, this.passphrase, caller, addr, 'withdrawable', []);
    const val  = await this._simulateTx(tx);
    return scValToI128(val);
  }

  /** Withdraw tokens as the recipient. Defaults to full available balance. */
  async withdraw(streamId: bigint | string, amount?: bigint): Promise<string> {
    this._ensureCanMutate();
    const id  = BigInt(streamId);
    const qty = amount ?? await this.withdrawable(id);
    return this._invoke(await this._resolveAddr(id), 'withdraw', [
      nativeToScVal(qty, { type: 'i128' }),
    ]);
  }

  /**
   * Withdraw from multiple streams concurrently.
   *
   * Note: Soroban currently permits only one invoke_host_function
   * operation per transaction, so this cannot be assembled into a single
   * atomic transaction the way classic Stellar payment operations can.
   * Each withdrawal is submitted as its own transaction; they run
   * concurrently and are reported independently so a failure on one
   * streamId (e.g. StreamNotFound, insufficient balance) does not block
   * or roll back the others.
   */
  async batchWithdraw(withdrawals: BatchWithdrawItem[]): Promise<BatchWithdrawResult[]> {
    this._ensureCanMutate();

    const settled = await Promise.allSettled(
      withdrawals.map(w => this.withdraw(w.streamId, w.amount)),
    );

    return settled.map((result, i) => {
      const streamId = BigInt(withdrawals[i]!.streamId);
      if (result.status === 'fulfilled') {
        return { streamId, success: true, txHash: result.value };
      }
      const err = result.reason;
      return {
        streamId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    });
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
    return this._invoke(await this._resolveAddr(BigInt(streamId)), 'top_up', [
      nativeToScVal(amount, { type: 'i128' }),
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
    const tx     = await buildContractCallTx(this.rpcUrl, this.passphrase, caller, addr, 'clawback', []);
    const server = this._server();
    const sim    = await server.simulateTransaction(tx);

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
   * List streams by sender or recipient with pagination metadata.
   * Returns a page of StreamInfo along with pagination metadata so the
   * frontend can implement infinite scrolling.
   */
  async list(params: ListStreamsParams): Promise<PaginatedStreams> {
    const { sender, recipient, limit = 20 } = params;
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

    const pageFromFilteredIds = async (filteredIds: bigint[]): Promise<PaginatedStreams> => {
      ids = filteredIds;
      const streams = await Promise.all(ids.map(id => this.get(id)));
      const hasNextPage = ids.length === limit;
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
    if (sender) {
      return pageFromFilteredIds(await this._factory.streamsBySender(sender, offset, limit));
    } else if (recipient) {
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
    return subscribeToStream(this.config.rpcUrl!, address, handlers);
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
    if (!this.activeWallet && !this.config.signer && !this.config.keypair) {
      throw new Error('keypair, wallet adapter, or signer is required for mutating operations');
    }
  }

  private _chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  private async _getSenderAddress(): Promise<string> {
    if (this.activeWallet) {
      return this.activeWallet.getPublicKey();
    }
    if (this.config.signer) {
      return this.config.signer.publicKey();
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
    if (this.config.signer) {
      const result = this.config.signer.sign(tx);
      if (result != null) {
        await result;
      }
      return tx;
    }
    if (this.config.keypair) {
      tx.sign(this.config.keypair);
      return tx;
    }
    throw new Error('keypair, wallet adapter, or signer is required for mutating operations');
  }

  private _server(): SorobanRpc.Server {
    return new SorobanRpc.Server(this.rpcUrl, { allowHttp: this.rpcUrl.startsWith('http://') });
  }

  private async _resolveAddr(id: bigint): Promise<string> {
    const addr = await this._factory.streamAddress(id);
    if (!addr) throw new ConduitError('stream', StreamErrorCode.StreamNotFound, `Stream ${id} not found`);
    return addr;
  }

  private async _simulateTx(tx: Transaction): Promise<xdr.ScVal> {
    const server = this._server();
    const result = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw ConduitError.fromSorobanMessage('stream', result.error);
    }
    if (!result.result) throw new Error('Simulation returned no result');
    return xdr.ScVal.fromXDR(result.result.retval.toXDR());
  }

  /** Simulate -> assemble -> sign -> submit -> poll. Returns txHash. */
  private async _invoke(contractId: string, method: string, args: xdr.ScVal[]): Promise<string> {
    const senderAddr = await this._getSenderAddress();
    const tx         = await buildContractCallTx(this.rpcUrl, this.passphrase, senderAddr, contractId, method, args);
    const server     = this._server();
    const sim        = await server.simulateTransaction(tx);
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
      sent = await server.sendTransaction(tx);
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
        s = await server.getTransaction(hash);
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
    paused:          m['paused']?.b()     ?? false,
    pausedAt:        m['paused_at']       ? Number(scValToU64(m['paused_at']))                : 0,
    cancelled:       m['cancelled']?.b()  ?? false,
    clawbackEnabled: m['clawback_enabled']?.b() ?? false,
  };
  (info as StreamInfo & { toJSON(): Record<string, unknown> }).toJSON = () => bigintSafeStringify(info as unknown as Record<string, unknown>);
  return info;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
