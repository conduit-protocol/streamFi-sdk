import resolve    from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import terser     from '@rollup/plugin-terser';
import { visualizer } from 'rollup-plugin-visualizer';

/**
 * Packages that consumers must install themselves — never bundle these.
 * @stellar/stellar-sdk is ~400KB+ and would blow up the bundle.
 * tslib is a runtime helper that consumers may already have.
 */
const external = [
  '@stellar/stellar-sdk',
  'tslib',
];

const shared = {
  input: {
    index: 'src/index.ts',
    utils: 'src/utils.ts',
  },
  external,
  plugins: [
    resolve({ preferBuiltins: true }),
  ],
};

/** Whether the CI or a contributor explicitly set VISUALIZE=1 */
const isVisualize = process.env.VISUALIZE === '1';

/**
 * Shared terser config — identical across ESM and CJS builds.
 * Kept as a single definition to stay DRY.
 */
const terserConfig = {
  compress: {
    defaults: true,
    // Keep console.warn/error for library consumers; strip info/debug
    // which are typically used only during development.
    drop_console: false,
    pure_funcs: ['console.info', 'console.debug'],
  },
  mangle: {
    // Preserve key class names so stack traces remain readable for
    // consumers.
    reserved: ['ConduitClient', 'StreamBuilder', 'ConduitBatcher'],
  },
  output: {
    comments: false,
  },
};

const sharedOutput = {
  sourcemap:      true,
  chunkFileNames: 'chunks/[name]-[hash].js',
  /**
   * Manual chunk assignment groups all SDK internal modules into one
   * stable chunk. This prevents Rollup from creating a monolithic
   * shared chunk when multiple entry points import overlapping modules,
   * and ensures hash stability across unrelated edits.
   *
   * NOTE: when new source files are added to `src/`, add them here too
   * so they end up in the stable chunk rather than auto-generated chunks.
   */
  manualChunks: {
    'sdk-internal': [
      'src/soroban.ts',
      'src/streams.ts',
      'src/builder.ts',
      'src/batch-tx.ts',
      'src/client.ts',
      'src/events.ts',
      'src/factory.ts',
      'src/governor.ts',
      'src/signer.ts',
      'src/errors.ts',
      'src/constants.ts',
      'src/indexer.ts',
      'src/fee-estimator.ts',
      'src/relayer/WebSocketRelayer.ts',
      'src/relayer/ErrorMapper.ts',
      'src/adapters/index.ts',
      'src/adapters/keypair.ts',
      'src/adapters/types.ts',
      'src/adapters/walletconnect.ts',
      'src/dashboard/transaction-history.ts',
    ],
  },
};

const typescriptPlugin = typescript({ tsconfig: './tsconfig.rollup.json' });

const config = [
  // ESM build
  {
    ...shared,
    output: {
      dir:            'dist/esm',
      format:         'esm',
      entryFileNames: '[name].js',
      ...sharedOutput,
    },
    plugins: [
      ...shared.plugins,
      typescriptPlugin,
      terser(terserConfig),
      ...(isVisualize
        ? [visualizer({
            filename: 'dist/stats-esm.html',
            title: '@conduit-protocol/sdk — ESM bundle',
            gzipSize: true,
            brotliSize: true,
          })]
        : []),
    ],
  },
  // CJS build
  {
    ...shared,
    output: {
      dir:            'dist/cjs',
      format:         'cjs',
      entryFileNames: '[name].js',
      exports:        'named',
      ...sharedOutput,
    },
    plugins: [
      ...shared.plugins,
      typescriptPlugin,
      terser(terserConfig),
      ...(isVisualize
        ? [visualizer({
            filename: 'dist/stats-cjs.html',
            title: '@conduit-protocol/sdk — CJS bundle',
            gzipSize: true,
            brotliSize: true,
          })]
        : []),
    ],
  },
];

export default config;
