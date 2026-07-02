import resolve    from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

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

const config = [
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
      typescript({ tsconfig: './tsconfig.rollup.json' }),
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
      typescript({ tsconfig: './tsconfig.rollup.json' }),
    ],
  },
];

export default config;
