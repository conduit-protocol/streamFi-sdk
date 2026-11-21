import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Address, Asset, Keypair } from '@stellar/stellar-sdk';

const { mockGetTokenDecimals } = vi.hoisted(() => ({
  mockGetTokenDecimals: vi.fn(),
}));

vi.mock('../soroban.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../soroban.js')>()),
  getTokenDecimals: mockGetTokenDecimals,
}));

import { TokenModule, formatTokenAmount } from '../token.js';
import { USDC_ISSUER } from '../constants.js';

const TESTNET = 'Test SDF Network ; September 2015';

describe('TokenModule.decimals (#1085)', () => {
  const customToken = Address.contract(Buffer.alloc(32, 9)).toString();

  beforeEach(() => {
    mockGetTokenDecimals.mockReset().mockResolvedValue(6);
  });

  it('resolves native XLM and the network USDC without an RPC call', async () => {
    const tokens = new TokenModule({ network: 'testnet' });
    const xlm = Asset.native().contractId(TESTNET);
    const usdc = new Asset('USDC', USDC_ISSUER.testnet).contractId(TESTNET);

    await expect(tokens.decimals(xlm)).resolves.toBe(7);
    await expect(tokens.decimals(usdc)).resolves.toBe(7);
    expect(mockGetTokenDecimals).not.toHaveBeenCalled();
  });

  it('queries other tokens through the shared decimals cache', async () => {
    const tokens = new TokenModule({ network: 'testnet' });

    await expect(tokens.decimals(customToken)).resolves.toBe(6);
    expect(mockGetTokenDecimals).toHaveBeenCalledWith(
      'https://soroban-testnet.stellar.org',
      TESTNET,
      expect.any(String),
      customToken,
    );
  });

  it('uses the connected keypair as the simulation source when none is given', async () => {
    const owner = Keypair.random();
    const tokens = new TokenModule({ network: 'testnet', keypair: owner });

    await tokens.decimals(customToken);
    expect(mockGetTokenDecimals.mock.calls[0]![2]).toBe(owner.publicKey());
  });

  it('skips the RPC for registered tokens and validates the value', async () => {
    const tokens = new TokenModule({ network: 'testnet' });
    tokens.registerDecimals(customToken, 18);

    await expect(tokens.decimals(customToken)).resolves.toBe(18);
    expect(mockGetTokenDecimals).not.toHaveBeenCalled();
    expect(() => tokens.registerDecimals(customToken, -1)).toThrow(RangeError);
    expect(() => tokens.registerDecimals(customToken, 1.5)).toThrow(RangeError);
  });

  it('formats a balance using the looked-up decimals', async () => {
    const tokens = new TokenModule({ network: 'testnet' });

    await expect(tokens.formatBalance(1_234_567_890n, customToken, 'en-US')).resolves.toBe(
      '1,234.56789',
    );
  });
});

describe('formatTokenAmount (#1086)', () => {
  it('shows at least two fractional digits', () => {
    expect(formatTokenAmount(10_000_000n, 7, 'en-US')).toBe('1.00');
    expect(formatTokenAmount(15_000_000n, 7, 'en-US')).toBe('1.50');
    expect(formatTokenAmount(0n, 7, 'en-US')).toBe('0.00');
  });

  it('keeps full precision and trims only trailing zeros', () => {
    expect(formatTokenAmount(12_345_678n, 7, 'en-US')).toBe('1.2345678');
    expect(formatTokenAmount(1n, 7, 'en-US')).toBe('0.0000001');
  });

  it('adds locale thousands separators and decimal mark', () => {
    expect(formatTokenAmount(12_345_678_901_234n, 7, 'en-US')).toBe('1,234,567.8901234');
    expect(formatTokenAmount(12_345_678_901_234n, 7, 'de-DE')).toBe('1.234.567,8901234');
  });

  it('is exact beyond Number.MAX_SAFE_INTEGER', () => {
    expect(formatTokenAmount(123_456_789_012_345_678_901_234_567n, 7, 'en-US')).toBe(
      '12,345,678,901,234,567,890.1234567',
    );
  });

  it('accepts integer strings, negative amounts and zero decimals', () => {
    expect(formatTokenAmount(' 25000000 ', 7, 'en-US')).toBe('2.50');
    expect(formatTokenAmount(-15_000_000n, 7, 'en-US')).toBe('-1.50');
    expect(formatTokenAmount(1234n, 0, 'en-US')).toBe('1,234');
    expect(formatTokenAmount(5n, 1, 'en-US')).toBe('0.5');
  });

  it('rejects invalid input', () => {
    expect(() => formatTokenAmount(1n, -1)).toThrow(RangeError);
    expect(() => formatTokenAmount(1n, 2.5)).toThrow(RangeError);
    expect(() => formatTokenAmount('1.5', 7)).toThrow(SyntaxError);
  });
});
