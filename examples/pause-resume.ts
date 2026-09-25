/**
 * Example: Pause and resume a stream (#739).
 *
 * Demonstrates the full pause/resume lifecycle:
 *   1. Create a stream
 *   2. Let some value accrue
 *   3. Pause the stream (stops accrual)
 *   4. Verify accrual has stopped
 *   5. Resume the stream (accrual continues from where it left off)
 *   6. Verify accrual resumes
 *
 * Run with:
 *   STELLAR_SECRET=S... FACTORY_ADDRESS=C... npx tsx examples/pause-resume.ts
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
  const recipient = keypair.publicKey();

  // 1. Create a stream
  console.log('1/6  Creating a 1-hour, 100 XLM stream…');
  const { streamId, txHash: createTx } = await client.streams.create({
    recipient,
    token: 'native',
    depositAmount: '100',
    durationSeconds: 60 * 60,
  });
  console.log(`     stream ${streamId} created  (tx ${createTx})`);

  // 2. Let value accrue
  console.log('2/6  Waiting ~10s for value to accrue…');
  await new Promise((r) => setTimeout(r, 10_000));
  const beforePause = await client.streams.withdrawable(streamId);
  console.log(`     withdrawable before pause: ${fromStroops(beforePause)} XLM`);

  // 3. Pause the stream
  console.log('3/6  Pausing the stream…');
  const pauseTx = await client.streams.pause(streamId);
  console.log(`     stream paused  (tx ${pauseTx})`);

  // 4. Verify accrual has stopped
  console.log('4/6  Waiting ~5s to verify accrual stopped…');
  await new Promise((r) => setTimeout(r, 5_000));
  const duringPause = await client.streams.withdrawable(streamId);
  console.log(`     withdrawable during pause: ${fromStroops(duringPause)} XLM`);
  if (duringPause <= beforePause) {
    console.log('     ✓ accrual confirmed stopped');
  } else {
    console.log('     ⚠ balance increased despite pause — check stream state');
  }

  // 5. Resume the stream
  console.log('5/6  Resuming the stream…');
  const resumeTx = await client.streams.resume(streamId);
  console.log(`     stream resumed  (tx ${resumeTx})`);

  // 6. Verify accrual resumes
  console.log('6/6  Waiting ~10s for value to accrue again…');
  await new Promise((r) => setTimeout(r, 10_000));
  const afterResume = await client.streams.withdrawable(streamId);
  console.log(`     withdrawable after resume: ${fromStroops(afterResume)} XLM`);
  if (afterResume > duringPause) {
    console.log('     ✓ accrual confirmed resumed');
  } else {
    console.log('     ⚠ balance did not increase after resume');
  }

  console.log('\nDone. View the transactions on https://stellar.expert/explorer/testnet');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
