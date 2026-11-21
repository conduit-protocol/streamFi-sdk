import { describe, it, expect, vi, afterEach } from 'vitest';
import { withSignatureTimeout } from '../signer.js';
import { SignatureTimeoutError, isConduitError } from '../errors.js';

describe('withSignatureTimeout', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects with SignatureTimeoutError when the signer never responds', async () => {
    vi.useFakeTimers();
    const p = withSignatureTimeout(new Promise<never>(() => {}), 500);
    const assertion = expect(p).rejects.toBeInstanceOf(SignatureTimeoutError);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('exposes timeoutMs and is recognised by isConduitError', async () => {
    const err = new SignatureTimeoutError(42);
    expect(err.timeoutMs).toBe(42);
    expect(isConduitError(err)).toBe(true);
  });

  it('passes through resolved values and rejections', async () => {
    await expect(withSignatureTimeout(Promise.resolve('ok'), 100)).resolves.toBe('ok');
    await expect(withSignatureTimeout(Promise.reject(new Error('rejected')), 100)).rejects.toThrow('rejected');
  });

  it('waits indefinitely when timeout is 0 or Infinity', async () => {
    await expect(withSignatureTimeout(Promise.resolve(1), 0)).resolves.toBe(1);
    await expect(withSignatureTimeout(1, Infinity)).resolves.toBe(1);
  });
});
