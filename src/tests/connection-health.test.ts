import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getEndpointHealth,
  getRelayerHealth,
  recordConnectionResult,
  resetConnectionHealth,
} from "../connection-health.js";

beforeEach(() => {
  resetConnectionHealth();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
  resetConnectionHealth();
});

describe("connection-health", () => {
  it("records latency, packet loss, and connected state for an endpoint", () => {
    recordConnectionResult("https://rpc.example", true, 120, "rpc");
    recordConnectionResult("https://rpc.example", false, 900, "rpc");
    recordConnectionResult("https://rpc.example", true, 180, "rpc");

    const health = getEndpointHealth("https://rpc.example");
    expect(health.connected).toBe(true);
    expect(health.status).toBe("healthy");
    expect(health.latencyMs).toBe(150);
    expect(health.packetLossRate).toBeCloseTo(1 / 3);
    expect(health.samples).toBe(3);
  });

  it("reports degraded when at least half the recent samples failed", () => {
    recordConnectionResult("https://rpc.example", false, 100, "rpc");
    recordConnectionResult("https://rpc.example", true, 100, "rpc");
    recordConnectionResult("https://rpc.example", false, 100, "rpc");
    recordConnectionResult("https://rpc.example", true, 100, "rpc");

    expect(getEndpointHealth("https://rpc.example").status).toBe("degraded");
  });

  it("keeps relayer health separate from RPC health", () => {
    recordConnectionResult("wss://relayer.example", true, 40, "relayer");

    expect(getRelayerHealth().connected).toBe(true);
    expect(getRelayerHealth().latencyMs).toBe(40);
    expect(getEndpointHealth("wss://relayer.example").samples).toBe(0);
  });

  it("prunes samples outside the rolling window", () => {
    recordConnectionResult("https://rpc.example", true, 100, "rpc");
    vi.advanceTimersByTime(61_000);

    expect(getEndpointHealth("https://rpc.example").samples).toBe(0);
    expect(getEndpointHealth("https://rpc.example").connected).toBe(false);
  });

  it("clears only the requested scope", () => {
    recordConnectionResult("https://rpc.example", true, 100, "rpc");
    recordConnectionResult("wss://relayer.example", true, 100, "relayer");

    resetConnectionHealth("https://rpc.example");

    expect(getEndpointHealth("https://rpc.example").samples).toBe(0);
    expect(getRelayerHealth().samples).toBe(1);
  });
});
