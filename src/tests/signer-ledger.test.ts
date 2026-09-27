import { describe, it, expect } from 'vitest';
import { LedgerErrorType, normalizeLedgerError, classifyLedgerError, LedgerHardwareError } from '../signer.js';

describe('LedgerErrorType (#835)', () => {
  it('has all expected error types', () => {
    expect(LedgerErrorType.UserRejected).toBe('USER_REJECTED');
    expect(LedgerErrorType.DeviceLocked).toBe('DEVICE_LOCKED');
    expect(LedgerErrorType.AppNotOpen).toBe('APP_NOT_OPEN');
    expect(LedgerErrorType.DeviceDisconnected).toBe('DEVICE_DISCONNECTED');
    expect(LedgerErrorType.TransportError).toBe('TRANSPORT_ERROR');
    expect(LedgerErrorType.InvalidResponse).toBe('INVALID_RESPONSE');
    expect(LedgerErrorType.Unknown).toBe('UNKNOWN');
  });
});

describe('normalizeLedgerError (#835)', () => {
  it('maps known error codes', () => {
    expect(normalizeLedgerError(0x6982).type).toBe(LedgerErrorType.UserRejected);
    expect(normalizeLedgerError(0x6985).type).toBe(LedgerErrorType.AppNotOpen);
    expect(normalizeLedgerError(0x6F00).type).toBe(LedgerErrorType.TransportError);
  });

  it('returns Unknown for unrecognized codes', () => {
    const result = normalizeLedgerError(0xFFFF);
    expect(result.type).toBe(LedgerErrorType.Unknown);
    expect(result.message).toContain('0xFFFF');
  });
});

describe('classifyLedgerError (#835)', () => {
  it('extracts Ledger status from error message', () => {
    const err = new Error('Ledger status word: 0x6982');
    const result = classifyLedgerError(err);
    expect(result).not.toBeNull();
    expect(result!.type).toBe(LedgerErrorType.UserRejected);
  });

  it('returns null for non-Ledger errors', () => {
    const err = new Error('some other error');
    expect(classifyLedgerError(err)).toBeNull();
  });

  it('returns null for non-Error values', () => {
    expect(classifyLedgerError(null)).toBeNull();
    expect(classifyLedgerError('string')).toBeNull();
  });
});

describe('LedgerHardwareError (#835)', () => {
  it('sets type and name correctly', () => {
    const err = new LedgerHardwareError(LedgerErrorType.DeviceDisconnected, 'test');
    expect(err.type).toBe(LedgerErrorType.DeviceDisconnected);
    expect(err.name).toBe('LedgerHardwareError');
    expect(err.message).toBe('test');
  });
});
