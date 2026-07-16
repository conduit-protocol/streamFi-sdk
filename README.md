# conduit-sdk

TypeScript client library for the Conduit streaming payments protocol. Integrate per-second token streams into any application on Stellar.

```bash
npm install @conduit-protocol/sdk
```

---

## Quickstart

```typescript
import { ConduitClient } from '@conduit-protocol/sdk';
import { Keypair } from '@stellar/stellar-sdk';

const client = new ConduitClient({
  network:  'testnet',
  keypair:  Keypair.fromSecret('S...'),
});

// Create a 30-day USDC stream
const { streamId } = await client.streams.create({
  recipient:       'GABC...XYZ',
  token:           'USDC',
  depositAmount:   '1000',              // 1 000 USDC
  durationSeconds: 30 * 24 * 3600,     // 30 days
});

console.log('Stream created:', streamId);
// Recipient earns ≈ 0.000386 USDC / second

// Check withdrawable balance
const available = await client.streams.withdrawable(streamId);
console.log('Available:', available, 'USDC');

// Withdraw
await client.streams.withdraw(streamId, available);
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
| `keypair` | `Keypair` | Yes (for writes) | Signing keypair |
| `rpcUrl` | `string` | No | Override default Soroban RPC URL |
| `factoryAddress` | `string` | No | Override deployed factory contract ID |
| `governorAddress` | `string` | No | Override deployed governor contract ID |

Default RPC URLs:

| Network | URL |
|---------|-----|
| `testnet` | `https://soroban-testnet.stellar.org` |
| `mainnet` | `https://soroban-mainnet.stellar.org` |
| `local` | `http://localhost:8000/soroban/rpc` |

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

#### `list(params)`

Query streams by sender or recipient.

```typescript
const streams = await client.streams.list({
  sender?:    string,
  recipient?: string,
  offset?:    number,  // default: 0
  limit?:     number,  // default: 20, max: 100
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
//   feeRecipient:         string,
//   minDurationSeconds:   number,
//   maxRatePerSecond:     bigint,
//   factoryAddress:       string,
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

**Caveat:** only `amount` is actually parsed today. `refundAmount`, `pausedAt`, `resumedAt`, `totalWithdrawn`, `remaining`, and `newBalance` are hardcoded `0`/`0n` placeholders in `src/events.ts` — the contracts emit these as tuples, and the event parser doesn't decode multi-value `ScVal`s yet. Treat an event as a "something happened, go refetch" signal, not a source of truth for those fields; use `client.streams.get(streamId)` to get the real numbers. See [`docs/api.md`](./docs/api.md) for detail.

---

## Browser / React Usage

The SDK works in the browser. For React apps, use the companion `@conduit-protocol/react` package (coming in v0.2) for hooks like `useStream`, `useWithdraw`, and `useStreamList`.

Until then, instantiate the client once and share it via React Context:

```typescript
// lib/conduit.ts
import { ConduitClient } from '@conduit-protocol/sdk';

export const conduit = new ConduitClient({
  network: process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet',
  // keypair injected per-action from wallet context
});
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
│   ├── streams.ts           # StreamsModule — all stream operations
│   ├── factory.ts           # FactoryModule — factory queries
│   ├── governor.ts          # GovernorModule — config reads
│   ├── soroban.ts           # Low-level Soroban RPC helpers
│   ├── errors.ts            # ConduitError + per-contract Stream/Factory/GovernorErrorCode
│   ├── utils.ts             # toStroops, fromStroops, etc.
│   ├── events.ts            # Event subscription logic
│   ├── contracts/
│   │   ├── stream-abi.ts    # DripStream XDR / spec
│   │   ├── factory-abi.ts   # DripFactory XDR / spec
│   │   └── governor-abi.ts  # DripGovernor XDR / spec
│   └── types/
│       └── index.ts         # All exported TypeScript types
├── examples/
│   ├── create-stream.ts     # End-to-end create example
│   ├── withdraw.ts          # Recipient withdraw example
│   └── list-streams.ts      # List all streams for an address
├── docs/
│   └── api.md               # Full API reference (generated)
├── tsconfig.json
├── rollup.config.ts
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

## License

MIT — see [`LICENSE`](./LICENSE).
