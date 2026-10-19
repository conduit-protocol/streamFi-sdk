import { StrKey, Networks } from '@stellar/stellar-sdk';

/** Stellar networks supported by public explorer links. */
export type NetworkType = 'mainnet' | 'testnet' | 'futurenet';

/** Human-readable labels for Stellar networks. */
export const NETWORK_NAMES: Record<NetworkType, string> = {
  mainnet: 'Mainnet',
  testnet: 'Testnet',
  futurenet: 'Futurenet',
};

/**
 * Stellar Expert URL bases, keyed by network and resource type.
 * Append the transaction hash, contract ID, or account ID to the relevant
 * base URL instead of rebuilding explorer paths throughout an application.
 */
export const EXPLORER_URLS: Record<
  NetworkType,
  { transaction: string; contract: string; account: string }
> = {
  mainnet: {
    transaction: 'https://stellar.expert/explorer/public/tx/',
    contract: 'https://stellar.expert/explorer/public/contract/',
    account: 'https://stellar.expert/explorer/public/account/',
  },
  testnet: {
    transaction: 'https://stellar.expert/explorer/testnet/tx/',
    contract: 'https://stellar.expert/explorer/testnet/contract/',
    account: 'https://stellar.expert/explorer/testnet/account/',
  },
  futurenet: {
    transaction: 'https://stellar.expert/explorer/futurenet/tx/',
    contract: 'https://stellar.expert/explorer/futurenet/contract/',
    account: 'https://stellar.expert/explorer/futurenet/account/',
  },
};

/** Connection details and official contract deployments for one Stellar network. */
export interface NetworkConfig {
  /** Network passphrase used when building and signing transactions. */
  networkPassphrase: string;
  /** Public Soroban RPC endpoint. */
  rpcUrl: string;
  /** Horizon endpoint (used by the fee estimator). */
  horizonUrl: string;
  /**
   * Official DripFactory contract ID, or `null` when no official deployment
   * has been published for this network yet — pass `factoryAddress`
   * explicitly in that case.
   */
  factoryAddress: string | null;
  /** Official vault contract ID, or `null` when not yet deployed. */
  vaultAddress: string | null;
}

/**
 * Official network configurations (#927). Use these instead of copying RPC
 * URLs, passphrases and contract IDs out of the docs:
 *
 *   const { rpcUrl, factoryAddress } = NETWORK_CONFIGS.testnet;
 */
export const NETWORK_CONFIGS: Readonly<Record<NetworkType, Readonly<NetworkConfig>>> = Object.freeze({
  mainnet: Object.freeze({
    networkPassphrase: Networks.PUBLIC,
    rpcUrl: 'https://soroban-mainnet.stellar.org',
    horizonUrl: 'https://horizon.stellar.org',
    factoryAddress: null,
    vaultAddress: null,
  }),
  testnet: Object.freeze({
    networkPassphrase: Networks.TESTNET,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    factoryAddress: null,
    vaultAddress: null,
  }),
  futurenet: Object.freeze({
    networkPassphrase: Networks.FUTURENET,
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    horizonUrl: 'https://horizon-futurenet.stellar.org',
    factoryAddress: null,
    vaultAddress: null,
  }),
});

/**
 * Networks that have RPC presets but no explorer links, such as the public
 * Futurenet and a local standalone container (#981).
 */
export type RpcNetworkId = 'futurenet' | 'standalone';

/** RPC endpoint and passphrase for a network, ready to pass to a client. */
export interface RpcNetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
}

/**
 * Soroban RPC endpoint and network passphrase per network. The standalone
 * entry matches the `local` preset in `soroban.ts`.
 */
export const NETWORK_CONFIG: Record<RpcNetworkId, RpcNetworkConfig> = {
  futurenet: {
    rpcUrl: 'https://rpc-futurenet.stellar.org',
    networkPassphrase: 'Test SDF Future Network ; October 2022',
  },
  standalone: {
    rpcUrl: 'http://localhost:8000/soroban/rpc',
    networkPassphrase: 'Standalone Network ; February 2017',
  },
};

/** Contract roles that the SDK can address by ID. */
export type ContractRole = 'factory' | 'governor';

