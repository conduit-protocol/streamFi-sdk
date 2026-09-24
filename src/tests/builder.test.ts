import { describe, it, expect } from 'vitest';
import { StreamBuilder } from '../builder.js';

describe('StreamBuilder', () => {
  it('correctly builds a stream configuration when all fields are provided', () => {
    const builder = new StreamBuilder()
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .amount(1000);

    const stream = builder.build();

    expect(stream).toEqual({
      token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
      sender: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
      recipient: 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA',
      amount: '1000',
    });
  });

  it('throws an error if any required field is missing', () => {
    expect(() => {
      new StreamBuilder()
        .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
        .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
        .amount(1000)
        .build();
    }).toThrow('token is required');

    expect(() => {
      new StreamBuilder()
        .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
        .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
        .amount(1000)
        .build();
    }).toThrow('sender is required');

    expect(() => {
      new StreamBuilder()
        .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
        .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
        .amount(1000)
        .build();
    }).toThrow('recipient is required');

    expect(() => {
      new StreamBuilder()
        .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
        .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
        .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
        .build();
    }).toThrow('amount is required');
  });

  it('aggregates multiple missing required fields', () => {
    expect(() => {
      new StreamBuilder().build();
    }).toThrow('4 validation issue(s)');
  });

  it('exposes all issues on ValidationError without throwing from validate()', () => {
    const builder = new StreamBuilder();
    expect(builder.validate()).toEqual([
      'token is required',
      'sender is required',
      'recipient is required',
      'amount is required',
    ]);

    try {
      builder.build();
    } catch (err: any) {
      expect(err.name).toBe('ValidationError');
      expect(err.issues).toEqual([
        'token is required',
        'sender is required',
        'recipient is required',
        'amount is required',
      ]);
    }
  });



  it('rejects malformed builder inputs before producing a stream configuration', () => {
    const malformedBuilders = [
      () => new StreamBuilder().token('').sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H').recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA').amount(1000).build(),
      () => new StreamBuilder().token('   ').sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H').recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA').amount(1000).build(),
      () => new StreamBuilder().token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526').sender('').recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA').amount(1000).build(),
      () => new StreamBuilder().token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526').sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H').recipient('   ').amount(1000).build(),
      () => new StreamBuilder().token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526').sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H').recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA').amount(0).build(),
      () => new StreamBuilder().token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526').sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H').recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA').amount(-1).build(),
      () => new StreamBuilder().token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526').sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H').recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA').amount(Number.NaN).build(),
      () => new StreamBuilder().token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526').sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H').recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA').amount(Number.POSITIVE_INFINITY).build(),
    ];

    for (const buildMalformed of malformedBuilders) {
      expect(buildMalformed).toThrow('Invalid StreamBuilder parameter');
    }
  });

  it('allows chaining calls in any order', () => {
    const stream = new StreamBuilder()
      .amount(500)
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .build();

    expect(stream).toEqual({
      token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
      sender: 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H',
      recipient: 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA',
      amount: '500',
    });
  });

  it('serialises a numeric ratePerSecond to a string to match the declared type', () => {
    const stream = new StreamBuilder()
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .amount(1000)
      .ratePerSecond(500)
      .build();

    // build()'s return type promises `ratePerSecond?: string` — the runtime
    // value must match the declared type (see #459).
    expect(stream.ratePerSecond).toBe('500');
    expect(typeof stream.ratePerSecond).toBe('string');
    const json = JSON.parse(JSON.stringify(stream));
    expect(json.ratePerSecond).toBe('500');
  });

  it('serialises bigint ratePerSecond to string', () => {
    const rate = BigInt('9007199254740993'); // > Number.MAX_SAFE_INTEGER
    const stream = new StreamBuilder()
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .amount(1000)
      .ratePerSecond(rate)
      .build();

    expect(stream.ratePerSecond).toBe('9007199254740993');
    // Must survive JSON.stringify (the Safari/WebKit fix)
    const json = JSON.parse(JSON.stringify(stream));
    expect(json.ratePerSecond).toBe('9007199254740993');
  });

  it('omits ratePerSecond from output when not set', () => {
    const stream = new StreamBuilder()
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .amount(1000)
      .build();

    expect(stream).not.toHaveProperty('ratePerSecond');
  });

  it('rejects non-positive ratePerSecond values', () => {
    const builder = () =>
      new StreamBuilder()
        .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
        .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
        .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
        .amount(1000)
        .ratePerSecond(0);

    expect(builder).toThrow('Invalid StreamBuilder parameter: ratePerSecond');

    const builderNeg = () =>
      new StreamBuilder()
        .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
        .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
        .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
        .amount(1000)
        .ratePerSecond(-1n);

    expect(builderNeg).toThrow('Invalid StreamBuilder parameter: ratePerSecond');
  });

  it('limits concurrent submissions via semaphore', async () => {
    let running = 0;
    let maxRunning = 0;
    const submitFn = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 10));
      running--;
      return 'ok';
    };

    const builder = new StreamBuilder({ concurrency: 3 })
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .amount(1000);

    // Launch 10 concurrent submissions
    const promises = Array.from({ length: 10 }, () => builder.submit(submitFn));
    await Promise.all(promises);

    // Max concurrent should not exceed the semaphore limit
    expect(maxRunning).toBeLessThanOrEqual(3);
  });

  it('rejects submissions when queue is full', async () => {
    const submitFn = async () => {
      await new Promise(r => setTimeout(r, 100));
      return 'ok';
    };

    const builder = new StreamBuilder({ concurrency: 1, maxQueueSize: 2 })
      .token('CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526')
      .sender('GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H')
      .recipient('GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA')
      .amount(1000);

    // First submission will acquire the semaphore
    const p1 = builder.submit(submitFn);
    // Second will be queued
    const p2 = builder.submit(submitFn);
    // Third should be rejected (queue full)
    await expect(builder.submit(submitFn)).rejects.toThrow('queue is full');

    // Clean up
    await p1;
    await p2;
  });

  it('accepts Soroban contract addresses (C...) for sender and recipient (#512)', () => {
    const contractSender = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
    const contractRecipient = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
    const token = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

    const builder = new StreamBuilder()
      .token(token)
      .sender(contractSender)
      .recipient(contractRecipient)
      .amount(1000)
      .ratePerSecond(10n);

    const stream = builder.build();
    expect(stream.sender).toBe(contractSender);
    expect(stream.recipient).toBe(contractRecipient);

    const args = builder.toContractArgs();
    expect(args).toHaveLength(8);
  });
});
