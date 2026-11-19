import { describe, it, expect } from 'vitest';
import { validateStreamSchedule, scheduleEndTime, InvalidScheduleError } from '../schedule.js';
import type { StreamScheduleConfig } from '../types/index.js';

describe('StreamScheduleConfig validation (#1097)', () => {
  it('accepts a well-formed schedule of each kind', () => {
    const schedules: StreamScheduleConfig[] = [
      { kind: 'linear', startTime: 1_000, endTime: 2_000 },
      { kind: 'cliff', startTime: 1_000, cliffTime: 1_500, endTime: 2_000 },
      { kind: 'stepped', startTime: 1_000, stepDurationSeconds: 100, steps: 10 },
    ];
    for (const schedule of schedules) {
      expect(validateStreamSchedule(schedule)).toBe(schedule);
    }
  });

  it('rejects a linear schedule that ends before it starts', () => {
    expect(() => validateStreamSchedule({ kind: 'linear', startTime: 2_000, endTime: 1_000 })).toThrow(
      InvalidScheduleError,
    );
  });

  it('rejects a cliff outside the stream window', () => {
    expect(() =>
      validateStreamSchedule({ kind: 'cliff', startTime: 1_000, cliffTime: 900, endTime: 2_000 }),
    ).toThrow('cliffTime must not be before startTime');
    expect(() =>
      validateStreamSchedule({ kind: 'cliff', startTime: 1_000, cliffTime: 2_000, endTime: 2_000 }),
    ).toThrow('endTime must be after cliffTime');
  });

  it('rejects non-positive step counts and durations', () => {
    expect(() =>
      validateStreamSchedule({ kind: 'stepped', startTime: 1_000, stepDurationSeconds: 0, steps: 5 }),
    ).toThrow('stepDurationSeconds');
    expect(() =>
      validateStreamSchedule({ kind: 'stepped', startTime: 1_000, stepDurationSeconds: 10, steps: 1.5 }),
    ).toThrow('steps');
  });

  it('rejects fractional or negative timestamps', () => {
    expect(() => validateStreamSchedule({ kind: 'linear', startTime: -1, endTime: 10 })).toThrow('startTime');
    expect(() => validateStreamSchedule({ kind: 'linear', startTime: 1, endTime: 10.5 })).toThrow('endTime');
  });

  it('rejects an unknown kind passed in from untyped input', () => {
    const loose = { kind: 'exponential', startTime: 1 } as unknown as StreamScheduleConfig;
    expect(() => validateStreamSchedule(loose)).toThrow('unknown schedule kind: exponential');
  });

  it('computes when each schedule is fully vested', () => {
    expect(scheduleEndTime({ kind: 'linear', startTime: 0, endTime: 50 })).toBe(50);
    expect(scheduleEndTime({ kind: 'cliff', startTime: 0, cliffTime: 10, endTime: 60 })).toBe(60);
    expect(scheduleEndTime({ kind: 'stepped', startTime: 100, stepDurationSeconds: 25, steps: 4 })).toBe(200);
  });
});
