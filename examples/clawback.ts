/**
 * Example: Clawback unstreamed tokens (#740).
 *
 * Demonstrates the sender clawback lifecycle:
 *   1. Create a stream WITH clawback enabled
 *   2. Let some value accrue
 *   3. Clawback the unstreamed (un-vested) portion
 *   4. Show the reclaimed amount
 *
 * Also demonstrates the ClawbackNotEnabledError case:
 *   5. Create a stream WITHOUT clawback
 *   6. Attempt clawback — expect it to fail
 *
 * Run with:
 *   STELLAR_SECRET=S... FACTORY_ADDRESS=C... npx tsx examples/clawback.ts
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

  // --- Part 1: Successful clawback ---

  // 1. Create a stream WITH clawback enabled
  console.log('1/4  Creating a 1-hour, 100 XLM stream WITH clawback enabled…');
  const { streamId } = await client.streams.create({
    recipient,
    token: 'native',
    depositAmount: '100',
    durationSeconds: 60 * 60,
    clawbackEnabled: true,
  });
  console.log(`     stream ${streamId} created`);

  // 2. Let some value accrue
  console.log('2/4  Waiting ~10s for partial accrual…');
  await new Promise((r) => setTimeout(r, 10_000));
  const withdrawable = await client.streams.withdrawable(streamId);
  const unstreamed = BigInt('1000000000') - withdrawable; // 100 XLM in stroops - withdrawn
  console.log(`     withdrawable (streamed):  ${fromStroops(withdrawable)} XLM`);
  console.log(`     unstreamed (remainder):    ~${fromStroops(unstreamed)} XLM`);

  // 3. Clawback the unstreamed portion
  console.log('3/4  Clawing back unstreamed tokens…');
  const reclaimed = await client.streams.clawback(streamId);
  console.log(`     reclaimed: ${fromStroops(reclaimed)} XLM`);

  // 4. Verify
  const afterClawback = await client.streams.withdrawable(streamId);
  console.log(`     withdrawable after clawback: ${fromStroops(afterClawback)} XLM`);
  console.log('     ✓ clawback succeeded');

  // --- Part 2: ClawbackNotEnabledError ---

  console.log('\n--- Demonstrating ClawbackNotEnabledError ---\n');

  // 5. Create a stream WITHOUT clawback
  console.log('5/6  Creating a stream WITHOUT clawback…');
  const { streamId: noClawbackId } = await client.streams.create({
    recipient,
    token: 'native',
    depositAmount: '50',
    durationSeconds: 60 * 60,
    clawbackEnabled: false,
  });
  console.log(`     stream ${noClawbackId} created`);

  // 6. Attempt clawback — should fail
  console.log('6/6  Attempting clawback on non-clawback stream…');
  try {
    await client.streams.clawback(noClawbackId);
    console.log('     ⚠ expected ClawbackNotEnabledError but clawback succeeded');
  } catch (err: any) {
    console.log(`     ✓ expected error: ${err.message}`);
  }

  console.log('\nDone. View the transactions on https://stellar.expert/explorer/testnet');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
