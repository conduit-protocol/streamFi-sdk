# conduit-sdk

TypeScript client library for the Conduit streaming payments protocol. Integrate per-second token streams into any application on Stellar.

## Create a StreamFi app

Use the included CLI package to start a Next.js project configured for Stellar testnet:

```bash
npx create-streamfi-app my-streamfi-app
```

It clones a Next.js starter, installs `@conduit-protocol/sdk`, and writes testnet RPC settings to `.env.local`. See [create-streamfi-app/README.md](create-streamfi-app/README.md) for options.

```bash
npm install @conduit-protocol/sdk
```

---

## Quickstart

A complete, copy-pasteable create -> withdraw script on **testnet**. A runnable
version lives at [`examples/quickstart.ts`](examples/quickstart.ts).

```typescript
import { ConduitClient, fromStroops } from '@conduit-protocol/sdk';
import { Keypair } from '@stellar/stellar-sdk';

// Generate a testnet key and fund it once:
//   const kp = Keypair.random();
//   await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
const keypair = Keypair.fromSecret(process.env.STELLAR_SECRET!);

const client = new ConduitClient({
  network:        'testnet',
  keypair,
  factoryAddress: process.env.FACTORY_ADDRESS!,   // testnet DripFactory contract id
});

async function main() {
  // Stream 100 XLM to the recipient over one hour (the 1-hour minimum).
  const { streamId, txHash } = await client.streams.create({
    recipient:       keypair.publicKey(),   // self, for a runnable demo
    token:           'native',              // XLM
    depositAmount:   '100',
    durationSeconds: 60 * 60,
  });
  console.log('stream', streamId, 'created  (tx', txHash + ')');

  // Let value accrue, then withdraw the full available balance as the recipient.
  await new Promise((r) => setTimeout(r, 15_000));
  const available = await client.streams.withdrawable(streamId);
  console.log('withdrawable:', fromStroops(available), 'XLM');

  const withdrawTx = await client.streams.withdraw(streamId, available);
  console.log('withdrawn  (tx', withdrawTx + ')');
}

main().catch(console.error);
```

---

## Installation

```bash
# npm
npm install @conduit-protocol/sdk

# yarn
yarn add @conduit-protocol/sdk

# pnpm
pnpm add @conduit-protocol/sdk
```

**Peer dependencies:**

```bash
npm install @stellar/stellar-sdk
```

---

## Configuration

### `ConduitClient`

```typescript
import { ConduitClient, type ConduitConfig } from '@conduit-protocol/sdk';

const client = new ConduitClient(config: ConduitConfig);
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `network` | `'mainnet' \| 'testnet' \| 'local'` | Yes | Network to connect to |
| `keypair` | `Keypair` | Optional | Signing keypair (for secret key workflows) |
| `wallet` | `WalletAdapter` | Optional | Custom wallet adapter (e.g. `WalletConnectAdapter`) |
| `rpcUrl` | `string` | No | Override default Soroban RPC URL |
| `factoryAddress` | `string` | No | Override deployed factory contract ID |
| `governorAddress` | `string` | No | Override deployed governor contract ID |
| `fee` | `string` | No | Explicit inclusion fee in stroops (overrides feeMultiplier) |
| `feeMultiplier` | `number` | No | Multiplier applied to BASE_FEE when fee is not set |

### Fee Precedence

When both `fee` and `feeMultiplier` are present, `fee` wins. The precedence is:

1. **`fee`** — explicit inclusion fee in stroops (e.g. `"5000"`)
2. **`feeMultiplier`** — multiplied by `BASE_FEE` when `fee` is absent
3. **`BASE_FEE`** — hardcoded fallback when neither is set

Use `resolveFee(config)` to compute the effective fee for a given `ConduitConfig`.

### WalletConnect v2 Integration (Mobile & Browser Wallets)

For web and mobile applications using WalletConnect v2:

```typescript
import { ConduitClient, WalletConnectAdapter } from '@conduit-protocol/sdk';

const walletAdapter = new WalletConnectAdapter({
  projectId: 'YOUR_WALLETCONNECT_PROJECT_ID',
  chainId: 'stellar:testnet',
});

// Connect to mobile wallet
await walletAdapter.connect();

