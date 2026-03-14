/**
 * GovernorModule — DripGovernor config reads.
 */

import { Address, xdr } from '@stellar/stellar-sdk';
import type { ConduitConfig, GovernorConfig } from './types/index.js';
import {
  buildContractCallTx,
  simulateReadOnly,
  scValToI128,
  scValToU64,
  NETWORK_PASSPHRASE,
  DEFAULT_RPC,
} from './soroban.js';

const DEFAULT_GOVERNOR: Record<string, string> = {
  mainnet: 'CDRIP_GOVERNOR_MAINNET_PLACEHOLDER',
  testnet: 'CDRIP_GOVERNOR_TESTNET_PLACEHOLDER',
  local:   'CDRIP_GOVERNOR_LOCAL_PLACEHOLDER',
};

const ZERO_ADDR = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

export class GovernorModule {
  private readonly rpcUrl:     string;
  private readonly passphrase: string;
  private readonly governorId: string;
  private readonly callerAddr: string;

  constructor(cfg: ConduitConfig) {
    this.rpcUrl     = cfg.rpcUrl         ?? DEFAULT_RPC[cfg.network];
    this.passphrase = NETWORK_PASSPHRASE[cfg.network];
    this.governorId = cfg.governorAddress ?? DEFAULT_GOVERNOR[cfg.network] ?? '';
    this.callerAddr = cfg.keypair?.publicKey() ?? ZERO_ADDR;
  }

  /** Fetch the current protocol config from the DripGovernor contract. */
  async getConfig(): Promise<GovernorConfig> {
    const tx  = await buildContractCallTx(
      this.rpcUrl, this.passphrase, this.callerAddr,
      this.governorId, 'config', [],
    );
    const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
    return parseGovernorConfig(val);
  }
}

function parseGovernorConfig(val: xdr.ScVal): GovernorConfig {
  const entries = val.map() ?? [];
  const m: Record<string, xdr.ScVal> = {};
  for (const e of entries) {
    const k = e.key().sym()?.toString('utf8') ?? e.key().str()?.toString('utf8') ?? '';
    m[k] = e.val();
  }
  return {
    feeBps:             m['fee_bps'].u32(),
    feeRecipient:       Address.fromScVal(m['fee_recipient']).toString(),
    minDurationSeconds: Number(scValToU64(m['min_duration_seconds'])),
    maxRatePerSecond:   scValToI128(m['max_rate_per_second']),
  };
}
