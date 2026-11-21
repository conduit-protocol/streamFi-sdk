import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { ConduitClient } from "../client.js";
import {
  recordConnectionResult,
  resetConnectionHealth,
} from "../connection-health.js";
import {
  advanceRpcEndpoint,
  clearRpcFailoverGroups,
  resolveRpcEndpoint,
} from "../soroban.js";

const FACTORY_ADDRESS = StrKey.encodeContract(Buffer.alloc(32, 7));

function makeClient(rpcUrls?: string[]): ConduitClient {
  return new ConduitClient({
    network: "testnet",
    factoryAddress: FACTORY_ADDRESS,
    ...(rpcUrls === undefined ? {} : { rpcUrls }),
  });
}

beforeEach(() => {
  resetConnectionHealth();
  clearRpcFailoverGroups();
});

afterEach(() => {
  resetConnectionHealth();
  clearRpcFailoverGroups();
});

describe("ConduitClient connection health", () => {
  it("aggregates RPC and relayer samples into a health snapshot", () => {
    const client = makeClient();
    const rpcUrl = client.getCurrentRpcUrl();

    recordConnectionResult(rpcUrl, true, 200, "rpc");
    recordConnectionResult(rpcUrl, false, 400, "rpc");
    recordConnectionResult("wss://relayer.example", true, 50, "relayer");

    const health = client.getConnectionHealth();

    expect(health.connected).toBe(true);
    expect(health.status).toBe("healthy");
    expect(health.activeRpcUrl).toBe(rpcUrl);
    expect(health.rpc.latencyMs).toBe(200);
    expect(health.rpc.packetLossRate).toBe(0.5);
    expect(health.relayer.latencyMs).toBe(50);
  });

  it("reports disconnected when no samples have been recorded", () => {
    const health = makeClient().getConnectionHealth();

    expect(health.connected).toBe(false);
    expect(health.status).toBe("disconnected");
  });

  it("tracks the active endpoint after failover", () => {
    const urls = ["https://rpc-a.example", "https://rpc-b.example"];
    const client = makeClient(urls);

    expect(client.getCurrentRpcUrl()).toBe(urls[0]);
    expect(resolveRpcEndpoint(urls[0]!)).toBe(urls[0]);

    expect(advanceRpcEndpoint(urls[0]!, new Set([urls[0]!]))).toBe(urls[1]);
    expect(client.getCurrentRpcUrl()).toBe(urls[1]);
  });
});