const client = new ConduitClient({
  network: 'testnet',
  wallet: walletAdapter,
});
```

You can also update the active wallet dynamically:

```typescript
client.setWallet(walletAdapter);
```

---

## Fluent Builder API

The SDK provides a Fluent Builder API (`StreamBuilder` and `ConduitBatcher`) to construct and batch stream operations. This is useful for building complex transaction configurations or compiling multiple stream deployments into a single batch transaction.

### Creating a Stream

```typescript
import { StreamBuilder } from '@conduit-protocol/sdk';

const stream = new StreamBuilder()
  .token('USDC')
  .sender('GABC...SENDER')
  .recipient('GXYZ...RECIPIENT')
  .amount(1000)
  .build();

console.log(stream);
// Output:
// {
//   token: 'USDC',
//   sender: 'GABC...SENDER',
//   recipient: 'GXYZ...RECIPIENT',
//   amount: 1000
// }
```

### Chaining Methods

The `StreamBuilder` class exposes the following chainable methods:

| Method | Argument Type | Description |
|--------|---------------|-------------|
| `token(address)` | `string` | Sets the Soroban token contract address. |
| `sender(address)` | `string` | Sets the sender address who funds the stream. |
| `recipient(address)` | `string` | Sets the recipient address receiving the stream. |
| `amount(val)` | `number` | Sets the deposit amount (in the token's smallest unit). |
| `ratePerSecond(val)` | `number \| bigint` | Sets the stream rate in stroops/sec. Required to build real `create_stream` args — the contract has no way to derive a rate on its own. |
| `startTime(val)` | `number` | Optional Unix timestamp; defaults to now. |
| `endTime(val)` | `number` | Optional Unix timestamp; defaults to `0` (open-ended). |
| `clawbackEnabled(val)` | `boolean` | Optional; defaults to `false`. |
| `build()` | — | Validates the fields and returns the stream configuration. Throws an error if any required field is missing. |
| `toBatchOperation()` | — | Returns a `BatchOperation` carrying the exact positional, ABI-typed args `create_stream` expects — pass it to `ConduitBatcher.executeAsync()`. |

### Batching Streams

You can bundle multiple stream operations together and compile them using `ConduitBatcher`. `execute()` turns each item into the ABI-exact positional `create_stream` args when the default method is used (amount/rate encoded as `i128`, `startTime`/`endTime` as `u64`), falling back to a generic sorted-map argument for other methods. To invoke the real `create_stream` contract with full control (including validated, defaulted `start_time`/`end_time`/`clawback_enabled`), build each stream's `BatchOperation` with `toBatchOperation()` and submit through `executeAsync()`:

```typescript
import { StreamBuilder, ConduitBatcher } from '@conduit-protocol/sdk';

const stream1 = new StreamBuilder()
  .token('USDC')
  .sender('GABC...SENDER')
  .recipient('GXYZ...RECIPIENT_A')
  .amount(500)
  .ratePerSecond(10n);

const stream2 = new StreamBuilder()
  .token('native')
  .sender('GABC...SENDER')
  .recipient('GXYZ...RECIPIENT_B')
  .amount(1500)
  .ratePerSecond(25n);

// Execute batch operation
const batcher = new ConduitBatcher();
const result = await batcher.executeAsync(
  [stream1.toBatchOperation(), stream2.toBatchOperation()],
  { context: { network: 'testnet', contractId: 'C...', sourceAccount: 'GABC...SENDER', sequence: '123' } },
);

console.log('Batch Success:', result.success);
console.log('Operations:', result.operations);
console.log('Transaction XDR:', result.xdr);
```

---

## API Reference

### `client.streams`

#### `create(params)`

Deploy a new `DripStream` contract via the factory.

```typescript
const result = await client.streams.create({
  recipient:       string,   // Stellar address
  token:           string,   // 'native' | 'USDC' | contract address
  depositAmount:   string,   // in display units ('100.5')
  durationSeconds: number,   // total stream duration in seconds
  startTime?:      number,   // Unix timestamp; defaults to now
  clawbackEnabled?: boolean, // default: false
  ratePerSecond?:  string,   // override calculated rate (in stroops)
});

