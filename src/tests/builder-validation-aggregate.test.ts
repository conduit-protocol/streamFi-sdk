import { describe, it, expect } from 'vitest';
import { StreamBuilder, ValidationError } from '../builder.js';

describe('StreamBuilder aggregated validation errors (Issue #631)', () => {
  it('throws ValidationError with multiple issues when multiple fields are missing', () => {
    const builder = new StreamBuilder();

    try {
      builder.build();
      expect.unreachable('should have thrown ValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err).toBeInstanceOf(Error);
      const valErr = err as ValidationError;

      expect(valErr.name).toBe('ValidationError');
      expect(valErr.issues).toBeDefined();
      expect(valErr.issues.length).toBe(4);

      const fields = valErr.issues.map((i) => i.field);
      expect(fields).toContain('token');
      expect(fields).toContain('sender');
      expect(fields).toContain('recipient');
      expect(fields).toContain('amount');
    }
  });

  it('aggregates exactly the missing fields when some are provided', () => {
    const builder = new StreamBuilder()
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .amount(5000);

    try {
      builder.build();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const valErr = err as ValidationError;

      expect(valErr.issues.length).toBe(2);
      const fields = valErr.issues.map((i) => i.field);
      expect(fields).toContain('sender');
      expect(fields).toContain('recipient');
      expect(fields).not.toContain('token');
      expect(fields).not.toContain('amount');
    }
  });

  it('succeeds when all required fields are set', () => {
    const stream = new StreamBuilder()
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .amount(1000)
      .build();

    expect(stream.token).toBe('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526');
    expect(stream.amount).toBe('1000');
  });
});
