import { describe, it, expect, vi } from 'vitest';
import { makeHeaderFetch } from '../utils/makeHeaderFetch.js';

describe('makeHeaderFetch', () => {
  it('attaches the configured headers to every request', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}'));
    const wrapped = makeHeaderFetch({ 'X-Api-Key': 'secret' }, base);

    await wrapped('https://rpc.example.com', { method: 'POST', body: '{}' });

    const init = base.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('x-api-key')).toBe('secret');
    // The original init fields must survive the merge.
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
  });

  it('does not clobber a header the caller set per request', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}'));
    const wrapped = makeHeaderFetch(
      { 'Content-Type': 'application/json', 'X-Trace': 'abc' },
      base,
    );

    await wrapped('https://rpc.example.com', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
    });

    const init = base.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    // Case-insensitive: the caller's lowercase form wins over ours.
    expect(headers.get('content-type')).toBe('text/plain');
    expect(headers.get('x-trace')).toBe('abc');
  });

  it('accepts Headers and tuple-array init forms', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}'));
    const wrapped = makeHeaderFetch({ 'X-Trace': 'abc' }, base);

    await wrapped('https://rpc.example.com', {
      headers: new Headers({ 'X-Caller': 'yes' }),
    });
    await wrapped('https://rpc.example.com', { headers: [['X-Caller', 'yes']] });

    for (const call of base.mock.calls) {
      const headers = new Headers((call[1] as RequestInit).headers);
      expect(headers.get('x-caller')).toBe('yes');
      expect(headers.get('x-trace')).toBe('abc');
    }
  });

  it('skips headers whose value is undefined', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}'));
    const wrapped = makeHeaderFetch({ 'X-Unset': undefined, 'X-Set': 'v' }, base);

    await wrapped('https://rpc.example.com');

    const headers = new Headers((base.mock.calls[0]?.[1] as RequestInit).headers);
    // Without the guard this would be the literal string "undefined".
    expect(headers.has('x-unset')).toBe(false);
    expect(headers.get('x-set')).toBe('v');
  });

  it('works when init is omitted entirely', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}'));
    const wrapped = makeHeaderFetch({ 'X-Trace': 'abc' }, base);

    await wrapped('https://rpc.example.com');

    const headers = new Headers((base.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get('x-trace')).toBe('abc');
  });

  it('passes the input through unchanged', async () => {
    const base = vi.fn().mockResolvedValue(new Response('{}'));
    const wrapped = makeHeaderFetch({ 'X-Trace': 'abc' }, base);

    await wrapped('https://rpc.example.com/path?a=1');

    expect(base.mock.calls[0]?.[0]).toBe('https://rpc.example.com/path?a=1');
  });
});
