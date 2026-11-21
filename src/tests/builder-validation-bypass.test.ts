import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConduitBatcher, StreamBuilder } from '../builder.js';

/** Real chain context so the batcher can build genuine transaction XDR. */
const TEST_CONTEXT = {
  contractId: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
  sourceAccount: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
  network: 'testnet' as const,
  sequence: '1',
};


describe('ConduitBatcher validation', () => {
  let batcher: ConduitBatcher;

  beforeEach(() => {
    batcher = new ConduitBatcher();
  });

  afterEach(() => {
    batcher.reset();
  });

  it('should reject null payload', () => {
    const result = batcher.execute(null as any, { context: TEST_CONTEXT });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('null'))).toBe(true);
  });

  it('should reject undefined payload', () => {
    const result = batcher.execute(undefined as any, { context: TEST_CONTEXT });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('undefined'))).toBe(true);
  });

  it('should reject non-array payload', () => {
    const result = batcher.execute('not an array' as any, { context: TEST_CONTEXT });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('array'))).toBe(true);
  });

  it('should reject array with null items', () => {
    const result = batcher.execute([null] as any, { context: TEST_CONTEXT });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('null'))).toBe(true);
  });

  it('should reject array with undefined items', () => {
    const result = batcher.execute([undefined] as any, { context: TEST_CONTEXT });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('undefined'))).toBe(true);
  });

  it('should reject array with non-object items', () => {
    const result = batcher.execute(['not an object'] as any, { context: TEST_CONTEXT });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('must be an object'))).toBe(true);
  });

  it('should reject item with invalid token (non C-address)', () => {
    const result = batcher.execute([
      { token: 'not-a-valid-contract', sender: 'GA1', recipient: 'GB1', amount: 100 },
    ], { context: TEST_CONTEXT });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('token') && e.includes('C-address'))).toBe(true);
  });

  it('should reject item with invalid sender (non G-address)', () => {
    const result = batcher.execute([
      { token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526', sender: 'not-a-valid-key', recipient: 'GB1', amount: 100 },
    ], { context: TEST_CONTEXT });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('sender') && e.includes('public key'))).toBe(true);
  });

  it('should reject item with invalid recipient (non G-address)', () => {
    const result = batcher.execute([
      { token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526', sender: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H', recipient: 'bad-recipient', amount: 100 },
    ], { context: TEST_CONTEXT });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('recipient') && e.includes('public key'))).toBe(true);
  });

  it('should reject item with zero amount', () => {
    const result = batcher.execute([
      { token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526', sender: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H', recipient: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H', amount: 0n },
    ], { context: TEST_CONTEXT });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('amount') && e.includes('positive'))).toBe(true);
  });

  it('should reject item with negative amount', () => {
    const result = batcher.execute([
      { token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526', sender: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H', recipient: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H', amount: -50 },
    ], { context: TEST_CONTEXT });
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('amount'))).toBe(true);
  });

  it('should accept valid object array with proper addresses', () => {
    const validPayload = [{
      method: 'create',
      params: { amount: 100 },
      token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
      sender: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
      recipient: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
    }];
    const result = batcher.execute(validPayload, { context: TEST_CONTEXT });
    expect(result.success).toBe(true);
    expect(result.operations).toBe(1);
  });

  it('should not validate missing optional fields', () => {
    // Items without token/sender/recipient fields should not trigger address validation
    const result = batcher.execute([
      { method: 'create', params: { amount: 100 } },
    ], { context: TEST_CONTEXT });
    expect(result.success).toBe(true);
    expect(result.operations).toBe(1);
  });

  it('should handle bigint fields safely in payload', () => {
    const payloadWithBigInt = [{ method: 'create', params: { amount: 100n } }];
    const result = batcher.execute(payloadWithBigInt, { context: TEST_CONTEXT });
    expect(result.success).toBe(true);
    expect(result.operations).toBe(1);
  });

  it('should throw when trying to execute after destroy', () => {
    batcher.destroy();
    expect(() => batcher.execute([], { context: TEST_CONTEXT })).toThrow(/destroyed/i);
  });
});

describe('StreamBuilder address validation', () => {
  it('should accept valid token (C-address)', () => {
    const builder = new StreamBuilder();
    expect(() => builder.token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')).not.toThrow();
  });

  it('should reject invalid token address', () => {
    const builder = new StreamBuilder();
    expect(() => builder.token('not-a-valid-contract')).toThrow(/C-address/);
  });

  it('should reject empty token address', () => {
    const builder = new StreamBuilder();
    expect(() => builder.token('')).toThrow(/non-empty/);
  });

  it('should accept valid sender (G-address)', () => {
    const builder = new StreamBuilder();
    expect(() => builder.sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')).not.toThrow();
  });

  it('should reject invalid sender address', () => {
    const builder = new StreamBuilder();
    expect(() => builder.sender('not-a-valid-sender')).toThrow(/public key/);
  });

  it('should accept valid recipient (G-address)', () => {
    const builder = new StreamBuilder();
    expect(() => builder.recipient('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')).not.toThrow();
  });

  it('should reject invalid recipient address', () => {
    const builder = new StreamBuilder();
    expect(() => builder.recipient('not-a-valid-recipient')).toThrow(/public key/);
  });
});
