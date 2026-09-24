'use server';

// Server Actions: this file's exported functions run only on the server, so
// getClient()'s signing keypair (loaded from a non-NEXT_PUBLIC_ env var)
// never gets bundled into client-side JavaScript. Do not import getClient()
// or the underlying signing keypair from any 'use client' component directly.

import { getClient } from './conduit';
import type { PaginatedStreams, CreateStreamParams, CreateStreamResult } from '@conduit-protocol/sdk';

export async function listStreams(address: string): Promise<PaginatedStreams> {
  const client = getClient();
  return client.streams.list({ recipient: address, limit: 50 });
}

export async function createStream(params: CreateStreamParams): Promise<CreateStreamResult> {
  const client = getClient();
  return client.streams.create(params);
}

export async function withdrawStream(streamId: bigint | string): Promise<string> {
  const client = getClient();
  return client.streams.withdraw(streamId);
}
