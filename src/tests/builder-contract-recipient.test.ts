import { describe, it, expect } from 'vitest';
import { StreamBuilder, ConduitBatcher } from '../builder.js';
import { Address } from '@stellar/stellar-sdk';

describe('StreamBuilder Contract Recipient Validation (#609)', () => {
  const contractRecipient = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';
  const accountSender = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
  const contractToken = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

  it('accepts a valid C... contract recipient address', () => {
    const builder = new StreamBuilder()
      .token(contractToken)
      .sender(accountSender)
      .recipient(contractRecipient)
      .amount(1000)
      .ratePerSecond(5n);

    const stream = builder.build();
    expect(stream.recipient).toBe(contractRecipient);
  });

  it('correctly encodes C... contract recipient as an ScAddressTypeContract in toContractArgs()', () => {
    const builder = new StreamBuilder()
      .token(contractToken)
      .sender(accountSender)
      .recipient(contractRecipient)
      .amount(500)
      .ratePerSecond(10n);

    const args = builder.toContractArgs();
    expect(args).toHaveLength(8);

    // Arg 1 is recipient ScVal
    const recipientScVal = args[1] as any;
    expect(recipientScVal.switch().name).toBe('scvAddress');
    expect(recipientScVal.value().switch().name).toBe('scAddressTypeContract');
    expect(new Address(contractRecipient).toScVal().toXDR('base64')).toEqual(
      recipientScVal.toXDR('base64'),
    );
  });

  it('rejects an invalid C... address with a malformed checksum or character', () => {
    const malformedContract = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBA9999';
    expect(() => {
      new StreamBuilder().recipient(malformedContract);
    }).toThrowError(/must be a valid Stellar public key or contract address/);
  });

  it('rejects empty or whitespace-only recipient string', () => {
    expect(() => {
      new StreamBuilder().recipient('');
    }).toThrowError(/must be a non-empty string/);

    expect(() => {
      new StreamBuilder().recipient('   ');
    }).toThrowError(/must be a non-empty string/);
  });

  it('validates C... contract recipients in ConduitBatcher payload', () => {
    const batcher = new ConduitBatcher();
    const result = batcher.execute([
      {
        token: contractToken,
        sender: accountSender,
        recipient: 'CINVALIDADDRESS',
        amount: '100',
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain('recipient must be a valid Stellar public key or contract address');
  });
});
