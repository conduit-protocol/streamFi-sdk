/**
 * Example: Transfer stream recipient (#741).
 *
 * Demonstrates reassigning who can withdraw from an existing stream:
 *   1. Create a stream from sender to recipient A
 *   2. Let some value accrue
 *   3. Check recipient A's withdrawable balance
 *   4. Transfer the recipient to address B
 *   5. Verify the balance travels with the stream (now withdrawable by B)
 *
 * Run with:
 *   STELLAR_SECRET=S... FACTORY_ADDRESS=C... npx tsx examples/transfer-recipient.ts
 *
 * NOTE: This demo streams to the sender itself (self-stream). In a real
 * app, recipient A and B are different accounts. The transfer is executed
 * by the current recipient (A), so to demo it end-to-end you'd need two
 * keypairs. This example uses the sender-as-recipient for simplicity.
 */

import { ConduitClient, fromStroops } from '../src/index.js';
import { Keypair } from '@stellar/stellar-sdk';

const secret = process.env['STELLAR_SECRET'];
const factoryAddress = process.env['FACTORY_ADDRESS'];

if (!secret || !factoryAddress) {
  console.error('Set STELLAR_SECRET and FACTORY_ADDRESS environment variables.');
  process.exit(1);
}

const keypair = Keypair.fromSecret(secret);

const client = new ConduitClient({
  network: 'testnet',
  keypair,
  factoryAddress,
});

async function main() {
  const recipientA = keypair.publicKey();
  // In a real app this would be a different account. For this demo we use a
  // well-known testnet address as "recipient B".
  const recipientB = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';

  // 1. Create a stream to recipient A
  console.log('1/5  Creating a 1-hour, 100 XLM stream to recipient A…');
  const { streamId } = await client.streams.create({
    recipient: recipientA,
    token: 'native',
    depositAmount: '100',
    durationSeconds: 60 * 60,
  });
  console.log(`     stream ${streamId} created`);

  // 2. Let value accrue
  console.log('2/5  Waiting ~10s for value to accrue…');
  await new Promise((r) => setTimeout(r, 10_000));

  // 3. Check balance before transfer
  const beforeTransfer = await client.streams.withdrawable(streamId);
  console.log('3/5  Withdrawable balance BEFORE transfer:');
  console.log(`     ${fromStroops(beforeTransfer)} XLM (withdrawable by recipient A)`);

  // 4. Transfer recipient to B
  console.log(`4/5  Transferring recipient to ${recipientB.slice(0, 8)}…`);
  const transferTx = await client.streams.transferRecipient(streamId, recipientB);
  console.log(`     recipient transferred  (tx ${transferTx})`);

  // 5. Verify the balance travels with the stream
  const afterTransfer = await client.streams.withdrawable(streamId);
  console.log('5/5  Withdrawable balance AFTER transfer:');
  console.log(`     ${fromStroops(afterTransfer)} XLM (now withdrawable by recipient B)`);
  if (afterTransfer >= beforeTransfer) {
    console.log('     ✓ balance preserved — it travels with the stream, not the original recipient');
  } else {
    console.log('     ⚠ balance decreased — check stream state');
  }

  console.log('\nDone. View the transactions on https://stellar.expert/explorer/testnet');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
