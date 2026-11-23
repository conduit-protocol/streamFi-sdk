import { describe, expect, it } from "vitest";
import type { StreamInfo } from "../types/index.js";
import { getStreamProgress, getStreamStatus } from "../streams.js";

function makeStream(overrides: Partial<StreamInfo> = {}): StreamInfo {
  return {
    id: 1n,
    address: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    sender: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    recipient: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    token: "native",
    ratePerSecond: 10n,
    startTime: 1000,
    endTime: 3700,
    withdrawn: 100n,
    paused: false,
    pausedAt: 0,
    cancelled: false,
    clawbackEnabled: false,
    ...overrides,
  };
}

describe("stream progress helpers", () => {
  it("returns formatted progress and remaining time for a bounded stream", () => {
    const progress = getStreamProgress(makeStream(), 2350);

    expect(progress.progress).toBe(50);
    expect(progress.progressRatio).toBe(0.5);
    expect(progress.elapsedSeconds).toBe(1350);
    expect(progress.remainingSeconds).toBe(1350);
    expect(progress.durationSeconds).toBe(2700);
    expect(progress.formattedProgress).toBe("50%");
    expect(progress.formattedRemaining).toBe("22m 30s");
    expect(progress.status).toBe("active");
    expect(progress.streamed).toBe(13500n);
    expect(progress.withdrawable).toBe(13400n);
  });

  it("handles open-ended streams without a finite remaining time", () => {
    const progress = getStreamProgress(makeStream({ endTime: 0 }), 2000);

    expect(progress.isOpenEnded).toBe(true);
    expect(progress.durationSeconds).toBeNull();
    expect(progress.remainingSeconds).toBe(0);
    expect(progress.formattedRemaining).toBe("Open-ended");
  });

  it("freezes progress while paused", () => {
    const progress = getStreamProgress(
      makeStream({ paused: true, pausedAt: 1500 }),
      2000,
    );

    expect(progress.elapsedSeconds).toBe(500);
    expect(progress.progressRatio).toBeCloseTo(500 / 2700);
    expect(progress.status).toBe("paused");
  });

  it("provides getStreamStatus as an alias", () => {
    const stream = makeStream();
    expect(getStreamStatus(stream, 2350)).toEqual(getStreamProgress(stream, 2350));
  });
});