// Returns:
// {
//   streamId:      bigint,
//   streamAddress: string,
//   txHash:        string,
// }
```

**Validation** (mirrors contract):

- `depositAmount > 0`
- `durationSeconds >= 3600` (1 hour minimum)
- `startTime >= now`
- Either `ratePerSecond` or `durationSeconds` must be provided (not both)

---

#### `get(streamId)`

Fetch stream state.

```typescript
const stream = await client.streams.get(streamId: bigint | string);

// Returns: StreamInfo
// {
//   id:               bigint,
//   address:          string,
//   sender:           string,
//   recipient:        string,
//   token:            string,
//   ratePerSecond:    bigint,   // stroops
//   startTime:        number,   // unix timestamp
//   endTime:          number,   // 0 = open-ended
//   withdrawn:        bigint,   // stroops
//   paused:           boolean,
//   pausedAt:         number,
//   cancelled:        boolean,
//   clawbackEnabled:  boolean,
// }
```

---

#### `withdrawable(streamId)`

Get the current withdrawable balance. Read-only, no transaction.

```typescript
const amount = await client.streams.withdrawable(streamId: bigint | string);
// Returns: bigint (in stroops)
```

---

#### `streamedTotal(streamId)`

Get the cumulative amount streamed since the stream started, regardless of withdrawals. Read-only, no transaction.

```typescript
const total = await client.streams.streamedTotal(streamId: bigint | string);
// Returns: bigint (cumulative stroops streamed since start)
```

Unlike `withdrawable()` (which reflects only the unwithdrawn portion), this value does not reset after a withdrawal — useful for progress displays that should keep counting up.

---

#### `withdraw(streamId, amount?)`

Withdraw tokens as the recipient.

```typescript
const txHash = await client.streams.withdraw(
  streamId: bigint | string,
  amount?:  bigint,          // defaults to full withdrawable balance
);
// Returns: string (transaction hash)
```

Throws `ConduitError.NothingToWithdraw` if balance is zero.

---

#### `cancel(streamId)`

Cancel the stream as the sender. Refunds unstreamed tokens.

```typescript
const txHash = await client.streams.cancel(streamId: bigint | string);
// Returns: string (transaction hash)
```

---

#### `pause(streamId)`

Pause the stream clock as the sender.

```typescript
const txHash = await client.streams.pause(streamId: bigint | string);
```

---

#### `resume(streamId)`

Resume a paused stream as the sender.

```typescript
const txHash = await client.streams.resume(streamId: bigint | string);
```

---

#### `topUp(streamId, amount)`

Add more tokens to the stream balance as the sender.

```typescript
const txHash = await client.streams.topUp(
  streamId: bigint | string,
  amount:   bigint,          // in stroops
);
```

---

#### `clawback(streamId)`

Reclaim unstreamed tokens (only if `clawbackEnabled` was true at creation).

```typescript
const txHash = await client.streams.clawback(streamId: bigint | string);
```

---

#### `forceCancel(streamId)`

Force-cancel a paused stream as the recipient after the 30-day pause threshold has elapsed.
Settles atomically like `cancel()`; prevents a sender from indefinitely pausing a stream to
hold unstreamed tokens hostage.

```typescript
const txHash = await client.streams.forceCancel(streamId: bigint | string);
```

---

#### `transferRecipient(streamId, newRecipient)`

Transfer the recipient role to a new address (current recipient only). The new recipient
inherits all rights, including the withdrawable balance accrued so far.

```typescript
const txHash = await client.streams.transferRecipient(
  streamId:     bigint | string,
  newRecipient: string,
);
```

---

#### `list(params)`

Query streams by sender and/or recipient. When **both** `sender` and `recipient` are given,
the result is the de-duplicated **union** of the two filters (streams where the address is
either sender or recipient).

```typescript
const streams = await client.streams.list({
  sender?:    string,
  recipient?: string,
  offset?:    number,  // default: 0
  limit?:     number,  // default: 20, max: 100 (out-of-range values are clamped, not rejected)
});
// Returns: StreamInfo[]
```

---

### `client.factory`

Direct access to factory-level queries:

```typescript
// Total streams created
const count = await client.factory.streamCount();

// Stream address by ID
const address = await client.factory.streamAddress(streamId);

