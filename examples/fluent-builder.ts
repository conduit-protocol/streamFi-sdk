/**
 * Example: Construct and batch stream operations using the Fluent Builder API.
 *
 * Run with:
 *   npx ts-node examples/fluent-builder.ts
 */

import { StreamBuilder, ConduitBatcher } from '../src/index.js';

function main() {
  console.log('Building stream configurations...');

  // Build stream 1
  const stream1 = new StreamBuilder()
    .token('CD...USDC')
    .sender('GD...SENDER')
    .recipient('GB...RECIPIENT_A')
    .amount(500)
    .build();

  console.log('Stream 1 built:', stream1);

  // Build stream 2
  const stream2 = new StreamBuilder()
    .token('CD...USDC')
    .sender('GD...SENDER')
    .recipient('GB...RECIPIENT_B')
    .amount(1200)
    .build();

  console.log('Stream 2 built:', stream2);

  console.log('\nExecuting batch operation via ConduitBatcher...');
  const result = ConduitBatcher.execute([stream1, stream2]);

  console.log('✅ Batch Execution Result:');
  console.log('  Success:      ', result.success);
  console.log('  Operations:   ', result.operations);
  console.log('  Transaction XDR:', result.xdr);
}

main();
