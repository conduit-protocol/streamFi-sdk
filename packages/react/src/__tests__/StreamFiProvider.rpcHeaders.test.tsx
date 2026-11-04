import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { StreamFiProvider, useStreamFiClient } from '../index.js';

// Capture the config each client is constructed with, so the test can assert
// on the `customFetch` the provider derived from `rpcHeaders`.
const constructed: Array<Record<string, unknown>> = [];

vi.mock('@conduit-protocol/sdk', () => ({
  SUPPORTED_NETWORKS: ['mainnet', 'testnet', 'local'],
  UnsupportedChainError: class UnsupportedChainError extends Error {},
  clearServerCache: () => {},
  clearTokenDecimalsCache: () => {},
  ConduitClient: vi.fn(function (this: unknown, config: Record<string, unknown>) {
    constructed.push(config);
    return { config };
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <StreamFiProvider config={{ network: 'testnet' }} rpcHeaders={{ 'X-Api-Key': 'k' }}>
      {children}
    </StreamFiProvider>
  );
}

describe('StreamFiProvider rpcHeaders', () => {
  it('passes a customFetch that injects the configured headers', async () => {
    constructed.length = 0;
    renderHook(() => useStreamFiClient(), { wrapper });

    const config = constructed.at(-1);
    expect(config).toBeDefined();
    const customFetch = config?.customFetch as typeof fetch;
    expect(typeof customFetch).toBe('function');

    const base = vi.fn().mockResolvedValue(new Response('{}'));
    // The wrapper defaults to globalThis.fetch; stub it to observe the call.
    const original = globalThis.fetch;
    globalThis.fetch = base as unknown as typeof fetch;
    try {
      await customFetch('https://rpc.example.com', { method: 'POST' });
    } finally {
      globalThis.fetch = original;
    }

    const headers = new Headers((base.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get('x-api-key')).toBe('k');
  });

  it('leaves customFetch undefined when no headers are given', () => {
    constructed.length = 0;
    const noHeaders = ({ children }: { children: ReactNode }) => (
      <StreamFiProvider config={{ network: 'testnet' }}>{children}</StreamFiProvider>
    );
    renderHook(() => useStreamFiClient(), { wrapper: noHeaders });

    const config = constructed.at(-1);
    expect(config?.customFetch).toBeUndefined();
  });

  it('leaves customFetch undefined for an empty header object', () => {
    constructed.length = 0;
    const emptyHeaders = ({ children }: { children: ReactNode }) => (
      <StreamFiProvider config={{ network: 'testnet' }} rpcHeaders={{}}>
        {children}
      </StreamFiProvider>
    );
    renderHook(() => useStreamFiClient(), { wrapper: emptyHeaders });

    expect(constructed.at(-1)?.customFetch).toBeUndefined();
  });
});
