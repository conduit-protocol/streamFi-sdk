/**
 * StreamsModule — all DripStream + DripFactory operations.
 */

import { SorobanRpc, nativeToScVal, xdr, Address, Transaction } from '@stellar/stellar-sdk';
import type {
  ConduitConfig,
  CreateStreamParams,
  CreateStreamResult,
  ListStreamsParams,
  StreamEventHandlers,
  StreamInfo,
  Subscription,
} from './types/index.js';
import { toStroops, calculateRate } from './utils.js';
import {
  buildContractCallTx,
  scValToI128,
  scValToU64,
  boolToScVal,
  DEFAULT_RPC,
  NETWORK_PASSPHRASE,
} from './soroban.js';
import { FactoryModule } from './factory.js';
import { ConduitError, ErrorCode } from './errors.js';

const ZERO_ADDR = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

export class StreamsModule {
  private readonly rpcUrl:     string;
  private readonly passphrase: string;
  private readonly callerAddr: string;
  private readonly _factory:   FactoryModule;

  constructor(private readonly config: ConduitConfig) {
    this.rpcUrl     = config.rpcUrl ?? DEFAULT_RPC[config.network];
    this.passphrase = NETWORK_PASSPHRASE[config.network];
    this.callerAddr = config.keypair?.publicKey() ?? ZERO_ADDR;
    this._factory   = new FactoryModule(config);
  }

  /**
   * Deploy a new DripStream via DripFactory.
   *
   * Simulates first to extract the assigned stream ID from the return value,
   * then signs and submits the assembled transaction.
   */
  async create(params: CreateStreamParams): Promise<CreateStreamResult> {
    if (!this.config.keypair) {
      throw new Error('keypair is required for mutating operations');
    }

    const {
      recipient, token, depositAmount,
      durationSeconds, ratePerSecond,
      startTime, clawbackEnabled = false,
    } = params;

    if (!durationSeconds && !ratePerSecond) {
      throw new Error('Either durationSeconds or ratePerSecond must be provided');
    }

    const depositStroops = toStroops(depositAmount);
    const rateStroops    = ratePerSecond
      ? BigInt(ratePerSecond)
      : calculateRate(depositAmount, durationSeconds!);
    const start = startTime ?? Math.floor(Date.now() / 1000);
    const end   = durationSeconds ? start + durationSeconds : 0;

    const senderAddr = this.config.keypair.publicKey();
    const factoryId  = this.config.factoryAddress ?? '';

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
      throw new Error(`Simulation failed: ${sim.error}`);
    }

    // create_stream returns the new stream ID (u64)
    const streamId = scValToU64(xdr.ScVal.fromXDR(sim.result!.retval.toXDR()));

