/**
 * Validation for {@link StreamScheduleConfig} (#1097).
 *
 * Schedule parameters used to be passed as loose option objects that were
 * never checked; a reversed time range or a cliff outside the stream only
 * failed (or silently mis-vested) on-chain. `validateStreamSchedule` checks
 * the shape for each schedule kind up front.
 */

import type { StreamScheduleConfig } from "./types/index.js";

export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScheduleError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function assertTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidScheduleError(
      `${name} must be a non-negative integer Unix timestamp (seconds), got ${value}`,
    );
  }
}

/**
 * Throws {@link InvalidScheduleError} if `schedule` is malformed; returns the
 * schedule unchanged otherwise so it can be used inline.
 */
export function validateStreamSchedule<T extends StreamScheduleConfig>(schedule: T): T {
  assertTimestamp("startTime", schedule.startTime);

  switch (schedule.kind) {
    case "linear":
      assertTimestamp("endTime", schedule.endTime);
      if (schedule.endTime <= schedule.startTime) {
        throw new InvalidScheduleError("endTime must be after startTime");
      }
      return schedule;

    case "cliff":
      assertTimestamp("cliffTime", schedule.cliffTime);
      assertTimestamp("endTime", schedule.endTime);
      if (schedule.cliffTime < schedule.startTime) {
        throw new InvalidScheduleError("cliffTime must not be before startTime");
      }
      if (schedule.endTime <= schedule.cliffTime) {
        throw new InvalidScheduleError("endTime must be after cliffTime");
      }
      return schedule;

    case "stepped":
      if (!Number.isSafeInteger(schedule.stepDurationSeconds) || schedule.stepDurationSeconds <= 0) {
        throw new InvalidScheduleError("stepDurationSeconds must be a positive integer");
      }
      if (!Number.isSafeInteger(schedule.steps) || schedule.steps <= 0) {
        throw new InvalidScheduleError("steps must be a positive integer");
      }
      if (!Number.isSafeInteger(schedule.startTime + schedule.stepDurationSeconds * schedule.steps)) {
        throw new InvalidScheduleError("stepped schedule end overflows a safe integer");
      }
      return schedule;

    default: {
      const unknownKind = (schedule as { kind?: unknown }).kind;
      throw new InvalidScheduleError(`unknown schedule kind: ${String(unknownKind)}`);
    }
  }
}

/** The timestamp (seconds) at which the schedule is fully vested. */
export function scheduleEndTime(schedule: StreamScheduleConfig): number {
  switch (schedule.kind) {
    case "linear":
    case "cliff":
      return schedule.endTime;
    case "stepped":
      return schedule.startTime + schedule.stepDurationSeconds * schedule.steps;
  }
}
