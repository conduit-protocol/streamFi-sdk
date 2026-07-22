import { describe, it, expect } from 'vitest';
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
});
