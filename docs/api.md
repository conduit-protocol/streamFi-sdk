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

**Throws:** `ConduitError.InvalidDeposit`, `ConduitError.InsufficientDeposit`, `ConduitError.BackdatedStream`, `ConduitError.InvalidTimeRange`

---

### `get(streamId) → Promise<StreamInfo>`

Fetches the complete stream state from the chain.

---

### `withdrawable(streamId) → Promise<bigint>`

Current withdrawable balance in stroops. Read-only, no transaction.

---

### `withdraw(streamId, amount?) → Promise<string>`

| Param | Type | Notes |
|-------|------|-------|
| `streamId` | `bigint \| string` | |
| `amount` | `bigint?` | Defaults to full withdrawable balance |

**Returns:** Transaction hash  
**Requires:** `keypair` set (recipient)  
**Throws:** `ConduitError.NothingToWithdraw`, `ConduitError.NotAuthorized`, `ConduitError.StreamCancelled`

---

### `cancel(streamId) → Promise<string>`

Atomically settles both parties (recipient gets owed amount, sender gets refund).

**Requires:** `keypair` set (sender)  
**Throws:** `ConduitError.NotAuthorized`, `ConduitError.StreamCancelled`

---

### `pause(streamId) → Promise<string>`

Freezes the stream clock. Withdrawable balance stops growing.

**Requires:** `keypair` set (sender)  
**Throws:** `ConduitError.AlreadyPaused`, `ConduitError.StreamCancelled`

---

### `resume(streamId) → Promise<string>`

Resumes a paused stream. Paused duration is excluded from streaming time.

**Requires:** `keypair` set (sender)  
**Throws:** `ConduitError.NotPaused`, `ConduitError.StreamCancelled`

---

### `topUp(streamId, amount) → Promise<string>`

Adds tokens to the stream balance. Extends effective stream duration.

**Requires:** `keypair` set (sender)  
**Throws:** `ConduitError.StreamCancelled`

---

### `clawback(streamId) → Promise<bigint>`

Reclaims unstreamed tokens. Only works if `clawbackEnabled` was `true` at creation.

**Returns:** Amount reclaimed (stroops)  
**Requires:** `keypair` set (sender)  
**Throws:** `ConduitError.ClawbackDisabled`, `ConduitError.NotAuthorized`

---

### `list(params) → Promise<StreamInfo[]>`

| Param | Type | Notes |
|-------|------|-------|
| `sender` | `string?` | Filter by sender address |
| `recipient` | `string?` | Filter by recipient address |
| `offset` | `number?` | Default `0` |
| `limit` | `number?` | Default `20`, max `100` |

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
  pollInterval: 3000,  // ms; default 5000
});

sub.unsubscribe();
```

---

## `client.factory`

### `streamCount() → Promise<bigint>`
### `streamAddress(id) → Promise<string | null>`
### `protocolFeeBps() → Promise<number>`

---

## `client.governor`

### `config() → Promise<GovernorConfig>`

```typescript
interface GovernorConfig {
  feeBps:             number;
  feeRecipient:       string;
  minDurationSeconds: number;
  maxRatePerSecond:   bigint;
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

| Code | `ErrorCode` constant | Meaning |
|------|---------------------|---------|
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

---

## Utility functions

```typescript
import { toStroops, fromStroops, calculateRate, streamProgress, withdrawableLocal }
  from '@conduit-protocol/sdk/utils';

toStroops('100.5')             // → 1005000000n
fromStroops(1005000000n)       // → '100.5'
calculateRate('1000', 2592000) // → 3858n  stroops/sec
streamProgress(streamInfo)     // → 0.42   (0–1 fraction elapsed)
withdrawableLocal(streamInfo)  // → bigint (client-side estimate, no RPC call)
```

`withdrawableLocal` is useful for building live counters without polling the chain on every render tick.
