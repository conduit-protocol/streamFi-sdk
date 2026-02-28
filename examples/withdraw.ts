/**
 * Example: Recipient withdraws their full available balance from a stream.
 *
 * Run with:
 *   STELLAR_SECRET=S... STREAM_ID=42 npx ts-node examples/withdraw.ts
 */

import { ConduitClient } from '../src/index.js';
import { Keypair }        from '@stellar/stellar-sdk';
import { fromStroops }    from '../src/utils.js';

const secret   = process.env['STELLAR_SECRET']!;
const streamId = process.env['STREAM_ID']!;

if (!secret || !streamId) {
  console.error('Set STELLAR_SECRET and STREAM_ID environment variables.');
  process.exit(1);
}

const client = new ConduitClient({
  network: 'testnet',
  keypair: Keypair.fromSecret(secret),
});

async function main() {
  console.log(`Checking stream ${streamId}…`);

  const available = await client.streams.withdrawable(BigInt(streamId));
  console.log(`Withdrawable: ${fromStroops(available)} XLM`);

  if (available === 0n) {
    console.log('Nothing to withdraw yet.');
    return;
  }

  console.log('Withdrawing…');
  const txHash = await client.streams.withdraw(BigInt(streamId));
  console.log(`✅ Withdrawn! Transaction: ${txHash}`);
}

main().catch(err => { console.error(err); process.exit(1); });
