import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBatchCreateStreamValidation } from '../hooks/useBatchCreateStreamValidation.js';

vi.mock('@conduit-protocol/sdk/utils', () => ({
  isValidAddress: (addr: string) => /^[GC][A-Z2-7]{55}$/.test(addr),
}));

const VALID_ADDR = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

describe('useBatchCreateStreamValidation', () => {
  it('returns empty errors and valid configs for well-formed rows', () => {
    const { result } = renderHook(() => useBatchCreateStreamValidation());

    let configs: ReturnType<typeof result.current.validate>;
    act(() => {
      configs = result.current.validate([
        { recipient: VALID_ADDR, amount: '1000', startTime: '1000', endTime: '2000' },
      ]);
    });

    expect(result.current.errors).toHaveLength(0);
    expect(result.current.isValid).toBe(true);
    expect(configs!).toHaveLength(1);
    expect(configs![0]!.recipient).toBe(VALID_ADDR);
  });

  it('reports error for invalid recipient address', () => {
    const { result } = renderHook(() => useBatchCreateStreamValidation());

    act(() => {
      result.current.validate([
        { recipient: 'not-an-address', amount: '1000', startTime: '1000', endTime: '2000' },
      ]);
    });

    const recipientErrors = result.current.errors.filter((e) => e.field === 'recipient');
    expect(recipientErrors).toHaveLength(1);
    expect(recipientErrors[0]!.row).toBe(0);
  });

  it('reports error when endTime <= startTime', () => {
    const { result } = renderHook(() => useBatchCreateStreamValidation());

    act(() => {
      result.current.validate([
        { recipient: VALID_ADDR, amount: '500', startTime: '2000', endTime: '1000' },
      ]);
    });

    const endErrors = result.current.errors.filter((e) => e.field === 'endTime');
    expect(endErrors.length).toBeGreaterThan(0);
  });

  it('reports multiple errors across multiple rows', () => {
    const { result } = renderHook(() => useBatchCreateStreamValidation());

    act(() => {
      result.current.validate([
        { recipient: 'bad', amount: '0', startTime: '1000', endTime: '2000' },
        { recipient: VALID_ADDR, amount: '100', startTime: '1000', endTime: '500' },
      ]);
    });

    expect(result.current.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.current.isValid).toBe(false);
  });

  it('omits invalid rows from returned configs', () => {
    const { result } = renderHook(() => useBatchCreateStreamValidation());

    let configs: ReturnType<typeof result.current.validate>;
    act(() => {
      configs = result.current.validate([
        { recipient: 'bad', amount: '100', startTime: '1000', endTime: '2000' },
        { recipient: VALID_ADDR, amount: '200', startTime: '1000', endTime: '2000' },
      ]);
    });

    expect(configs!).toHaveLength(1);
    expect(configs![0]!.recipient).toBe(VALID_ADDR);
  });

  it('reset clears errors', () => {
    const { result } = renderHook(() => useBatchCreateStreamValidation());

    act(() => {
      result.current.validate([
        { recipient: 'bad', amount: '100', startTime: '1000', endTime: '2000' },
      ]);
    });
    expect(result.current.errors.length).toBeGreaterThan(0);

    act(() => result.current.reset());
    expect(result.current.errors).toHaveLength(0);
    expect(result.current.isValid).toBe(true);
  });
});
