import { describe, it, expect } from "vitest";
import {
  StreamStatus,
  deriveStreamStatus,
  type StreamInfo,
} from "../types/index.js";

/** Build a minimal valid {@link StreamInfo} for tests. */
function makeInfo(overrides: Partial<StreamInfo> = {}): StreamInfo {
  return {
    id: 1n,
    address: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    sender: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    token: "native",
    ratePerSecond: 1n,
    startTime: 1_000,
    endTime: 2_000,
    withdrawn: 0n,
    paused: false,
    pausedAt: 0,
    cancelled: false,
    clawbackEnabled: false,
    ...overrides,
  };
}

describe("deriveStreamStatus", () => {
  const NOW = 1_500;

  it("returns Cancelled when the stream is cancelled", () => {
    expect(deriveStreamStatus(makeInfo({ cancelled: true }), NOW)).toBe(
      StreamStatus.Cancelled,
    );
  });

  it("returns Paused when the stream is paused", () => {
    expect(deriveStreamStatus(makeInfo({ paused: true }), NOW)).toBe(
      StreamStatus.Paused,
    );
  });

  it("returns Completed once the natural endTime has passed", () => {
    expect(deriveStreamStatus(makeInfo({ endTime: 2_000 }), 2_500)).toBe(
      StreamStatus.Completed,
    );
  });

  it("returns Created before the stream's startTime", () => {
    expect(deriveStreamStatus(makeInfo({ startTime: 1_000 }), 500)).toBe(
      StreamStatus.Created,
    );
  });

  it("returns Active for an in-flight, unpaused, uncancelled stream", () => {
    expect(deriveStreamStatus(makeInfo(), NOW)).toBe(StreamStatus.Active);
  });

  it("gives Cancelled precedence over Paused", () => {
    expect(
      deriveStreamStatus(makeInfo({ cancelled: true, paused: true }), NOW),
    ).toBe(StreamStatus.Cancelled);
  });

  it("gives Paused precedence over Completed", () => {
    expect(
      deriveStreamStatus(makeInfo({ paused: true, endTime: 2_000 }), 2_500),
    ).toBe(StreamStatus.Paused);
  });
});
