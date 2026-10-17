import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { KeypairWalletAdapter } from '../adapters/keypair.js';

const FAST = { iterations: 1_000 };

describe('KeypairWalletAdapter keystore (#819)', () => {
  it('round-trips through exportKeystore / fromKeystore', async () => {
    const kp = Keypair.random();
    const ks = await new KeypairWalletAdapter(kp).exportKeystore('hunter2', FAST);
    const restored = await KeypairWalletAdapter.fromKeystore(ks, 'hunter2');
    expect(restored.getPublicKey()).toBe(kp.publicKey());
  });

  it('accepts the keystore as a JSON string read from disk', async () => {
    const kp = Keypair.random();
    const ks = await new KeypairWalletAdapter(kp).exportKeystore('pw', FAST);
    const restored = await KeypairWalletAdapter.fromKeystore(JSON.stringify(ks), 'pw');
    expect(restored.getPublicKey()).toBe(kp.publicKey());
  });

  it('never contains the secret key in the serialized output', async () => {
    const kp = Keypair.random();
    const json = JSON.stringify(await new KeypairWalletAdapter(kp).exportKeystore('pw', FAST));
    expect(json).not.toContain(kp.secret());
    expect(json).toContain(kp.publicKey());
  });

  it('uses a fresh salt and iv for every export', async () => {
    const adapter = new KeypairWalletAdapter(Keypair.random());
    const a = await adapter.exportKeystore('pw', FAST);
    const b = await adapter.exportKeystore('pw', FAST);
    expect(a.kdfparams.salt).not.toBe(b.kdfparams.salt);
    expect(a.cipherparams.iv).not.toBe(b.cipherparams.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('rejects a wrong passphrase', async () => {
    const ks = await new KeypairWalletAdapter(Keypair.random()).exportKeystore('right', FAST);
    await expect(KeypairWalletAdapter.fromKeystore(ks, 'wrong')).rejects.toThrow(/wrong passphrase/);
  });

  it('rejects a keystore relabelled with another public key', async () => {
    const ks = await new KeypairWalletAdapter(Keypair.random()).exportKeystore('pw', FAST);
    const forged = { ...ks, publicKey: Keypair.random().publicKey() };
    await expect(KeypairWalletAdapter.fromKeystore(forged, 'pw')).rejects.toThrow(/wrong passphrase/);
  });

  it('rejects a tampered ciphertext', async () => {
    const ks = await new KeypairWalletAdapter(Keypair.random()).exportKeystore('pw', FAST);
    const bytes = Buffer.from(ks.ciphertext, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    await expect(
      KeypairWalletAdapter.fromKeystore({ ...ks, ciphertext: bytes.toString('base64') }, 'pw'),
    ).rejects.toThrow(/wrong passphrase/);
  });

  it('rejects malformed input', async () => {
    await expect(KeypairWalletAdapter.fromKeystore('not json', 'pw')).rejects.toThrow(/not valid JSON/);
    await expect(KeypairWalletAdapter.fromKeystore('{}', 'pw')).rejects.toThrow(/Invalid or unsupported/);
  });

  it('requires a non-empty passphrase', async () => {
    const adapter = new KeypairWalletAdapter(Keypair.random());
    await expect(adapter.exportKeystore('')).rejects.toThrow(/passphrase/);
  });

  it('refuses to export a public-key-only keypair', async () => {
    const adapter = new KeypairWalletAdapter(Keypair.fromPublicKey(Keypair.random().publicKey()));
    await expect(adapter.exportKeystore('pw', FAST)).rejects.toThrow(/no secret key/);
  });
});
