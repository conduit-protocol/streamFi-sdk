# conduit-sdk API Reference

Full method signatures, parameters, return types, and error conditions.

---

## `ConduitClient`

```typescript
new ConduitClient(config: ConduitConfig)
```

### `ConduitConfig`

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `network` | `'mainnet' \| 'testnet' \| 'local'` | ✓ | — |
| `keypair` | `Keypair` | For writes | — |
| `rpcUrl` | `string` | | Network default |
| `factoryAddress` | `string` | | Deployed factory |
| `governorAddress` | `string` | | Deployed governor |
| `wallet` | `WalletAdapter` | | — |
| `fee` | `string` | | Explicit inclusion (bid) fee in stroops for submitted transactions. Takes precedence over `feeMultiplier`. Defaults to `BASE_FEE` (100 stroops) |
| `feeMultiplier` | `number` | | Multiplier applied to `BASE_FEE` to compute the inclusion fee, e.g. `10` bids 10x the network minimum. Ignored when `fee` is set |

> **Inclusion fee.** Every submitted transaction previously used `BASE_FEE`
> (the network minimum, 100 stroops) unconditionally, with no way to raise
> it. Under inclusion-fee pressure (surge pricing, congested ledgers) a
> 100-stroop bid is not selected, and the SDK's confirmation polling
> eventually throws a misleading `Transaction timed out` instead of
> surfacing "fee too low". Set `fee` (an exact stroops amount) or
> `feeMultiplier` (a multiple of `BASE_FEE`) on `ConduitConfig` to bid
> higher; `fee` wins if both are set.

### Convenience methods

* `pauseStream(streamId: string) → Promise<string>` — equivalent to `client.streams.pause(streamId)`.
* `unpauseStream(streamId: string) → Promise<string>` — equivalent to `client.streams.resume(streamId)`.
* `setWallet(wallet: WalletAdapter): void` — dynamically attach or change the active wallet adapter. Throws `UnsupportedChainError` if the wallet's `chainId` is on a different network than the client was configured for. See [Wallet Adapters](#wallet-adapters) below. Only propagates to `client.streams` — `client.factory` and `client.governor` are read-only and use `config.keypair` for simulation fee sourcing, so they are unaffected.

---

## `client.streams`

### `create(params) → Promise<CreateStreamResult>`

| Param | Type | Notes |
|-------|------|-------|
| `recipient` | `string` | Stellar G-address |
| `token` | `string` | `'native'`, `'USDC'`, or contract address |
| `depositAmount` | `string` | Display units, e.g. `'1000'` |
| `durationSeconds` | `number?` | Exclusive with `ratePerSecond` |
| `startTime` | `number?` | Unix timestamp; defaults to now |
| `clawbackEnabled` | `boolean?` | Default `false` |
| `ratePerSecond` | `string?` | Stroops/s; exclusive with `durationSeconds` |

**Throws:** `ConduitError` with `contract: 'factory'` — `FactoryErrorCode.InvalidDeposit`, `.InsufficientDeposit`, `.BackdatedStream`, `.InvalidTimeRange`, `.RateExceedsMax`, `.DurationTooShort`

---

### `get(streamId) → Promise<StreamInfo>`

Fetches the complete stream state from the chain.

---

### `withdrawable(streamId) → Promise<bigint>`

Current withdrawable balance in stroops. Read-only, no transaction.

---

### `streamedTotal(streamId) → Promise<bigint>`

Cumulative amount streamed since the stream started, in stroops — regardless of
withdrawals. Unlike `withdrawable()`, which reflects only the unwithdrawn
portion, this value never resets after a withdrawal, so it is suitable for
progress displays that should keep counting up. Read-only, no transaction.

```typescript
const total = await client.streams.streamedTotal(streamId);
// Returns: bigint (cumulative stroops streamed since start)
```

---

### `withdraw(streamId, amount?) → Promise<string>`

| Param | Type | Notes |
|-------|------|-------|
| `streamId` | `bigint \| string` | |
| `amount` | `bigint?` | Defaults to full withdrawable balance |

**Returns:** Transaction hash  
**Requires:** `keypair` set (recipient)  
**Throws:** `Error` (client-side) if an explicit `amount` is `<= 0n` — validated before any RPC round-trip, mirroring the contract's `InvalidAmount` guard; `ConduitError` with `contract: 'stream'` — `StreamErrorCode.NothingToWithdraw`, `.NotAuthorized`, `.StreamCancelled`, `.InvalidAmount`

---

### `batchWithdraw(withdrawals) → Promise<BatchWithdrawResult[]>`

| Param | Type | Notes |
|-------|------|-------|
| `withdrawals` | `{ streamId: bigint \| string; amount?: bigint }[]` | One entry per stream to withdraw from |

```typescript
interface BatchWithdrawResult {
  streamId: bigint;
  success:  boolean;
  txHash?:  string;  // present when success is true
  error?:   string;  // present when success is false
}
```

Withdraws from multiple streams. Soroban permits only one
`invoke_host_function` operation per transaction, so this cannot be a single
atomic transaction — each withdrawal is submitted as its own transaction and
reported independently, so a failure on one streamId (e.g.
`StreamNotFound`, insufficient balance) does not fail the others.

Withdrawals are submitted **one at a time, not concurrently**. Each
transaction is built from the caller account's current sequence number;
submitting all N withdrawals at once means every one of them would read the
same sequence number and collide, so with a single keypair/wallet at most
one could ever land on-chain. Awaiting each withdrawal in turn guarantees
every submission gets a distinct, ordered sequence number.

