/**
 * GovernorModule — DripGovernor config reads.
 */

import { Address, Transaction, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { ConduitConfig, GovernorConfig } from './types/index.js';
import type { Signer } from './signer.js';
import { ZERO_ADDR } from './constants.js';
import { coalesceAsync } from './coalesce-async.js';
import {
  buildContractCallTx,
  invokeContract,
  resolveFee,
  simulateReadOnly,
  scValToI128,
  scValToU32,
  scValToU64,
  NETWORK_PASSPHRASE,
  DEFAULT_RPC,
} from './soroban.js';
import { SUPPORTED_NETWORKS, UnsupportedChainError } from './errors.js';

/**
 * How long a `config` read is reused before re-simulating (#785).
 *
 * Governance parameters change only when a proposal passes, so the window
 * is a staleness budget rather than a correctness requirement. 30s is ~6
 * Stellar ledgers at the 5s close cadence, and matches the default
 * `negativeCacheTtlMs` so the two caches in this SDK fail fresh at the same
 * time. Override it with `ConduitConfig.governorConfigCacheTtlMs`, or set
 * `0` to disable caching.
 */
const GOVERNOR_CONFIG_CACHE_TTL_MS = 30_000;

export class GovernorModule {
  private readonly rpcUrl:      string;
  private readonly passphrase:  string;
  private readonly governorId: string | undefined;
  private readonly callerAddr:  string;
  private readonly network:     ConduitConfig['network'];
  private readonly cfg:         ConduitConfig;

  /**
   * Cached `config` read and the timestamp it goes stale at (#785). A single
   * entry is enough: a `GovernorModule` reads exactly one contract, so there
   * is only ever one key.
   */
  private configCache: { value: GovernorConfig; expiresAt: number } | undefined;
  private readonly configCacheTtlMs: number;
  /**
   * In-flight `config` fetches, keyed by the constant `'config'`. Coalesces
   * the burst of calls a TTL cache produces the moment its entry expires —
   * without it, N concurrent callers all miss at once and N simulations go
   * out. Reuses {@link coalesceAsync} (the same helper `soroban.ts` uses for
   * token decimals), which evicts a rejection so the next caller retries.
   *
   * Entries are released as soon as the shared fetch settles, because
   * `coalesceAsync` only evicts on rejection and a retained *fulfilled*
   * promise would pin the first result past its TTL. An in-flight entry is
   * therefore always a fetch that has not completed yet.
   */
  private readonly inFlightConfig = new Map<string, Promise<GovernorConfig>>();

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
    this.cfg        = cfg;
    this.configCacheTtlMs = cfg.governorConfigCacheTtlMs ?? GOVERNOR_CONFIG_CACHE_TTL_MS;
  }

  /**
   * Fetch the current protocol config from the DripGovernor contract.
   *
   * The result is cached for `governorConfigCacheTtlMs` (default 30s) —
   * governance parameters only change when a proposal passes, so a polling
   * dashboard should not pay a simulation per tick for data that is almost
   * always unchanged (#785). Concurrent misses share a single simulation,
   * and a failed one is never cached.
   *
   * Each caller receives its own object, so mutating a result (e.g. holding
   * a locally-adjusted copy) cannot change what the next caller sees. Call
   * {@link clearConfigCache} to force the next call to re-simulate, or set
   * `governorConfigCacheTtlMs: 0` to disable caching outright.
   *
   * @param signal - Abort signal; rejects with an `AbortError` if already
   *   aborted. The signal gates *this* call only — it never aborts an
   *   in-flight simulation that other concurrent callers are also awaiting.
   */
  async getConfig(signal?: AbortSignal): Promise<GovernorConfig> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!this.governorId) {
      throw new Error(
        `ConduitConfig.governorAddress is required (no default DripGovernor is known for network "${this.network}").`,
      );
    }

    const cached = this.configCache;
    if (cached && Date.now() < cached.expiresAt) {
      return { ...cached.value };
    }

    const value = await coalesceAsync(this.inFlightConfig, 'config', async () => {
      const tx  = await buildContractCallTx(
        this.rpcUrl, this.passphrase, this.callerAddr,
        this.governorId!, 'config', [],
      );
      const val = await simulateReadOnly(this.rpcUrl, this.passphrase, tx);
      const parsed = parseGovernorConfig(val);
      // Stamped on completion, so the TTL bounds staleness from the moment
      // the data was actually read rather than from when the call started.
      // A TTL of 0 (or less) yields an entry that is never fresh again, so
      // caching is effectively off without a separate code path.
      this.configCache = { value: parsed, expiresAt: Date.now() + this.configCacheTtlMs };
      return parsed;
    });

    // `coalesceAsync` holds on to a *fulfilled* promise, which would pin the
    // first result forever and defeat the TTL. Release the entry once the
    // shared fetch has settled (callers already awaiting it keep their
    // reference); a rejection was already evicted by `coalesceAsync` itself.
    this.inFlightConfig.delete('config');

    return { ...value };
  }

  /** Drop the cached `config` read so the next {@link getConfig} re-simulates. */
  clearConfigCache(): void {
    this.configCache = undefined;
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

  /**
   * Execute several approved proposals, e.g. to apply a multi-step parameter
   * change (pause threshold and fee bps) in one call.
   *
   * Soroban allows only one `invoke_host_function` operation per transaction,
   * so this cannot be a single atomic transaction: each proposal is submitted
   * as its own transaction, one at a time, in the order given. Submitting
   * sequentially also keeps the caller's sequence numbers valid (the same
   * reason `StreamsModule.batchWithdraw` is sequential). Results are reported
   * per proposal, so a failure does not hide the outcome of the others.
   *
   * Because later proposals may depend on earlier ones, pass
   * `{ stopOnError: true }` to halt at the first failure; the remaining
   * proposals are then reported as skipped rather than submitted.
   *
   * @param proposalIds - Proposal ids to execute. Duplicates are rejected.
   * @param options.signal - Abort signal, checked before each submission.
   * @throws if no signer is configured, `proposalIds` is empty, or an id is
   *   not a non-negative safe integer / is duplicated.
   */
  async executeMultipleProposals(
    proposalIds: number[],
    options: ExecuteProposalsOptions = {},
  ): Promise<ExecuteProposalResult[]> {
    if (!this.governorId) {
      throw new Error(
        `ConduitConfig.governorAddress is required (no default DripGovernor is known for network "${this.network}").`,
      );
    }
    if (!Array.isArray(proposalIds) || proposalIds.length === 0) {
      throw new Error('proposalIds must be a non-empty array');
    }
    const seen = new Set<number>();
    for (const id of proposalIds) {
      if (!Number.isSafeInteger(id) || id < 0) {
        throw new Error(`Invalid proposal id ${String(id)}: must be a non-negative integer`);
      }
      if (seen.has(id)) throw new Error(`Duplicate proposal id ${id}`);
      seen.add(id);
    }

    const signer = this.resolveSigner();
    const caller = await this.resolveCaller();
    const fee    = resolveFee(this.cfg);
    const polling = {
      ...(this.cfg.confirmationPollIntervalMs !== undefined && { pollIntervalMs: this.cfg.confirmationPollIntervalMs }),
      ...(this.cfg.confirmationMaxAttempts !== undefined && { maxAttempts: this.cfg.confirmationMaxAttempts }),
    };

    const results: ExecuteProposalResult[] = [];
    let halted = false;
    for (const proposalId of proposalIds) {
      if (halted) {
        results.push({ proposalId, success: false, skipped: true, error: new Error('Skipped after an earlier proposal failed') });
        continue;
      }
      try {
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const tx = await buildContractCallTx(
          this.rpcUrl, this.passphrase, caller, this.governorId,
          'execute', [nativeToScVal(BigInt(proposalId), { type: 'u64' })], fee,
        );
        const txHash = await invokeContract(this.rpcUrl, this.passphrase, signer, tx, polling);
        results.push({ proposalId, success: true, txHash });
      } catch (err) {
        // DOMException (AbortError) is not an `Error` subclass in every runtime.
        const error = err instanceof Error || (typeof err === 'object' && err !== null && 'message' in err)
          ? (err as Error)
          : new Error(String(err));
        results.push({ proposalId, success: false, error });
        if (options.stopOnError) halted = true;
      }
    }
    return results;
  }

  private resolveSigner(): Signer {
    const { wallet, signer, keypair } = this.cfg;
    if (wallet) {
      const passphrase = this.passphrase;
      return {
        publicKey: () => { throw new Error('use wallet.getPublicKey()'); },
        sign: async (tx) => {
          const signed = await wallet.signTransaction(tx, { networkPassphrase: passphrase });
          if (signed == null) throw new Error('Wallet adapter signTransaction returned null or undefined');
          return typeof signed === 'string' ? new Transaction(signed, passphrase) : signed;
        },
      };
    }
    if (signer) return signer;
    if (keypair) {
      return { publicKey: () => keypair.publicKey(), sign: (tx) => { tx.sign(keypair); } };
    }
    throw new Error('keypair, wallet adapter, or signer is required for mutating operations');
  }

  private async resolveCaller(): Promise<string> {
    const { wallet, signer, keypair } = this.cfg;
    if (wallet) return wallet.getPublicKey();
    if (signer) return signer.publicKey();
    if (keypair) return keypair.publicKey();
    throw new Error('keypair, wallet adapter, or signer is required for mutating operations');
  }
}

