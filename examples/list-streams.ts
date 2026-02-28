/**
 * Example: List all streams for a given address.
 *
 * Run with:
 *   ADDRESS=G... npx ts-node examples/list-streams.ts
 */

import { ConduitClient }   from '../src/index.js';
import { streamProgress }  from '../src/utils.js';

const address = process.env['ADDRESS'];

if (!address) {
  console.error('Set ADDRESS environment variable.');
  process.exit(1);
}

const client = new ConduitClient({ network: 'testnet' });

async function main() {
  const streams = await client.streams.list({ recipient: address });

  if (streams.length === 0) {
    console.log(`No streams found for ${address}`);
    return;
  }

  console.log(`Found ${streams.length} stream(s) for ${address}:\n`);
  for (const s of streams) {
    const pct = (streamProgress(s) * 100).toFixed(1);
    console.log(`  [${s.id}] from ${s.sender.slice(0, 8)}… — ${pct}% complete — status: ${s.cancelled ? 'cancelled' : s.paused ? 'paused' : 'active'}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
