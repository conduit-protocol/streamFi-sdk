/**
 * Quickstart (#633): create a stream and withdraw from it, end to end, on
 * Stellar **testnet**.
 *
 * 1. Generate a testnet keypair and fund it:
 *
 *      # sender (also used here as the recipient for a self-demo)
 *      node -e "console.log(require('@stellar/stellar-sdk').Keypair.random().secret())"
 *      curl "https://friendbot.stellar.org?addr=<G...address...>"
 *
 * 2. Get the testnet DripFactory contract id from the protocol docs / deploy.
 *
 * 3. Run:
 *
 *      STELLAR_SECRET=S... FACTORY_ADDRESS=C... npx tsx examples/quickstart.ts
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
  // For a self-contained demo the sender streams to itself. In a real app the
  // recipient is a different account.
  const recipient = keypair.publicKey();

  console.log('1/3  Creating a 1-hour, 100 XLM stream…');
  const { streamId, txHash: createTx } = await client.streams.create({
    recipient,
    token: 'native', // XLM
    depositAmount: '100',
    durationSeconds: 60 * 60,
  });
  console.log(`     stream ${streamId} created  (tx ${createTx})`);

  // Let a little value accrue before withdrawing.
  console.log('2/3  Waiting ~15s for value to accrue…');
  await new Promise((r) => setTimeout(r, 15_000));

  const available = await client.streams.withdrawable(streamId);
  console.log(`     withdrawable: ${fromStroops(available)} XLM`);

  if (available === 0n) {
    console.log('     nothing accrued yet — try again in a moment.');
    return;
  }

  console.log('3/3  Withdrawing the full available balance…');
  const withdrawTx = await client.streams.withdraw(streamId, available);
  console.log(`     withdrawn  (tx ${withdrawTx})`);
  console.log('\nDone. View the transactions on https://stellar.expert/explorer/testnet');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
