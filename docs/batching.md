# Batching Guide

Batching lets you submit multiple operations in a single coordinated transaction sequence, with built-in progress tracking and error recovery.

## Two Paths to Batching

### 1. High-Level: StreamsModule.batchWithdraw()

Simplest path for withdrawing from multiple streams. The SDK handles all transaction building, signing, and submission.

```ts
import { ConduitClient } from '@streamfi/sdk';

const client = new ConduitClient({ network: 'testnet' });

const results = await client.streams.batchWithdraw([
  { streamId: 1n, amount: '100' },
  { streamId: 2n, amount: '50' },
]);

results.forEach((r) => {
  console.log(`Stream ${r.streamId}: ${r.status}`);
  if (r.txHash) console.log(`  TX: ${r.txHash}`);
  if (r.error) console.log(`  Error: ${r.error}`);
});
```

### 2. Low-Level: ConduitBatcher

For custom sequences of contract method calls, use `ConduitBatcher` and its transaction building functions:

```ts
import {
  ConduitBatcher,
  createBatchStreams,
  buildBatchTransactions,
  submitBatch,
} from '@streamfi/sdk';

// Define operations (method name + parameters)
const operations = [
  { method: 'transfer_recipient', params: { stream_id: 1n, new_recipient: 'G...' } },
  { method: 'withdraw', params: { stream_id: 2n, amount: 1000n } },
];

// Build transactions
const built = await buildBatchTransactions(operations, {
  contractId: 'C...',
  sourceAccount: 'G...',
  network: 'testnet',
  rpcUrl: 'https://soroban-testnet.stellar.org',
});

// Submit
const result = await submitBatch(built, 'https://soroban-testnet.stellar.org', {
  sign: async (xdr) => signer.sign(xdr),
});

console.log(`Succeeded: ${result.outcomes.filter(o => o.status === 'SUCCESS').length}`);
console.log(`Failed: ${result.outcomes.filter(o => o.status === 'FAILED').length}`);
```

---

## High-Level: batchWithdraw()

### Why Use Batching for Withdrawals?

- **Efficiency:** One signature + network round trip covers many withdrawals.
- **Atomicity:** Either all succeed or none are submitted (pre-sequenced design).
- **Observability:** Track each withdrawal's status individually.

### Signature

```ts
async function batchWithdraw(
  withdrawals: BatchWithdrawItem[],
  options?: { signal?: AbortSignal }
): Promise<BatchWithdrawResult[]>
```

### Input: BatchWithdrawItem

```ts
interface BatchWithdrawItem {
  streamId: bigint | string;
  amount: bigint | string;
}
```

### Output: BatchWithdrawResult

```ts
interface BatchWithdrawResult {
  streamId: bigint;
  status: 'SUCCESS' | 'FAILED' | 'ERROR';
  txHash?: string;      // Present if status === 'SUCCESS'
  withdrawAmount: bigint;
  error?: string;       // Present if status is 'FAILED' or 'ERROR'
}
```

### Example: Handling Results

```ts
try {
  const results = await client.streams.batchWithdraw([
    { streamId: 1n, amount: '100' },
    { streamId: 2n, amount: '50' },
    { streamId: 3n, amount: '25' },
  ]);

  results.forEach((r) => {
    if (r.status === 'SUCCESS') {
      console.log(`✓ Stream ${r.streamId}: ${r.txHash}`);
    } else if (r.status === 'FAILED') {
      console.error(`✗ Stream ${r.streamId}: ${r.error}`);
    } else {
      console.error(`⚠ Stream ${r.streamId}: ${r.error}`);
    }
  });

  const failures = results.filter(r => r.status !== 'SUCCESS');
  if (failures.length > 0) {
    console.warn(`${failures.length} withdrawal(s) failed`);
  }
} catch (err) {
  console.error('Batch failed:', err);
}
```

### Error Handling

Errors from `batchWithdraw()` fall into two categories:

1. **Per-item errors** (captured in the result array):
   - Stream not found
   - Insufficient withdrawable balance
   - Authorization failure

2. **Batch-level errors** (thrown from the function):
   - Network connectivity
   - Rate limiting
   - Insufficient XLM for fees

