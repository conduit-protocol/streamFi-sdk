import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair, TransactionBuilder, Account, Operation, Networks, Asset } from '@stellar/stellar-sdk';
import {
  LedgerErrorType,
  LedgerHardwareError,
  LEDGER_DEVICE_TIMEOUT_HINT,
  classifyLedgerError,
  isDeviceTimeoutError,
  wrapLedgerError,
  wrapDeviceTimeoutError,
  withDeviceTimeout,
  LedgerSigner,
  type LedgerDevice,
} from '../signer.js';

function buildTx() {
  const kp = Keypair.random();
  return new TransactionBuilder(new Account(kp.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(30)
    .build();
}

describe('device timeout diagnostics', () => {
  afterEach(() => vi.useRealTimers());

  it('classifies timeout messages without losing status-word classification', () => {
    expect(isDeviceTimeoutError(new Error('device timeout while awaiting confirmation'))).toBe(true);
    expect(isDeviceTimeoutError(new Error('Ledger status word: 0x6982'))).toBe(false);
    expect(classifyLedgerError(new Error('Ledger status word: 0x6982'))!.type)
      .toBe(LedgerErrorType.UserRejected);
    expect(classifyLedgerError(new Error('device timed out'))!.type)
      .toBe(LedgerErrorType.DeviceTimeout);
    expect(LedgerErrorType.DeviceTimeout).toBe('DEVICE_TIMEOUT');
  });

  it('wraps generic timeouts in an actionable LedgerHardwareError', () => {
    const wrapped = wrapDeviceTimeoutError(new Error('timeout awaiting device'));
    expect(wrapped).toBeInstanceOf(LedgerHardwareError);
    expect(wrapped.type).toBe(LedgerErrorType.DeviceTimeout);
    expect(wrapped.message).toContain('unlock');
    expect(wrapped.message).toContain('timeout awaiting device');
  });

  it('keeps classified types and appends the hint once', () => {
    const first = wrapLedgerError(new Error('Ledger status word: 0x6985'), 'signing');
    expect(first.type).toBe(LedgerErrorType.AppNotOpen);
    const second = wrapLedgerError(first, 'signing');
    expect(second.type).toBe(LedgerErrorType.AppNotOpen);
    expect(second.message.match(/check that the hardware device/g)).toHaveLength(1);
  });

  it('races a hanging device operation with a descriptive timeout', async () => {
    vi.useFakeTimers();
    const assertion = expect(withDeviceTimeout(new Promise<never>(() => {}), 50, 'signing'))
      .rejects.toBeInstanceOf(LedgerHardwareError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('has LedgerSigner surface device timeouts with the diagnostic hint', async () => {
    const device: LedgerDevice = {
      getPublicKey: vi.fn(async () => ({ publicKey: 'GLEDGER' })),
      signTransaction: vi.fn(async () => { throw new Error('device response timeout'); }),
    };
    const signer = new LedgerSigner({ device, path: "44'/148'/0'/0/0" });

    await expect(signer.sign(buildTx())).rejects.toMatchObject({
      name: 'LedgerHardwareError',
      type: LedgerErrorType.DeviceTimeout,
    });
    await expect(signer.sign(buildTx())).rejects.toThrow(LEDGER_DEVICE_TIMEOUT_HINT);
  });
});
