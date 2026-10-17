import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair, SorobanRpc } from '@stellar/stellar-sdk';
import { ConduitClient } from '../client.js';
import { clearServerCache } from '../soroban.js';
import { unregisterCustomFetch } from '../custom-fetch.js';
import { RateLimitError } from '../errors.js';

const URL_A = 'https://rpc.custom-fetch.test';
const FACTORY = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

function jsonResponse(result: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('ConduitConfig.customFetch (#862)', () => {
  afterEach(() => {
    unregisterCustomFetch(URL_A);
    clearServerCache();
  });

  it('routes Soroban RPC requests through the supplied fetch', async () => {
    const customFetch = vi.fn(async () => jsonResponse({ sequence: 42, id: 'x', protocolVersion: 21 }));
    const client = new ConduitClient({ network: 'testnet', rpcUrl: URL_A, factoryAddress: FACTORY, customFetch });

    const ledger = await client.rpcServer.getLatestLedger();

    expect(ledger.sequence).toBe(42);
    expect(customFetch).toHaveBeenCalledTimes(1);
    const [url, init] = customFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${URL_A}/`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ jsonrpc: '2.0', method: 'getLatestLedger' });
  });

  it('forwards headers the custom fetch is expected to see', async () => {
    const customFetch = vi.fn(async () => jsonResponse({ sequence: 1 }));
    const client = new ConduitClient({ network: 'testnet', rpcUrl: URL_A, factoryAddress: FACTORY, customFetch });
    await client.rpcServer.getLatestLedger();
    const init = (customFetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['Content-Type']).toMatch(/json/);
  });

  it('keeps non-2xx status visible so 429s still map to RateLimitError', async () => {
    const customFetch = vi.fn(async () =>
      new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
    );
    const client = new ConduitClient({ network: 'testnet', rpcUrl: URL_A, factoryAddress: FACTORY, customFetch });

    const err = await client.rpcServer.getLatestLedger().catch((e: unknown) => e);

    expect(RateLimitError.fromRpcError(err)).toBeInstanceOf(RateLimitError);
  });

  it('does not touch RPC URLs without a registered fetch', async () => {
    const customFetch = vi.fn(async () => jsonResponse({ sequence: 1 }));
    new ConduitClient({ network: 'testnet', rpcUrl: URL_A, factoryAddress: FACTORY, customFetch });
    const other = new SorobanRpc.Server('http://127.0.0.1:1', { allowHttp: true });

    await expect(other.getLatestLedger()).rejects.toBeDefined();
    expect(customFetch).not.toHaveBeenCalled();
  });

  it('rejects a non-function customFetch', () => {
    expect(
      () => new ConduitClient({ network: 'testnet', rpcUrl: URL_A, factoryAddress: FACTORY, customFetch: 'nope' as never }),
    ).toThrow(/customFetch must be a function/);
  });

  it('is optional: clients without it behave as before', () => {
    expect(() => new ConduitClient({ network: 'testnet', factoryAddress: FACTORY, keypair: Keypair.random() })).not.toThrow();
  });
});
