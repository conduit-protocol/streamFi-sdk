import { ConduitClient, KeypairSigner } from '@conduit-protocol/sdk';
import cron from 'node-cron';
import 'dotenv/config';

async function main() {
  const network = process.env.STREAM_NETWORK || 'testnet';
  const factoryAddress = process.env.FACTORY_ADDRESS;
  const secret = process.env.STELLAR_SECRET;
  const recipient = process.env.RECIPIENT_ADDRESS;

  if (!factoryAddress || !secret || !recipient) {
    console.error('Missing FACTORY_ADDRESS, STELLAR_SECRET, or RECIPIENT_ADDRESS in .env');
    process.exit(1);
  }

  const signer = KeypairSigner.fromSecret(secret);
  const client = new ConduitClient({
    network,
    factoryAddress,
    signer,
  });

  // Run every minute.
  cron.schedule('* * * * *', async () => {
    console.log('[cron] Checking withdrawable balances...');
    try {
      const streams = await client.streams.forRecipient(recipient);
      for (const stream of streams) {
        const withdrawable = await client.streams.withdrawable(stream.id);
        if (withdrawable > 0n) {
          const tx = await client.streams.withdraw(stream.id, withdrawable);
          console.log('[cron] Withdrew from stream', stream.id, tx.hash);
        }
      }
    } catch (err) {
      console.error('[cron] Error:', err.message);
    }
  });

  console.log('Cron worker started; checking every minute.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
