# Error Handling Guide

The Conduit SDK defines a comprehensive set of error types, each carrying contextual information so your app can respond appropriately without parsing error messages.

## Error Hierarchy

All SDK errors inherit from JavaScript's `Error`. The highest-level categorization:

```
Error
├── ConduitError (contract errors from DripStream/DripFactory/DripGovernor)
├── UnsupportedChainError (invalid network)
├── StreamFiNetworkError (RPC/Indexer connectivity)
├── InsufficientBalanceError (user has < required XLM)
├── RateLimitError (HTTP 429 / JSON-RPC -32029)
├── RpcServiceUnavailableError (HTTP 503)
├── IndexerTimeoutError (GraphQL timeout)
├── OperationAbortedError (user cancelled via AbortSignal)
├── ConfirmationTimeoutError (confirmation polling timeout)
└── ValidationError (StreamBuilder validation)
```

### Typed Stream Operation Errors

When returned by `StreamsModule` methods, certain `ConduitError` codes are automatically translated into more specific types:

```
ConduitError
├── StreamNotFoundError (stream does not exist)
├── AmountExceedsWithdrawableError (insufficient balance to withdraw)
├── UnauthorizedStreamActionError (caller is not sender/recipient)
├── InvalidStreamStateError (stream is in wrong state)
└── ClawbackNotEnabledError (clawback not available for this stream)
```

Factory-specific errors:

```
ConduitError
├── RateExceedsMaxError (rate_per_sec exceeds governor limit)
├── DurationTooShortError (duration below governor minimum)
└── BackdatedStreamError (start_time is in the past)
```

---

## Catching Errors

### By Type (instanceof)

The most common pattern:

```ts
try {
  await client.streams.create({
    asset: 'USDC',
    amount: '1000',
    startTime: ...,
    endTime: ...,
  });
} catch (err) {
  if (err instanceof InsufficientBalanceError) {
    console.error(`Need ${err.requiredBalance} stroops, have ${err.currentBalance}`);
  } else if (err instanceof RateExceedsMaxError) {
    console.error('Your rate exceeds the protocol maximum');
  } else if (err instanceof InvalidStreamStateError) {
    console.error(`Cannot ${err.operation}: stream is ${err.currentState}`);
  } else if (err instanceof UnauthorizedStreamActionError) {
    console.error(`${err.caller} cannot ${err.operation} this stream`);
  } else if (err instanceof ConduitError) {
    console.error(`Contract error on ${err.contract}: #${err.code}`);
  } else if (err instanceof StreamFiNetworkError) {
    console.error('Network error:', err.cause);
  }
}
```

### By Contract Error Code

For generic `ConduitError` handling:

```ts
import { ConduitError, StreamErrorCode, FactoryErrorCode } from '@streamfi/sdk';

try {
  const stream = await client.streams.get(streamId);
} catch (err) {
  if (err instanceof ConduitError) {
    if (err.contract === 'stream' && err.code === StreamErrorCode.NotAuthorized) {
      console.error('You do not have permission to access this stream');
    } else if (!err.isKnown) {
      console.error(`Unknown error code #${err.code} from ${err.contract}`);
    }
  }
}
```

### Type Guards

For catching errors across bundle boundaries or after serialization:

```ts
import { isConduitError } from '@streamfi/sdk';

