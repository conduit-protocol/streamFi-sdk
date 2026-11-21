/**
 * Example: Create a 30-day USDC stream on testnet.
 *
 * Run with:
 *   STELLAR_SECRET=S... FACTORY_ADDRESS=C... npx ts-node examples/create-stream.ts
 *
 * Requires STELLAR_SECRET and FACTORY_ADDRESS env variables to be set.
 */

import { ConduitClient } from '../src/index.js';
import { Keypair }        from '@stellar/stellar-sdk';

const secret          = process.env['STELLAR_SECRET'];
const factoryAddress  = process.env['FACTORY_ADDRESS'];

if (!secret) {
  console.error('Set STELLAR_SECRET environment variable.');
  process.exit(1);
}
if (!factoryAddress) {
  console.error('Set FACTORY_ADDRESS environment variable (DripFactory contract ID for testnet).');
  process.exit(1);
}

const keypair = Keypair.fromSecret(secret);

const client = new ConduitClient({
  network: 'testnet',
  keypair,
  factoryAddress,
});

async function main() {
  console.log('Creating stream…');

  const result = await client.streams.create({
    recipient:       'GABC1234RECIPIENTADDRESSEXAMPLE000000000000000000000000',
    token:           'native',   // XLM
    depositAmount:   '1000',     // 1 000 XLM total
    durationSeconds: 30 * 24 * 3600,  // 30 days
    clawbackEnabled: false,
  });

  console.log('✅ Stream created!');
  console.log('  Stream ID:      ', result.streamId.toString());
  console.log('  Stream address: ', result.streamAddress);
  console.log('  Transaction:    ', result.txHash);

  // Check withdrawable
  const available = await client.streams.withdrawable(result.streamId);
  console.log('  Withdrawable now:', available.toString(), 'stroops');
}

main().catch(err => { console.error(err); process.exit(1); });
