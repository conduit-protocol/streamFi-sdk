import { describe, it, expect, vi } from 'vitest';
import { randomBytes, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { Address, Networks, xdr } from '@stellar/stellar-sdk';
import {
  WebAuthnSigner,
  derToRawSignature,
  type WebAuthnAssertionCredential,
  type WebAuthnCredentialsContainer,
} from '../signer.js';

// ── derToRawSignature ──────────────────────────────────────────────────────

/** Minimal DER INTEGER encoder (sign-pads with 0x00 when the high bit is set), used only to build test fixtures. */
function encodeDerInteger(value: Uint8Array): Uint8Array {
  let trimmed = value;
  while (trimmed.length > 1 && trimmed[0] === 0x00) trimmed = trimmed.slice(1);
  const needsPad = (trimmed[0] ?? 0) & 0x80;
  const content = needsPad ? Uint8Array.from([0x00, ...trimmed]) : trimmed;
  return Uint8Array.from([0x02, content.length, ...content]);
}

/** Hand-rolled DER `ECDSA-Sig-Value` encoder for raw `r || s` (64 bytes), used only to build test fixtures. */
function encodeDerFromRaw(raw: Uint8Array): Uint8Array {
  const r = encodeDerInteger(raw.slice(0, 32));
  const s = encodeDerInteger(raw.slice(32, 64));
  const content = Uint8Array.from([...r, ...s]);
  return Uint8Array.from([0x30, content.length, ...content]);
}

describe('derToRawSignature (#966)', () => {
  it('round-trips real P-256 signatures through a hand-built DER encoding', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    for (let i = 0; i < 25; i++) {
      const message = randomBytes(32);
      // IEEE P1363 is already the raw `r || s` (64-byte) format we want to recover.
      const raw = cryptoSign(null, message, { key: privateKey, dsaEncoding: 'ieee-p1363' });
      const der = encodeDerFromRaw(new Uint8Array(raw));
      expect(derToRawSignature(der)).toEqual(new Uint8Array(raw));
    }
  });

  it('handles an r/s value short enough to need left-padding', () => {
    const raw = new Uint8Array(64);
    raw[31] = 0x07; // r = 7
    raw[63] = 0x09; // s = 9
    const der = encodeDerFromRaw(raw);
    expect(derToRawSignature(der)).toEqual(raw);
  });

  it('throws on a non-SEQUENCE input', () => {
    expect(() => derToRawSignature(new Uint8Array([0x02, 1, 1]))).toThrow(/SEQUENCE/);
  });

  it('throws on a truncated input', () => {
    expect(() => derToRawSignature(new Uint8Array([0x30, 10, 0x02, 32]))).toThrow(/Malformed DER/);
  });

  it('throws when the second element is not an INTEGER', () => {
    const r = encodeDerInteger(new Uint8Array([1, 2, 3, 4, 5]));
    const bogus = Uint8Array.from([0x30, r.length + 2, ...r, 0x05, 0x00]);
    expect(() => derToRawSignature(bogus)).toThrow(/INTEGER/);
  });
});

// ── WebAuthnSigner ─────────────────────────────────────────────────────────

function randomContractAddress(): Address {
  return Address.contract(randomBytes(32));
}

function buildAuthEntry(
  credentialAddress: Address,
  targetContract: Address,
): xdr.SorobanAuthorizationEntry {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: targetContract.toScAddress(),
        functionName: 'withdraw',
        args: [],
      }),
    ),
    subInvocations: [],
  });
  const credentials = xdr.SorobanCredentials.sorobanCredentialsAddress(
    new xdr.SorobanAddressCredentials({
      address: credentialAddress.toScAddress(),
      nonce: new xdr.Int64(12345),
      signatureExpirationLedger: 0,
      signature: xdr.ScVal.scvVec([]),
    }),
  );
  return new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation: invocation });
}

function mockCredentials(assertion: WebAuthnAssertionCredential | null): WebAuthnCredentialsContainer {
  return { get: vi.fn().mockResolvedValue(assertion) };
}

function fakeAssertion(): WebAuthnAssertionCredential {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const authenticatorData = randomBytes(37).buffer;
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get' })).buffer;
  const signature = cryptoSign(null, randomBytes(32), { key: privateKey }).buffer;
  return { response: { authenticatorData, clientDataJSON, signature } };
}

