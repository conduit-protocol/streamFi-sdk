import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { ConduitConfig } from "../types/index.js";

const { mockSimulate, mockGetTokenDecimals } = vi.hoisted(() => ({
  mockSimulate: vi.fn(),
  mockGetTokenDecimals: vi.fn().mockResolvedValue(7),
}));

vi.mock("../factory.js", () => ({
  FactoryModule: class {
    streamAddress = vi.fn();
  },
}));

vi.mock("../soroban.js", async () => {
  const actual = await vi.importActual<typeof import("../soroban.js")>("../soroban.js");
  return {
    ...actual,
    buildContractCallTx: vi.fn().mockResolvedValue({ _stub: "tx" }),
    getTokenDecimals: mockGetTokenDecimals,
    catchNetworkError: <T>(_label: string, promise: Promise<T>) => promise,
  };
});

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>(
    "@stellar/stellar-sdk",
  );
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: class {
        simulateTransaction = mockSimulate;
      },
    },
  };
});

const FACTORY_ADDR = StrKey.encodeContract(Buffer.alloc(32, 1));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 3));
const SENDER = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();

function makeConfig(): ConduitConfig {
  return {
    network: "testnet",
    factoryAddress: FACTORY_ADDR,
    keypair: Keypair.random(),
  };
}

function successSimulation() {
  return {
    minResourceFee: "250000",
    transactionData: {
      build: () => ({
        resources: () => ({
          instructions: () => 12_345,
          readBytes: () => 64,
          writeBytes: () => 128,
          footprint: () => ({ readWrite: () => [1, 2] }),
        }),
      }),
    },
  };
}

beforeEach(() => {
  mockSimulate.mockReset();
  mockGetTokenDecimals.mockReset().mockResolvedValue(7);
});

describe("StreamsModule.simulateCreateStream()", () => {
  it("returns fee and resource estimates without submitting a transaction", async () => {
    mockSimulate.mockResolvedValue(successSimulation());

    const { StreamsModule } = await import("../streams.js");
    const sdk = new StreamsModule(makeConfig());
    const result = await sdk.simulateCreateStream({
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN,
      depositAmount: "1000",
      durationSeconds: 3600,
    });

    expect(result.minResourceFee).toBe(250000n);
    expect(result.resourceFee).toBe(250000n);
    expect(result.storageDeposit).toBe(250000n);
    expect(result.inclusionFee).toBe(100n);
    expect(result.totalFee).toBe(250100n);
    expect(result.depositAmount).toBe(10_000_000_000n);
    expect(result.requiredBalance).toBe(10_000_250_100n);
    expect(result.cpuInstructions).toBe(12345n);
    expect(result.readBytes).toBe(64n);
    expect(result.writeBytes).toBe(128n);
    expect(result.storageEntries).toBe(2);
  });

  it("reports simulation errors instead of throwing", async () => {
    mockSimulate.mockResolvedValue({ error: "insufficient balance" });

    const { StreamsModule } = await import("../streams.js");
    const sdk = new StreamsModule(makeConfig());
    const result = await sdk.simulateCreateStream({
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN,
      depositAmount: "1000",
      durationSeconds: 3600,
    });

    expect(result.simulationError).toBe("insufficient balance");
    expect(result.resourceFee).toBe(30_000_000n);
  });
});
