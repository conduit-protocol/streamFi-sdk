# Contributing to conduit-sdk

Thank you for helping improve the Conduit TypeScript SDK. This guide covers environment setup, code conventions, testing, and the PR process.

---

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [Getting Started](#getting-started)
3. [Repository Layout](#repository-layout)
4. [Development Workflow](#development-workflow)
5. [Code Conventions](#code-conventions)
6. [Testing](#testing)
7. [Commit Convention](#commit-convention)
8. [Pull Request Process](#pull-request-process)
9. [Releasing](#releasing)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating you agree to uphold it. Report unacceptable behaviour to **conduct@conduit.sh**.

---

## Getting Started

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 20 |
| npm | ≥ 10 |

### Setup

```bash
git clone https://github.com/conduit-protocol/conduit-sdk
cd conduit-sdk
npm install

# Build (TypeScript → ESM/CJS bundles)
npm run build

# Run tests
npm test

# Type check only (no emit)
npm run typecheck

# Lint
npm run lint
```

### Environment for manual testing

To run the examples against testnet you need a funded Stellar keypair:

```bash
# Generate and fund a testnet keypair with Friendbot
stellar keys generate test-key --network testnet --fund

# Export the secret key
stellar keys show test-key
```

Then set environment variables:

```bash
export CONDUIT_NETWORK=testnet
export CONDUIT_SECRET_KEY=S...
export CONDUIT_FACTORY=C...   # from conduit-contracts deploy output
```

Run an example:

```bash
npx tsx examples/create-stream.ts
```

---

## Repository Layout

```
conduit-sdk/
├── src/
│   ├── client.ts            # ConduitClient — the public entry point
│   ├── streams.ts           # StreamsModule — all stream operations
│   ├── factory.ts           # FactoryModule — factory-level queries
│   ├── governor.ts          # GovernorModule — protocol config reads
│   ├── soroban.ts           # Low-level Soroban RPC helpers
│   ├── errors.ts            # ConduitError class + ErrorCode enum
│   ├── utils.ts             # Pure helpers: toStroops, fromStroops, etc.
│   ├── events.ts            # Event subscription / polling logic
│   ├── contracts/
│   │   ├── stream-abi.ts    # DripStream XDR / function spec
│   │   ├── factory-abi.ts   # DripFactory XDR / function spec
│   │   └── governor-abi.ts  # DripGovernor XDR / function spec
│   ├── tests/
│   │   ├── utils.test.ts    # Unit tests for pure helpers
│   │   ├── errors.test.ts   # ConduitError construction + fromContractError
│   │   ├── factory.test.ts  # FactoryModule with mocked RPC
│   │   └── streams.test.ts  # StreamsModule with mocked RPC
│   └── types/
│       └── index.ts         # All exported TypeScript types
├── examples/
│   ├── create-stream.ts
│   ├── withdraw.ts
│   └── list-streams.ts
├── docs/
│   └── api.md               # Full API reference
├── rollup.config.ts         # Bundle config (ESM + CJS + types)
├── tsconfig.json
├── tsconfig.build.json      # Stricter settings for production build
├── vitest.config.ts
└── package.json
```

---

## Development Workflow

```
main          ← always releasable
  └── feat/your-feature
```

1. **Fork** and clone your fork.
2. Create a branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
3. Make changes. Run `npm run build` frequently — TypeScript errors surface quickly.
4. Add tests. See [Testing](#testing).
5. Run the full suite:
   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm run build
   ```
6. Push and open a PR.

---

## Code Conventions

### TypeScript style

- **No `any`.** Use `unknown` and narrow explicitly, or use a concrete type.
- **No non-null assertions** (`!`) except in tests. Use optional chaining or an explicit null check.
- **Explicit return types** on all public methods.
- `async`/`await` throughout — no `.then()` chains in new code.
- Errors thrown to callers must be `ConduitError` instances (not raw `Error`). Wrap unexpected errors:
  ```typescript
  throw ConduitError.fromContractError(raw);
  ```

### BigInt handling

All on-chain token amounts are `bigint` (stroops). Never convert to `number` for arithmetic — `Number(bigint)` loses precision above 2^53.

```typescript
// ✓
const half = amount / 2n;

// ✗ — loses precision
const half = Number(amount) / 2;
```

### Soroban RPC calls

All RPC calls go through `src/soroban.ts`. Do not call `SorobanRpc` directly from module files. This keeps the mock boundary clean for tests.

Read-only operations must use **simulation only** — never submit a transaction for a read:

```typescript
// ✓  read-only: simulate and extract retval
const val = await this._simulateTx(tx);

// ✗  submitting a tx for a read wastes fees and sequence numbers
await this._sendAndPoll(server, tx);
```

### Module boundaries

- `streams.ts` orchestrates — it calls factory to resolve addresses, then calls stream contracts.
- `factory.ts` and `governor.ts` are thin wrappers — one function per contract call.
- `soroban.ts` is the only file that imports from `@stellar/stellar-sdk`. No other file should import stellar-sdk directly (this makes it easy to mock in tests).

### Exports

All public types and classes must be re-exported from `src/index.ts`. Internal helpers (e.g. `scValToI128`) are not exported.

---

## Testing

Tests use [Vitest](https://vitest.dev). All test files live in `src/tests/`.

### Unit tests

Unit tests cover pure functions and modules with mocked RPC. Mock `soroban.ts` at the module level:

```typescript
import { vi } from 'vitest';

vi.mock('../soroban.js', () => ({
  buildContractCallTx: vi.fn().mockResolvedValue(/* mock tx */),
  DEFAULT_RPC: { testnet: 'https://mock-rpc', mainnet: '', local: '' },
  NETWORK_PASSPHRASE: { testnet: 'Test SDF Network ; September 2015', mainnet: '', local: '' },
}));
```

Do not make real network calls in unit tests.

### Test coverage requirements

| Category | Requirement |
|----------|-------------|
| Pure utils (`utils.ts`) | Every exported function, including edge cases (zero, max values, fractional stroops) |
| Error handling | Every `ErrorCode` value; `fromContractError` with malformed input |
| Module methods | Happy path + each thrown `ConduitError` code |

### Running tests

```bash
# All tests
npm test

# Watch mode
npm run test:watch

# Single file
npx vitest run src/tests/streams.test.ts

# With coverage
npx vitest run --coverage
```

---

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>
```

**Types:** `feat`, `fix`, `test`, `refactor`, `docs`, `chore`, `perf`

**Scopes:** `streams`, `factory`, `governor`, `soroban`, `utils`, `errors`, `events`, `types`, `build`, `deps`, `docs`

**Examples:**

```
feat(streams): implement withdraw() with optional amount default

fix(utils): handle zero deposit in toStroops without division error

test(streams): add unit test for clawback simulation parsing

docs(api): document subscribe() pollInterval option

chore(deps): bump @stellar/stellar-sdk to 12.1.0

perf(factory): cache streamAddress resolution per session
```

---

## Pull Request Process

### Branch naming

```
feat/<issue-number>-short-slug      # new feature
fix/<issue-number>-short-slug       # bug fix
test/<issue-number>-short-slug      # tests only
docs/<issue-number>-short-slug      # docs only
refactor/<issue-number>-short-slug  # internal refactor
```

Examples: `fix/2-calculate-rate-zero-guard`, `feat/4-force-cancel-method`

### 5-commit convention

Every PR must be structured as **exactly 5 logical commits** (minimum). Commits must be in this order:

| # | Commit type | What it contains |
|---|---|---|
| 1 | `test(<scope>): add failing test for <issue>` | Unit tests that reproduce the bug or describe the new behaviour — expected to fail on `main` |
| 2 | `fix(<scope>)` or `feat(<scope>)`: minimal implementation | The smallest code change that makes commit 1's tests green |
| 3 | `test(<scope>): edge cases and error paths` | Tests for boundary values, each `ErrorCode` thrown, and related paths |
| 4 | `docs(<scope>): update api.md and inline JSDoc` | JSDoc on new/changed public methods, `docs/api.md` entry, `CHANGELOG.md` entry |
| 5 | `chore(<scope>): typecheck + lint pass` | Any TypeScript or ESLint fixes surfaced by the change; no functional changes |

**Rules:**
- Each commit must be independently `git cherry-pick`-able — no inter-commit dependencies except the explicit test→fix ordering.
- Commit messages must include a **body** explaining why. Subjects alone are not acceptable for code commits.
- Reference the issue in the fix/feat commit body: `Closes #2`.
- No squashing before review. Reviewers read the diff per-commit.

### Example commit sequence for fix/2-calculate-rate-zero-guard

```
test(utils): add failing test — calculateRate returns 0n for small deposit

fix(utils): throw ConduitError when rate calculation truncates to 0n

test(utils): add edge cases — negative duration, exactly-1 stroop result

docs(utils): add JSDoc warning about BigInt truncation in calculateRate

chore(utils): fix lint warning in utils.ts after calculateRate change
```

### Author checklist before opening a PR

- [ ] Branch name follows the naming convention above
- [ ] PR title: `fix(utils): guard calculateRate against 0n result (#2)`
- [ ] PR description has `Closes #<n>` or `Fixes #<n>`
- [ ] Exactly 5 commits (minimum), each with an explanatory body
- [ ] `npm run typecheck` — no errors
- [ ] `npm run lint` — no warnings
- [ ] `npm test` — all tests pass
- [ ] `npm run build` — build succeeds, no significant bundle size increase
- [ ] New public API documented in `docs/api.md`
- [ ] `CHANGELOG.md` entry under `[Unreleased]`

### Review requirements

- **Mandatory owner review:** Every PR requires approval from **@jaydbrown** before merging. No exceptions.
- PRs that change the public API (new exports, changed signatures, removed types) additionally require **1 further maintainer approval** (2 approvals total) plus a `CHANGELOG.md` entry.
- CI must be green (typecheck, lint, tests, build).

### Reviewer checklist

- [ ] Commit 1 is a test that fails on `main` before the fix
- [ ] Commit 2 fix is minimal — no bundled unrelated changes
- [ ] No `any` types introduced
- [ ] No non-null assertions (`!`) in production code (only in tests with a comment)
- [ ] All new `ErrorCode` values are tested
- [ ] `bigint` used for all on-chain amounts — no `Number()` conversion on large values
- [ ] Public API changes are documented in `docs/api.md` and `CHANGELOG.md`
- [ ] 5-commit structure is clean

### Breaking changes

If your change modifies a public function signature, removes an export, or changes a type in a backwards-incompatible way:

1. Mark the PR with the `breaking-change` label.
2. Add a `BREAKING CHANGE:` footer to the relevant commit message.
3. Increment the minor version in `package.json` (we are pre-1.0; breaking changes are minor bumps).

---

## Releasing

Releases are managed by maintainers. The process:

1. Update `CHANGELOG.md` — move `[Unreleased]` items to the new version section.
2. Bump `package.json` version.
3. Tag: `git tag v0.x.y`.
4. CI publishes to npm automatically on tag push.

Contributors do not need to manage releases.

---

## License

By contributing you agree that your contributions will be licensed under the [MIT License](./LICENSE).
