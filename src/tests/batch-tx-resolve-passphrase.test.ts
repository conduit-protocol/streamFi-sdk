/**
 * Direct unit tests for `resolvePassphrase()` (src/batch-tx.ts) — issue #462.
 *
 * A small pure function with several distinct branches (explicit passphrase
 * present/blank, named network known/unknown, neither provided). Before this
 * file it was only exercised incidentally through
 * `buildBatchTransactionsSync`/`buildBatchTransactions` tests; covering it
 * directly is cheap and locks in each branch's behaviour.
 */

import { describe, it, expect } from 'vitest';
import { resolvePassphrase, BatchBuildError } from '../batch-tx.js';
import { NETWORK_PASSPHRASE } from '../soroban.js';
import type { BatchTransactionContext } from '../batch-tx.js';
import type { Network } from '../types/index.js';

const CONTRACT_ID = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SOURCE      = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';

function ctx(overrides: Partial<BatchTransactionContext>): BatchTransactionContext {
  return { contractId: CONTRACT_ID, sourceAccount: SOURCE, ...overrides };
}

describe('resolvePassphrase', () => {
  it('returns the explicit networkPassphrase when present', () => {
    expect(resolvePassphrase(ctx({ networkPassphrase: 'My Custom Net' }))).toBe('My Custom Net');
  });

  it('takes the explicit passphrase over a named network', () => {
    expect(resolvePassphrase(ctx({ network: 'mainnet', networkPassphrase: 'Explicit' }))).toBe('Explicit');
  });

  it('ignores a blank or whitespace-only networkPassphrase', () => {
    expect(resolvePassphrase(ctx({ network: 'testnet', networkPassphrase: '' }))).toBe(
      NETWORK_PASSPHRASE.testnet,
    );
    expect(resolvePassphrase(ctx({ network: 'testnet', networkPassphrase: '   ' }))).toBe(
      NETWORK_PASSPHRASE.testnet,
    );
  });

  it('resolves each known named network to its passphrase', () => {
    for (const network of ['mainnet', 'testnet', 'local'] as Network[]) {
      expect(resolvePassphrase(ctx({ network }))).toBe(NETWORK_PASSPHRASE[network]);
    }
  });

  it('throws BatchBuildError for an unknown network', () => {
    expect(() => resolvePassphrase(ctx({ network: 'invalid-net' as Network }))).toThrow(
      BatchBuildError,
    );
    expect(() => resolvePassphrase(ctx({ network: 'invalid-net' as Network }))).toThrow(
      'Unknown network "invalid-net"',
    );
  });

  it('throws BatchBuildError when neither networkPassphrase nor network is provided', () => {
    expect(() => resolvePassphrase(ctx({}))).toThrow(BatchBuildError);
    expect(() => resolvePassphrase(ctx({}))).toThrow(
      'BatchTransactionContext requires either networkPassphrase or network',
    );
  });
});
