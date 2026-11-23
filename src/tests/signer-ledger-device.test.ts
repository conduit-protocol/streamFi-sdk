import { describe, it, expect, vi } from 'vitest';
import { Keypair, TransactionBuilder, Account, Operation, Networks, Asset, Transaction } from '@stellar/stellar-sdk';
import { LedgerSigner, LedgerHardwareError } from '../signer.js';
import type { LedgerDevice } from '../signer.js';

const PATH = "44'/148'/0'/0/0";

function buildTx(): Transaction {
  const kp = Keypair.random();
  const account = new Account(kp.publicKey(), '1');
  return new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(30)
    .build();
}

describe('LedgerSigner', () => {
  it('throws from publicKey() before the key is resolved', () => {
    const signer = new LedgerSigner({ device: {} as LedgerDevice, path: PATH });
    expect(() => signer.publicKey()).toThrow(LedgerHardwareError);
  });

  it('resolves and caches the public key via getPublicKey()', async () => {
    const device = { getPublicKey: vi.fn(async () => ({ publicKey: 'GLEDGERPUBKEY' })), signTransaction: vi.fn() };
    const signer = new LedgerSigner({ device, path: PATH });
    expect(await signer.getPublicKey()).toBe('GLEDGERPUBKEY');
    expect(signer.publicKey()).toBe('GLEDGERPUBKEY');
    expect(device.getPublicKey).toHaveBeenCalledWith(PATH);
    // cached: a second call does not hit the device again
    await signer.getPublicKey();
    expect(device.getPublicKey).toHaveBeenCalledTimes(1);
  });

  it('uses a constructor-supplied publicKey without touching the device', () => {
    const device = { getPublicKey: vi.fn(), signTransaction: vi.fn() };
    const signer = new LedgerSigner({ device, path: PATH, publicKey: 'GPRESET' });
    expect(signer.publicKey()).toBe('GPRESET');
    expect(device.getPublicKey).not.toHaveBeenCalled();
  });

  it('signs by delegating to the device and returning a Transaction', async () => {
    const tx = buildTx();
    const device: LedgerDevice = {
      getPublicKey: vi.fn(async () => ({ publicKey: 'GLEDGERPUBKEY' })),
      signTransaction: vi.fn(async (_p, xdr) => ({ signature: new Uint8Array([1, 2, 3]), signedTxXdr: xdr })),
    };
    const signer = new LedgerSigner({ device, path: PATH });
    const signed = await signer.sign(tx);
    expect(device.signTransaction).toHaveBeenCalledWith(PATH, tx.toXDR());
    expect(signed).toBeInstanceOf(Transaction);
    expect(signed.toXDR()).toBe(tx.toXDR());
  });
});
