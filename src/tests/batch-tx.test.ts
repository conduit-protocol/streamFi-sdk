import { resolvePassphrase, BatchTransactionContext, BatchBuildError } from '../batch-tx.js';
import { describe, it, expect } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';

describe('resolvePassphrase', () => {
  it('should return networkPassphrase when provided', () => {
    const ctx = { networkPassphrase: 'custom passphrase' } as BatchTransactionContext;
    expect(resolvePassphrase(ctx)).toBe('custom passphrase');
  });

  it('should resolve named networks', () => {
    expect(resolvePassphrase({ network: 'mainnet' } as BatchTransactionContext)).toBe(Networks.PUBLIC);
    expect(resolvePassphrase({ network: 'testnet' } as BatchTransactionContext)).toBe(Networks.TESTNET);
    expect(resolvePassphrase({ network: 'local' } as BatchTransactionContext)).toBe(Networks.STANDALONE);
  });

  it('should throw BatchBuildError on unknown network', () => {
    expect(() => resolvePassphrase({ network: 'unknown' as any } as BatchTransactionContext))
      .toThrowError(BatchBuildError);
  });

  it('should throw BatchBuildError when neither is provided', () => {
    expect(() => resolvePassphrase({} as BatchTransactionContext))
      .toThrowError(BatchBuildError);
  });
});
