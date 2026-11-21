/**
 * Tests for the Horizon fallback used by buildContractCallTx's getAccount
 * step when the Soroban RPC endpoint is unreachable (#953).
 */
import { describe, it, expect, vi } from 'vitest';
import { Account, Keypair } from '@stellar/stellar-sdk';
import { getAccountWithFallback } from '../soroban.js';
import {
  StreamFiNetworkError,
  RpcServiceUnavailableError,
  CircuitOpenError,
} from '../errors.js';

const ACCOUNT_ID = Keypair.random().publicKey();

function fakeServer(getAccount: () => Promise<Account>) {
  return { getAccount } as unknown as import('@stellar/stellar-sdk').SorobanRpc.Server;
}

describe('getAccountWithFallback', () => {
  it('returns the RPC account directly when the RPC endpoint is healthy', async () => {
    const rpcAccount = new Account(ACCOUNT_ID, '100');
    const server = fakeServer(() => Promise.resolve(rpcAccount));
    const customFetch = vi.fn();

    const account = await getAccountWithFallback(
      server,
      ACCOUNT_ID,
      'https://horizon-testnet.stellar.org',
      customFetch as unknown as typeof fetch,
    );

    expect(account).toBe(rpcAccount);
    expect(customFetch).not.toHaveBeenCalled();
  });

  it('falls back to Horizon when the RPC call throws a StreamFiNetworkError', async () => {
    const server = fakeServer(() =>
      Promise.reject(new StreamFiNetworkError('Network error during getAccount: fetch failed')),
    );
    const customFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sequence: '12345' }),
    });

    const account = await getAccountWithFallback(
      server,
      ACCOUNT_ID,
      'https://horizon-testnet.stellar.org',
      customFetch as unknown as typeof fetch,
    );

    expect(account.accountId()).toBe(ACCOUNT_ID);
    expect(account.sequenceNumber()).toBe('12345');
    expect(customFetch).toHaveBeenCalledWith(
      'https://horizon-testnet.stellar.org/accounts/' + ACCOUNT_ID,
    );
  });

  it('falls back to Horizon on RpcServiceUnavailableError (HTTP 503)', async () => {
    const server = fakeServer(() =>
      Promise.reject(new RpcServiceUnavailableError('RPC node service unavailable (503).')),
    );
    const customFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sequence: '99' }),
    });

    const account = await getAccountWithFallback(
      server,
      ACCOUNT_ID,
      'https://horizon-testnet.stellar.org',
      customFetch as unknown as typeof fetch,
    );

    expect(account.sequenceNumber()).toBe('99');
  });

  it('falls back to Horizon when the circuit is already open', async () => {
    const server = fakeServer(() =>
      Promise.reject(new CircuitOpenError('https://soroban-testnet.stellar.org', null)),
    );
    const customFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sequence: '7' }),
    });

    const account = await getAccountWithFallback(
      server,
      ACCOUNT_ID,
      'https://horizon-testnet.stellar.org',
      customFetch as unknown as typeof fetch,
    );

    expect(account.sequenceNumber()).toBe('7');
  });

  it('does NOT fall back on a non-network error (e.g. account not found)', async () => {
    const notFound = new Error('Account not found');
    const server = fakeServer(() => Promise.reject(notFound));
    const customFetch = vi.fn();

    await expect(
      getAccountWithFallback(
        server,
        ACCOUNT_ID,
        'https://horizon-testnet.stellar.org',
        customFetch as unknown as typeof fetch,
      ),
    ).rejects.toBe(notFound);
    expect(customFetch).not.toHaveBeenCalled();
  });

  it('does NOT fall back when no horizonUrl is configured', async () => {
    const networkError = new StreamFiNetworkError('down');
    const server = fakeServer(() => Promise.reject(networkError));
    const customFetch = vi.fn();

    await expect(
      getAccountWithFallback(server, ACCOUNT_ID, undefined, customFetch as unknown as typeof fetch),
    ).rejects.toBe(networkError);
    expect(customFetch).not.toHaveBeenCalled();
  });

  it('throws a StreamFiNetworkError when Horizon itself responds with a non-OK status', async () => {
    const server = fakeServer(() => Promise.reject(new StreamFiNetworkError('down')));
    const customFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    await expect(
      getAccountWithFallback(
        server,
        ACCOUNT_ID,
        'https://horizon-testnet.stellar.org',
        customFetch as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(StreamFiNetworkError);
  });

  it('throws a StreamFiNetworkError when Horizon returns no sequence number', async () => {
    const server = fakeServer(() => Promise.reject(new StreamFiNetworkError('down')));
    const customFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    await expect(
      getAccountWithFallback(
        server,
        ACCOUNT_ID,
        'https://horizon-testnet.stellar.org',
        customFetch as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(StreamFiNetworkError);
  });

  it('throws a StreamFiNetworkError when the Horizon fetch itself rejects', async () => {
    const server = fakeServer(() => Promise.reject(new StreamFiNetworkError('down')));
    const customFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      getAccountWithFallback(
        server,
        ACCOUNT_ID,
        'https://horizon-testnet.stellar.org',
        customFetch as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(StreamFiNetworkError);
  });
});