**Requires:** `keypair`, `wallet`, or `signer` set (recipient)

---

### `cancel(streamId) → Promise<string>`

Atomically settles both parties (recipient gets owed amount, sender gets refund).

**Requires:** `keypair` set (sender)  
**Throws:** `ConduitError` with `contract: 'stream'` — `StreamErrorCode.NotAuthorized`, `.StreamCancelled`

---

### `pause(streamId) → Promise<string>`

Freezes the stream clock. Withdrawable balance stops growing.

**Requires:** `keypair` set (sender)  
**Throws:** `ConduitError` with `contract: 'stream'` — `StreamErrorCode.AlreadyPaused`, `.StreamCancelled`

---

### `resume(streamId) → Promise<string>`

Resumes a paused stream. Paused duration is excluded from streaming time.

**Requires:** `keypair` set (sender)  
**Throws:** `ConduitError` with `contract: 'stream'` — `StreamErrorCode.NotPaused`, `.StreamCancelled`

---

### `topUp(streamId, amount) → Promise<string>`

Adds tokens to the stream balance. Extends effective stream duration.

**Requires:** `keypair` set (sender)  
**Throws:** `Error` (client-side) if `amount` is `<= 0n` — validated before any RPC round-trip; `ConduitError` with `contract: 'stream'` — `StreamErrorCode.StreamCancelled`, `.InvalidAmount`

---

### `forceCancel(streamId) → Promise<string>`

Force-cancels a **paused** stream as the recipient, once the 30-day pause threshold has
elapsed. Settles atomically like `cancel()`: the recipient's earned-but-unwithdrawn tokens are
paid out and the unstreamed remainder is refunded to the sender. Prevents a sender from
indefinitely pausing a stream to hold unstreamed tokens hostage.

**Requires:** `keypair` set (recipient)  
**Throws:** `ConduitError` with `contract: 'stream'` — `StreamErrorCode.NotPaused`, `.PauseThresholdNotMet`, `.StreamCancelled`, `.NotAuthorized`

---

### `transferRecipient(streamId, newRecipient) → Promise<string>`

Transfers the recipient role to a new address (current recipient only). The new recipient
inherits all rights, including the withdrawable balance accrued up to the moment of transfer.

| Param | Type | Notes |
|-------|------|-------|
| `streamId` | `bigint \| string` | |
| `newRecipient` | `string` | Stellar G-address of the new recipient |

**Returns:** Transaction hash  
**Requires:** `keypair` set (recipient)  
**Throws:** `Error` (client-side) if `newRecipient` is empty; `ConduitError` with `contract: 'stream'` — `StreamErrorCode.NotAuthorized`, `.StreamCancelled`

---

### `clawback(streamId) → Promise<bigint>`

Reclaims unstreamed tokens. Only works if `clawbackEnabled` was `true` at creation.

**Returns:** Amount reclaimed (stroops)  
**Requires:** `keypair` set (sender)  
**Throws:** `ConduitError` with `contract: 'stream'` — `StreamErrorCode.ClawbackDisabled`, `.NotAuthorized`

---

### `list(params) → Promise<PaginatedStreams>`

| Param | Type | Notes |
|-------|------|-------|
| `sender` | `string?` | Filter by sender address |
| `recipient` | `string?` | Filter by recipient address |
| `offset` | `number?` | Default `0` |
| `limit` | `number?` | Default `20`, max `100` |
| `cursor` | `string?` | Opaque base64-encoded cursor from a previous page's `nextCursor`; takes precedence over `offset` when both are provided. Throws `Invalid cursor` on malformed input |

**Returns:** a page of results plus pagination metadata:

```typescript
interface PaginatedStreams {
  streams:     StreamInfo[];  // stream info for this page
  hasNextPage: boolean;       // whether more results exist after this page
  totalCount:  bigint;        // number of filtered stream IDs seen through the end of this page
  offset:      number;        // the offset used for this page
  limit:       number;        // the limit used for this page
  nextCursor?: string;        // opaque cursor for the next page; present only when hasNextPage is true
}
```

Pass a page's `nextCursor` back as `cursor` to fetch the next page (see [`examples/list-streams.ts`](../examples/list-streams.ts)).

When **both** `sender` and `recipient` are given, the result is the **union** of the two
filters (streams where the address is either sender or recipient), de-duplicated — neither
filter is silently dropped.

---

### `subscribe(streamId, handlers) → Subscription`

Poll for on-chain events.

```typescript
const sub = client.streams.subscribe(streamId, {
  onWithdraw:  e => console.log('Withdrawn:', e.amount),
  onCancel:    e => console.log('Cancelled:', e.refundAmount),
  onPause:     e => console.log('Paused at:', e.pausedAt),
  onResume:    e => console.log('Resumed at:', e.resumedAt),
  onTopUp:     e => console.log('Topped up:', e.amount),
  onClawback:  e => console.log('Clawback:', e.amount),
  onCreated:            e => console.log('Created:', e.recipient),
  onForceCancel:        e => console.log('Force-cancelled by:', e.recipient),
  onRecipientTransfer:  e => console.log('Recipient transferred to:', e.newRecipient),
  onOperatorSet:        e => console.log('Operator set:', e.operator),
  onOperatorRevoke:     e => console.log('Operator revoked:', e.operator),
  onError:     err => console.warn('Polling error:', err),
  pollInterval:            3000,   // ms; default 5000
  maxBackoffMs:            30000,  // ms; default 60000
  maxConsecutiveFailures:  5,      // default 10
});

sub.unsubscribe();
```

