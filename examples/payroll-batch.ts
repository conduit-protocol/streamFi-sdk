/**
 * Example: create a payroll-shaped batch of streams.
 *
 * This demonstrates the common case where one payer creates several streams
 * with the same token and duration, but each employee receives a different
 * amount. It also shows how to inspect batch output instead of assuming every
 * item succeeded.
 *
 * Run with:
 *   npx ts-node examples/payroll-batch.ts
 */

import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { ConduitBatcher, StreamBuilder } from '../src/index.js';

type PayrollRecipient = {
  name: string;
  recipient: string;
  amount: bigint;
};

async function main() {
  const payrollAdmin = Keypair.random().publicKey();
  const token = StrKey.encodeContract(Buffer.alloc(32, 1));
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 2));

  const payroll: PayrollRecipient[] = [
    { name: 'Ari', recipient: Keypair.random().publicKey(), amount: 1_500_000_000n },
    { name: 'Bea', recipient: Keypair.random().publicKey(), amount: 2_000_000_000n },
    { name: 'Cam', recipient: Keypair.random().publicKey(), amount: 1_250_000_000n },
  ];

  const startTime = Math.floor(Date.now() / 1000) + 60;
  const durationSeconds = 30 * 24 * 60 * 60;
  const endTime = startTime + durationSeconds;

  const operations = payroll.map((employee) => {
    const ratePerSecond = employee.amount / BigInt(durationSeconds);

    return new StreamBuilder()
      .sender(payrollAdmin)
      .recipient(employee.recipient)
      .token(token)
      .amount(employee.amount)
      .ratePerSecond(ratePerSecond)
      .startTime(BigInt(startTime))
      .endTime(BigInt(endTime))
      .toBatchOperation();
  });

  const batcher = new ConduitBatcher();
  const result = await batcher.executeAsync(operations, {
    context: {
      network: 'testnet',
      networkPassphrase: 'Test SDF Network ; September 2015',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      contractId,
      sourceAccount: payrollAdmin,
      sequence: '123456789',
    },
  });

  if (!result.success) {
    console.error('Payroll batch could not be prepared. Review each error before retrying:');
    for (const error of result.errors ?? []) {
      console.error(`- ${error}`);
    }
    return;
  }

  console.log(`Prepared ${result.operations} payroll stream transaction(s).`);
  for (const [index, tx] of (result.transactions ?? []).entries()) {
    const employee = payroll[tx.operationIndex ?? index];
    console.log([
      `- ${employee?.name ?? `recipient ${index + 1}`}`,
      `method=${tx.method}`,
      `prepared=${tx.prepared}`,
      `recipient=${employee?.recipient}`,
    ].join(' | '));
  }

  if ((result.transactions?.length ?? 0) !== payroll.length) {
    console.warn('Some payroll entries did not produce transactions; inspect the batch result before submitting.');
  }
}

main().catch(console.error);