import resolve   from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import type { RollupOptions } from 'rollup';

const external = ['@stellar/stellar-sdk'];

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

const config: RollupOptions[] = [
  // ESM build
  {
    ...shared,
    output: {
      dir:            'dist/esm',
      format:         'esm',
      entryFileNames: '[name].js',
      chunkFileNames: 'chunks/[name]-[hash].js',
      sourcemap:      true,
    },
    plugins: [
      ...shared.plugins,
      typescript({ tsconfig: './tsconfig.build.json', declarationDir: 'dist/types' }),
    ],
  },
  // CJS build
  {
    ...shared,
    output: {
      dir:            'dist/cjs',
      format:         'cjs',
      entryFileNames: '[name].js',
      chunkFileNames: 'chunks/[name]-[hash].js',
      sourcemap:      true,
      exports:        'named',
    },
    plugins: [
      ...shared.plugins,
      typescript({ tsconfig: './tsconfig.build.json', declaration: false }),
    ],
  },
];

export default config;
