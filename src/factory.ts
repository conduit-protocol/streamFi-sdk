/**
 * FactoryModule — DripFactory read queries.
 */

import { nativeToScVal, xdr, Address } from '@stellar/stellar-sdk';
import type { ConduitConfig } from './types/index.js';
import { ZERO_ADDR } from './constants.js';
import {
  buildContractCallTx,
  simulateReadOnly,
  scValToU64,
  NETWORK_PASSPHRASE,
  DEFAULT_RPC,
} from './soroban.js';

export class FactoryModule {
  private readonly rpcUrl:      string;
  private readonly passphrase:  string;
  private readonly factoryId:   string;
  private readonly callerAddr:  string;

  constructor(private readonly config: ConduitConfig) {
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
    // For read-only calls we use the keypair's public key as the fee source;
    // if no keypair, we use the zero address (simulation only — no real account needed).
    this.callerAddr = config.keypair?.publicKey() ?? ZERO_ADDR;
  }

  /** Total number of streams ever created through this factory. */
  async streamCount(): Promise<bigint> {
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, this.callerAddr,
      this.factoryId, 'stream_count', [],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return scValToU64(val);
  }

  /** Resolve a stream ID to its deployed contract address. Returns null if not found. */
  async streamAddress(streamId: bigint | string): Promise<string | null> {
    const id  = BigInt(streamId);
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, this.callerAddr,
      this.factoryId, 'stream_address',
      [nativeToScVal(id, { type: 'u64' })],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);

    // Contract returns Option<Address> — void = None
    if (val.switch().name === 'scvVoid') return null;
    try {
      return Address.fromScVal(val).toString();
    } catch {
      return null;
    }
  }

  /** List stream IDs where `address` is the sender, paginated. */
  async streamsBySender(address: string, offset = 0, limit = 20): Promise<bigint[]> {
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, this.callerAddr,
      this.factoryId, 'streams_by_sender',
      [
        new Address(address).toScVal(),
        nativeToScVal(offset, { type: 'u32' }),
        nativeToScVal(limit,  { type: 'u32' }),
      ],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return this.parseU64Vec(val);
  }

  /** List stream IDs where `address` is the recipient, paginated. */
  async streamsByRecipient(address: string, offset = 0, limit = 20): Promise<bigint[]> {
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, this.callerAddr,
      this.factoryId, 'streams_by_recipient',
      [
        new Address(address).toScVal(),
        nativeToScVal(offset, { type: 'u32' }),
        nativeToScVal(limit,  { type: 'u32' }),
      ],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return this.parseU64Vec(val);
  }

  /** Current protocol fee in basis points (e.g. 30 = 0.3%). */
  async protocolFeeBps(): Promise<number> {
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, this.callerAddr,
      this.factoryId, 'protocol_fee_bps', [],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return Number(val.u32());
  }

  private parseU64Vec(val: xdr.ScVal): bigint[] {
    const items = val.vec();
    if (!items) return [];
    return items.map(v => scValToU64(v));
  }
}