```ts
import {
  AmountExceedsWithdrawableError,
  StreamFiNetworkError,
  RateLimitError,
} from '@streamfi/sdk';

try {
  const results = await client.streams.batchWithdraw([...]);
} catch (err) {
  if (err instanceof RateLimitError) {
    setTimeout(() => retry(), err.retryAfterMs ?? 5000);
  } else if (err instanceof StreamFiNetworkError) {
    console.error('Network offline');
  } else {
    throw err;
  }
}
```

---

## Low-Level: buildBatchTransactions()

For custom batches beyond `batchWithdraw()`, use the low-level batch builder.

### Signature

```ts
async function buildBatchTransactions(
  operations: BuildableOperation[],
  context: BatchTransactionContext
): Promise<BuiltBatchTransaction[]>
```

### Input: BuildableOperation

```ts
interface BuildableOperation {
  method: string;                                    // Contract method name
  params?: Record<string, unknown>;                  // Named parameters (map)
  types?: Record<string, ScValType>;                 // Per-field ScVal type hints
  args?: unknown[];                                  // Positional arguments (alternative to params)
}
```

For example:

```ts
const operations = [
  {
    method: 'withdraw',
    params: { stream_id: 1n, amount: 1000n },
    types: { stream_id: 'u64', amount: 'u128' },
  },
  {
    method: 'pause',
    params: { stream_id: 2n },
    types: { stream_id: 'u64' },
  },
];
```

### Input: BatchTransactionContext

```ts
interface BatchTransactionContext {
  contractId: string;                    // Soroban contract (C-address)
  sourceAccount: string;                 // Signer account (G-address)
  network?: Network;                     // Named network (mainnet/testnet/local)
  networkPassphrase?: string;            // Explicit passphrase (overrides network)
  sequence?: string;                     // Current account sequence (offline building)
  rpcUrl?: string;                       // RPC endpoint (online building + simulation)
  fee?: string;                          // Per-transaction fee in stroops (default: BASE_FEE)
  timeoutSeconds?: number;               // Transaction timeout (default: 30)
}
```

**Offline vs. Online:**

- **Offline** (`sequence` provided, no `rpcUrl`): Builds unsigned XDR. Not yet submittable (needs signing + simulation).
- **Online** (`rpcUrl` provided): Fetches sequence, simulates, and assembles XDR. Ready to sign and submit.

### Output: BuiltBatchTransaction[]

```ts
interface BuiltBatchTransaction {
  index: number;         // Position in the input operations array
  method: string;        // Operation method name
  xdr: string;           // Unsigned transaction envelope (base64)
  prepared: boolean;     // True if simulated and assembled
}
```

### Example: Online Building

```ts
import { buildBatchTransactions } from '@streamfi/sdk';

const built = await buildBatchTransactions(
  [
    { method: 'withdraw', params: { stream_id: 1n, amount: 1000n } },
    { method: 'pause', params: { stream_id: 2n } },
  ],
  {
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    sourceAccount: 'GXXXXXX...',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    network: 'testnet',
    fee: '10000',
  }
);

console.log(built);
// [
//   { index: 0, method: 'withdraw', xdr: '...', prepared: true },
//   { index: 1, method: 'pause', xdr: '...', prepared: true },
// ]
```

### Example: Offline Building

```ts
import { buildBatchTransactionsSync } from '@streamfi/sdk';

const built = buildBatchTransactionsSync(
  [
    { method: 'withdraw', params: { stream_id: 1n, amount: 1000n } },
  ],
  {
    contractId: 'C...',
    sourceAccount: 'G...',
    network: 'testnet',
    sequence: '12345',  // Current account sequence
  }
);

console.log(built[0].prepared); // false — not yet simulated
```

---

## Low-Level: submitBatch()

Submit built transactions sequentially. Each transaction consumes a sequence number, so they must be submitted in order.

### Signature

```ts
async function submitBatch(
  transactions: BuiltBatchTransaction[],
  rpcUrl: string,
  options?: BatchSubmitOptions
): Promise<BatchSubmitResult>
```

### Input: BatchSubmitOptions

```ts
interface BatchSubmitOptions {
  pollIntervalMs?: number;        // Poll delay between confirmation checks (default: 1000ms)
  maxPollAttempts?: number;       // Max polls per transaction (default: 30)
  networkPassphrase?: string;     // Passphrase for XDR reconstruction
  sign?: (xdr: string) => Promise<string> | string;  // Signer callback
  signal?: AbortSignal;           // Abort signal for cancellation
  onProgress?: (progress) => void; // Progress callback per transaction
  dryRun?: boolean;               // Skip signing/submission, return synthetic success
  throwOnError?: boolean;         // Throw if any tx fails
}
```

