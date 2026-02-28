/**
 * StreamsModule — all DripStream + DripFactory operations.
 */

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

export class StreamsModule {
  constructor(private readonly config: ConduitConfig) {}

  /**
   * Deploy a new DripStream via DripFactory.
   */
  async create(params: CreateStreamParams): Promise<CreateStreamResult> {
    if (!this.config.keypair) {
      throw new Error('keypair is required for mutating operations');
    }

    const {
      recipient,
      token,
      depositAmount,
      durationSeconds,
      ratePerSecond,
      startTime,
      clawbackEnabled = false,
    } = params;

    if (!durationSeconds && !ratePerSecond) {
      throw new Error('Either durationSeconds or ratePerSecond must be provided');
    }

    const depositStroops = toStroops(depositAmount);
    const rateStroops    = ratePerSecond
      ? BigInt(ratePerSecond)
      : calculateRate(depositAmount, durationSeconds!);

    const start  = startTime ?? Math.floor(Date.now() / 1000);
    const end    = durationSeconds ? start + durationSeconds : 0;

    // TODO: build and submit the create_stream transaction via soroban.ts
    // Returning a stub until contract ABIs are wired.
    console.log('create_stream', { recipient, token, depositStroops, rateStroops, start, end, clawbackEnabled });

    return {
      streamId:      0n,
      streamAddress: '',
      txHash:        '',
    };
  }

  /**
   * Fetch full stream state from the DripStream contract.
   */
  async get(streamId: bigint | string): Promise<StreamInfo> {
    const id = BigInt(streamId);
    // TODO: resolve address from factory, then call stream.info()
    void id;
    throw new Error('Not implemented — wire to soroban.ts');
  }

  /**
   * Get withdrawable balance (read-only, no transaction).
   */
  async withdrawable(streamId: bigint | string): Promise<bigint> {
    const id = BigInt(streamId);
    void id;
    throw new Error('Not implemented — wire to soroban.ts');
  }

  /**
   * Withdraw tokens as the recipient.
   */
  async withdraw(streamId: bigint | string, amount?: bigint): Promise<string> {
    if (!this.config.keypair) throw new Error('keypair required');
    void streamId; void amount;
    throw new Error('Not implemented — wire to soroban.ts');
  }

  /** Cancel the stream (sender only). */
  async cancel(streamId: bigint | string): Promise<string> {
    if (!this.config.keypair) throw new Error('keypair required');
    void streamId;
    throw new Error('Not implemented — wire to soroban.ts');
  }

  /** Pause the stream (sender only). */
  async pause(streamId: bigint | string): Promise<string> {
    if (!this.config.keypair) throw new Error('keypair required');
    void streamId;
    throw new Error('Not implemented — wire to soroban.ts');
  }

  /** Resume a paused stream (sender only). */
  async resume(streamId: bigint | string): Promise<string> {
    if (!this.config.keypair) throw new Error('keypair required');
    void streamId;
    throw new Error('Not implemented — wire to soroban.ts');
  }

  /** Deposit additional tokens into the stream (sender only). */
  async topUp(streamId: bigint | string, amount: bigint): Promise<string> {
    if (!this.config.keypair) throw new Error('keypair required');
    void streamId; void amount;
    throw new Error('Not implemented — wire to soroban.ts');
  }

  /** Clawback unstreamed tokens (sender; only if enabled at creation). */
  async clawback(streamId: bigint | string): Promise<bigint> {
    if (!this.config.keypair) throw new Error('keypair required');
    void streamId;
    throw new Error('Not implemented — wire to soroban.ts');
  }

  /**
   * List streams by sender or recipient.
   */
  async list(params: ListStreamsParams): Promise<StreamInfo[]> {
    void params;
    throw new Error('Not implemented — wire to soroban.ts');
  }

  /**
   * Subscribe to on-chain stream events via polling.
   *
   * Resolves the stream address from the factory, then delegates to
   * the event subscription module.
   */
  async subscribeAsync(
    streamId: bigint | string,
    handlers: StreamEventHandlers,
  ): Promise<Subscription> {
    const address = await this.factory().streamAddress(BigInt(streamId));
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

    return {
      unsubscribe: () => {
        stopped = true;
        inner?.unsubscribe();
      },
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private factory() {
    // Lazy import to avoid circular dependency
    const { FactoryModule } = require('./factory.js') as typeof import('./factory.js');
    return new FactoryModule(this.config);
  }
}
