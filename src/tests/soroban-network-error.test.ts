import { describe, it, expect } from 'vitest';
import { catchNetworkError } from '../soroban.js';
import { StreamFiNetworkError, InsufficientBalanceError } from '../errors.js';

describe('catchNetworkError', () => {
  it('reclassifies the canonical undici `TypeError: fetch failed` as a StreamFiNetworkError', async () => {
    const promise = Promise.reject(new TypeError('fetch failed'));

    await expect(catchNetworkError('simulateTransaction', promise)).rejects.toBeInstanceOf(
      StreamFiNetworkError,
    );
    await expect(catchNetworkError('simulateTransaction', promise)).rejects.toThrow(
      /Network error during simulateTransaction/,
    );
  });

  it('reclassifies a TypeError whose nested cause carries a network errno code', async () => {
    // Node's fetch rejects with `TypeError: fetch failed` and puts the real
    // errno (ECONNREFUSED etc.) on the nested `cause`.
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), { code: 'ECONNREFUSED' });
    const cause = Object.assign(new TypeError('fetch failed'), { cause: inner });

    await expect(catchNetworkError('sendTransaction', Promise.reject(cause))).rejects.toBeInstanceOf(
      StreamFiNetworkError,
    );
  });

  it('reclassifies browser fetch failures (`Failed to fetch`)', async () => {
    await expect(
      catchNetworkError('getAccount', Promise.reject(new TypeError('Failed to fetch'))),
    ).rejects.toBeInstanceOf(StreamFiNetworkError);
  });

  it('reclassifies a non-TypeError error carrying a network errno code', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND soroban-testnet.stellar.org'), {
      code: 'ENOTFOUND',
    });

    await expect(catchNetworkError('getAccount', Promise.reject(cause))).rejects.toBeInstanceOf(
      StreamFiNetworkError,
    );
  });

  it('reclassifies an axios-style error object with ERR_NETWORK code', async () => {
    await expect(
      catchNetworkError('simulateTransaction', Promise.reject({ code: 'ERR_NETWORK', message: 'Network Error' })),
    ).rejects.toBeInstanceOf(StreamFiNetworkError);
  });

  it('does NOT misclassify an unrelated TypeError mentioning "connect" (regression for #457)', async () => {
    // A programming bug in the simulate/assemble/sign pipeline must be
    // reported as the real TypeError, not masked as a network outage.
    const bug = new TypeError("Cannot read properties of undefined (reading 'connect')");

    await expect(catchNetworkError('simulateTransaction', Promise.reject(bug))).rejects.toBe(bug);
    await expect(catchNetworkError('simulateTransaction', Promise.reject(bug))).rejects.toBeInstanceOf(TypeError);
    await expect(catchNetworkError('simulateTransaction', Promise.reject(bug))).rejects.not.toBeInstanceOf(
      StreamFiNetworkError,
    );
  });

  it('does NOT misclassify an unrelated TypeError mentioning "fetch"', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'fetch')");

    await expect(catchNetworkError('getAccount', Promise.reject(bug))).rejects.toBe(bug);
    await expect(catchNetworkError('getAccount', Promise.reject(bug))).rejects.not.toBeInstanceOf(
      StreamFiNetworkError,
    );
  });

  it('re-throws non-network errors as-is', async () => {
    const contractError = new Error('Simulation failed: contract error #7');

    await expect(
      catchNetworkError('simulateTransaction', Promise.reject(contractError)),
    ).rejects.toBe(contractError);
  });

  it('passes an already-classified StreamFiNetworkError through unchanged', async () => {
    const networkError = new StreamFiNetworkError('Network error during getAccount: fetch failed');

    await expect(catchNetworkError('getAccount', Promise.reject(networkError))).rejects.toBe(networkError);
  });

  it('passes an InsufficientBalanceError through unchanged', async () => {
    const insufficient = new InsufficientBalanceError(10_000_000n, 50_000_000n);

    await expect(catchNetworkError('invoke', Promise.reject(insufficient))).rejects.toBe(insufficient);
  });
});