describe('WebAuthnSigner (#966)', () => {
  it('publicKey() returns the configured smart-wallet contract address', () => {
    const contractAddress = randomContractAddress().toString();
    const signer = new WebAuthnSigner({
      contractAddress,
      credential: { id: randomBytes(16) },
      credentials: mockCredentials(fakeAssertion()),
    });
    expect(signer.publicKey()).toBe(contractAddress);
  });

  it('sign() is a no-op passthrough', () => {
    const signer = new WebAuthnSigner({
      contractAddress: randomContractAddress().toString(),
      credential: { id: randomBytes(16) },
      credentials: mockCredentials(fakeAssertion()),
    });
    const tx = { marker: 'unchanged' } as unknown as import('@stellar/stellar-sdk').Transaction;
    expect(signer.sign(tx)).toBe(tx);
  });

  it('authorizeEntry() requests an assertion and attaches a credential ScVal', async () => {
    const wallet = randomContractAddress();
    const target = randomContractAddress();
    const credentialsContainer = mockCredentials(fakeAssertion());
    const signer = new WebAuthnSigner({
      contractAddress: wallet.toString(),
      credential: { id: randomBytes(16) },
      credentials: credentialsContainer,
    });

    const entry = buildAuthEntry(wallet, target);
    const signed = await signer.authorizeEntry(entry, 1_000, Networks.TESTNET);

    expect(credentialsContainer.get).toHaveBeenCalledTimes(1);
    const addrAuth = signed.credentials().address();
    expect(addrAuth.signatureExpirationLedger()).toBe(1_000);
    const sigVec = addrAuth.signature().vec();
    expect(sigVec).not.toBeNull();
    expect(sigVec).toHaveLength(1);

    const map = sigVec![0]!.map();
    const keys = map!.map((entry) => entry.key().sym().toString());
    expect(keys.sort()).toEqual(['authenticator_data', 'client_data_json', 'signature']);
  });

  it('passes the allowCredentials id and rpId through to credentials.get()', async () => {
    const wallet = randomContractAddress();
    const credentialId = randomBytes(16);
    const credentialsContainer = mockCredentials(fakeAssertion());
    const signer = new WebAuthnSigner({
      contractAddress: wallet.toString(),
      credential: { id: credentialId },
      credentials: credentialsContainer,
      rpId: 'example.com',
      userVerification: 'required',
    });

    await signer.authorizeEntry(buildAuthEntry(wallet, randomContractAddress()), 1, Networks.TESTNET);

    expect(credentialsContainer.get).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: expect.objectContaining({
          rpId: 'example.com',
          userVerification: 'required',
          allowCredentials: [{ id: credentialId, type: 'public-key' }],
        }),
      }),
    );
  });

  it('rejects an entry for a different address', async () => {
    const wallet = randomContractAddress();
    const otherWallet = randomContractAddress();
    const signer = new WebAuthnSigner({
      contractAddress: wallet.toString(),
      credential: { id: randomBytes(16) },
      credentials: mockCredentials(fakeAssertion()),
    });

    await expect(
      signer.authorizeEntry(buildAuthEntry(otherWallet, randomContractAddress()), 1, Networks.TESTNET),
    ).rejects.toThrow(/not this signer's/);
  });

  it('throws UserCancelledError when the assertion is cancelled', async () => {
    const wallet = randomContractAddress();
    const signer = new WebAuthnSigner({
      contractAddress: wallet.toString(),
      credential: { id: randomBytes(16) },
      credentials: mockCredentials(null),
    });

    await expect(
      signer.authorizeEntry(buildAuthEntry(wallet, randomContractAddress()), 1, Networks.TESTNET),
    ).rejects.toThrow(/cancelled/);
  });

  it('respects custom credentialScValKeys', async () => {
    const wallet = randomContractAddress();
    const credentialsContainer = mockCredentials(fakeAssertion());
    const signer = new WebAuthnSigner({
      contractAddress: wallet.toString(),
      credential: { id: randomBytes(16) },
      credentials: credentialsContainer,
      credentialScValKeys: { signature: 'sig' },
    });

    const signed = await signer.authorizeEntry(
      buildAuthEntry(wallet, randomContractAddress()),
      1,
      Networks.TESTNET,
    );
    const map = signed.credentials().address().signature().vec()![0]!.map();
    const keys = map!.map((entry) => entry.key().sym().toString());
    expect(keys).toContain('sig');
    expect(keys).not.toContain('signature');
  });

  it('throws when no navigator.credentials is available and none was injected', () => {
    expect(
      () =>
        new WebAuthnSigner({
          contractAddress: randomContractAddress().toString(),
          credential: { id: randomBytes(16) },
        }),
    ).toThrow(/navigator\.credentials/);
  });
});