    const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
    assembled.sign(this.config.keypair);
    const txHash = await this._sendAndPoll(server, assembled);

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
    if (!this.config.keypair) throw new Error('keypair required');
    const id  = BigInt(streamId);
    const qty = amount ?? await this.withdrawable(id);
    return this._invoke(await this._resolveAddr(id), 'withdraw', [
      nativeToScVal(qty, { type: 'i128' }),
    ]);
  }

  /** Cancel the stream (sender only). Settles all balances atomically. */
  async cancel(streamId: bigint | string): Promise<string> {
    if (!this.config.keypair) throw new Error('keypair required');
    return this._invoke(await this._resolveAddr(BigInt(streamId)), 'cancel', []);
  }

  /** Pause the stream (sender only). */
  async pause(streamId: bigint | string): Promise<string> {
    if (!this.config.keypair) throw new Error('keypair required');
    return this._invoke(await this._resolveAddr(BigInt(streamId)), 'pause', []);
  }

  /** Resume a paused stream (sender only). Shifts start/end times forward. */
  async resume(streamId: bigint | string): Promise<string> {
    if (!this.config.keypair) throw new Error('keypair required');
    return this._invoke(await this._resolveAddr(BigInt(streamId)), 'resume', []);
  }

  /** Deposit additional tokens into the stream (sender only). */
  async topUp(streamId: bigint | string, amount: bigint): Promise<string> {
    if (!this.config.keypair) throw new Error('keypair required');
    return this._invoke(await this._resolveAddr(BigInt(streamId)), 'top_up', [
      nativeToScVal(amount, { type: 'i128' }),
    ]);
  }

  /**
   * Clawback unstreamed tokens (sender; only if enabled at creation).
   * Returns the amount reclaimed (simulated before submission).
   */
  async clawback(streamId: bigint | string): Promise<bigint> {
    if (!this.config.keypair) throw new Error('keypair required');
    const addr   = await this._resolveAddr(BigInt(streamId));
    const caller = this.config.keypair.publicKey();
    const tx     = await buildContractCallTx(this.rpcUrl, this.passphrase, caller, addr, 'clawback', []);
    const server = this._server();
    const sim    = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }

    const amount    = scValToI128(xdr.ScVal.fromXDR(sim.result!.retval.toXDR()));
    const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
    assembled.sign(this.config.keypair);
    await this._sendAndPoll(server, assembled);

    return amount;
  }

  /**
   * List streams by sender or recipient.
   * Resolves full StreamInfo for each ID — use sparingly with large sets.
   */
  async list(params: ListStreamsParams): Promise<StreamInfo[]> {
    const { sender, recipient, offset = 0, limit = 20 } = params;
    let ids: bigint[] = [];
    if (sender) {
      ids = await this._factory.streamsBySender(sender, offset, limit);
    } else if (recipient) {
      ids = await this._factory.streamsByRecipient(recipient, offset, limit);
    }
    return Promise.all(ids.map(id => this.get(id)));
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

  private _server(): SorobanRpc.Server {
    return new SorobanRpc.Server(this.rpcUrl, { allowHttp: this.rpcUrl.startsWith('http://') });
  }

  private async _resolveAddr(id: bigint): Promise<string> {
    const addr = await this._factory.streamAddress(id);
    if (!addr) throw new ConduitError(ErrorCode.StreamNotFound, `Stream ${id} not found`);
    return addr;
  }

  private async _simulateTx(tx: Transaction): Promise<xdr.ScVal> {
    const server = this._server();
    const result = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error: ${result.error}`);
    }
    if (!result.result) throw new Error('Simulation returned no result');
    return xdr.ScVal.fromXDR(result.result.retval.toXDR());
  }

  /** Simulate → assemble → sign → submit → poll. Returns txHash. */
  private async _invoke(contractId: string, method: string, args: xdr.ScVal[]): Promise<string> {
    const keypair = this.config.keypair!;
    const tx      = await buildContractCallTx(this.rpcUrl, this.passphrase, keypair.publicKey(), contractId, method, args);
    const server  = this._server();
    const sim     = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }
    const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
    assembled.sign(keypair);
    return this._sendAndPoll(server, assembled);
  }

  private async _sendAndPoll(server: SorobanRpc.Server, tx: Transaction): Promise<string> {
    const sent = await server.sendTransaction(tx);
    if (sent.status === 'ERROR') {
      throw new Error(`Transaction rejected: ${JSON.stringify(sent.errorResult)}`);
    }
    const hash = sent.hash;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const s = await server.getTransaction(hash);
      if (s.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) return hash;
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
    sender:          Address.fromScVal(m['sender']).toString(),
    recipient:       Address.fromScVal(m['recipient']).toString(),
    token:           Address.fromScVal(m['token']).toString(),
    ratePerSecond:   scValToI128(m['rate_per_second']),
    startTime:       Number(scValToU64(m['start_time'])),
    endTime:         Number(scValToU64(m['end_time'])),
    withdrawn:       scValToI128(m['withdrawn']),
    paused:          m['paused'].b(),
    pausedAt:        Number(scValToU64(m['paused_at'])),
    cancelled:       m['cancelled'].b(),
    clawbackEnabled: m['clawback_enabled'].b(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
