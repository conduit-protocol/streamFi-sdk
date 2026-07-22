/**
 * Example: List streams for a given address with pagination.
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
  let offset = 0;
  const pageLimit = 20;
  let totalPages = 0;

  do {
    const page = await client.streams.list({ recipient: address, offset, limit: pageLimit });
    totalPages++;

    if (page.streams.length === 0 && totalPages === 1) {
      console.log(`No streams found for ${address}`);
      return;
    }

    console.log(`\nPage ${totalPages} (offset=${page.offset}, showing ${page.streams.length}/${page.totalCount} total):`);
    for (const s of page.streams) {
      const pct = (streamProgress(s) * 100).toFixed(1);
      console.log(`  [${s.id}] from ${s.sender.slice(0, 8)}… — ${pct}% complete — status: ${s.cancelled ? 'cancelled' : s.paused ? 'paused' : 'active'}`);
    }

    if (!page.hasNextPage) break;
    offset += pageLimit;
  } while (true);
}

main().catch(err => { console.error(err); process.exit(1); });
