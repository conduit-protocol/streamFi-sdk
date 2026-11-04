/**
 * Ledger-key helpers for batched stream reads (#904).
 *
 * Reading many streams without one `simulateTransaction` per stream relies on
 * two facts about how the protocol lays out its storage:
 *
 * 1. The factory maps `DataKey::StreamAddr(u64)` to the stream's contract
 *    address, in **persistent** storage
 *    (`contracts/factory/src/storage.rs`).
 * 2. Each stream keeps its entire `StreamInfo` struct under `DataKey::Config`
 *    in **instance** storage (`contracts/stream/src/state.rs`,
 *    `env.storage().instance().set(&DataKey::Config, info)`), and instance
 *    storage is itself a single ledger entry per contract.
 *
 * Both are directly addressable, so one `getLedgerEntries` call can carry many
 * keys and return many streams.
 *
 * ## How a `#[contracttype]` enum key is encoded
 *
 * A unit variant (`Config`) serialises to a bare `ScVal::Symbol("Config")`.
 * A variant **with a payload** serialises to an `ScVal::Vec` whose first
 * element is the variant name as a `Symbol`, followed by the payload:
 *
 * ```rust
 * // soroban-sdk-macros, derive_enum.rs
 * let tup = (Symbol::try_from_val(env, &case_name_str_lit)?, #(#field_convs,)*);
 * ```
 *
 * So `DataKey::StreamAddr(42)` is `scvVec([scvSymbol("StreamAddr"), scvU64(42)])`
 * — the discriminant is the *name*, not the variant index. Encoding it as a
 * `u32` index produces a key the RPC cannot match.
 *
 * ## Why keys go through `xdr.LedgerKey.contractData`
 *
 * `@stellar/stellar-base` declares `LedgerKeyContractData` only inside its
 * private `xdrHidden` namespace and never re-exports it, so the public
 * constructor is untyped — and constructing it directly (via `new` or
 * `Reflect.construct`) yields a bare `ChildStruct` lacking the union
 * accessors the RPC needs. The typed static factory
 * `xdr.LedgerKey.contractData` returns the proper `ChildUnion`.
 */

import { Address, xdr, StrKey, nativeToScVal } from "@stellar/stellar-sdk";

/** Name of the factory's id → address variant, from `DataKey::StreamAddr(u64)`. */
const STREAM_ADDR_VARIANT = "StreamAddr";

/** Name of the stream's consolidated state variant, from `DataKey::Config`. */
const STREAM_CONFIG_VARIANT = "Config";

/**
 * Read a field off `LedgerKeyContractData` / `LedgerEntryDataContractData`.
 *
 * `@stellar/stellar-base`'s typings declare `key`, `contract`, `durability`
 * and `val` as accessor *methods* (`key(): ScVal`), but the runtime objects
 * expose them as plain *properties* — `typeof entry.key === "object"` and
 * `entry.key()` throws `is not a function`. Calling the method form fails at
 * runtime; reading the property fails typecheck. This accessor reads the
 * property and satisfies both, keeping the cast in one documented place
 * instead of scattering `as never` through the helpers.
 */
function field<T>(holder: unknown, name: string): T {
  return (holder as Record<string, T>)[name] as T;
}

/**
 * Ledger key for the factory's `DataKey::StreamAddr(id)` entry — the stream's
 * contract address. Lives in persistent storage.
 */
export function streamAddressLedgerKey(
  factoryAddress: string,
  streamId: bigint,
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData({
    contract: Address.fromString(factoryAddress).toScAddress(),
    key: xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(STREAM_ADDR_VARIANT),
      nativeToScVal(streamId, { type: "u64" }),
    ]),
    durability: xdr.ContractDataDurability.persistent(),
  } as never);
}

/**
 * Ledger key for a contract's instance entry, which carries its whole instance
 * storage (including the stream's `DataKey::Config`).
 */
export function contractInstanceLedgerKey(
  contractAddress: string,
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData({
    contract: Address.fromString(contractAddress).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
  } as never);
}

/** Recover the decimal stream id from a key built by {@link streamAddressLedgerKey}. */
export function streamIdFromAddressLedgerKey(
  key: xdr.LedgerKey,
): string | undefined {
  if (key.switch().name !== "contractData") return undefined;
  const scKey = field<xdr.ScVal>(key.contractData(), "key");
  if (scKey.switch().name !== "scvVec") return undefined;
  const parts = scKey.vec();
  if (!parts || parts.length !== 2) return undefined;
  const variant = parts[0];
  if (!variant || variant.switch().name !== "scvSymbol") return undefined;
  if (variant.sym().toString("utf8") !== STREAM_ADDR_VARIANT) return undefined;
  const idVal = parts[1];
  if (!idVal || idVal.switch().name !== "scvU64") return undefined;
  return idVal.u64().toString();
}

/** Recover the contract address from a key built by {@link contractInstanceLedgerKey}. */
export function contractIdFromInstanceLedgerKey(
  key: xdr.LedgerKey,
): string | undefined {
  if (key.switch().name !== "contractData") return undefined;
  const contractData = key.contractData();
  // Only instance entries; skip anything else that happens to be batched in.
  if (
    field<xdr.ScVal>(contractData, "key").switch().name !==
    "scvLedgerKeyContractInstance"
  ) {
    return undefined;
  }
  const scAddress = field<xdr.ScAddress>(contractData, "contract");
  if (scAddress.switch().name !== "scAddressTypeContract") return undefined;
  return StrKey.encodeContract(scAddress.contractId());
}

/**
 * Extract the `DataKey::Config` value from a contract-instance ledger entry.
 *
 * Instance storage is a `Vec<ScMapEntry>`; the stream writes its whole
 * `StreamInfo` under the symbol `Config`. Returns `undefined` when the entry
 * is not a contract instance or carries no `Config` key.
 */
export function instanceConfigValue(
  instanceEntry: xdr.LedgerEntryData,
): xdr.ScVal | undefined {
  if (instanceEntry.switch().name !== "contractData") return undefined;
  const contractData = instanceEntry.contractData();
  const val = field<xdr.ScVal>(contractData, "val");
  if (val.switch().name !== "scvContractInstance") return undefined;
  const storage = val.instance().storage() ?? [];
  for (const entry of storage) {
    const key = entry.key();
    if (key.switch().name !== "scvSymbol") continue;
    if (key.sym().toString("utf8") === STREAM_CONFIG_VARIANT) {
      return entry.val();
    }
  }
  return undefined;
}
