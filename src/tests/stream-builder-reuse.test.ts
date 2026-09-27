import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { StreamBuilder } from '../builder.js';
import type { CreateStreamParams } from '../types/index.js';

describe('StreamBuilder Reuse (#806)', () => {
  const TOKEN = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
  const SENDER_A = Keypair.random().publicKey();
  const SENDER_B = Keypair.random().publicKey();
  const RECIPIENT_A = Keypair.random().publicKey();
  const RECIPIENT_B = Keypair.random().publicKey();

  describe('reset()', () => {
    it('clears all configured fields allowing builder reuse', () => {
      const builder = new StreamBuilder()
        .token(TOKEN)
        .sender(SENDER_A)
        .recipient(RECIPIENT_A)
        .amount(1000);

      const first = builder.build();
      expect(first.amount).toBe('1000');
      expect(first.recipient).toBe(RECIPIENT_A);

      // Calling reset() clears fields
      builder.reset();
      expect(() => builder.build()).toThrow('4 validation issue(s)');

      // Re-populating allows building a completely new configuration
      builder
        .token(TOKEN)
        .sender(SENDER_B)
        .recipient(RECIPIENT_B)
        .amount(5000);

      const second = builder.build();
      expect(second.sender).toBe(SENDER_B);
      expect(second.recipient).toBe(RECIPIENT_B);
      expect(second.amount).toBe('5000');
    });

    it('clears destroyed state so a destroyed builder can be reset and reused', () => {
      const builder = new StreamBuilder()
        .token(TOKEN)
        .sender(SENDER_A)
        .recipient(RECIPIENT_A)
        .amount(1000);

      builder.destroy();
      expect(() => builder.build()).toThrow('StreamBuilder has been destroyed');

      builder.reset();
      builder
        .token(TOKEN)
        .sender(SENDER_A)
        .recipient(RECIPIENT_A)
        .amount(2000);

      const stream = builder.build();
      expect(stream.amount).toBe('2000');
    });
  });

  describe('clone()', () => {
    it('creates an independent copy of the builder state', () => {
      const original = new StreamBuilder()
        .token(TOKEN)
        .sender(SENDER_A)
        .recipient(RECIPIENT_A)
        .amount(1000)
        .ratePerSecond(10)
        .clawbackEnabled(true);

      const cloned = original.clone();

      // Mutating clone does not mutate original
      cloned.recipient(RECIPIENT_B).amount(2500);

      const origStream = original.build();
      const clonedStream = cloned.build();

      expect(origStream.recipient).toBe(RECIPIENT_A);
      expect(origStream.amount).toBe('1000');
      expect(origStream.clawbackEnabled).toBe(true);

      expect(clonedStream.recipient).toBe(RECIPIENT_B);
      expect(clonedStream.amount).toBe('2500');
      expect(clonedStream.clawbackEnabled).toBe(true);
    });
  });

  describe('fromConfig()', () => {
    it('pre-populates builder from CreateStreamParams with durationSeconds', () => {
      const futureStart = Math.floor(Date.now() / 1000) + 3600;
      const config: CreateStreamParams & { sender: string } = {
        token: TOKEN,
        sender: SENDER_A,
        recipient: RECIPIENT_A,
        depositAmount: '10000000',
        durationSeconds: 7200,
        startTime: futureStart,
        clawbackEnabled: true,
      };

      const builder = StreamBuilder.fromConfig(config);
      const stream = builder.build();

      expect(stream.token).toBe(TOKEN);
      expect(stream.sender).toBe(SENDER_A);
      expect(stream.recipient).toBe(RECIPIENT_A);
      expect(stream.amount).toBe('10000000');
      expect(stream.startTime).toBe(futureStart);
      expect(stream.endTime).toBe(futureStart + 7200);
      expect(stream.clawbackEnabled).toBe(true);
    });

    it('supports overriding fields on the pre-populated builder', () => {
      const config: CreateStreamParams & { sender: string } = {
        token: TOKEN,
        sender: SENDER_A,
        recipient: RECIPIENT_A,
        depositAmount: '500',
      };

      const builder = StreamBuilder.fromConfig(config)
        .recipient(RECIPIENT_B)
        .amount(999);

      const stream = builder.build();
      expect(stream.recipient).toBe(RECIPIENT_B);
      expect(stream.amount).toBe('999');
      expect(stream.sender).toBe(SENDER_A);
    });
  });
});