### Output: BatchSubmitResult

```ts
interface BatchSubmitResult {
  allSucceeded: boolean;          // true only if every tx succeeded
  firstFailureIndex: number;      // Index of first failed tx, or -1
  outcomes: BatchTxOutcome[];     // Per-transaction results
}

interface BatchTxOutcome {
  index: number;
  method: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'ERROR';
  txHash?: string;    // Present if SUCCESS
  error?: string;     // Present if FAILED, SKIPPED, or ERROR
  dryRun?: boolean;   // true if this was a dry-run
}
```

**Status meanings:**

- `SUCCESS`: Confirmed on-chain; `txHash` is set.
- `FAILED`: Submitted but network rejected it; `error` describes the rejection.
- `SKIPPED`: Not submitted because an earlier tx in the batch failed (sequence numbers would be invalid).
- `ERROR`: Local or RPC error prevented submission; `error` describes it.

### Example: Submit with Signer

```ts
import { submitBatch } from '@streamfi/sdk';

const result = await submitBatch(built, 'https://soroban-testnet.stellar.org', {
  pollIntervalMs: 2000,
  maxPollAttempts: 20,
  sign: async (xdr) => {
    const tx = new Transaction(xdr, Networks.TESTNET_NETWORK_PASSPHRASE);
    tx.sign(keypair);
    return tx.toXDR();
  },
  onProgress: ({ index, method, status }) => {
    console.log(`[${index}] ${method}: ${status}`);
  },
});

if (result.allSucceeded) {
  console.log('✓ Batch complete');
} else {
  console.error(`✗ Failed at index ${result.firstFailureIndex}`);
  result.outcomes
    .filter(o => o.status === 'SKIPPED')
    .forEach(o => console.log(`  Skipped: [${o.index}] ${o.method}`));
}
```

### Example: Dry-Run (Preview without Submitting)

```ts
const result = await submitBatch(built, rpcUrl, {
  dryRun: true,
  sign: async (xdr) => xdr,  // Dummy signer
});

// All outcomes will have status: 'SUCCESS' and dryRun: true
console.log('Would succeed:', result.allSucceeded);
```

### Handling Mid-Batch Failure

By design, if transaction N fails, all transactions N+1... are marked `SKIPPED` (their sequence numbers are now invalid):

```ts
result.outcomes.forEach((o) => {
  if (o.status === 'SUCCESS') {
    console.log(`✓ [${o.index}] ${o.txHash}`);
  } else if (o.status === 'SKIPPED') {
    console.log(`⊘ [${o.index}] Skipped (batch failed earlier)`);
  } else {
    console.log(`✗ [${o.index}] ${o.error}`);
  }
});
```

---

## Cancellation

Pass an `AbortSignal` to cancel an in-progress operation:

```ts
const controller = new AbortController();

const promise = client.streams.batchWithdraw([...], {
  signal: controller.signal,
});

// Later...
controller.abort();  // Cancels pending operations

try {
  await promise;
} catch (err) {
  if (err instanceof OperationAbortedError) {
    console.log(`Cancelled: ${err.operation}`);
  }
}
```

---

## Type Hints for Complex Parameters

When passing parameters that aren't naturally encoded as expected (e.g., a `u64` stream ID that would default to `i64`), use the `types` map:

```ts
const operations = [
  {
    method: 'create_stream',
    params: {
      recipient: 'G...',
      amount: '1000000000',      // Could be parsed as i128 by default
      start_time: 1700000000,    // Could be parsed as i64 by default
      end_time: 1700100000,
    },
    types: {
      amount: 'u128',            // Force u128
      start_time: 'u64',         // Force u64
      end_time: 'u64',
    },
  },
];
```

Available types: `u32`, `i32`, `u64`, `i64`, `u128`, `i128`, `u256`, `i256`, `string`, `symbol`, `address`, `bool`, `bytes`.

---

## Limitations

- **One operation per transaction:** Soroban limits each transaction to one `InvokeHostFunction` operation. Batches build N transactions, not one.
- **Sequence numbers:** Transactions are pre-sequenced and must be submitted in order. A failed transaction fails all subsequent ones.
- **No partial retries:** If transaction 3 fails, transactions 4+ are skipped. You must retry the entire batch or cherry-pick survivors.
