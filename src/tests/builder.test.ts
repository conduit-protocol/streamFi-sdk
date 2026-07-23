import { describe, it, expect, vi } from 'vitest';
import { StreamBuilder, ConduitBatcher } from '../builder.js';

describe('StreamBuilder', () => {
  it('correctly builds a stream configuration when all fields are provided', () => {
    const builder = new StreamBuilder()
      .token('CD...')
      .sender('GA...')
      .recipient('GB...')
      .amount(1000);

    const stream = builder.build();

    expect(stream).toEqual({
      token: 'CD...',
      sender: 'GA...',
      recipient: 'GB...',
      amount: 1000,
    });
  });

  it('throws an error if any required field is missing', () => {
    expect(() => {
      new StreamBuilder()
        .sender('GA...')
        .recipient('GB...')
        .amount(1000)
        .build();
    }).toThrow('Missing required parameters for StreamBuilder');

    expect(() => {
      new StreamBuilder()
        .token('CD...')
        .recipient('GB...')
        .amount(1000)
        .build();
    }).toThrow('Missing required parameters for StreamBuilder');

    expect(() => {
      new StreamBuilder()
        .token('CD...')
        .sender('GA...')
        .amount(1000)
        .build();
    }).toThrow('Missing required parameters for StreamBuilder');

    expect(() => {
      new StreamBuilder()
        .token('CD...')
        .sender('GA...')
        .recipient('GB...')
        .build();
    }).toThrow('Missing required parameters for StreamBuilder');
  });



  it('rejects malformed builder inputs before producing a stream configuration', () => {
    const malformedBuilders = [
      () => new StreamBuilder().token('').sender('GA...').recipient('GB...').amount(1000).build(),
      () => new StreamBuilder().token('   ').sender('GA...').recipient('GB...').amount(1000).build(),
      () => new StreamBuilder().token('CD...').sender('').recipient('GB...').amount(1000).build(),
      () => new StreamBuilder().token('CD...').sender('GA...').recipient('   ').amount(1000).build(),
      () => new StreamBuilder().token('CD...').sender('GA...').recipient('GB...').amount(0).build(),
      () => new StreamBuilder().token('CD...').sender('GA...').recipient('GB...').amount(-1).build(),
      () => new StreamBuilder().token('CD...').sender('GA...').recipient('GB...').amount(Number.NaN).build(),
      () => new StreamBuilder().token('CD...').sender('GA...').recipient('GB...').amount(Number.POSITIVE_INFINITY).build(),
    ];

    for (const buildMalformed of malformedBuilders) {
      expect(buildMalformed).toThrow('Invalid StreamBuilder parameter');
    }
  });

  it('allows chaining calls in any order', () => {
    const stream = new StreamBuilder()
      .amount(500)
      .recipient('GB...')
      .token('CD...')
      .sender('GA...')
      .build();

    expect(stream).toEqual({
      token: 'CD...',
      sender: 'GA...',
      recipient: 'GB...',
      amount: 500,
    });
  });

  it('includes ratePerSecond as a number when set with a number', () => {
    const stream = new StreamBuilder()
      .token('CD...')
      .sender('GA...')
      .recipient('GB...')
      .amount(1000)
      .ratePerSecond(500)
      .build();

    expect(stream.ratePerSecond).toBe(500);
  });

  it('serialises bigint ratePerSecond to string', () => {
    const rate = BigInt('9007199254740993'); // > Number.MAX_SAFE_INTEGER
    const stream = new StreamBuilder()
      .token('CD...')
      .sender('GA...')
      .recipient('GB...')
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
      .token('CD...')
      .sender('GA...')
      .recipient('GB...')
      .amount(1000)
      .build();

    expect(stream).not.toHaveProperty('ratePerSecond');
  });

  it('rejects non-positive ratePerSecond values', () => {
    const builder = () =>
      new StreamBuilder()
        .token('CD...')
        .sender('GA...')
        .recipient('GB...')
        .amount(1000)
        .ratePerSecond(0);

    expect(builder).toThrow('Invalid StreamBuilder parameter: ratePerSecond');

    const builderNeg = () =>
      new StreamBuilder()
        .token('CD...')
        .sender('GA...')
        .recipient('GB...')
        .amount(1000)
        .ratePerSecond(-1n);

    expect(builderNeg).toThrow('Invalid StreamBuilder parameter: ratePerSecond');
  });
});

describe('ConduitBatcher', () => {
  it('executes a batch of streams successfully', () => {
    const stream1 = new StreamBuilder()
      .token('CD1')
      .sender('GA1')
      .recipient('GB1')
      .amount(100)
      .build();

    const stream2 = new StreamBuilder()
      .token('CD2')
      .sender('GA2')
      .recipient('GB2')
      .amount(200)
      .build();

    const result = ConduitBatcher.execute([stream1, stream2]);

    expect(result.success).toBe(true);
    expect(result.operations).toBe(2);
    expect(result.xdr).toBe('AAAA...mock...batch...XDR');
  });

  it('serialises bigint fields to strings before processing', () => {
    const payload = {
      token: 'CD...',
      sender: 'GA...',
      recipient: 'GB...',
      rate: BigInt('9007199254740993'),
      deposit: 50000n,
    };

    const spy = console.log as ReturnType<typeof vi.fn>;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = ConduitBatcher.execute([payload]);

    consoleSpy.mockRestore();

    expect(result.success).toBe(true);
    expect(result.operations).toBe(1);
  });

  it('handles mixed bigint and non-bigint payloads', () => {
    const streams = [
      { id: 1n, rate: 2n, name: 'stream-a' },
      { id: 3, rate: 4, name: 'stream-b' },
      { nested: { deep: { val: 99n } } },
    ];

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = ConduitBatcher.execute(streams);
    consoleSpy.mockRestore();

    expect(result.success).toBe(true);
    expect(result.operations).toBe(3);
  });

  it('returns zero operations for an empty array', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = ConduitBatcher.execute([]);
    consoleSpy.mockRestore();

    expect(result.success).toBe(true);
    expect(result.operations).toBe(0);
  });
});
