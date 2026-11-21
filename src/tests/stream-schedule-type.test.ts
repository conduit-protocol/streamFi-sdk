import { describe, it, expect } from 'vitest';
import { StreamScheduleType } from '../types/index.js';

describe('StreamScheduleType (#968)', () => {
  it('exposes the expected numeric values', () => {
    expect(StreamScheduleType.Linear).toBe(0);
    expect(StreamScheduleType.CliffLinear).toBe(1);
    expect(StreamScheduleType.ExponentialDecay).toBe(2);
  });

  it('round-trips through JSON as plain numbers', () => {
    const serialized = JSON.stringify({ type: StreamScheduleType.CliffLinear });
    const parsed = JSON.parse(serialized) as { type: StreamScheduleType };
    expect(parsed.type).toBe(StreamScheduleType.CliffLinear);
  });
});
