module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: "./tsconfig.json",
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ["dist", "examples", "node_modules"],
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    // @stellar/stellar-sdk v12 renamed SorobanRpc to rpc. Use rpc for all new code.
    "no-restricted-imports": [
      "warn",
      {
        paths: [
          {
            name: "@stellar/stellar-sdk",
            importNames: ["SorobanRpc"],
            message:
              "SorobanRpc is deprecated in @stellar/stellar-sdk v12. Import rpc instead.",
          },
        ],
      },
    ],
    // Flag Number() calls to prevent precision loss on stroop/amount values.
    // Stroops are u128 values; converting them to Number (float precision) is unsafe.
    // Pattern matches: Number(stroopAmount), Number(depositAmount), Number(batchItemAmount), etc.
    // false positives are acceptable here as the message directs developers to review.
    "no-restricted-syntax": [
      "warn",
      {
        selector: "CallExpression[callee.name='Number']",
        message:
          "Ensure you are not calling Number() on stroop or amount values. These are u128 values that must use BigInt or string arithmetic to avoid precision loss (e.g., Number(stroopAmount), Number(depositAmount)).",
      },
    ],
  },
  overrides: [
    {
      // Test files mock external SDKs/wallets/RPC providers, where `any` is
      // the idiomatic escape hatch — precise types would just be duplicating
      // the mocked library's surface for no safety benefit.
      files: ["src/tests/**/*.ts"],
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/ban-types": "off",
      },
    },
  ],
};
