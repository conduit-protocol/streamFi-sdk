import { ConduitClient } from '@conduit-protocol/sdk';
import { Keypair } from '@stellar/stellar-sdk';

function getNetwork(): 'mainnet' | 'testnet' | 'local' {
  const n = process.env.NEXT_PUBLIC_NETWORK;
  if (n === 'mainnet' || n === 'testnet' || n === 'local') return n;
  return 'testnet';
}

function getKeypair(): Keypair | undefined {
  // Deliberately NOT NEXT_PUBLIC_-prefixed: that prefix tells Next.js to
  // inline the value into the client-side JS bundle, which would ship this
  // signing secret to every browser that loads the page. getClient() is only
  // ever called from Server Actions ('use server' in lib/streams.ts), so a
  // server-only env var is both correct and safe here.
  const secret = process.env.STELLAR_SECRET;
  if (!secret) return undefined;
  return Keypair.fromSecret(secret);
}

function getFactoryAddress(): string | undefined {
  // FACTORY_ADDRESS is the deployed DripFactory contract ID for the chosen
  // network. It must be set for any factory query (list, count, resolve) to
  // work.  Not NEXT_PUBLIC_-prefixed because it is only used in Server
  // Actions — no reason to ship it to every browser.
  return process.env.FACTORY_ADDRESS;
}

let _client: ConduitClient | null = null;

export function getClient(): ConduitClient {
  if (_client) return _client;
  _client = new ConduitClient({
    network: getNetwork(),
    keypair: getKeypair(),
    factoryAddress: getFactoryAddress(),
  });
  return _client;
}

export function resetClient(): void {
  _client = null;
}
