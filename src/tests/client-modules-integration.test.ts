import { describe, it, expect } from 'vitest';
import { ConduitClient } from '../client.js';
import type { StreamInfo } from '../types/index.js';
import type { StreamSnapshot } from '../module36.js';

describe('ConduitClient — Modules Integration (Issue #779)', () => {
  const dummyStream: StreamInfo = {
    id: 100n,
    address: 'CCSTREAM100ADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    sender: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLYC3ZCHB2D4P3CF',
    recipient: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    token: 'native',
    ratePerSecond: 10n,
    startTime: 1000,
    endTime: 2000,
    withdrawn: 0n,
    paused: false,
    pausedAt: 0,
    cancelled: false,
    clawbackEnabled: false,
  };

  const client = new ConduitClient({
    network: 'testnet',
    factoryAddress: 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM',
  });

  it('exercises client.portfolio (Module26) end-to-end', () => {
    expect(client.portfolio).toBeDefined();
    const summary = client.portfolio.aggregatePortfolio(
      [{ id: 's100', stream: dummyStream, timestamp: 1500 }],
      1500,
    );
    expect(summary.activeCount).toBe(1);
    expect(summary.totalWithdrawable).toBe(5000n);
  });

  it('exercises client.snapshots (Module36) end-to-end', () => {
    expect(client.snapshots).toBeDefined();
    const s1: StreamSnapshot = { stream: dummyStream, observedAt: 1200 };
    const s2: StreamSnapshot = { stream: { ...dummyStream, withdrawn: 500n }, observedAt: 1300 };
    const diff = client.snapshots.diffSnapshots(s1, s2);
    expect(diff.withdrawableDelta).toBe(500n);
  });

  it('exercises client.risk (Module44) end-to-end', () => {
    expect(client.risk).toBeDefined();
    const assessment = client.risk.assessSingleItem({
      id: 's100',
      stream: dummyStream,
      timestamp: 1500,
    });
    expect(assessment.riskLevel).toBeDefined();
    expect(typeof assessment.runwaySecs).toBe('number');
  });

  it('exercises client.batchAnalytics / client.module48 (Module48) end-to-end', () => {
    expect(client.batchAnalytics).toBeDefined();
    expect(client.module48).toBe(client.batchAnalytics);
    const results = client.batchAnalytics.processStreamBatch([
      { id: 's100', stream: dummyStream, timestamp: 1500 },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.withdrawable).toBe(5000n);
  });

  it('exercises client.batchEngine / client.module49 (Module49) end-to-end', () => {
    expect(client.batchEngine).toBeDefined();
    expect(client.module49).toBe(client.batchEngine);
    const results = client.batchEngine.processStreamBatch([
      { id: 's100', stream: dummyStream, timestamp: 1500 },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.withdrawable).toBe(5000n);
  });
});