> The first poll seeds its start ledger from `getLatestLedger()` (Soroban RPC's
> `getEvents` requires one); a failed seed is retried on the next poll. After a
> polling failure the retry delay grows exponentially
> (`pollInterval · 2^(failures−1)`, capped at `maxBackoffMs`); a successful poll
> resets it. Once `maxConsecutiveFailures` failures occur in a row the
> subscription stops (a final `onError` is delivered first).

> **All event payload fields are decoded.** `src/events.ts`'s `dispatchEvent()` parses every
> multi-field event from its tuple `ScVal`s: `onWithdraw` → `{ recipient, amount,
> totalWithdrawn, remaining }`, `onCancel` → `{ sender, refundAmount, withdrawnSoFar }`,
> `onPause` → `{ sender, pausedAt, withdrawable }`, `onTopUp` → `{ sender, amount, newBalance }`,
> `onCreated` → `{ sender, recipient, token, depositAmount, ratePerSecond, startTime, endTime }`,
> `onForceCancel` → `{ recipient, payoutAmount, refundAmount }`. Single-field events are decoded
> from their bare scalar: `onResume` → `{ sender, resumedAt }`, `onClawback` → `{ sender, amount }`,
> `onRecipientTransfer` → `{ previousRecipient, newRecipient }`, `onOperatorSet` → `{ sender,
> operator }`, `onOperatorRevoke` → `{ sender, operator }`. These fields are real values from the
> chain — no placeholder `0`/`0n` values remain.
>
> `onRecipientTransfer`, `onForceCancel`, `onOperatorSet`, and `onOperatorRevoke` were previously
> silently ignored — a live subscriber was never notified when the recipient role moved to
> another address, a paused stream was force-cancelled, or an operator was delegated/revoked.

The first poll seeds its start ledger from `getLatestLedger()` before calling `getEvents()` (Soroban
RPC's `getEvents` rejects without a start ledger). If that seeding call itself fails, it's retried on
the next poll rather than leaving the subscription permanently unable to seed a cursor.

A polling failure calls `onError` and reschedules the next poll with exponential backoff —
`pollInterval * 2^(consecutiveFailures - 1)`, capped at `maxBackoffMs` — instead of retrying at a
fixed interval. A successful poll resets the failure count and the delay back to `pollInterval`. If
`maxConsecutiveFailures` consecutive polls fail in a row, the subscription stops polling entirely
(after the final `onError` call for that failure) rather than retrying forever against a dead
endpoint; call `subscribe()` again to restart it.

---

## `client.factory`

### `streamCount() → Promise<bigint>`
### `streamAddress(id) → Promise<string | null>`

Resolved (non-null) addresses are cached in-memory for the lifetime of the client, since a
stream's contract address is fixed at creation and never changes. A `null` result (stream not
yet found) is not cached, so a later call for the same `id` will still hit the network. This
cache is what `StreamsModule` relies on to avoid re-resolving the same address on every
`get`/`withdraw`/`cancel`/`pause`/`resume`/`topUp`/`clawback` call and when paginating `list()`.

### `protocolFeeBps() → Promise<number>`

---

## `client.governor`

### `config() → Promise<GovernorConfig>`

```typescript
interface GovernorConfig {
  feeBps:             number;
  feeRecipient?:      string;
  minDurationSeconds: number;
  maxRatePerSecond:   bigint;
  factoryAddress?:    string;
}
```

---

## `StreamInfo`

```typescript
interface StreamInfo {
  id:              bigint;
  address:         string;   // DripStream contract address
  sender:          string;
  recipient:       string;
  token:           string;   // asset contract address
  ratePerSecond:   bigint;   // stroops per second
  startTime:       number;   // unix timestamp
  endTime:         number;   // 0 = open-ended
  withdrawn:       bigint;   // stroops already withdrawn
  paused:          boolean;
  pausedAt:        number;   // timestamp of last pause
  cancelled:       boolean;
  clawbackEnabled: boolean;
}
```

---

## Error Codes

Each contract has its own error-code space — `ConduitError.contract` tells you which table
applies (`'stream' | 'factory' | 'governor'`). The same numeric `code` means something different
in each one.

**`StreamErrorCode`** (`err.contract === 'stream'`)

| Code | Constant | Meaning |
|------|----------|---------|
| 1 | `NotAuthorized` | Caller is not sender or recipient |
| 2 | `StreamNotFound` | Stream ID does not exist |
| 3 | `StreamCancelled` | Stream has been cancelled |
| 4 | `StreamNotStarted` | Stream has not started yet |
| 5 | `StreamEnded` | Stream is past end_time |
| 6 | `NothingToWithdraw` | Zero withdrawable balance |
| 7 | `InsufficientDeposit` | Deposit < rate_per_sec |
| 8 | `InvalidTimeRange` | end_time ≤ start_time |
| 9 | `AlreadyPaused` | Stream is already paused |
| 10 | `NotPaused` | Stream is not paused |
| 11 | `ClawbackDisabled` | Clawback not enabled |
| 12 | `ArithmeticOverflow` | Integer overflow |
| 13 | `PauseThresholdNotMet` | `force_cancel` before the 30-day pause threshold elapsed |
| 14 | `AlreadyInitialized` | Stream has already been initialized |
| 15 | `InvalidAmount` | `withdraw`/`top_up` amount must be > 0 |

**`FactoryErrorCode`** (`err.contract === 'factory'`)

