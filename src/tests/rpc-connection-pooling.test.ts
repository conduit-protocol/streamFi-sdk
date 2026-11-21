import { describe, it, expect } from 'vitest';
import { SorobanRpc } from '@stellar/stellar-sdk';
import { ConduitClient } from '../client.js';

const FACTORY_ADDRESS = 'CCWAMYJME27OHTPKVSV252YRPXEO4BSKBHVLQ7ML3OWYNMB5RQEVHSM';

describe('RPC connection pooling (#952)', () => {
  it('configures the shared Soroban RPC axios instance with keep-alive HTTP(S) agents', () => {
    new ConduitClient({ network: 'testnet', factoryAddress: FACTORY_ADDRESS });

    const { httpAgent, httpsAgent } = SorobanRpc.AxiosClient.defaults;
    expect(httpAgent).toBeDefined();
    expect(httpAgent.keepAlive).toBe(true);
    expect(httpAgent.maxSockets).toBe(50);

    expect(httpsAgent).toBeDefined();
    expect(httpsAgent.keepAlive).toBe(true);
    expect(httpsAgent.maxSockets).toBe(50);
  });

  it('reuses the same agent instances across multiple clients instead of creating a new one per client', () => {
    new ConduitClient({ network: 'testnet', factoryAddress: FACTORY_ADDRESS });
    const { httpAgent: firstHttp, httpsAgent: firstHttps } = SorobanRpc.AxiosClient.defaults;

    new ConduitClient({ network: 'mainnet', factoryAddress: FACTORY_ADDRESS });
    const { httpAgent: secondHttp, httpsAgent: secondHttps } = SorobanRpc.AxiosClient.defaults;

    expect(secondHttp).toBe(firstHttp);
    expect(secondHttps).toBe(firstHttps);
  });
});
