# React Hooks Guide for @streamfi/react

The `@streamfi/react` package provides a set of React hooks that simplify stream management in React applications. These hooks handle loading states, error management, and transaction tracking automatically.

## Overview

All hooks require a `ConduitClient` instance, either passed explicitly or accessed via the `useConduitClient` hook that reads from the `<ConduitClientProvider>` context.

## useTransferRecipient

Transfers stream ownership to a new recipient.

### Usage

```ts
import { useTransferRecipient } from '@streamfi/react';

function TransferButton() {
  const streamId = 123n;
  const { transferRecipient, isPending, error, txHash } = useTransferRecipient(streamId);

  const handleTransfer = async () => {
    try {
      const hash = await transferRecipient('GXXXXX...');
      console.log('Transfer submitted:', hash);
    } catch (err) {
      console.error('Transfer failed:', err);
    }
  };

  return (
    <div>
      <button onClick={handleTransfer} disabled={isPending}>
        {isPending ? 'Transferring...' : 'Transfer Recipient'}
      </button>
      {error && <p className="error">{error.message}</p>}
      {txHash && <p className="success">TX: {txHash}</p>}
    </div>
  );
}
```

### Return Type

```ts
interface UseTransferRecipientResult {
  transferRecipient: (newRecipient: string, overrideStreamId?: bigint | string) => Promise<string>;
  isPending: boolean;
  error: Error | null;
  txHash: string | null;
}
```

### Parameters

- `streamId` (optional): The stream to transfer. If not provided, you can pass it to `transferRecipient()` as `overrideStreamId`.
- `options` (optional): `{ client?: ConduitClient }` — supply a custom client instance if not using the context provider.

---

## useFeeEstimate

Estimates the fee for a stream operation without submitting it.

### Usage

```ts
import { useFeeEstimate } from '@streamfi/react';

function CreateStreamForm() {
  const operation = {
    asset: 'USDC',
    amount: '1000',
    startTime: Math.floor(Date.now() / 1000) + 3600,
    endTime: Math.floor(Date.now() / 1000) + 86400,
  };

  const { estimate, isLoading, error } = useFeeEstimate(operation, { enabled: true });

  return (
    <div>
      {isLoading && <p>Calculating fee...</p>}
      {error && <p className="error">{error.message}</p>}
      {estimate !== null && <p>Estimated fee: {estimate} stroops</p>}
    </div>
  );
}
```

### Return Type

```ts
interface UseFeeEstimateResult {
  estimate: number | null;
  isLoading: boolean;
  error: Error | null;
}
```

### Parameters

- `operation` (optional): A stream operation object or a string method name. Pass `null` to disable estimation.
- `options` (optional):
  - `enabled`: Enable/disable fee estimation (default: `true`). Useful for controlling when estimation runs.
  - `client`: Custom `ConduitClient` instance.

---

## useBatchWithdraw

Withdraws from multiple streams in a single batch operation.

### Usage

```ts
import { useBatchWithdraw } from '@streamfi/react';

function WithdrawMultipleButton() {
  const { batchWithdraw, isPending, error, results } = useBatchWithdraw();

  const handleWithdraw = async () => {
    try {
      const outcomes = await batchWithdraw([
        { streamId: 1n, amount: '100' },
        { streamId: 2n, amount: '50' },
      ]);
      console.log('Batch result:', outcomes);
    } catch (err) {
      console.error('Batch failed:', err);
    }
  };

  return (
    <div>
      <button onClick={handleWithdraw} disabled={isPending}>
        {isPending ? 'Withdrawing...' : 'Batch Withdraw'}
      </button>
      {error && <p className="error">{error.message}</p>}
      {results.length > 0 && (
        <ul>
          {results.map((r) => (
            <li key={r.streamId}>
              Stream {r.streamId}: {r.status}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

### Return Type

```ts
interface UseBatchWithdrawResult {
  batchWithdraw: (withdrawals: BatchWithdrawItem[]) => Promise<BatchWithdrawResult[]>;
  isPending: boolean;
  error: Error | null;
  results: BatchWithdrawResult[];
}
```

### Parameters

- `options` (optional): `{ client?: ConduitClient }` — supply a custom client instance.

---

## useStreamBalance

Polls for the current withdrawable balance of a stream at a configurable interval.

### Usage

```ts
import { useStreamBalance } from '@streamfi/react';

function StreamBalanceDisplay() {
  const streamId = 123n;
  const { withdrawable, isLoading, error } = useStreamBalance(streamId, {
    intervalMs: 5000,  // Poll every 5 seconds
    enabled: true,     // Enable/disable polling
  });

  if (isLoading && withdrawable === null) return <p>Loading...</p>;
  if (error) return <p className="error">{error.message}</p>;

  const balanceXlm = withdrawable ? Number(withdrawable) / 1e7 : 0;
  return <p>Withdrawable: {balanceXlm} XLM</p>;
}
```

### Return Type

```ts
interface UseStreamBalanceResult {
  withdrawable: bigint | null;
  isLoading: boolean;
  error: Error | null;
}
```

### Parameters

- `streamId` (optional): The stream to monitor. Pass `null` to stop polling.
- `options` (optional):
  - `intervalMs`: Poll interval in milliseconds (default: `5000`).
  - `enabled`: Enable/disable polling (default: `true`).
  - `client`: Custom `ConduitClient` instance.

---

## Providing a Client

To avoid passing `client` to every hook, wrap your app with `ConduitClientProvider`:

```tsx
import { ConduitClientProvider } from '@streamfi/react';
import { ConduitClient } from '@streamfi/sdk';

const client = new ConduitClient({ network: 'testnet' });

export default function App() {
  return (
    <ConduitClientProvider client={client}>
      <YourApp />
    </ConduitClientProvider>
  );
}
```

All hooks will now automatically use the provided client from context.

---

## Error Handling

Each hook exposes an `error` field that captures:

- Network errors (see {@link StreamFiNetworkError})
- Contract errors (see {@link ConduitError} and subclasses)
- Validation errors (see {@link ValidationError})
- Timeout errors (see {@link IndexerTimeoutError}, {@link RateLimitError})

Refer to the [error-handling guide](./error-handling.md) for strategies to catch and respond to specific error types.

---

## Advanced: Combining Hooks

A common pattern is to disable operations while a fee estimate is still loading:

```ts
function StreamForm() {
  const operation = buildOperation(formState);
  const { estimate, isLoading: feeLoading } = useFeeEstimate(operation);
  const { transferRecipient, isPending } = useTransferRecipient(streamId);

  const isReady = !feeLoading && estimate !== null;
  return (
    <button onClick={() => transferRecipient(newRecipient)} disabled={!isReady || isPending}>
      {!isReady ? 'Calculating...' : isPending ? 'Transferring...' : 'Transfer'}
    </button>
  );
}
```