| Code | Constant | Meaning |
|------|----------|---------|
| 1 | `NotInitialized` | Factory hasn't been initialized |
| 2 | `InvalidDeposit` | deposit ≤ 0 |
| 3 | `InvalidRate` | rate_per_sec ≤ 0 |
| 4 | `InvalidTimeRange` | end_time ≤ start_time |
| 5 | `InsufficientDeposit` | Deposit too small for the rate/duration |
| 6 | `BackdatedStream` | start_time is in the past |
| 7 | `AlreadyInitialized` | Factory has already been initialized |
| 8 | `RateExceedsMax` | rate_per_sec exceeds governor's max_rate_per_second |
| 9 | `DurationTooShort` | Duration below governor's min_duration_seconds |
| 10 | `ArithmeticOverflow` | Integer overflow validating deposit against duration |

**`GovernorErrorCode`** (`err.contract === 'governor'`)

| Code | Constant | Meaning |
|------|----------|---------|
| 1 | `NotAuthorized` | Caller is not the current authority |
| 2 | `InvalidParam` | Setter argument failed validation |
| 3 | `AlreadyInitialized` | Governor has already been initialized |

---

## Utility functions

```typescript
import { toStroops, fromStroops, calculateRate, streamProgress, withdrawableLocal,
  bigintSafeStringify, isValidAddress }
  from '@conduit-protocol/sdk/utils';

toStroops('100.5')             // → 1005000000n
fromStroops(1005000000n)       // → '100.5'
calculateRate('1000', 2592000) // → 3858n  stroops/sec
streamProgress(streamInfo)     // → 0.42   (0–1 fraction elapsed)
withdrawableLocal(streamInfo)  // → bigint (client-side estimate, no RPC call)
```

`withdrawableLocal` is useful for building live counters without polling the chain on every render tick.

