/**
 * GovernorModule — DripGovernor config reads.
 */

import { Address, xdr } from '@stellar/stellar-sdk';
import type { ConduitConfig, GovernorConfig } from './types/index.js';
import { ZERO_ADDR } from './constants.js';
import {
  buildContractCallTx,
  simulateReadOnly,
  scValToI128,
  scValToU32,
  scValToU64,
  NETWORK_PASSPHRASE,
  DEFAULT_RPC,
} from './soroban.js';
import { SUPPORTED_NETWORKS, UnsupportedChainError } from './errors.js';

export class GovernorModule {
  private readonly rpcUrl:      string;
  private readonly passphrase:  string;
  private readonly governorId: string | undefined;
  private readonly callerAddr:  string;
  private readonly network:     ConduitConfig['network'];

  // Unlike FactoryModule (a hard prerequisite for virtually all StreamsModule
  // methods), GovernorModule is orthogonal to stream operations — a caller
  // using only client.streams shouldn't be forced to supply a
  // governorAddress they'll never touch. ConduitClient constructs this
  // module unconditionally, so the missing-address check has to be deferred
  // to first actual use (getConfig()) rather than thrown in the constructor.
  constructor(cfg: ConduitConfig) {
    // Guard against direct construction with an unsupported network, which
    // would bypass the ConduitClient validation gate (fixes #157).
    if (!(SUPPORTED_NETWORKS as readonly string[]).includes(cfg.network)) {
      throw new UnsupportedChainError(cfg.network);
    }
    this.rpcUrl     = cfg.rpcUrl ?? DEFAULT_RPC[cfg.network];
    this.passphrase = NETWORK_PASSPHRASE[cfg.network];
    this.governorId = cfg.governorAddress;
    this.callerAddr = cfg.keypair?.publicKey() ?? ZERO_ADDR;
    this.network    = cfg.network;
  }

  /** Fetch the current protocol config from the DripGovernor contract. */
  async getConfig(): Promise<GovernorConfig> {
    if (!this.governorId) {
      throw new Error(
        `ConduitConfig.governorAddress is required (no default DripGovernor is known for network "${this.network}").`,
      );
    }
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, this.callerAddr,
      this.governorId, 'config', [],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return parseGovernorConfig(val);
  }

  /** Fetch active governance proposals from the DripGovernor contract. */
  async getProposals(): Promise<GovernorProposal[]> {
    if (!this.governorId) {
      throw new Error(
        `ConduitConfig.governorAddress is required (no default DripGovernor is known for network "${this.network}").`,
      );
    }
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, this.callerAddr,
      this.governorId, 'getProposals', [],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return parseGovernorProposals(val);
  }
}

export interface GovernorProposal {
  id: string;
  description: string;
  targetConfig: Record<string, unknown>;
  status: 'active' | 'passed' | 'failed' | 'pending';
  proposer: string;
  startTime: number;
  endTime: number;
  votesFor: bigint;
  votesAgainst: bigint;
}

function parseGovernorConfig(val: xdr.ScVal): GovernorConfig {
  const entries = val.map() ?? [];
  const m: Record<string, xdr.ScVal> = {};
  for (const e of entries) {
    const k = e.key().sym()?.toString('utf8') ?? e.key().str()?.toString('utf8') ?? '';
    m[k] = e.val();
  }
  return {
    feeBps:             m['fee_bps'] ? scValToU32(m['fee_bps']) : 0,
    minDurationSeconds: m['min_duration_seconds'] ? Number(scValToU64(m['min_duration_seconds'])) : 0,
    maxDurationSeconds: m['max_duration_seconds'] ? Number(scValToU64(m['max_duration_seconds'])) : 0,
    maxRatePerSecond:   m['max_rate_per_second'] ? scValToI128(m['max_rate_per_second']) : 0n,
    ...(m['fee_recipient'] ? { feeRecipient: Address.fromScVal(m['fee_recipient']).toString() } : {}),
    ...(m['factory_address'] ? { factoryAddress: Address.fromScVal(m['factory_address']).toString() } : {}),
  };
}

function parseGovernorProposals(val: xdr.ScVal): GovernorProposal[] {
  const arr = val.vec() ?? [];
  return arr.map((entry) => {
    const m: Record<string, xdr.ScVal> = {};
    const entries = entry.map() ?? [];
    for (const e of entries) {
      const k = e.key().sym()?.toString('utf8') ?? e.key().str()?.toString('utf8') ?? '';
      m[k] = e.val();
    }
    const statusVal = m['status'];
    const statusValNum = statusVal?.switch().name === 'scvU32' ? statusVal.u32() : undefined;
    const status: GovernorProposal['status'] = (() => {
      switch (statusValNum) {
        case 0: return 'pending';
        case 1: return 'active';
        case 2: return 'passed';
        case 3: return 'failed';
        default: return 'pending';
      }
    })();
    const descriptionVal = m['description'];
    const description = descriptionVal?.switch().name === 'scvString' ? descriptionVal.str()?.toString('utf8') ?? '' : '';
    return {
      id: m['id'] ? scValToU64(m['id']).toString() : '0',
      description,
      targetConfig: m['target_config'] ? parseGovernorConfig(m['target_config']) : {},
      status,
      proposer: m['proposer'] ? Address.fromScVal(m['proposer']).toString() : '',
      startTime: m['start_time'] ? Number(scValToU64(m['start_time'])) : 0,
      endTime: m['end_time'] ? Number(scValToU64(m['end_time'])) : 0,
      votesFor: m['votes_for'] ? scValToI128(m['votes_for']) : 0n,
      votesAgainst: m['votes_against'] ? scValToI128(m['votes_against']) : 0n,
    };
  });
}
