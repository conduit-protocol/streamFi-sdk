/**
 * StreamsModule — all DripStream + DripFactory operations.
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
  Subscription,
} from './types/index.js';
import type { WalletAdapter } from './adapters/types.js';
import { KeypairWalletAdapter } from './adapters/keypair.js';
import { toStroops, calculateRate } from './utils.js';
import {
  buildContractCallTx,
  scValToI128,
  scValToU64,
  boolToScVal,
  getTokenDecimals,
  DEFAULT_RPC,
  NETWORK_PASSPHRASE,
} from './soroban.js';
import { FactoryModule } from './factory.js';
import { ConduitError, StreamErrorCode } from './errors.js';
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
   * Deploy a new DripStream via DripFactory.
   *
   * Simulates first to extract the assigned stream ID from the return value,
   * then signs and submits the assembled transaction.
   */
  async create(params: CreateStreamParams): Promise<CreateStreamResult> {
    this._ensureCanMutate();
    const senderAddr = await this._getSenderAddress();
    const {
      recipient, token, depositAmount,
      durationSeconds, ratePerSecond,
      startTime, clawbackEnabled = false,
    } = params;

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

  /** Fetch full stream state from the deployed DripStream contract. */
  async get(streamId: bigint | string): Promise<StreamInfo> {
    const id   = BigInt(streamId);
    const addr = await this._resolveAddr(id);
    const tx   = await buildContractCallTx(this.rpcUrl, this.passphrase, this.callerAddr, addr, 'info', []);
    const val  = await this._simulateTx(tx);
    return parseStreamInfo(id, addr, val);
  }

  /** Get withdrawable balance — read-only, no transaction. */
  async withdrawable(streamId: bigint | string): Promise<bigint> {
    const id   = BigInt(streamId);
    const addr = await this._resolveAddr(id);
    const tx   = await buildContractCallTx(this.rpcUrl, this.passphrase, this.callerAddr, addr, 'withdrawable', []);
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
   * Returns a page of StreamInfo along with hasNextPage and totalCount so
   * the frontend can implement infinite scrolling.
   */
  async list(params: ListStreamsParams): Promise<PaginatedStreams> {
    const { sender, recipient, offset = 0, limit = 20 } = params;
    let ids: bigint[] = [];

    // Fetch stream IDs and total count in parallel — totalCount comes from
    // stream_count() on the factory, which is a cheap Soroban simulate.
    if (sender) {
      const [senderIds, totalCount] = await Promise.all([
        this._factory.streamsBySender(sender, offset, limit),
        this._factory.streamCount(),
      ]);
      ids = senderIds;
      const streams = await Promise.all(ids.map(id => this.get(id)));
      return {
        streams,
        hasNextPage: BigInt(offset) + BigInt(limit) < totalCount,
        totalCount,
        offset,
        limit,
      };
    } else if (recipient) {
      const [recipientIds, totalCount] = await Promise.all([
        this._factory.streamsByRecipient(recipient, offset, limit),
        this._factory.streamCount(),
      ]);
      ids = recipientIds;
      const streams = await Promise.all(ids.map(id => this.get(id)));
      return {
        streams,
        hasNextPage: BigInt(offset) + BigInt(limit) < totalCount,
        totalCount,
        offset,
        limit,
      };
    }

    // Neither sender nor recipient — return empty page
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

  /** Synchronous subscribe — resolves address lazily on first poll tick. */
  subscribe(streamId: bigint | string, handlers: StreamEventHandlers): Subscription {
    let inner: Subscription | null = null;
    let stopped = false;

    this.subscribeAsync(streamId, handlers)
      .then(sub => { if (stopped) sub.unsubscribe(); else inner = sub; })
      .catch(err => console.warn('[conduit-sdk] subscribe error:', err));

    return { unsubscribe: () => { stopped = true; inner?.unsubscribe(); } };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _ensureCanMutate(): void {
    if (!this.activeWallet && !this.config.signer && !this.config.keypair) {
      throw new Error('keypair, wallet adapter, or signer is required for mutating operations');
    }
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
      if (typeof signed === 'string') {
        return new Transaction(signed, this.passphrase);
      }
      return signed;
    }
    if (this.config.signer) {
      await this.config.signer.sign(tx);
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

  /** Simulate → assemble → sign → submit → poll. Returns txHash. */
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
    const sent = await server.sendTransaction(tx);
    if (sent.status === 'ERROR') {
      throw new Error(`Transaction rejected: ${JSON.stringify(sent.errorResult)}`);
    }
    const hash = sent.hash;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const s = await server.getTransaction(hash);
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

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseStreamInfo(id: bigint, address: string, val: xdr.ScVal): StreamInfo {
  const entries = val.map() ?? [];
  const m: Record<string, xdr.ScVal> = {};
  for (const e of entries) {
    const k = e.key().sym()?.toString('utf8') ?? e.key().str()?.toString('utf8') ?? '';
    m[k] = e.val();
  }
  return {
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
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
