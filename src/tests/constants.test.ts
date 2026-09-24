import { describe, it, expect } from 'vitest';
import { StrKey, Asset } from '@stellar/stellar-sdk';
import { USDC_ISSUER, MIN_STREAM_DURATION_SECONDS } from '../constants.js';

// See #508 — the previous mainnet USDC issuer constant was a placeholder
// strkey ("...ANYOUR") that failed checksum validation, so
// `new Asset('USDC', issuer)` threw on every mainnet
// `create({ token: 'USDC' })` call.
describe('USDC_ISSUER', () => {
  it('is a valid Ed25519 strkey for both networks', () => {
    expect(StrKey.isValidEd25519PublicKey(USDC_ISSUER.testnet)).toBe(true);
    expect(StrKey.isValidEd25519PublicKey(USDC_ISSUER.mainnet)).toBe(true);
  });

  it('constructs a Stellar Asset without throwing', () => {
    expect(() => new Asset('USDC', USDC_ISSUER.testnet)).not.toThrow();
    expect(() => new Asset('USDC', USDC_ISSUER.mainnet)).not.toThrow();
  });
});

describe('MIN_STREAM_DURATION_SECONDS', () => {
  it('is exported as a constant', () => {
    expect(typeof MIN_STREAM_DURATION_SECONDS).toBe('number');
    expect(MIN_STREAM_DURATION_SECONDS).toBeGreaterThan(0);
  });

  it('equals 3600 (1 hour)', () => {
    expect(MIN_STREAM_DURATION_SECONDS).toBe(3600);
  });
});
