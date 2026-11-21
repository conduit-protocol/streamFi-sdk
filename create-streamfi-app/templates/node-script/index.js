import { ConduitClient, KeypairSigner } from '@conduit-protocol/sdk';
import 'dotenv/config';

async function main() {
  const network = process.env.STREAM_NETWORK || 'testnet';
  const factoryAddress = process.env.FACTORY_ADDRESS;
  const secret = process.env.STELLAR_SECRET;

  if (!factoryAddress || !secret) {
    console.error('Missing FACTORY_ADDRESS or STELLAR_SECRET in .env');
    process.exit(1);
  }

  const signer = KeypairSigner.fromSecret(secret);
  const client = new ConduitClient({
    network,
    factoryAddress,
    signer,
  });

  // Example: create a 1-minute test stream to yourself on testnet.
  const sender = signer.publicKey;
  const recipient = sender;
  const now = Math.floor(Date.now() / 1000);
  const stream = await client.streams.create({
    sender,
    recipient,
    token: process.env.TOKEN_ADDRESS || 'native',
    deposit: '10',
    ratePerSecond: '0.001',
    startTime: now,
    endTime: now + 60,
  });

  console.log('Created stream:', stream.id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
