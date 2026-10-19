import { describe, it, expect } from 'vitest';
import { CONTRACT_IDS, NETWORK_CONFIG, getContractId } from '../constants.js';

/**
 * #981 — Futurenet and standalone network presets. Contract IDs are derived
 * per deployment (deployer + salt), so none are hardcoded: unpublished
 * entries are `null` and callers must pass their own addresses.
 */

describe('NETWORK_CONFIG (#981)', () => {
  it('provides the Futurenet RPC URL and passphrase', () => {
    expect(NETWORK_CONFIG.futurenet).toEqual({
      rpcUrl: 'https://rpc-futurenet.stellar.org',
      networkPassphrase: 'Test SDF Future Network ; October 2022',
    });
  });

  it('provides the local standalone RPC URL and passphrase', () => {
    expect(NETWORK_CONFIG.standalone).toEqual({
      rpcUrl: 'http://localhost:8000/soroban/rpc',
      networkPassphrase: 'Standalone Network ; February 2017',
    });
  });
});

describe('CONTRACT_IDS (#981)', () => {
  it('has no published ids for futurenet or standalone', () => {
    expect(CONTRACT_IDS.futurenet).toEqual({ factory: null, governor: null });
    expect(CONTRACT_IDS.standalone).toEqual({ factory: null, governor: null });
  });

  it('getContractId returns null for a contract that has not been published', () => {
    expect(getContractId('futurenet', 'factory')).toBeNull();
    expect(getContractId('standalone', 'governor')).toBeNull();
  });
});