`toStroops`, `fromStroops`, `calculateRate`, and `calculateYield` use a precomputed `POW10`
lookup table for decimal values 0–19, avoiding repeated `BigInt(10 ** decimals)` computation
on every call. See [`docs/architecture.md`](./architecture.md#performance) for the full
write-up of this and the other `StreamsModule` caching optimizations.

### `bigintSafeStringify(value)`

Recursively converts all `bigint` values in an object or array to their string
representation, ensuring safe JSON serialisation across all browsers (Safari/WebKit
serialises bare `bigint` as `{}` instead of throwing). Used internally by the SDK
before network submission and in `StreamInfo.toJSON()`.

**Lazy cloning:** The function only allocates a new object or array when at least one
descendant value is a `bigint` that gets converted. If no `bigint` values are present,
the original input reference is returned unchanged — avoiding unnecessary allocations
and GC pressure. This makes it safe to call in hot paths like `StreamBuilder.build()`
and `ConduitBatcher.execute()`.

```typescript
import { bigintSafeStringify } from '@conduit-protocol/sdk/utils';

// Object with bigints → new object allocated
const sanitized = bigintSafeStringify({ rate: 38580n });
// → { rate: '38580' }

// Object without bigints → same reference returned
const plain = { name: 'test', amount: 100 };
const result = bigintSafeStringify(plain);
console.log(result === plain); // → true
```

### `isValidAddress(address)`

Static format validation for Stellar public keys (G-addresses). Checks StrKey encoding,
version byte, and checksum — does not verify on-chain existence. Returns `true` for
valid Ed25519 public keys, `false` otherwise.

```typescript
import { isValidAddress } from '@conduit-protocol/sdk/utils';

isValidAddress('GABC...XYZ');           // → true
isValidAddress(Keypair.random().publicKey()); // → true
isValidAddress('not-an-address');      // → false
```

---

## RPC Server Lifecycle

The SDK maintains an internal cache of `SorobanRpc.Server` instances keyed by URL. Reusing server
instances avoids creating new HTTP agents on every RPC call, which reduces TCP/TLS handshake
overhead, lowers GC pressure, and improves throughput — particularly for operations like
`client.streams.list()` that issue multiple RPC calls in quick succession.

### `getServer(rpcUrl)`

Returns a cached `SorobanRpc.Server` for the given URL. Subsequent calls with the same URL
return the same instance. This is the recommended way to obtain an RPC server when calling
low-level Soroban helpers directly.

```typescript
import { getServer } from '@conduit-protocol/sdk';

const server = getServer('https://soroban-mainnet.stellar.org');
```

### `clearServerCache()`

Clears the internal server cache. Useful in test suites between test cases that switch
network configurations, or when you need to force a fresh server instance.

```typescript
import { clearServerCache } from '@conduit-protocol/sdk';

clearServerCache();
```

> **Internal usage:** All SDK functions that interact with the Soroban RPC (`buildContractCallTx`,
> `simulateReadOnly`, `invokeContract`, `StreamsModule`, `subscribeToStream`, etc.) build their
> server through an internal wrapper that calls `getServer` for the cached instance and adds
> automatic retry-with-backoff on rate-limit errors (HTTP 429). HTTP 503 (Service Unavailable) is
> **not** retried — it is surfaced as a `RpcServiceUnavailableError` so callers can fail over to a
> different RPC URL instead of retrying a node that is down. Calling `getServer` yourself
> gives you the cached-but-unwrapped instance — no automatic retry — so you do not need to call
> it yourself unless you are using the low-level Soroban helpers directly and want to manage
> retries on your own.

### `getTokenDecimals(rpcUrl, passphrase, callerAddr, tokenId) → Promise<number>`

Queries a SEP-41 token contract's `decimals()`. A token's decimals cannot change after
deployment, so results are cached per `rpcUrl:tokenId` for the lifetime of the process —
repeated calls for the same token (e.g. across multiple `client.streams.create()` calls) resolve
from cache instead of issuing another RPC simulation. Concurrent calls for the same token also
dedupe onto a single in-flight simulation. A failed simulation is not cached, so the next call
retries against the network.

```typescript
import { getTokenDecimals, clearTokenDecimalsCache } from '@conduit-protocol/sdk';

clearTokenDecimalsCache(); // force a fresh simulation on the next call
```

---

## Wallet Adapters

`WalletAdapter` is the interface `client.streams` signs transactions through — implement it to
support any wallet. The SDK ships two implementations:

### `KeypairWalletAdapter`

Wraps a raw `@stellar/stellar-sdk` `Keypair` so `config.keypair` can be used through the same
`WalletAdapter` interface as a browser or WalletConnect wallet. Constructed automatically by
`ConduitClient`/`StreamsModule` when `config.keypair` is supplied and no `config.wallet` is given.

```typescript
new KeypairWalletAdapter(keypair: Keypair)
```

* `getPublicKey(): string` — the keypair's G-address.
* `signTransaction(tx: Transaction | string, opts?: SignTransactionOptions): Promise<Transaction | string>` — signs and returns a `Transaction` instance as-is; for a raw XDR string, requires `opts.networkPassphrase` (throws otherwise) and returns signed XDR. `opts.accountToSign` is not applicable — a keypair only ever signs as itself.
* `isConnected(): boolean` — always `true`.

### `WalletConnectAdapter`

Wraps a WalletConnect v2 session. See its JSDoc in `src/adapters/walletconnect.ts` for the full
option set.

---

## `GraphQLIndexer`

A client for a Conduit indexer's GraphQL endpoint — one-shot queries plus live subscriptions.

```typescript
new GraphQLIndexer(endpoint: string)
```

Throws if `endpoint` is empty.

### `query<T = unknown>(options) → Promise<T>`

Issues a single GraphQL query as an HTTP POST and returns the unwrapped `data` payload.

> [!NOTE]
> **Return Contract (Unwrapped Data)**: Unlike standard GraphQL clients that return the raw
> `{ data, errors }` envelope, `query()` automatically unpacks the response and returns `body.data`
> directly. If the GraphQL endpoint returns any errors in `errors[]`, `query()` throws a
> `ConduitError` containing the aggregated error messages. Pass a type parameter
> `query<T>()` to strongly type the returned data.

| Field | Type | Required |
|-------|------|----------|
| `query` | `string` | ✓ |
| `variables` | `Record<string, unknown>` | |
| `headers` | `Record<string, string>` | |
| `timeoutMs` | `number` | |
| `signal` | `AbortSignal` | |

The request is wired to a per-request `AbortController`. If the indexer has not responded within
`timeoutMs` (default `DEFAULT_INDEXER_TIMEOUT_MS`, 15_000) the fetch is aborted and `query()`
rejects with an `IndexerTimeoutError` (whose `endpoint` and `timeoutMs` fields describe what
timed out). Pass `timeoutMs: 0`/`Infinity` to disable the SDK timeout. A caller-supplied `signal`
aborts the in-flight request and rejects with the underlying `AbortError` — use it to cancel on
unmount or navigation.

**Throws** if `query` is empty, if the HTTP response is not `ok`, if GraphQL errors are returned
(as a `ConduitError`), or with an `IndexerTimeoutError` when the request exceeds `timeoutMs`.

### `subscribe(options) → IndexerSubscription`

Opens a live subscription. Prefers a `graphql-transport-ws` WebSocket connection derived from
`endpoint` (`https://` → `wss://`, `http://` → `ws://`); when no `WebSocket` constructor is
available (e.g. some non-browser, non-Node runtimes) it falls back to reading a
`text/event-stream` HTTP response and parsing its `data:` lines.

| Field | Type | Required |
|-------|------|----------|
| `query` | `string` | ✓ |
| `variables` | `Record<string, unknown>` | |
| `headers` | `Record<string, string>` | |
| `onData` | `(data: unknown) => void` | ✓ |
| `onError` | `(error: Error) => void` | |
| `maxReconnectAttempts` | `number` (0–32, default 5) | |
| `reconnectDelayMs` | `number` (0–60000, default 1000) | |

On the WebSocket path, an unexpected socket close calls `onError` (if provided) and retries
with linear backoff (`reconnectDelayMs * attempt`), matching `WebSocketRelayer`. The
subscription stays active until `unsubscribe()`, `cleanup()`, or the retry budget is
exhausted. Exhaustion calls `onError` again with a message containing `exhausted` and then
tears the subscription down. The SSE fallback does not reconnect.

`maxReconnectAttempts` / `reconnectDelayMs` must be integers in the ranges above; out-of-range
values throw before a socket is opened. `maxReconnectAttempts: 0` reports the close and
tears down immediately.

Returns `{ unsubscribe(): void }`. Calling `unsubscribe()` is idempotent — it sends a
`complete` message (WebSocket transport) or aborts the underlying fetch (SSE fallback),
cancels any pending reconnect timer, and is safe to call more than once.

### `getSubscriptionCount() → number`

Number of subscriptions currently active on this indexer instance.

### `cleanup(): void`

Unsubscribes every active subscription and marks the indexer destroyed — subsequent calls to
`query()` or `subscribe()` throw.

```typescript
import { GraphQLIndexer } from '@conduit-protocol/sdk';

const indexer = new GraphQLIndexer('https://indexer.streamfi.io/graphql');

const sub = indexer.subscribe({
  query: 'subscription { streamUpdated(id: "1") { id withdrawn } }',
  onData: (data) => console.log(data),
  onError: (err) => console.error(err),
});

// later
sub.unsubscribe();
indexer.cleanup();
```

---

## Fluent Builder API

The SDK provides `StreamBuilder` and `ConduitBatcher` to construct and execute stream operations fluently and in batches.

### `StreamBuilder`

A helper class to build stream configurations with method chaining.

#### Methods

* `token(address: string): this` - Sets the Soroban token contract address.
* `sender(address: string): this` - Sets the sender address.
* `recipient(address: string): this` - Sets the recipient address.
* `amount(val: number): this` - Sets the deposit amount in the smallest unit (stroops).
* `ratePerSecond(val: number | bigint): this` - Sets the stream rate in stroops per second, as an alternative to `amount()`-only streams. Accepts a `number` or `bigint`; `bigint` values are serialised to strings before network submission to avoid Safari/WebKit `JSON.stringify` quirks.
* `startTime(val: number): this` - Sets the stream's start time (Unix timestamp, seconds). Optional; `toContractArgs()`/`toBatchOperation()` default to "now" when omitted. Throws if `val` is in the past.
* `endTime(val: number): this` - Sets the stream's end time (Unix timestamp, seconds). Optional; `toContractArgs()`/`toBatchOperation()` default to `0` (open-ended) when omitted.
* `clawbackEnabled(val: boolean): this` - Sets whether the sender may claw back unstreamed tokens. Optional; defaults to `false`.
* `build(): StreamConfig` - Validates and returns the built stream configuration. Throws if any required field is missing. Includes `ratePerSecond`/`startTime`/`endTime`/`clawbackEnabled` in the result when set.
* `toContractArgs(): unknown[]` - Produces the exact 8 positional arguments the real `DripFactory.create_stream` contract call expects — `(sender, recipient, token, deposit_amount: i128, rate_per_sec: i128, start_time: u64, end_time: u64, clawback_enabled: bool)`. Throws everything `build()` throws, plus a dedicated error if `ratePerSecond` was never set (the contract has no way to derive a rate on its own).
* `toBatchOperation(method?: string): BatchOperation` - Wraps `toContractArgs()` in a `BatchOperation` (`{ method: 'create_stream', params: {}, args }`) ready to pass to `ConduitBatcher.executeAsync()`. This is the supported way to take a `StreamBuilder` all the way to a real, submittable `create_stream` transaction — see the note under `ConduitBatcher` below.
* `submit(submitFn, options?): Promise<unknown>` - Builds the payload and submits it through `submitFn` with automatic retries (exponential backoff), concurrency control via an internal semaphore, a pending queue with backpressure, and `AbortSignal` support. Throws if the builder was destroyed or the queue is full.

  Options (`SubmitOptions`):
  * `maxRetries?: number` - Max retry attempts per payload (default `3`).
  * `retryDelayMs?: number` - Base backoff delay in ms, doubled per retry (default `100`).
  * `concurrency?: number` - Max concurrent in-flight submissions (default `10`).
  * `maxQueueSize?: number` - Max pending queue size before backpressure kicks in (default `100`).
  * `signal?: AbortSignal` - Aborts an in-flight submission.

```typescript
import { StreamBuilder } from '@conduit-protocol/sdk';

const stream = new StreamBuilder()
  .token('USDC')
  .sender('GD...')
  .recipient('GB...')
  .amount(1000)
  .build();

// ratePerSecond is an alternative to amount():
const drip = new StreamBuilder()
  .token('USDC')
  .sender('GD...')
  .recipient('GB...')
  .ratePerSecond(10n) // 10 stroops/sec
  .build();

// submit() handles retries, backpressure and abort for you:
const result = await new StreamBuilder()
  .token('USDC')
  .sender('GD...')
  .recipient('GB...')
  .amount(1000)
  .submit(async (payload) => submitToNetwork(payload), { maxRetries: 5 });
```

### `ConduitBatcher`

A utility class to bundle multiple stream operations with mandatory client-side validation. `execute`/`executeAsync` are **instance methods** — instantiate with `new ConduitBatcher()` first (see [`examples/fluent-builder.ts`](../examples/fluent-builder.ts)).

> **Building real `create_stream` calls:** `execute()` takes plain `Record<string, unknown>[]`. With the default `create_stream` method it builds the exact positional, ABI-typed args (`deposit_amount`/`rate_per_sec` as `i128`, `start_time`/`end_time` as `u64`, honoring `startTime`/`endTime`/`clawbackEnabled` when present); for other methods it encodes each item as a single sorted map keyed by whatever properties it happens to have. `execute()` does no ABI validation (a missing `ratePerSecond` silently becomes `0`, for example), so for a fully validated `create_stream` invocation build a `BatchOperation` with `StreamBuilder.toBatchOperation()` (which supplies the correct positional, ABI-typed `args`) and pass it to `executeAsync()`.
>
> **Integer encoding:** `paramToScVal()` no longer forces every integer `number` to `i64` and every `bigint` to `i128`. Untyped positive integers now encode as `u64` (matching the contract's `start_time`/`end_time`/stream-ID types) and negatives as `i64`; pass an explicit type (`paramToScVal(value, 'i128')`) or a per-field `BatchOperation.types` hint (e.g. `{ streamId: 'u64', amount: 'i128' }`) to force a specific width, and already-encoded `xdr.ScVal`s pass through untouched (#497).

#### Methods

* `execute(streams: Record<string, unknown>[], options?: BatchExecuteOptions): BatchResult` - Validates and bundles the list of stream configurations into a single transaction. Returns `{ success: false, errors: [...] }` if validation fails instead of throwing. Each item becomes an ABI-agnostic sorted-map argument unless you build `BatchOperation`s with explicit `args` (see `toBatchOperation()` above) and go through `executeAsync()` instead.

**Validation Rules:**
- Payload must be a non-null, non-empty array
- Each array item must be a non-null object
- Invalid payloads are rejected at the client before submission

```typescript
import { StreamBuilder, ConduitBatcher } from '@conduit-protocol/sdk';

// Real create_stream invocation: build ABI-exact args, then executeAsync().
const operation = new StreamBuilder()
  .token('USDC')
  .sender('GD...')
  .recipient('GB...')
  .amount(1000)
  .ratePerSecond(10n)
  .toBatchOperation();

const result = await new ConduitBatcher().executeAsync([operation], { context });
if (!result.success) {
  console.error('Validation errors:', result.errors);
  return;
}
```

* `executeAsync(operations: BatchOperation[], signalOrOptions?: AbortSignal | BatchExecuteAsyncOptions): Promise<BatchResult>` - Asynchronously execute a batch with abort signal / options support. `BatchOperation.args`, when present, is used verbatim as the contract's positional arguments (see `StreamBuilder.toBatchOperation()`). `BatchOperation.types` supplies per-field ScVal type hints for the `params` map (e.g. `{ method: 'withdraw', params: { streamId: 1n }, types: { streamId: 'u64' } }`) so u64 stream IDs and i128 amounts encode with the correct width instead of the default inference (#497).

**Throws:** `Error` if batcher is destroyed.

---

### `buildBatchTransactions(operations, context) → Promise<BuiltBatchTransaction[]>`

Builds one transaction per operation and, when `context.rpcUrl` is set, simulates and assembles
each via RPC so the returned XDR is ready to submit. Simulations for the batch's operations run
**concurrently** (not one at a time) since each operation's transaction and simulation are
independent of every other operation's. Each result's `index` field reflects its position in the
input `operations` array — use it to submit transactions in order, since sequence numbers are
still consumed sequentially even though simulation itself is not.

---

## `NonceManager`

```typescript
const nonces = new NonceManager({ startNonce: 0n, maxNonce: 1_000_000n });
const lock = await nonces.acquire();
// ... use lock.nonce ...
lock.release();
```

A single-lock queue that hands out sequential nonces one caller at a time. `acquire()` resolves
immediately if the lock is free, or queues behind the current holder otherwise.

* `acquire(): Promise<NonceLock>` — waits for the lock, then resolves with `{ nonce, release }`.
* `acquireWithFallback(timeoutMs = 5000): Promise<NonceLock>` — like `acquire`, but rejects if the
  lock isn't granted within `timeoutMs`. A timed-out call is cancelled out of the wait queue, so
  it never holds the lock hostage — a later `release()` from the current holder correctly hands
  the lock to the next live waiter (or frees it) instead of dead-ending on an abandoned caller.
* `safeAcquire(retries = 3, delayMs = 100): Promise<NonceLock>` — retries `acquireWithFallback`
  with linear backoff.
* `reset(nonce?)`, `destroy()`, `.current`, `.remaining`, `.acquired` — state inspection/reset.

---

## `Module36` (Feature #36)

Stream snapshot diff engine implementing Feature #36. Uses LRU-memoized comparisons to avoid recomputing deltas for repeated identical stream state comparisons; actual speedup is workload-dependent (proportional to cache hit rate).

### Constructor

```typescript
new Module36(config?: Module36Config)
```

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `cacheSize` | `number` | `1000` | Max entries in the LRU memoization cache |
| `enableOptimization` | `boolean` | `true` | Enables LRU-memoized diffing |

### Methods

* `diffSnapshots(previous: StreamSnapshot, current: StreamSnapshot): StreamDiff` — Computes withdrawable/progress deltas and status-change detection between two observations.
* `diffBatch(pairs: Array<{ previous: StreamSnapshot; current: StreamSnapshot }>): StreamDiff[]` — Diffs many snapshot pairs in one pass.
* `computeAccrual(ratePerSecond: bigint, fromSec: number, toSec: number): bigint` — Fast BigInt accrual between timestamps.
* `clearCache(): void` — Clears the LRU cache and performance counters.
* `getPerformanceMetrics(): Module36Metrics` — Returns `totalDiffs`, `cacheHits`, `cacheMisses`, `averageExecutionTimeMs`, and `measuredSpeedupPercent` (a real measurement derived from this instance's own accumulated hit/miss timings, `null` until both have occurred at least once — not a fixed assumed percentage).

---

## `Module26` (Feature #26)

Stream portfolio aggregator implementing Feature #26. Uses LRU-memoized summaries to avoid recomputing totals for repeated identical portfolio comparisons; actual speedup is workload-dependent (proportional to cache hit rate).

### Constructor

```typescript
new Module26(config?: Module26Config)
```

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `cacheSize` | `number` | `1000` | Max entries in the LRU memoization cache |
| `enableOptimization` | `boolean` | `true` | Enables LRU-memoized aggregation |
| `batchChunkSize` | `number` | `50` | Chunk size for large portfolio scans |

### Methods

* `aggregatePortfolio(items: PortfolioStreamItem[], nowSec?: number): PortfolioSummary` — Totals withdrawable balance, active rate, and lifecycle counts.
* `projectRemaining(stream: StreamInfo, horizonSecs: number, nowSec?: number): bigint` — Projects remaining accrual over a time horizon.
* `clearCache(): void` — Clears the LRU cache and performance counters.
* `getPerformanceMetrics(): Module26Metrics` — Returns `totalAggregations`, `cacheHits`, `cacheMisses`, `averageExecutionTimeMs`, and `measuredSpeedupPercent` (a real measurement derived from this instance's own accumulated hit/miss timings, `null` until both have occurred at least once — not a fixed assumed percentage).

---

## `Module48` (Feature #48)

Streaming analytics and batch-evaluation engine implementing Feature #48. Uses a memoized lookup cache to avoid recomputing withdrawable/progress for repeated identical stream evaluations; actual speedup is workload-dependent (proportional to cache hit rate).

### Constructor

```typescript
new Module48(config?: Module48Config)
```

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `cacheSize` | `number` | `1000` | Max entries in memoization cache |
| `enableOptimization` | `boolean` | `true` | Enables memoized lookup caching |
| `batchChunkSize` | `number` | `50` | Stream chunk size for batch processing |

### Methods

* `processSingleItem(item: StreamBatchItem): Module48Result` - Evaluates a stream's withdrawable balance and progress.
* `processStreamBatch(items: StreamBatchItem[]): Module48Result[]` - Processes batch array of streams in chunks.
* `computeOptimizedYield(ratePerSecond: bigint, durationSecs: number): bigint` - Fast BigInt yield calculation.
* `clearCache(): void` - Clears the internal lookup cache and metrics.
* `getPerformanceMetrics(): Module48Metrics` - Returns `totalProcessed`, `cacheHits`, `cacheMisses`, `averageExecutionTimeMs`, and `measuredSpeedupPercent` (a real measurement derived from this instance's own accumulated hit/miss timings, `null` until both have occurred at least once — not a fixed assumed percentage).

---

## `Module49` (Feature #49)

Streaming analytics and evaluation engine implementing Feature #49. Built with memoized cache algorithms and pre-allocated buffer iteration for fast stream batch evaluation.

### Constructor

```typescript
new Module49(config?: Module49Config)
```

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `cacheSize` | `number` | `1000` | Max entries in memoization cache |
| `enableOptimization` | `boolean` | `true` | Enables memoized lookup caching |
| `batchChunkSize` | `number` | `50` | Stream chunk size for batch processing |

### Methods

* `processSingleItem(item: StreamBatchItem49): Module49Result` - Evaluates a stream's withdrawable balance and progress.
* `processStreamBatch(items: StreamBatchItem49[]): Module49Result[]` - Processes batch array of streams in chunks.
* `computeOptimizedYield(ratePerSecond: bigint, durationSecs: number): bigint` - Fast BigInt yield calculation.
* `clearCache(): void` - Clears the internal lookup cache and metrics.
* `getPerformanceMetrics(): Module49Metrics` - Returns real-time metrics (`totalProcessed`, `cacheHits`, `cacheMisses`, `hitRate`, `averageExecutionTimeMs`).

---

## `Module44` (Feature #44)

Stream liquidity-risk / runway calculator implementing Feature #44. For each stream, computes the remaining `runwaySecs` until `endTime` and classifies it into a `LiquidityRiskLevel` (`'inactive' | 'critical' | 'warning' | 'healthy'`), so a dashboard can flag streams about to run out of scheduled balance. Uses the same LRU-memoized lookup pattern as `Module26`/`Module36`/`Module48`; actual speedup is workload-dependent (proportional to cache hit rate) — see `getPerformanceMetrics()` for a measured value, never a fixed assumed percentage.

### Constructor

```typescript
new Module44(config?: Module44Config)
```

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `cacheSize` | `number` | `1000` | Max entries in memoization cache |
| `enableOptimization` | `boolean` | `true` | Enables memoized lookup caching |
| `batchChunkSize` | `number` | `50` | Stream chunk size for batch processing |
| `criticalThresholdSecs` | `number` | `86400` (1 day) | Runway below this is `'critical'`. Throws if negative |
| `warningThresholdSecs` | `number` | `604800` (7 days) | Runway below this (and at/above `criticalThresholdSecs`) is `'warning'`. Throws if not greater than `criticalThresholdSecs` |

### Methods

* `assessSingleItem(item: StreamRiskItem): StreamRiskAssessment` — Computes one stream's `runwaySecs` and `riskLevel`. A cancelled, paused, or zero-rate stream is `'inactive'` with `runwaySecs: 0`. An open-ended stream (`endTime === 0`) is `'healthy'` with `runwaySecs: null` — its runway isn't bounded by a schedule, only by the sender keeping the balance topped up.
* `assessBatch(items: StreamRiskItem[]): StreamRiskAssessment[]` — Assesses an array of streams in `batchChunkSize` chunks.
* `estimateTopUpNeeded(stream: StreamInfo, targetRunwaySecs: number, nowSec?: number): bigint` — Stroops needed via `top_up()` for the stream's runway to reach `targetRunwaySecs`. Returns `0n` if the stream is inactive/paused/cancelled, the target is non-positive, or the target is already met (including any open-ended stream, whose runway is treated as unbounded).
* `clearCache(): void` — Clears the internal lookup cache and metrics.
* `getPerformanceMetrics(): Module44Metrics` — Returns `totalAssessed`, `cacheHits`, `cacheMisses`, `averageExecutionTimeMs`, and `measuredSpeedupPercent` (a real measurement derived from this instance's own accumulated hit/miss timings, `null` until both have occurred at least once).