try {
  // ...
} catch (err) {
  if (isConduitError(err)) {
    log('SDK error:', err.name, err.message);
  } else {
    log('External error:', err);
  }
}
```

---

## Complete Error Reference

### ConduitError

The root error for any failure originating from a smart contract.

**Properties:**
- `contract: 'stream' | 'factory' | 'governor'` — which contract threw
- `code: number` — error code (negative if unknown)
- `isKnown: boolean` — whether the code is in the SDK's catalogue

**Example:**
```ts
try {
  await client.factory.create({ ... });
} catch (err) {
  if (err instanceof ConduitError && !err.isKnown) {
    console.warn(`Unknown ${err.contract} error #${err.code}`);
  }
}
```

### StreamNotFoundError

Thrown by `StreamsModule.get()` when a stream ID does not exist.

**Properties:**
- `streamId: bigint` — the ID that was not found

**Example:**
```ts
try {
  await client.streams.get(streamId);
} catch (err) {
  if (err instanceof StreamNotFoundError) {
    console.error(`Stream ${err.streamId} does not exist`);
  }
}
```

### AmountExceedsWithdrawableError

Thrown by `StreamsModule.withdraw()` when the requested amount exceeds the withdrawable balance.

**Properties:**
- `available: bigint` — withdrawable amount in stroops

**Example:**
```ts
try {
  await client.streams.withdraw(streamId, requestedAmount);
} catch (err) {
  if (err instanceof AmountExceedsWithdrawableError) {
    console.error(`Can only withdraw ${err.available} stroops`);
  }
}
```

### UnauthorizedStreamActionError

Thrown when a caller who is neither sender nor recipient attempts a restricted operation.

**Properties:**
- `operation: string` — method name (e.g., "cancel", "withdraw")
- `caller: string` — rejected caller address

**Example:**
```ts
try {
  await client.streams.cancel(streamId);
} catch (err) {
  if (err instanceof UnauthorizedStreamActionError) {
    console.error(`${err.caller} cannot ${err.operation}`);
  }
}
```

### InvalidStreamStateError

Thrown when a stream is in the wrong state for the requested operation.

**Properties:**
- `operation: string` — attempted operation
- `currentState: 'cancelled' | 'not_started' | 'ended' | 'paused' | 'active' | undefined`

**Example:**
```ts
try {
  await client.streams.resume(streamId);
} catch (err) {
  if (err instanceof InvalidStreamStateError) {
    console.error(`Cannot ${err.operation}: stream is ${err.currentState}`);
  }
}
```

### ClawbackNotEnabledError

Thrown by `StreamsModule.clawback()` when the stream was created without `clawbackEnabled: true`.

**Example:**
```ts
try {
  await client.streams.clawback(streamId);
} catch (err) {
  if (err instanceof ClawbackNotEnabledError) {
    console.error('This stream does not support clawback');
  }
}
```

### RateExceedsMaxError

Thrown by `FactoryModule.create()` when `rate_per_sec` exceeds the governor's maximum.

**Example:**
```ts
try {
  await client.factory.create({ ... });
} catch (err) {
  if (err instanceof RateExceedsMaxError) {
    console.error('Stream rate exceeds protocol maximum');
  }
}
```

### DurationTooShortError

Thrown by `FactoryModule.create()` when stream duration is below the governor's minimum.

**Example:**
```ts
try {
  await client.factory.create({ ... });
} catch (err) {
  if (err instanceof DurationTooShortError) {
    console.error('Stream duration is too short');
  }
}
```

### BackdatedStreamError

Thrown by `FactoryModule.create()` when `startTime` is in the past.

**Example:**
```ts
try {
  await client.factory.create({ startTime: pastTimestamp, ... });
} catch (err) {
  if (err instanceof BackdatedStreamError) {
    console.error('Start time cannot be in the past');
  }
}
```

### UnsupportedChainError

Thrown synchronously by `ConduitClient` constructor when an invalid network is supplied.

**Properties:**
- `providedNetwork: string` — the invalid value
- `supportedNetworks: readonly string[]` — accepted values

**Example:**
```ts
try {
  const client = new ConduitClient({ network: 'polygon' });
} catch (err) {
  if (err instanceof UnsupportedChainError) {
    console.error(`${err.providedNetwork} not supported. Try: ${err.supportedNetworks.join(', ')}`);
  }
}
```

### StreamFiNetworkError

Thrown when an RPC or Indexer call fails due to connectivity issues.

**Properties:**
- `cause: unknown` — the underlying error

**Example:**
```ts
try {
  const stream = await client.streams.get(streamId);
} catch (err) {
  if (err instanceof StreamFiNetworkError) {
    console.warn('Network offline. Please check your connection.');
  }
}
```

### InsufficientBalanceError

Thrown when the user's XLM balance is too low to cover deposit + Soroban fees.

**Properties:**
- `currentBalance: bigint` — user's balance in stroops
- `requiredBalance: bigint` — minimum required in stroops

**Example:**
```ts
try {
  await client.streams.create({ ... });
} catch (err) {
  if (err instanceof InsufficientBalanceError) {
    const requiredXlm = err.requiredBalance / 10_000_000;
    console.error(`You need at least ${requiredXlm} XLM`);
  }
}
```

### RateLimitError

Thrown when the RPC node responds with HTTP 429 (Too Many Requests).

**Properties:**
- `retryAfterMs: number | undefined` — milliseconds to wait before retrying (parsed from Retry-After header if present)

**Strategy:** Back off and retry against the same endpoint.

**Example:**
```ts
try {
  const stream = await client.streams.get(streamId);
} catch (err) {
  if (err instanceof RateLimitError) {
    const delay = err.retryAfterMs ?? 5000;
    console.warn(`Rate limited. Retry after ${delay}ms`);
  }
}
```

### RpcServiceUnavailableError

Thrown when the RPC node responds with HTTP 503 (Service Unavailable).

**Properties:**
- `retryAfterMs: number | undefined` — milliseconds to wait before retrying

**Strategy:** The endpoint is down; consider failing over to a different RPC URL.

**Example:**
```ts
try {
  const stream = await client.streams.get(streamId);
} catch (err) {
  if (err instanceof RpcServiceUnavailableError) {
    console.error('RPC endpoint is down. Try a different endpoint.');
  }
}
```

### IndexerTimeoutError

Thrown when a GraphQL indexer query exceeds its timeout window.

**Properties:**
- `endpoint: string` — indexer URL that timed out
- `timeoutMs: number` — timeout window in milliseconds

**Example:**
```ts
try {
  const data = await indexer.query({ ... });
} catch (err) {
  if (err instanceof IndexerTimeoutError) {
    console.error(`Indexer at ${err.endpoint} did not respond within ${err.timeoutMs}ms`);
  }
}
```

### OperationAbortedError

Thrown when an operation is cancelled via an `AbortSignal`.

**Properties:**
- `operation: string` — human-readable name of the cancelled operation

**Example:**
```ts
const controller = new AbortController();
const promise = client.streams.create({ ... }, { signal: controller.signal });
// Later...
controller.abort();
try {
  await promise;
} catch (err) {
  if (err instanceof OperationAbortedError) {
    console.log(`Cancelled: ${err.operation}`);
  }
}
```

### ConfirmationTimeoutError

Thrown by `StreamsModule.create()` when confirmation polling exceeds `maxAttempts` without reaching a terminal status and `strict: true` is set.

**Properties:**
- `hash: string` — transaction hash that was submitted
- `attempts: number` — number of poll attempts performed
- `timeoutMs: number` — total polling duration

**Example:**
```ts
try {
  await client.streams.create({ ... });
} catch (err) {
  if (err instanceof ConfirmationTimeoutError) {
    console.error(`TX ${err.hash} timed out after ${err.attempts} attempts. Check the blockchain.`);
  }
}
```

### ValidationError

Thrown by `StreamBuilder.build()` when validation fails. Collects all issues instead of throwing on the first.

**Properties:**
- `issues: readonly string[]` — individual validation messages

**Example:**
```ts
try {
  builder.build();
} catch (err) {
  if (err instanceof ValidationError) {
    err.issues.forEach(issue => console.error(`  - ${issue}`));
  }
}
```

---

## Logging Strategy

A recommended logging pattern:

```ts
function logSdkError(err: unknown) {
  if (err instanceof ConduitError) {
    console.error(`[${err.name}] ${err.contract}/${err.code}: ${err.message}`);
  } else if (err instanceof StreamFiNetworkError) {
    console.error('[StreamFiNetworkError] Network connectivity:', err.cause);
  } else if (isConduitError(err)) {
    console.error(`[${err.name}] ${err.message}`);
  } else {
    console.error('[Unknown]', err);
  }
}
```

---

## Testing Error Scenarios

When testing, you can throw specific errors to verify your handlers:

```ts
import { InvalidStreamStateError, StreamErrorCode } from '@streamfi/sdk';

test('shows correct message when stream is already paused', async () => {
  const error = new InvalidStreamStateError('resume', StreamErrorCode.AlreadyPaused);
  // Your error handler should recognize currentState === 'paused'
});
```
