import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Address, Asset, Keypair, Networks, xdr } from '@stellar/stellar-sdk';

const { mockBuildContractCallTx, mockSimulateReadOnly, mockGetAccount, mockGetTokenDecimals } = vi.hoisted(() => ({
  mockBuildContractCallTx: vi.fn(),
  mockSimulateReadOnly: vi.fn(),
  mockGetAccount: vi.fn(),
  mockGetTokenDecimals: vi.fn(),
}));

vi.mock('../soroban.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../soroban.js')>()),
  buildContractCallTx: mockBuildContractCallTx,
  simulateReadOnly: mockSimulateReadOnly,
  getTokenDecimals: mockGetTokenDecimals,
  getServer: () => ({ getAccount: mockGetAccount }),
}));


import { MissingTrustlineError } from '../errors.js';
import { USDC_ISSUER } from '../constants.js';
import { TokenModule } from '../token.js';

const owner = Keypair.random();
const tokenA = Address.contract(Buffer.alloc(32, 7)).toString();
const tokenB = Address.contract(Buffer.alloc(32, 8)).toString();
const tx = { kind: 'transaction' };

function newTokens(options?: { metadataCacheSize?: number }): TokenModule {
  return new TokenModule(
    { network: 'testnet', keypair: owner },
    options,
  );
}

describe('TokenModule metadata LRU cache', () => {
  beforeEach(() => {
    mockGetTokenDecimals.mockReset().mockResolvedValue(7);
    mockBuildContractCallTx.mockReset().mockResolvedValue(tx);
    mockSimulateReadOnly.mockReset().mockResolvedValue(xdr.ScVal.scvU32(7));
    mockGetAccount.mockReset();
  });

  it('caches decimals per token and only queries the source once', async () => {
    const tokens = newTokens();
    await expect(tokens.decimals(tokenA)).resolves.toBe(7);
    await expect(tokens.decimals(tokenA)).resolves.toBe(7);
    await expect(tokens.decimals(tokenA)).resolves.toBe(7);

    expect(mockGetTokenDecimals).toHaveBeenCalledTimes(1);
    expect(mockGetTokenDecimals.mock.calls[0]?.[3]).toBe(tokenA);
  });

  it('caches symbol values (scvString and scvSymbol)', async () => {
    mockSimulateReadOnly.mockResolvedValueOnce(xdr.ScVal.scvString(Buffer.from('USDC')));
    const tokens = newTokens();
    await expect(tokens.symbol(tokenA)).resolves.toBe('USDC');
    await expect(tokens.getSymbol(tokenA)).resolves.toBe('USDC');

    mockSimulateReadOnly.mockResolvedValueOnce(xdr.ScVal.scvSymbol(Buffer.from('XLM')));
    await expect(tokens.symbol(tokenB)).resolves.toBe('XLM');

    expect(mockSimulateReadOnly).toHaveBeenCalledTimes(2);
    expect(mockBuildContractCallTx.mock.calls[0]?.[4]).toBe('symbol');
  });

  it('coalesces concurrent in-flight lookups for the same token', async () => {
    const tokens = newTokens();
    const [a, b] = await Promise.all([tokens.decimals(tokenA), tokens.decimals(tokenA)]);

    expect(a).toBe(7);
    expect(b).toBe(7);
    expect(mockGetTokenDecimals).toHaveBeenCalledTimes(1);
  });

  it('does not cache failed metadata lookups', async () => {
    mockGetTokenDecimals
      .mockRejectedValueOnce(new Error('simulation boom'))
      .mockResolvedValueOnce(2);
    const tokens = newTokens();

    await expect(tokens.decimals(tokenA)).rejects.toThrow('simulation boom');
    await expect(tokens.decimals(tokenA)).resolves.toBe(2);
    expect(mockGetTokenDecimals).toHaveBeenCalledTimes(2);
  });

  it('evicts the least-recently-used token at the configured capacity', async () => {
    const tokens = newTokens({ metadataCacheSize: 1 });
    await tokens.decimals(tokenA);
    await tokens.decimals(tokenB);
    // tokenA was evicted by tokenB, so this is a third LRU miss.
    await tokens.decimals(tokenA);

    expect(tokens.getMetadataCacheMetrics().decimals.cacheMisses).toBe(3);
  });

  it('clearMetadataCache forces fresh lookups', async () => {
    const tokens = newTokens();
    await tokens.decimals(tokenA);
    tokens.clearMetadataCache();
    await tokens.decimals(tokenA);

    expect(mockGetTokenDecimals).toHaveBeenCalledTimes(2);
  });
});

describe('TokenModule.checkTrustline', () => {
  const issuer = USDC_ISSUER.testnet;
  const usdcContract = new Asset('USDC', issuer).contractId(Networks.TESTNET);
  const account = Keypair.random().publicKey();

  beforeEach(() => {
    mockGetAccount.mockReset();
  });

  it('never requires a trustline for native XLM', async () => {
    const result = await newTokens().checkTrustline('native', account);
    expect(result.hasTrustline).toBe(true);
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('detects an existing trustline via the asset contract ID', async () => {
    mockGetAccount.mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '10' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: issuer, balance: '5' },
      ],
    });

    const result = await newTokens().checkTrustline(usdcContract, account);
    expect(result.hasTrustline).toBe(true);
    expect(result.assetCode).toBe('USDC');
    expect(result.message).toContain('has a trustline');
  });

  it('reports a missing trustline with an actionable message', async () => {
    mockGetAccount.mockResolvedValue({ balances: [{ asset_type: 'native', balance: '10' }] });

    const result = await newTokens().checkTrustline('USDC', account);
    expect(result.hasTrustline).toBe(false);
    expect(result.message).toContain('no trustline');
    expect(result.message).toContain(account);
  });

  it('throws MissingTrustlineError when throwOnMissing is set', async () => {
    mockGetAccount.mockResolvedValue({ balances: [{ asset_type: 'native', balance: '10' }] });

    await expect(
      newTokens().checkTrustline('USDC', account, { throwOnMissing: true }),
    ).rejects.toBeInstanceOf(MissingTrustlineError);
  });

  it('requireTrustline throws on a missing trustline', async () => {
    mockGetAccount.mockResolvedValue({ balances: [{ asset_type: 'native', balance: '10' }] });

    await expect(newTokens().requireTrustline('USDC', account)).rejects.toThrow(/trustline/);
  });
});
