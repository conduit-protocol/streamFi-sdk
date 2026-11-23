import { describe, it, expect, vi } from 'vitest';
import { createMockIndexer, MockGraphQLIndexer } from '../mock-indexer.js';

describe('MockGraphQLIndexer — latency', () => {
  it('delays query resolution by latencyMs', async () => {
    const idx = createMockIndexer({ queries: { q: { ok: 1 } }, latencyMs: 50 });
    const start = Date.now();
    await idx.query({ query: 'q' });
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('does not delay when latencyMs is 0', async () => {
    const idx = createMockIndexer({ queries: { q: 1 }, latencyMs: 0 });
    await expect(idx.query({ query: 'q' })).resolves.toBe(1);
  });
});

describe('MockGraphQLIndexer — failure simulation', () => {
  it('throws on query when the failure roll triggers', async () => {
    const idx = new MockGraphQLIndexer({ queries: { q: 1 }, failureRate: 1, random: () => 0.5 });
    await expect(idx.query({ query: 'q' })).rejects.toThrow(/simulated RPC connection drop/);
  });

  it('never fails when failureRate is 0', async () => {
    const idx = new MockGraphQLIndexer({ queries: { q: 1 }, failureRate: 0 });
    await expect(idx.query({ query: 'q' })).resolves.toBe(1);
  });

  it('routes dropped emissions to onError and skips onData', async () => {
    const onData = vi.fn();
    const onError = vi.fn();
    const idx = new MockGraphQLIndexer({ subscriptions: { s: [1, 2] }, failureRate: 1, random: () => 0.5 });
    idx.subscribe({ query: 's', onData, onError });
    await new Promise((r) => setTimeout(r, 40));
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onData).not.toHaveBeenCalled();
  });

  it('delivers events normally when failureRate is 0', async () => {
    const onData = vi.fn();
    const onError = vi.fn();
    const idx = new MockGraphQLIndexer({ subscriptions: { s: ['a', 'b'] }, failureRate: 0 });
    idx.subscribe({ query: 's', onData, onError });
    await new Promise((r) => setTimeout(r, 40));
    expect(onData).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });
});
