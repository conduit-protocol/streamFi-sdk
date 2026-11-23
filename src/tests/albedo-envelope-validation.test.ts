import { describe, it, expect, vi } from 'vitest';
import {
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  Account,
  Networks,
} from '@stellar/stellar-sdk';
import {
  AlbedoWalletAdapter,
  AlbedoEnvelopeError,
  verifyEnvelope,
  type AlbedoApi,
} from '../adapters/albedo.js';

const PASSPHRASE = Networks.TESTNET;

function makeUnsignedTx(source: string) {
  return new TransactionBuilder(new Account(source, '1'), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .setTimeout(30)
    .build();
}

describe('verifyEnvelope (#1188)', () => {
  const keypair = Keypair.random();

  function signedXdr(signers: Keypair[] = [keypair]): string {
    const tx = makeUnsignedTx(keypair.publicKey());
    for (const signer of signers) tx.sign(signer);
    return tx.toXDR();
  }

  it('accepts a well-formed signed envelope', () => {
    const xdr = signedXdr();
    const result = verifyEnvelope(xdr, PASSPHRASE);
    expect(result.signatureCount).toBe(1);
    expect(result.transaction.toXDR()).toBe(xdr);
  });

  it('rejects an empty or non-XDR response', () => {
    expect(() => verifyEnvelope('', PASSPHRASE)).toThrow(AlbedoEnvelopeError);
    expect(() => verifyEnvelope('not-base64-xdr', PASSPHRASE)).toThrow(/malformed/i);
    try {
      verifyEnvelope('not-base64-xdr', PASSPHRASE);
    } catch (error) {
      expect((error as AlbedoEnvelopeError).reason).toBe('invalid_xdr');
    }
  });

  it('rejects an unsigned envelope', () => {
    const xdr = makeUnsignedTx(keypair.publicKey()).toXDR();
    expect(() => verifyEnvelope(xdr, PASSPHRASE)).toThrow(/at least 1 signature/);
    try {
      verifyEnvelope(xdr, PASSPHRASE);
    } catch (error) {
      expect((error as AlbedoEnvelopeError).reason).toBe('invalid_signature_count');
    }
  });

  it('rejects the wrong signature count', () => {
    const xdr = signedXdr();
    expect(() => verifyEnvelope(xdr, PASSPHRASE, { expectedSignatureCount: 2 })).toThrow(
      /expected exactly 2/,
    );
  });

  it('can verify signatures against an expected signer', () => {
    const xdr = signedXdr();
    expect(() =>
      verifyEnvelope(xdr, PASSPHRASE, { signerPublicKey: keypair.publicKey() }),
    ).not.toThrow();
    expect(() =>
      verifyEnvelope(xdr, PASSPHRASE, { signerPublicKey: Keypair.random().publicKey() }),
    ).toThrow(/was not produced by/);
  });
});

describe('AlbedoWalletAdapter response validation (#1188)', () => {
  const keypair = Keypair.random();

  function responseWith(signers: Keypair[]) {
    const tx = makeUnsignedTx(keypair.publicKey());
    for (const signer of signers) tx.sign(signer);
    return { signed_envelope_xdr: tx.toXDR() };
  }

  function adapterFor(client: AlbedoApi): AlbedoWalletAdapter {
    return new AlbedoWalletAdapter({
      albedo: client,
      publicKey: keypair.publicKey(),
      networkPassphrase: PASSPHRASE,
    });
  }

  it('accepts a valid response', async () => {
    const client: AlbedoApi = { tx: vi.fn().mockResolvedValue(responseWith([keypair])) };
    const tx = makeUnsignedTx(keypair.publicKey());
    const result = await adapterFor(client).signTransaction(tx);
    expect(result).toBeInstanceOf(Object);
  });

  it('rejects a malformed XDR string returned by the popup', async () => {
    const client: AlbedoApi = { tx: vi.fn().mockResolvedValue({ signed_envelope_xdr: 'garbage' }) };
    const tx = makeUnsignedTx(keypair.publicKey());
    await expect(adapterFor(client).signTransaction(tx)).rejects.toThrow(AlbedoEnvelopeError);
  });

  it('rejects an envelope the popup forgot to sign', async () => {
    const unsigned = makeUnsignedTx(keypair.publicKey()).toXDR();
    const client: AlbedoApi = { tx: vi.fn().mockResolvedValue({ xdr: unsigned }) };
    const tx = makeUnsignedTx(keypair.publicKey());
    await expect(adapterFor(client).signTransaction(tx)).rejects.toThrow(/at least 1 signature/);
  });

  it('rejects an over-signed envelope', async () => {
    const client: AlbedoApi = {
      tx: vi.fn().mockResolvedValue(responseWith([keypair, Keypair.random()])),
    };
    const tx = makeUnsignedTx(keypair.publicKey());
    await expect(adapterFor(client).signTransaction(tx)).rejects.toThrow(/expected exactly 1/);
  });

  it('rejects an error object from the intent', async () => {
    const client: AlbedoApi = { tx: vi.fn().mockResolvedValue({ error: 'User rejected' }) };
    const tx = makeUnsignedTx(keypair.publicKey());
    await expect(adapterFor(client).signTransaction(tx)).rejects.toThrow(/User rejected/);
  });
});
