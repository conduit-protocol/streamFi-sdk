import { describe, it, expect } from 'vitest';
import {
  ConduitError,
  StreamErrorCode,
  FactoryErrorCode,
  GovernorErrorCode,
  GovernorInvalidParamError,
  StreamFiNetworkError,
  InsufficientBalanceError,
  RateLimitError,
  CAIP2_TO_NETWORK,
  SUPPORTED_NETWORKS,
} from '../errors.js';

describe('ConduitError', () => {
  it('carries the right contract and code', () => {
    const err = new ConduitError('stream', StreamErrorCode.NothingToWithdraw);
    expect(err.contract).toBe('stream');
    expect(err.code).toBe(StreamErrorCode.NothingToWithdraw);
    expect(err.name).toBe('ConduitError');
    expect(err).toBeInstanceOf(Error);
  });

  it('has a human-readable message by default', () => {
    const err = new ConduitError('stream', StreamErrorCode.StreamCancelled);
    expect(err.message).toMatch(/cancelled/i);
  });

  it('accepts a custom message', () => {
    const err = new ConduitError('stream', StreamErrorCode.NotAuthorized, 'custom detail');
    expect(err.message).toBe('custom detail');
  });

  it('all 15 stream error codes have messages', () => {
    for (let code = 1; code <= 15; code++) {
      const err = new ConduitError('stream', code);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it('all 10 factory error codes have messages', () => {
    for (let code = 1; code <= 10; code++) {
      const err = new ConduitError('factory', code);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it('all 3 governor error codes have messages', () => {
    for (let code = 1; code <= 3; code++) {
      const err = new ConduitError('governor', code);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it('the same numeric code means something different per contract', () => {
    // Regression test for the bug this replaced: code 1 must not resolve to
    // the same message across contracts.
    const streamErr   = new ConduitError('stream', 1);
    const factoryErr  = new ConduitError('factory', 1);
    const governorErr = new ConduitError('governor', GovernorErrorCode.NotAuthorized);

    expect(streamErr.message).toMatch(/not authorized|sender or recipient/i);
    expect(factoryErr.message).toMatch(/not.*initialized/i);
    expect(governorErr.message).toMatch(/not authorized|governor authority/i);
    expect(streamErr.message).not.toBe(factoryErr.message);
  });
});

describe('ConduitError.fromContractError', () => {
  it('parses a code object scoped to the given contract', () => {
    const err = ConduitError.fromContractError('stream', { code: 6 });
    expect(err.contract).toBe('stream');
    expect(err.code).toBe(StreamErrorCode.NothingToWithdraw);
  });

  it('resolves factory code 1 as NotInitialized, not stream NotAuthorized', () => {
    const err = ConduitError.fromContractError('factory', { code: 1 });
    expect(err.code).toBe(FactoryErrorCode.NotInitialized);
    expect(err.message).toMatch(/not.*initialized/i);
  });

  it('falls back to code -1 for an unknown code', () => {
    const err = ConduitError.fromContractError('governor', { code: 999 });
    expect(err.code).toBe(-1);
  });

  it('handles non-object input', () => {
    const err = ConduitError.fromContractError('stream', 'unexpected string');
    expect(err.code).toBe(-1);
    expect(err.message).toContain('unexpected string');
  });
});

describe('ConduitError.fromSorobanMessage', () => {
  it('extracts the contract error code from a HostError message', () => {
    const err = ConduitError.fromSorobanMessage('stream', 'HostError: Error(Contract, #6)');
    expect(err).toBeInstanceOf(ConduitError);
    expect((err as ConduitError).code).toBe(StreamErrorCode.NothingToWithdraw);
    expect((err as ConduitError).contract).toBe('stream');
  });

  it('scopes the same code to the correct contract', () => {
    const err = ConduitError.fromSorobanMessage('factory', 'HostError: Error(Contract, #7)');
    expect((err as ConduitError).code).toBe(FactoryErrorCode.AlreadyInitialized);
    expect((err as ConduitError).message).toMatch(/already.*initialized/i);
  });

  it('detects WasmVm/InvalidAction and returns an InsufficientBalanceError', () => {
    const err = ConduitError.fromSorobanMessage('stream', 'HostError: Error(WasmVm, InvalidAction)');
    expect(err).toBeInstanceOf(InsufficientBalanceError);
    expect(err.message).toContain('XLM');
  });

  it('falls back to a plain Error for a network-level failure message', () => {
    const err = ConduitError.fromSorobanMessage('stream', 'fetch failed: ECONNREFUSED');
    expect(err).not.toBeInstanceOf(ConduitError);
  });
});

describe('StreamFiNetworkError', () => {
  it('carries the original cause', () => {
    const cause = new TypeError('fetch failed');
    const err = new StreamFiNetworkError('Network error', cause);
    expect(err.name).toBe('StreamFiNetworkError');
    expect(err.message).toContain('Network error');
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('InsufficientBalanceError', () => {
  it('formats a human-readable message with XLM amounts', () => {
    // 5 XLM = 50_000_000 stroops, 10 XLM = 100_000_000 stroops
    const err = new InsufficientBalanceError(50_000_000n, 100_000_000n);
    expect(err.name).toBe('InsufficientBalanceError');
    expect(err.message).toMatch(/10\.0+ XLM.*5\.0+ XLM/);
    expect(err.currentBalance).toBe(50_000_000n);
    expect(err.requiredBalance).toBe(100_000_000n);
  });

  it('includes the Soroban VM detail when provided', () => {
    const err = new InsufficientBalanceError(10_000_000n, 50_000_000n, 'HostError: Error(WasmVm, InvalidAction)');
    expect(err.message).toContain('WasmVm');
  });
});

describe('RateLimitError', () => {
  it('parses a 429 error from an axios-style error object', () => {
    const raw = { response: { status: 429, headers: { 'retry-after': '5' } } };
    const err = RateLimitError.fromRpcError(raw);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err!.retryAfterMs).toBe(5000);
    expect(err!.message).toContain('429');
  });

  it('parses JSON-RPC error code -32029', () => {
    const raw = { code: -32029 };
    const err = RateLimitError.fromRpcError(raw);
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('returns null for non-rate-limit errors', () => {
    const raw = { response: { status: 500 } };
    const err = RateLimitError.fromRpcError(raw);
    expect(err).toBeNull();
  });
});

describe('CAIP2_TO_NETWORK', () => {
  it('maps every supported CAIP-2 chain to a supported network name', () => {
    for (const network of Object.values(CAIP2_TO_NETWORK)) {
      expect(SUPPORTED_NETWORKS as readonly string[]).toContain(network);
    }
  });

  it('is the map both ConduitClient and WalletConnectAdapter validate against', async () => {
    // ConduitClient rejects a wallet whose chainId is not a key here...
    const { ConduitClient } = await import('../client.js');
    const badWallet = { chainId: 'eip155:1', getPublicKey: () => 'G', signTransaction: async (t: unknown) => t };
    expect(() => new ConduitClient({
      network: 'testnet',
      factoryAddress: 'C',
      wallet: badWallet as never,
    })).toThrow();

    // ...and WalletConnectAdapter rejects the same unknown chainId at construction.
    const { WalletConnectAdapter } = await import('../adapters/walletconnect.js');
    expect(() => new WalletConnectAdapter({ chainId: 'eip155:1' })).toThrow(/unsupported chainId/);
    expect(() => new WalletConnectAdapter({ chainId: 'stellar:testnet' })).not.toThrow();
  });
});

describe('GovernorInvalidParamError (#772)', () => {
  it('is a ConduitError for the governor InvalidParam code', () => {
    const err = new GovernorInvalidParamError();
    expect(err).toBeInstanceOf(ConduitError);
    expect(err).toBeInstanceOf(GovernorInvalidParamError);
    expect(err.name).toBe('GovernorInvalidParamError');
    expect(err.contract).toBe('governor');
    expect(err.code).toBe(GovernorErrorCode.InvalidParam);
    expect(err.isKnown).toBe(true);
  });

  it('is what fromSorobanMessage returns for governor error #2', () => {
    const err = ConduitError.fromSorobanMessage('governor', 'HostError: Error(Contract, #2)');
    expect(err).toBeInstanceOf(GovernorInvalidParamError);
    expect(err.message).toContain('Parameter failed validation');
    expect(err.message).toContain('Error(Contract, #2)');
  });

  it('is what fromContractError returns for a governor InvalidParam code', () => {
    expect(ConduitError.fromContractError('governor', { code: 2 })).toBeInstanceOf(
      GovernorInvalidParamError,
    );
  });

  it('leaves the other governor errors as plain ConduitErrors', () => {
    const err = ConduitError.fromSorobanMessage('governor', 'HostError: Error(Contract, #1)');
    expect(err).toBeInstanceOf(ConduitError);
    expect(err).not.toBeInstanceOf(GovernorInvalidParamError);
  });
});
