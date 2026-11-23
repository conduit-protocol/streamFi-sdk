import { describe, it, expect } from 'vitest';
import { Keypair, xdr } from '@stellar/stellar-sdk';
import {
  mergeFootprints,
  buildDeduplicatedFootprint,
  deduplicateFootprint,
  mergeSimulationFootprints,
} from '../batch-tx.js';

function accountKey(seed?: string): xdr.LedgerKey {
  const kp = seed ? Keypair.fromSecret(seed) : Keypair.random();
  return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: kp.xdrPublicKey() }));
}

function footprint(readOnly: xdr.LedgerKey[], readWrite: xdr.LedgerKey[]): xdr.LedgerFootprint {
  return new xdr.LedgerFootprint({ readOnly, readWrite });
}

function ids(keys: xdr.LedgerKey[]): string[] {
  return keys.map((key) => key.toXDR('base64'));
}

describe('deduplicated footprint builder', () => {
  it('deduplicates keys inside a single footprint', () => {
    const key = accountKey();
    const merged = deduplicateFootprint(footprint([key, key], [key]));

    expect(merged.readOnly()).toHaveLength(0);
    expect(ids(merged.readWrite())).toEqual(ids([key]));
  });

  it('merges read-only and read-write sets across footprints', () => {
    const a = accountKey();
    const b = accountKey();
    const c = accountKey();
    const first = footprint([a, b], [c]);
    const second = footprint([b, c], [a]);

    const merged = mergeFootprints(first, second);

    expect(ids(merged.readOnly())).toEqual(ids([b]));
    expect(ids(merged.readWrite())).toEqual(ids([c, a]));
  });

  it('promotes a read-only key that another operation needs writable', () => {
    const key = accountKey();
    const merged = buildDeduplicatedFootprint([
      footprint([key], []),
      footprint([], [key]),
    ]);

    expect(merged.readOnly()).toHaveLength(0);
    expect(ids(merged.readWrite())).toEqual(ids([key]));
  });

  it('accepts raw ledger-key arrays and simulation responses', () => {
    const key = accountKey();
    const merged = mergeFootprints([key], {
      transactionData: { footprint: footprint([], [key]) },
    });

    expect(ids(merged.readWrite())).toEqual(ids([key]));

    const fromSims = mergeSimulationFootprints([
      { transactionData: { footprint: footprint([key], []) } } as never,
    ]);
    expect(ids(fromSims.readOnly())).toEqual(ids([key]));
  });

  it('does not mutate its inputs', () => {
    const key = accountKey();
    const first = footprint([key], []);
    const second = footprint([key], []);
    mergeFootprints(first, second);

    expect(first.readOnly()).toHaveLength(1);
    expect(second.readOnly()).toHaveLength(1);
  });

  it('rejects non-ledger-key entries', () => {
    expect(() => mergeFootprints(['not-a-key'] as never)).toThrow(/LedgerKey/);
  });
});