// Protocol fee in basis points (e.g. 30 = 0.3%)
const feeBps = await client.factory.protocolFeeBps();
```

---

### `client.governor`

Read protocol configuration:

```typescript
const config = await client.governor.config();
// Returns:
// {
//   feeBps:               number,
//   feeRecipient?:        string,
//   minDurationSeconds:   number,
//   maxRatePerSecond:     bigint,
//   factoryAddress?:      string,
// }
```

---

## Error Handling

All methods throw `ConduitError` on failure. **Each of the three contracts defines its own
error-code space** — the same number means something different on `DripStream` vs `DripFactory`
vs `DripGovernor` — so `ConduitError` always carries a `contract` field alongside `code`. Check
both, not just `code`:

```typescript
import { ConduitError, StreamErrorCode, FactoryErrorCode } from '@conduit-protocol/sdk';

try {
  await client.streams.withdraw(streamId);
} catch (err) {
  if (err instanceof ConduitError && err.contract === 'stream') {
    switch (err.code) {
      case StreamErrorCode.NothingToWithdraw:
        console.log('No balance yet');
        break;
      case StreamErrorCode.NotAuthorized:
        console.log('Wrong keypair');
        break;
      case StreamErrorCode.StreamCancelled:
        console.log('Stream was cancelled');
        break;
      default:
        console.error('Unexpected error:', err.message);
    }
  } else if (err instanceof ConduitError) {
    console.error(`Unexpected ${err.contract} error:`, err.message);
  }
}

try {
  await client.streams.create({ /* ... */ });
} catch (err) {
  if (err instanceof ConduitError && err.contract === 'factory') {
    if (err.code === FactoryErrorCode.RateExceedsMax) {
      console.log('Rate exceeds the governor-configured maximum');
    }
  }
}
```

**`StreamErrorCode`**

| Code | Constant | Description |
|------|----------|-------------|
| 1 | `NotAuthorized` | Caller is not sender or recipient |
| 2 | `StreamNotFound` | Invalid stream ID |
| 3 | `StreamCancelled` | Stream has been cancelled |
| 4 | `StreamNotStarted` | Stream has not started yet |
| 5 | `StreamEnded` | Stream past its end time |
| 6 | `NothingToWithdraw` | Zero withdrawable balance |
| 7 | `InsufficientDeposit` | Deposit too small |
| 8 | `InvalidTimeRange` | end_time ≤ start_time |
| 9 | `AlreadyPaused` | Stream is already paused |
| 10 | `NotPaused` | Stream is not paused |
| 11 | `ClawbackDisabled` | Clawback not enabled |
| 12 | `ArithmeticOverflow` | Integer overflow |
| 13 | `PauseThresholdNotMet` | `force_cancel` called before the 30-day pause threshold elapsed |
| 14 | `AlreadyInitialized` | Stream has already been initialized |
| 15 | `InvalidAmount` | `withdraw`/`top_up` amount must be greater than zero |

**`FactoryErrorCode`**

| Code | Constant | Description |
|------|----------|-------------|
| 1 | `NotInitialized` | Factory hasn't been initialized |
| 2 | `InvalidDeposit` | deposit ≤ 0 |
| 3 | `InvalidRate` | rate_per_sec ≤ 0 |
| 4 | `InvalidTimeRange` | end_time ≤ start_time |
| 5 | `InsufficientDeposit` | Deposit too small for the rate/duration |
| 6 | `BackdatedStream` | start_time is in the past |
| 7 | `AlreadyInitialized` | Factory has already been initialized |
| 8 | `RateExceedsMax` | rate_per_sec exceeds the governor's max_rate_per_second |
| 9 | `DurationTooShort` | Duration is below the governor's min_duration_seconds |
| 10 | `ArithmeticOverflow` | Integer overflow validating deposit against duration |

**`GovernorErrorCode`**

| Code | Constant | Description |
|------|----------|-------------|
| 1 | `NotAuthorized` | Caller is not the current authority |
| 2 | `InvalidParam` | Setter argument failed validation |
| 3 | `AlreadyInitialized` | Governor has already been initialized |

---

## Utilities

```typescript
import { 
  toStroops,
  fromStroops,
  calculateRate,
  streamProgress,
} from '@conduit-protocol/sdk/utils';

// Convert display amount to stroops
toStroops('100.5')             // → 1005000000n

// Convert stroops to display amount  
fromStroops(1005000000n)       // → '100.5'

// Calculate rate per second from deposit + duration
calculateRate('1000', 2592000) // → 38580n  (stroops/sec)

