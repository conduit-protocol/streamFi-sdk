import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { ConduitClient } from '../client.js';
import { clearServerCache } from '../soroban.js';
import { unregisterCustomFetch } from '../custom-fetch.js';

/**
 * #980 — retry idempotent Soroban RPC reads on 502/503/504 gateway errors.
 * Soroban RPC is JSON-RPC over POST, so idempotency is decided from the
 * JSON-RPC `method`. `sendTransaction` must never be replayed.
 */

const FACTORY = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

let urlSeq = 0;
/** A unique RPC URL per test so circuit-breaker state never leaks between cases. */
function nextUrl(): string {
  urlSeq += 1;
  return `https://rpc.gateway-retry.test/${urlSeq}`;
}

function jsonResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function status(code: number): Response {
  return new Response('upstream unavailable', { status: code });
}

const LEDGER = { sequence: 9, id: 'x', protocolVersion: 21 };

describe('custom fetch gateway retry (#980)', () => {
  let url: string;

  beforeEach(() => {
    vi.useFakeTimers();
    url = nextUrl();
  });

  afterEach(() => {
    vi.useRealTimers();
    unregisterCustomFetch(url);
    clearServerCache();
  });

  function clientWith(customFetch: typeof fetch): ConduitClient {
    return new ConduitClient({ network: 'testnet', rpcUrl: url, factoryAddress: FACTORY, customFetch });
  }

  it('retries getLatestLedger on 503 and returns the first successful response', async () => {
    const customFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(jsonResponse(LEDGER));
    const client = clientWith(customFetch);

    const pending = client.rpcServer.getLatestLedger();
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ sequence: 9 });
    expect(customFetch).toHaveBeenCalledTimes(3);
  });

  it('retries on 502 and 504 as well as 503', async () => {
    const customFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(status(502))
      .mockResolvedValueOnce(status(504))
      .mockResolvedValueOnce(jsonResponse(LEDGER));
    const client = clientWith(customFetch);

    const pending = client.rpcServer.getLatestLedger();
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ sequence: 9 });
    expect(customFetch).toHaveBeenCalledTimes(3);
  });

  it('gives up after 3 retries (4 attempts in total) and rejects', async () => {
    const customFetch = vi.fn<typeof fetch>(async () => status(503));
    const client = clientWith(customFetch);

    const pending = client.rpcServer.getLatestLedger().catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await pending).toBeDefined();
    expect(customFetch).toHaveBeenCalledTimes(4);
  });

  it('does not retry sendTransaction, so a submission is never replayed', async () => {
    const customFetch = vi.fn<typeof fetch>(async () => status(503));
    const client = clientWith(customFetch);
    const source = new Account(Keypair.random().publicKey(), '1');
    const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: Networks.TESTNET })
      .setTimeout(30)
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .build();

    await expect(client.rpcServer.sendTransaction(tx)).rejects.toBeDefined();

    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-gateway 5xx responses such as 500', async () => {
    const customFetch = vi.fn<typeof fetch>(async () => status(500));
    const client = clientWith(customFetch);

    await expect(client.rpcServer.getLatestLedger()).rejects.toBeDefined();

    expect(customFetch).toHaveBeenCalledTimes(1);
  });
});
