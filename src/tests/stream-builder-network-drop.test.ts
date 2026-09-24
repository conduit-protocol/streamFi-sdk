import { describe, it, expect } from 'vitest';
import { StreamBuilder, ConduitBatcher } from '../builder.js';

/** Real chain context so the batcher can build genuine transaction XDR. */
const TEST_CONTEXT = {
  contractId: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
  sourceAccount: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
  network: 'testnet' as const,
  sequence: '1',
};


describe('StreamBuilder Network Interruption & Payload Queueing Regression Tests', () => {
  it('throws boundary check error when build is called with missing or null parameters', () => {
    const builder = new StreamBuilder();
    expect(() => builder.build()).toThrow('4 validation issue(s)');

    const nullTokenBuilder = new StreamBuilder();
    expect(() => nullTokenBuilder.token(null as any)).toThrow(
      'Invalid StreamBuilder parameter: token must be a non-empty string'
    );
  });

  it('queues payload during transient network failures and resolves cleanly when network recovers', async () => {
    const builder = new StreamBuilder()
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .amount(1000);

    let attempts = 0;
    const flakeyNetworkSubmit = async (_payload: any) => {
      attempts++;
      if (attempts < 2) {
        throw new Error('Network interruption: Connection reset by peer');
      }
      return { status: 'CONFIRMED', txHash: '0x1234567890abcdef' };
    };

    const result = await builder.submit(flakeyNetworkSubmit, { maxRetries: 3, retryDelayMs: 10 });
    expect(result).toMatchObject({ status: 'CONFIRMED' });
    expect(attempts).toBe(2);

    // Queue should be empty after successful submission
    expect(builder.getPendingQueue().length).toBe(0);

    builder.cleanup();
  });

  it('retains pending payload in queue and cleans up timers when submission fails max retries', async () => {
    const builder = new StreamBuilder()
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .amount(500);

    const brokenNetworkSubmit = async () => {
      throw new Error('Network unreachable');
    };

    await expect(builder.submit(brokenNetworkSubmit, { maxRetries: 2, retryDelayMs: 10 })).rejects.toThrow(
      'StreamBuilder network payload submission failed after 2 retries: Network unreachable'
    );

    // The payload is removed from pendingQueue on final failure too, not just
    // on success 鈥?leaving it there after the caller has already seen the
    // rejection is what issue #188 reported as a leak.
    expect(builder.getPendingQueue().length).toBe(0);

    builder.cleanup();
  });

  it('returns validation errors from ConduitBatcher for invalid batch items', () => {
    const batcher = new ConduitBatcher();
    const emptyResult = batcher.execute([], { context: TEST_CONTEXT });
    expect(emptyResult.success).toBe(true);
    expect(emptyResult.operations).toBe(0);

    const nullItemResult = batcher.execute([null as any], { context: TEST_CONTEXT });
    expect(nullItemResult.success).toBe(false);
    expect(nullItemResult.errors![0]).toContain('cannot be null or undefined');
  });
});