/**
 * On-chain proposal state as returned by the governor contract (#860).
 *
 * Note: this is the contract's raw state enum. It is distinct from the coarser
 * {@link GovernorProposal.status} string returned by `getProposals()`.
 */
export enum ProposalState {
  Pending = 0,
  Active = 1,
  Defeated = 2,
  Succeeded = 3,
}

const PROPOSAL_STATE_LABELS: Record<ProposalState, string> = {
  [ProposalState.Pending]: 'Pending',
  [ProposalState.Active]: 'Active',
  [ProposalState.Defeated]: 'Defeated',
  [ProposalState.Succeeded]: 'Succeeded',
};

/**
 * Narrows a raw contract value (number, bigint, or numeric string) to a
 * {@link ProposalState}. Returns `undefined` for anything that is not a known state.
 */
export function parseProposalState(value: unknown): ProposalState | undefined {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'bigint') n = Number(value);
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return undefined;
  return Number.isInteger(n) && n in PROPOSAL_STATE_LABELS ? (n as ProposalState) : undefined;
}

/**
 * Human-readable label for a raw proposal state, suitable for UI badges.
 * Unknown values render as `Unknown` rather than throwing.
 */
export function formatProposalState(state: number): string {
  const parsed = parseProposalState(state);
  return parsed === undefined ? 'Unknown' : PROPOSAL_STATE_LABELS[parsed];
}

export interface ExecuteProposalsOptions {
  /** Halt at the first failed proposal; later ones are reported as skipped. Default `false`. */
  stopOnError?: boolean;
  /** Abort signal, checked before each submission. */
  signal?: AbortSignal;
}

export interface ExecuteProposalResult {
  proposalId: number;
  success: boolean;
  /** Transaction hash, present when `success` is true. */
  txHash?: string;
  /** Failure reason, present when `success` is false. */
  error?: Error;
  /** True when not attempted because `stopOnError` halted the run. */
  skipped?: boolean;
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
    ...(m['voting_delay'] ? { votingDelay: Number(scValToU64(m['voting_delay'])) } : {}),
    ...(m['voting_period'] ? { votingPeriod: Number(scValToU64(m['voting_period'])) } : {}),
    ...(m['proposal_threshold'] ? { proposalThreshold: scValToI128(m['proposal_threshold']) } : {}),
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