// Current progress (0–1) of a stream
streamProgress(stream)         // → 0.42
```

### `AbortSignal` & timeouts

Methods that do network I/O (`GraphQLIndexer.query`, batch/builder submission,
...) accept an optional `signal: AbortSignal`. To bound one by time, pass
`AbortSignal.timeout(ms)` — but note it needs **Node >= 17.3**, Deno >= 1.20,
Chrome >= 103, Firefox >= 100, or Safari >= 15.4.

For older runtimes use the SDK's `timeoutSignal(ms)` helper (native when
available, `AbortController` + `setTimeout` otherwise):

```typescript
import { timeoutSignal } from '@conduit-protocol/sdk';

const data = await indexer.query({ query: GET_STREAMS, signal: timeoutSignal(5_000) });
```

Or hand-roll the polyfill:

```typescript
function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
```

---

## Types

```typescript
// Full type definitions in src/types/index.ts

export type Network = 'mainnet' | 'testnet' | 'local';

export interface ConduitConfig {
  network:          Network;
  keypair?:         Keypair;
  rpcUrl?:          string;
  factoryAddress?:  string;
  governorAddress?: string;
}

export interface StreamInfo {
  id:              bigint;
  address:         string;
  sender:          string;
  recipient:       string;
  token:           string;
  ratePerSecond:   bigint;
  startTime:       number;
  endTime:         number;
  withdrawn:       bigint;
  paused:          boolean;
  pausedAt:        number;
  cancelled:       boolean;
  clawbackEnabled: boolean;
}

export interface CreateStreamParams {
  recipient:        string;
  token:            string;
  depositAmount:    string;
  durationSeconds?: number;
  startTime?:       number;
  clawbackEnabled?: boolean;
  ratePerSecond?:   string;
}

export interface CreateStreamResult {
  streamId:      bigint;
  streamAddress: string;
  txHash:        string;
}
```

---

## Events

Subscribe to on-chain events:

```typescript
const sub = client.streams.subscribe(streamId, {
  onWithdraw: (event) => {
    console.log('Withdrawn:', event.amount, 'by', event.recipient);
  },
  onCancel:   (event) => console.log('Cancelled; refund:', event.refundAmount),
  onPause:    (event) => console.log('Paused at:', event.pausedAt),
  onResume:   (event) => console.log('Resumed at:', event.resumedAt),
  onTopUp:    (event) => console.log('Topped up:', event.amount),
});

// Unsubscribe
sub.unsubscribe();
```

Event subscriptions poll the Soroban event ledger every 5 seconds by default. Pass `{ pollInterval: 2000 }` to change the interval.

`src/events.ts` fully decodes each event's payload — multi-field events are parsed from their tuple `ScVal`s (`onWithdraw` → `amount`/`totalWithdrawn`/`remaining`, `onCancel` → `refundAmount`/`withdrawnSoFar`, `onPause` → `pausedAt`/`withdrawable`, `onTopUp` → `amount`/`newBalance`) and single-field events from their bare scalar (`onResume` → `resumedAt`, `onClawback` → `amount`). All fields are decoded; previously claimed "placeholders" are now properly parsed. See [`docs/api.md`](./docs/api.md) for detail.

---

## Browser / React Usage

The SDK works in the browser. For React apps, use the companion [`@streamfi/react`](./packages/react) package
for a `StreamFiProvider` plus hooks (`useStream`, `useCreateStream`, `useStreamFiClient`):

```typescript
import { StreamFiProvider, useStream, useCreateStream } from '@streamfi/react';

function App() {
  return (
    <StreamFiProvider config={{ network: 'testnet' /* keypair injected per-action from wallet context */ }}>
      <StreamPage streamId={42n} />
    </StreamFiProvider>
  );
}

function StreamPage({ streamId }: { streamId: bigint }) {
  const { stream, loading, error } = useStream(streamId);
  const { createStream, loading: creating } = useCreateStream();
  // ...
}
```

### Next.js Example

A working Next.js (App Router) example is available at [`examples/nextjs-app/`](./examples/nextjs-app/). It demonstrates:

- Fetching and displaying active streams for a given Stellar address
- Creating a new stream via a modal form
- Withdrawing from a stream

```bash
# From the repo root
npm install && npm run build
cd examples/nextjs-app
cp .env.example .env.local  # then edit .env.local
npm run dev
```

---

## Development

```bash
git clone https://github.com/conduit-protocol/conduit-sdk
cd conduit-sdk
npm install

