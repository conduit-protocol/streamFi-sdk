import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError, RpcServiceUnavailableError } from "../errors.js";
import { resetCircuit } from "../rpc-circuit-state.js";
import { resetConnectionHealth } from "../connection-health.js";

const { mockGetLatestLedgerA, mockGetLatestLedgerB } = vi.hoisted(() => ({
  mockGetLatestLedgerA: vi.fn(),
  mockGetLatestLedgerB: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");
  return {
    ...actual,
    SorobanRpc: {
      ...(actual as { SorobanRpc: Record<string, unknown> }).SorobanRpc,
      Server: vi.fn().mockImplementation(function MockServer(url: string) {
        return {
          getLatestLedger:
            url === "https://rpc-a.example"
              ? mockGetLatestLedgerA
              : mockGetLatestLedgerB,
        };
      }),
    },
  };
});

import {
  advanceRpcEndpoint,
  clearRpcEndpointStates,
  clearRpcFailoverGroups,
  clearServerCache,
  createRpcServer,
  registerRpcEndpointGroup,
  resolveRpcEndpoint,
} from "../soroban.js";

const URLS = ["https://rpc-a.example", "https://rpc-b.example"];

beforeEach(() => {
  clearServerCache();
  clearRpcFailoverGroups();
  clearRpcEndpointStates();
  resetConnectionHealth();
  resetCircuit(URLS[0]!);
  resetCircuit(URLS[1]!);
  mockGetLatestLedgerA.mockReset();
  mockGetLatestLedgerB.mockReset();
});

afterEach(() => {
  clearServerCache();
  clearRpcFailoverGroups();
  clearRpcEndpointStates();
  resetConnectionHealth();
  resetCircuit(URLS[0]!);
  resetCircuit(URLS[1]!);
});

describe("soroban.ts multi-RPC failover", () => {
  it("rotates to the next endpoint on HTTP 503", async () => {
    registerRpcEndpointGroup(URLS, { failureThreshold: 3 });
    mockGetLatestLedgerA.mockRejectedValue({ response: { status: 503, headers: {} } });
    mockGetLatestLedgerB.mockResolvedValue({ sequence: 42 });

    const result = await (createRpcServer(URLS[0] ?? "").getLatestLedger() as Promise<unknown>);

    expect(result).toEqual({ sequence: 42 });
    expect(mockGetLatestLedgerA).toHaveBeenCalledTimes(1);
    expect(mockGetLatestLedgerB).toHaveBeenCalledTimes(1);
    expect(resolveRpcEndpoint(URLS[0] ?? "")).toBe(URLS[1]);
  });

  it("rotates to the next endpoint on HTTP 502 (bad gateway)", async () => {
    registerRpcEndpointGroup(URLS, { failureThreshold: 3 });
    mockGetLatestLedgerA.mockRejectedValue({ response: { status: 502, headers: {} } });
    mockGetLatestLedgerB.mockResolvedValue({ sequence: 43 });

    const result = await (createRpcServer(URLS[0] ?? "").getLatestLedger() as Promise<unknown>);

    expect(result).toEqual({ sequence: 43 });
    expect(mockGetLatestLedgerA).toHaveBeenCalledTimes(1);
    expect(mockGetLatestLedgerB).toHaveBeenCalledTimes(1);
    expect(resolveRpcEndpoint(URLS[0] ?? "")).toBe(URLS[1]);
  });

  it("does not fail over on a client error (HTTP 400)", async () => {
    registerRpcEndpointGroup(URLS, { failureThreshold: 3 });
    mockGetLatestLedgerA.mockRejectedValue({ response: { status: 400, headers: {} } });
    mockGetLatestLedgerB.mockResolvedValue({ sequence: 44 });

    await expect(
      createRpcServer(URLS[0] ?? "").getLatestLedger() as Promise<unknown>,
    ).rejects.toMatchObject({ response: { status: 400 } });
    expect(mockGetLatestLedgerB).not.toHaveBeenCalled();
    expect(resolveRpcEndpoint(URLS[0] ?? "")).toBe(URLS[0]);
  });

  it("classifies HTTP 502 as a service-unavailable error", async () => {
    const { RpcServiceUnavailableError: Unavailable } = await import("../errors.js");
    const { RateLimitError: Limit } = await import("../errors.js");
    const mapped = Limit.fromRpcError({ response: { status: 502, headers: {} } });
    expect(mapped).toBeInstanceOf(Unavailable);
    expect((mapped as Error).message).toContain("(502)");
  });

  it("rotates to the next endpoint on HTTP 429 without retrying the same one", async () => {
    registerRpcEndpointGroup(URLS, { failureThreshold: 3 });
    mockGetLatestLedgerA.mockRejectedValue({
      message: "Request failed with status code 429",
      response: { status: 429, headers: { "retry-after": "1" } },
    });
    mockGetLatestLedgerB.mockResolvedValue({ sequence: 43 });

    const result = await (createRpcServer(URLS[0] ?? "").getLatestLedger() as Promise<unknown>);

    expect(result).toEqual({ sequence: 43 });
    expect(mockGetLatestLedgerA).toHaveBeenCalledTimes(1);
    expect(mockGetLatestLedgerB).toHaveBeenCalledTimes(1);
  });

  it("rotates on a network timeout", async () => {
    registerRpcEndpointGroup(URLS, { failureThreshold: 1 });
    mockGetLatestLedgerA.mockRejectedValue({
      code: "ECONNRESET",
      message: "socket hung up",
    });
    mockGetLatestLedgerB.mockResolvedValue({ sequence: 44 });

    await expect(
      createRpcServer(URLS[0] ?? "").getLatestLedger() as Promise<unknown>,
    ).resolves.toEqual({ sequence: 44 });
    expect(resolveRpcEndpoint(URLS[0] ?? "")).toBe(URLS[1]);
  });

  it("returns RateLimitError when every endpoint is rate limited", async () => {
    registerRpcEndpointGroup(URLS, { failureThreshold: 3 });
    mockGetLatestLedgerA.mockRejectedValue({
      response: { status: 429, headers: {} },
    });
    mockGetLatestLedgerB.mockRejectedValue({
      response: { status: 429, headers: {} },
    });

    await expect(
      createRpcServer(URLS[0] ?? "").getLatestLedger() as Promise<unknown>,
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(mockGetLatestLedgerA).toHaveBeenCalledTimes(1);
    expect(mockGetLatestLedgerB).toHaveBeenCalledTimes(1);
  });

  it("surfaces service unavailability when all endpoints return 503", async () => {
    registerRpcEndpointGroup(URLS, { failureThreshold: 3 });
    mockGetLatestLedgerA.mockRejectedValue({
      response: { status: 503, headers: {} },
    });
    mockGetLatestLedgerB.mockRejectedValue({
      response: { status: 503, headers: {} },
    });

    await expect(
      createRpcServer(URLS[0] ?? "").getLatestLedger() as Promise<unknown>,
    ).rejects.toBeInstanceOf(RpcServiceUnavailableError);
  });

  it("advances only to endpoints that were not already attempted", async () => {
    registerRpcEndpointGroup(URLS, { failureThreshold: 3 });
    expect(advanceRpcEndpoint(URLS[0] ?? "", new Set(URLS))).toBeUndefined();
  });
});
