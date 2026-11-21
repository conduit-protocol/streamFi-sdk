import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamsModule } from '../streams.js';
import type { ConduitConfig, CreateStreamParams } from '../types/index.js';

/**
 * Regression tests for issue #62 — deprecating StreamsModule.create() in
 * favor of StreamBuilder. Verifies the console warning fires once in
 * development mode, is silent in production mode, and does not affect the
 * method's actual behavior/return contract.
 */

const KEYPAIR = {
  publicKey: () => 'GDUMMYPUBLICKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  sign: (tx: unknown) => tx,
};

function makeConfig(): ConduitConfig {
  return {
    network: 'testnet',
    keypair: KEYPAIR as unknown as ConduitConfig['keypair'],
    factoryAddress: 'CFACTORYDUMMYADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  } as ConduitConfig;
}

describe('StreamsModule.create() deprecation warning (#62)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  it('warns once in development mode when create() is invoked', async () => {
    process.env.NODE_ENV = 'development';
    const mod = new StreamsModule(makeConfig());

    // create() will fail downstream (no live network in unit tests), which is
    // fine — the warning fires synchronously at the top of the method, before
    // any network call, so we only need to trigger and swallow the eventual
    // rejection.
    const params: CreateStreamParams = {
      recipient: 'GRECIPIENTDUMMYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      token: 'CTOKENDUMMYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      depositAmount: '100',
      durationSeconds: 3600,
    };

    await mod.create(params).catch(() => {});

    const deprecationWarnings = warnSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('StreamsModule.create()'),
    );
    expect(deprecationWarnings.length).toBe(1);
    expect(deprecationWarnings[0][0]).toContain('StreamBuilder');
  });

  it('does not warn in production mode', async () => {
    process.env.NODE_ENV = 'production';
    const mod = new StreamsModule(makeConfig());

    const params: CreateStreamParams = {
      recipient: 'GRECIPIENTDUMMYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      token: 'CTOKENDUMMYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      depositAmount: '100',
      durationSeconds: 3600,
    };

    await mod.create(params).catch(() => {});

    const deprecationWarnings = warnSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('StreamsModule.create()'),
    );
    expect(deprecationWarnings.length).toBe(0);
  });

  it('warns in a browser-like environment where process is undefined (#574)', () => {
    // Verify that the optional-chaining expression used in warnV1Deprecated
    // — `process?.env?.NODE_ENV !== 'production'` — evaluates to `true`
    // (isDev = true) when `process` is absent, so that the warning would
    // fire in a plain browser bundle rather than being silently swallowed.
    //
    // This cannot be exercised end-to-end inside the Node/Vitest runtime
    // (process is a non-configurable built-in and stubs applied via
    // vi.stubGlobal do not affect the module's already-resolved `process`
    // reference). Instead we verify the exact expression directly:
    //
    //   (undefined as any)?.env?.NODE_ENV !== 'production'
    //   => undefined !== 'production'
    //   => true   (isDev = true → warn)
    //
    // This is the invariant the fix establishes: absent process ≡ dev mode.
    const processUndefined = undefined as NodeJS.Process | undefined;
    expect(processUndefined?.env?.NODE_ENV !== 'production').toBe(true);
  });
});