# Build (tsc + rollup)
npm run build

# Watch mode
npm run dev

# Tests (Vitest)
npm test

# Type check
npm run typecheck

# Lint
npm run lint
```

---

## Directory Structure

```
conduit-sdk/
├── src/
│   ├── client.ts            # ConduitClient — main entry point
│   ├── builder.ts           # Fluent builder and batcher for streams
│   ├── streams.ts           # StreamsModule — all stream operations
│   ├── factory.ts           # FactoryModule — factory queries
│   ├── governor.ts          # GovernorModule — config reads
│   ├── soroban.ts           # Low-level Soroban RPC helpers
│   ├── errors.ts            # ConduitError + per-contract Stream/Factory/GovernorErrorCode
│   ├── utils.ts             # toStroops, fromStroops, etc.
│   ├── events.ts            # Event subscription logic
│   └── types/
│       └── index.ts         # All exported TypeScript types
├── examples/
│   ├── create-stream.ts     # End-to-end create example
│   ├── fluent-builder.ts    # Fluent Builder and batcher example
│   ├── withdraw.ts          # Recipient withdraw example
│   ├── list-streams.ts      # List all streams for an address
│   ├── dashboard/           # React + Vite + GraphQL dashboard
│   └── nextjs-app/          # Next.js (App Router) example
├── packages/
│   └── react/               # @streamfi/react — React hooks (see Browser / React Usage)
├── create-streamfi-app/     # `npx create-streamfi-app` scaffolding CLI
├── docs/
│   └── api.md               # Full API reference (generated)
├── tsconfig.json
├── rollup.config.mjs
├── vitest.config.ts
├── package.json
└── .github/
    └── workflows/
        └── ci.yml           # typecheck + test + build on PR
```

---

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). For the module map and call flow, see [`docs/architecture.md`](./docs/architecture.md).

---

## Environment Variables

The SDK can be configured via environment variables or explicit constructor options in `ConduitClient`. A template is provided in [`.env.example`](./.env.example).

* `STELLAR_SECRET`: Stellar secret key for signing transactions (keep secure; server-side only).
* `NEXT_PUBLIC_NETWORK` / `CONDUIT_NETWORK`: Stellar network selection (`testnet`, `mainnet`, or `local`).
* `SOROBAN_RPC_URL` / `RPC_URL`: Optional custom Soroban RPC endpoint override.
* `CONDUIT_FACTORY_ADDRESS`: Optional override for deployed DripFactory contract address.
* `CONDUIT_GOVERNOR_ADDRESS`: Optional override for deployed DripGovernor contract address.
* `CONDUIT_TOKEN_ADDRESS`: Optional default token contract address or `'native'`.
* `STREAM_ID` / `ADDRESS`: Parameters for example scripts and CLI integration.

---

## License

MIT — see [`LICENSE`](./LICENSE).
\n## ConduitConfig reference\n\n| Field | Type | Default | Effect |\n|---|---|---|---|\n| network | \`mainnet | testnet | local\` | (required) | Which Stellar network to connect to. |\n| keypair | \`Keypair\` | undefined | Signing keypair used for mutating operations. |\n| wallet | \`WalletAdapter\` | undefined | Browser/mobile wallet adapter (e.g. WalletConnect). |\n| signer | \`Signer\` | undefined | Custom signer plugin (KMS/HSM). Takes precedence over keypair. |\n| rpcUrl | \`string\` | Network default | Override the default Soroban RPC endpoint. |\n| factoryAddress | \`string\` | Network default | Override the deployed DripFactory contract ID. |\n| governorAddress | \`string\` | Network default | Override the deployed DripGovernor contract ID. |\n| confirmationPollIntervalMs | \`number\` | 1000 | Poll interval for transaction confirmation. |\n| confirmationMaxAttempts | \`number\` | 30 | Maximum confirmation polling attempts. |\n| fee | \`string\` | undefined | Explicit inclusion fee in stroops. Takes precedence over feeMultiplier. |\n| feeMultiplier | \`number\` | 1 | Multiplier applied to BASE_FEE when fee is not set. |\n\n