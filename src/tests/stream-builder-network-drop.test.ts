import { describe, it, expect } from 'vitest';
import { StreamBuilder, ConduitBatcher } from '../builder.js';

describe('StreamBuilder Network Interruption & Payload Queueing Regression Tests', () => {
  it('throws boundary check error when build is called with missing or null parameters', () => {
    const builder = new StreamBuilder();
    expect(() => builder.build()).toThrow('Missing required parameters for StreamBuilder');

    const nullTokenBuilder = new StreamBuilder();
    expect(() => nullTokenBuilder.token(null as any)).toThrow(
      'Invalid StreamBuilder parameter: token must be a non-empty string'
    );
  });

  it('queues payload during transient network failures and resolves cleanly when network recovers', async () => {
    const builder = new StreamBuilder()
      .token('CDLZFC3SYJYDVR72W5SCK8FJL5F5J8F5J8F5J8F5J8F5J8F5J8F5J8')
      .sender('GAAZI5T63WGLXNJB6KYZIC2OT74E767E2DMB3E2MB3E2MB3E2MB3E2')
      .recipient('GBRPYHIL2CI3FNQ4BXLFMNDJBAVLVDW6NZH372NZH372NZH372NZH372')
      .amount(1000);

    let attempts = 0;
    const flakeyNetworkSubmit = async (payload: any) => {
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
      .token('CDLZFC3SYJYDVR72W5SCK8FJL5F5J8F5J8F5J8F5J8F5J8F5J8F5J8')
      .sender('GAAZI5T63WGLXNJB6KYZIC2OT74E767E2DMB3E2MB3E2MB3E2MB3E2')
      .recipient('GBRPYHIL2CI3FNQ4BXLFMNDJBAVLVDW6NZH372NZH372NZH372NZH372')
      .amount(500);

    const brokenNetworkSubmit = async () => {
      throw new Error('Network unreachable');
    };

    await expect(builder.submit(brokenNetworkSubmit, { maxRetries: 2, retryDelayMs: 10 })).rejects.toThrow(
      'StreamBuilder network payload submission failed after 2 retries without payload drop: Network unreachable'
    );

    // Payload is preserved in pendingQueue so caller can retry or inspect
    expect(builder.getPendingQueue().length).toBe(1);
    expect(builder.getPendingQueue()[0]).toMatchObject({
      amount: 500,
    });

    builder.cleanup();
  });

  it('throws boundary check error in ConduitBatcher when stream item is null or empty array', () => {
    expect(() => ConduitBatcher.execute([])).toThrow(
      'Streams payload array cannot be null, undefined, or empty'
    );
    expect(() => ConduitBatcher.execute([null as any])).toThrow(
      'Stream item inside batch cannot be null or undefined'
    );
  });
});
