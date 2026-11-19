import { describe, it, expect } from "vitest";
import { xdr, Address, Keypair, StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import {
  streamAddressLedgerKey,
  contractInstanceLedgerKey,
  streamIdFromAddressLedgerKey,
  contractIdFromInstanceLedgerKey,
  instanceConfigValue,
} from "../ledger-keys.js";

const FACTORY = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const STREAM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

/** Build a stream-instance ledger entry the way the contract writes it. */
function instanceEntry(streamId: bigint, withConfig = true): xdr.LedgerEntryData {
  const kp = Keypair.random();
  const sender = Address.fromString(kp.publicKey());
  const fields: Array<[string, xdr.ScVal]> = [
    ["sender", sender.toScVal()],
    ["recipient", sender.toScVal()],
    ["token", Address.fromString(Keypair.random().publicKey()).toScVal()],
    ["rate_per_second", nativeToScVal(1000n, { type: "i128" })],
    ["start_time", nativeToScVal(1_700_000_000n, { type: "u64" })],
    ["end_time", nativeToScVal(1_700_003_600n, { type: "u64" })],
    ["withdrawn", nativeToScVal(250n, { type: "i128" })],
    ["paused_at", nativeToScVal(0n, { type: "u64" })],
    ["flags", nativeToScVal(1, { type: "u32" })],
    ["event_sequence", nativeToScVal(3n, { type: "u64" })],
    ["cumulative_fees", nativeToScVal(7n, { type: "i128" })],
  ];
  const configVal = xdr.ScVal.scvMap(
    fields.map(
      ([k, v]) =>
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v }),
    ),
  );

  const storage: xdr.ScMapEntry[] = [];
  if (withConfig) {
    storage.push(
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("Config"),
        val: configVal,
      }),
    );
  }
  storage.push(
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("StorageVersion"),
      val: nativeToScVal(2, { type: "u32" }),
    }),
  );

  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableWasm(
      Buffer.alloc(32, 7),
    ),
    storage,
  });

  return xdr.LedgerEntryData.contractData({
    contract: Address.fromString(STREAM).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(instance),
  } as never);
}

describe("streamAddressLedgerKey", () => {
  it("encodes DataKey::StreamAddr(id) as scvVec([Symbol, u64])", () => {
    const key = streamAddressLedgerKey(FACTORY, 42n);
    expect(key.switch().name).toBe("contractData");

    const cd = key.contractData();
    expect((cd.durability as unknown as {name: string}).name).toBe("persistent");
    // The variant name is the discriminant — NOT the variant index.
    const parts = (cd.key as unknown as xdr.ScVal).vec()!;
    expect(parts).toHaveLength(2);
    expect(parts[0]!.switch().name).toBe("scvSymbol");
    expect(parts[0]!.sym().toString("utf8")).toBe("StreamAddr");
    expect(parts[1]!.switch().name).toBe("scvU64");
    expect(parts[1]!.u64().toString()).toBe("42");
  });

  it("targets the factory contract", () => {
    const cd = streamAddressLedgerKey(FACTORY, 1n).contractData();
    expect(StrKey.encodeContract((cd.contract as unknown as xdr.ScAddress).contractId())).toBe(FACTORY);
  });

  it("round-trips the id through streamIdFromAddressLedgerKey", () => {
    for (const id of [0n, 1n, 42n, 2n ** 32n, 18446744073709551615n]) {
      const key = streamAddressLedgerKey(FACTORY, id);
      expect(streamIdFromAddressLedgerKey(key)).toBe(id.toString());
    }
  });

  it("produces a distinct key per stream id", () => {
    const a = streamAddressLedgerKey(FACTORY, 1n);
    const b = streamAddressLedgerKey(FACTORY, 2n);
    // Compare the encoded id rather than XDR: `toXDR` needs the real struct.
    expect(streamIdFromAddressLedgerKey(a)).toBe("1");
    expect(streamIdFromAddressLedgerKey(b)).toBe("2");
  });
});

describe("contractInstanceLedgerKey", () => {
  it("uses scvLedgerKeyContractInstance", () => {
    const cd = contractInstanceLedgerKey(STREAM).contractData();
    expect((cd.key as unknown as xdr.ScVal).switch().name).toBe("scvLedgerKeyContractInstance");
    expect(StrKey.encodeContract((cd.contract as unknown as xdr.ScAddress).contractId())).toBe(STREAM);
  });

  it("round-trips the address through contractIdFromInstanceLedgerKey", () => {
    const key = contractInstanceLedgerKey(STREAM);
    expect(contractIdFromInstanceLedgerKey(key)).toBe(STREAM);
  });
});

describe("key readers reject foreign keys", () => {
  it("streamIdFromAddressLedgerKey ignores a Config-style key", () => {
    const other = contractInstanceLedgerKey(STREAM);
    expect(streamIdFromAddressLedgerKey(other)).toBeUndefined();
  });

  it("streamIdFromAddressLedgerKey ignores a different variant name", () => {
    // A key shaped like DataKey::StreamCount (no payload) must not be read as
    // a stream address.
    const wrong = xdr.LedgerKey.contractData({
      contract: Address.fromString(FACTORY).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("StreamCount")]),
      durability: xdr.ContractDataDurability.persistent(),
    } as never);
    expect(streamIdFromAddressLedgerKey(wrong)).toBeUndefined();
  });

  it("contractIdFromInstanceLedgerKey ignores an address key", () => {
    const addrKey = streamAddressLedgerKey(FACTORY, 3n);
    expect(contractIdFromInstanceLedgerKey(addrKey)).toBeUndefined();
  });
});

describe("instanceConfigValue", () => {
  it("extracts the Config value from instance storage", () => {
    const entry = instanceEntry(1n);
    const val = instanceConfigValue(entry);
    expect(val).toBeDefined();
    expect(val!.switch().name).toBe("scvMap");

    // The extracted map must be what parseStreamInfo consumes: symbol keys.
    const names = (val!.map() ?? []).map((e) =>
      e.key().switch().name === "scvSymbol"
        ? e.key().sym().toString("utf8")
        : "",
    );
    expect(names).toContain("sender");
    expect(names).toContain("rate_per_second");
    expect(names).toContain("flags");
    expect(names).toContain("paused_at");
  });

  it("returns undefined when instance storage has no Config entry", () => {
    expect(instanceConfigValue(instanceEntry(1n, false))).toBeUndefined();
  });

  it("returns undefined for a non-contractData entry", () => {
    // A `ttl` entry is the simplest LedgerEntryData variant with no payload.
    const notContractData = xdr.LedgerEntryData.ttl({
      keyHash: Buffer.alloc(32, 1),
      liveUntilLedgerSeq: 100,
    } as never);
    expect(instanceConfigValue(notContractData)).toBeUndefined();
  });
});
