/**
 * Example: Construct and batch stream operations using the Fluent Builder API.
 *
 * Run with:
 *   npx ts-node examples/fluent-builder.ts
 */

import { StreamBuilder, ConduitBatcher } from '../src/index.js';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

async function main() {
  console.log('Building stream configurations...');

  // Generate valid dummy addresses for the example
  const SENDER = Keypair.random().publicKey();
  const RECIPIENT_A = Keypair.random().publicKey();
  const RECIPIENT_B = Keypair.random().publicKey();
  const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 1)); // Dummy contract ID
  const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 2));

  // Build stream 1. ratePerSecond is required here (not just amount) because
  // the real create_stream contract call has no way to derive a rate on its
  // own — see StreamBuilder.toContractArgs().
  const stream1 = new StreamBuilder()
    .token(TOKEN)
    .sender(SENDER)
    .recipient(RECIPIENT_A)
    .amount(500)
    .ratePerSecond(10n);

  console.log('Stream 1 config:', stream1.build());

  // Build stream 2
  const stream2 = new StreamBuilder()
    .token(TOKEN)
    .sender(SENDER)
    .recipient(RECIPIENT_B)
    .amount(1200)
    .ratePerSecond(25n);

  console.log('Stream 2 config:', stream2.build());

  console.log('\nExecuting batch operation via ConduitBatcher...');
  const batcher = new ConduitBatcher();
  // toBatchOperation() turns each builder into a BatchOperation carrying the
  // exact positional, ABI-typed args create_stream expects (sender,
  // recipient, token, deposit_amount: i128, rate_per_sec: i128, start_time:
  // u64, end_time: u64, clawback_enabled: bool) — passing build() output
  // straight into execute() would instead encode a camelCase map with the
  // wrong amount type and no start/end/clawback fields at all (see #435).
  const result = await batcher.executeAsync(
    [stream1.toBatchOperation(), stream2.toBatchOperation()],
    {
      context: {
        network: 'testnet',
        networkPassphrase: 'Test SDF Network ; September 2015',
        rpcUrl: 'https://soroban-testnet.stellar.org',
        contractId: CONTRACT_ID,
        sourceAccount: SENDER,
        sequence: '123456789',
      },
    },
  );

  if (result.success) {
    console.log('✅ Batch Execution Result:');
    console.log('  Success:      ', result.success);
    console.log('  Operations:   ', result.operations);
    console.log('  Transaction XDR:', result.xdr);
  } else {
    console.log('❌ Batch Execution Failed:');
    console.log('  Errors:       ', result.errors);
  }
}

main().catch(console.error);