/**
 * Deployed contract IDs per network. Each ID is derived from the deployer's
 * address and salt, so the SDK publishes none for `futurenet` or `standalone`.
 * An entry stays `null` until a deployment is recorded here, and callers must
 * pass their own addresses (`factoryAddress`, `governorAddress`) until then.
 */
export const CONTRACT_IDS: Record<RpcNetworkId, Record<ContractRole, string | null>> = {
  futurenet: { factory: null, governor: null },
  standalone: { factory: null, governor: null },
};

/**
 * Returns the published contract ID for `role` on `network`, or `null` when
 * none has been published. A `null` result means the caller must supply the
 * address explicitly.
 */
export function getContractId(network: RpcNetworkId, role: ContractRole): string | null {
  return CONTRACT_IDS[network][role];
}

/**
 * A syntactically valid Stellar G-address with no known keypair. Used only
 * as the transaction source for read-only simulation calls when no real
 * keypair is configured — Soroban's simulateTransaction doesn't require the
 * source account to actually exist or sign anything for a read-only
 * invocation. Never used to sign or move funds.
 */
export const ZERO_ADDR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Minimum stream duration (in seconds). Streams cannot be created with duration less than this. */
export const MIN_STREAM_DURATION_SECONDS = 3600;

/** Default page size for `ProductionModule` / `StreamsModule.list()` pagination. */
export const DEFAULT_LIST_LIMIT = 20;

/**
 * Maximum page size the SDK will send to `DripFactory::streams_by_sender` /
 * `streams_by_recipient`. The contract itself does not clamp this — an
 * unbounded `limit` produces an oversized simulation response -- so the SDK
 * enforces the README-documented max client-side (see #489).
 */
export const MAX_LIST_LIMIT = 100;

/**
 * Clamp a caller-supplied list `limit` into the valid `[1, MAX_LIST_LIMITY`
 * range expected by `streams_by_sender` / `streams_by_recipient`. Non-finite
 * input (NaN, ±Infinity) and values that truncate to `0` or below fall back
 * to {@link DEFAULT_LIST_LIMIT} rather than producing an invalid u32
 * conversion or an empty page.
 */
export function clampListLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  const truncated = Math.trunc(limit);
  if (truncated <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(truncated, MAX_LIST_LIMIT);
}

/**
 * Clamp a caller-supplied pagination `offset` to a non-negative integer
 * within the valid u32 range (`[0, 2^32 - 1]`). Non-finite or negative
 * input returns 0 rather than producing an invalid u32 conversion.
 */
export function clampOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(Math.trunc(offset), 0), 0xFFFFFFFF);
}

/**
 * Bit-flags packed into the on-chain `StreamInfo.flags` (`u32`). `paused`,
 * `cancelled` and `clawback_enabled` are NOT individual struct fields -- they
 * live in these bits.
 *
 * Mirrors `FLAG_PAUSED` / `FLAG_CLAWBACK_ENABLED` and the
 * `StreamInfo::is_paused()` / `is_cancelled()` / `is_clawback_enabled()`
 * getters in `contracts/stream/src/storage.rs`.
 */
export const STREAM_FLAG_PAUSED = 1;
export const STREAM_FLAG_CLAWBACK_ENABLED = 1 << 1;
export const STREAM_FLAG_CANCELLED = 1 << 2;

/**
 * Known USDC issuer G-addresses per network.
 *
 * - `mainnet` — Circle's production issuer.
 * - `testnet` — Circle's Testnet issuer (SDF Test Network).
 * - `local`   — No canonical USDC issuer exists on a local Soroban instance.
 *   Accessing this entry throws at runtime so callers get a clear error
 *   instead of silently inheriting the mainnet address (see #804).
 *
 * @example
 * ```ts
 * import { USDC_ISSUER } from './constants.js';
 * const issuer = USDC_ISSUER[network]; // throws on 'local'
 * ```
 */
export const USDC_ISSUER: Record<'mainnet' | 'testnet', string> & {
  readonly local: never;
} = {
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  get local(): never {
    throw new Error(
      "token: 'USDC' is not supported on the 'local' network — no canonical " +
      'USDC issuer exists on a local Soroban instance. ' +
      'Pass an explicit contract address for your locally-deployed token instead.',
    );
  },
} as const;
