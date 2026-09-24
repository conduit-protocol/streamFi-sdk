# Testing components that use `@conduit-protocol/sdk`

Any app built on `ConduitClient` eventually needs tests that don't hit real Stellar RPC/indexer
endpoints. You don't need to reimplement the SDK's internals to do this — `ConduitClient` is
mocked at the module level, and only the handful of methods your component actually calls need a
fake implementation.

This pattern is exercised directly in
[`packages/react/src/__tests__/useStream.test.tsx`](../packages/react/src/__tests__/useStream.test.tsx)
and
[`packages/react/src/__tests__/useCreateStream.test.tsx`](../packages/react/src/__tests__/useCreateStream.test.tsx).
The examples below are extracted from those tests.

## The pattern

1. Mock the `@conduit-protocol/sdk` module so that `new ConduitClient(...)` returns a plain object
   with only the sub-interfaces (`streams`, `factory`, `governor`) your component touches.
2. Back each method you use with a `vi.fn()` you control per-test.
3. Render your component inside `StreamFiProvider` — it's the thing that actually constructs
   `ConduitClient` from `config`, so the mock above is what it receives.

You don't need a full fake of `ConduitClient` — a narrower shape like `{ streams: { get } }` or
`{ streams: { create } }` is enough as long as it covers what the hook under test calls.

## Example: testing a component that uses `useStream`

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { StreamFiProvider, useStream } from '@conduit-protocol/react';
import type { StreamInfo } from '@conduit-protocol/sdk';

const mockGet = vi.fn();

// Mock the SDK module — ConduitClient's constructor returns our fake `streams.get`.
vi.mock('@conduit-protocol/sdk', () => ({
  ConduitClient: vi.fn(function () {
    return { streams: { get: mockGet } };
  }),
}));

function TestStream({ id }: { id: string }) {
  const { stream, loading, error } = useStream(id);
  if (loading) return <div data-testid="loading">loading</div>;
  if (error) return <div data-testid="error">{error.message}</div>;
  if (!stream) return <div data-testid="empty">no-stream</div>;
  return <div data-testid="stream-token">{stream.token}</div>;
}

describe('useStream', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('shows loading then data', async () => {
    const fakeStream: StreamInfo = {
      id: 42n,
      address: 'C...',
      sender: 'G...',
      recipient: 'G...',
      token: 'native',
      ratePerSecond: 100n,
      startTime: 1000,
      endTime: 2000,
      withdrawn: 0n,
      paused: false,
      pausedAt: 0,
      cancelled: false,
      clawbackEnabled: false,
    };
    mockGet.mockResolvedValue(fakeStream);

    const config = { network: 'testnet' as const };
    render(
      <StreamFiProvider config={config}>
        <TestStream id="42" />
      </StreamFiProvider>,
    );

    expect(screen.getByTestId('loading')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('stream-token')).toHaveTextContent('native'));
  });

  it('shows error on failure', async () => {
    mockGet.mockRejectedValue(new Error('not found'));

    const config = { network: 'testnet' as const };
    render(
      <StreamFiProvider config={config}>
        <TestStream id="99" />
      </StreamFiProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('not found'));
  });
});
```

## Example: testing a component that uses `useCreateStream`

Same pattern, different fake surface (`streams.create` instead of `streams.get`):

```tsx
const mockCreate = vi.fn();

vi.mock('@conduit-protocol/sdk', () => ({
  ConduitClient: vi.fn(function () {
    return { streams: { create: mockCreate } };
  }),
}));

// ...render a component that calls useCreateStream(), then:
mockCreate.mockResolvedValue({ streamId: 1n, streamAddress: 'C...', txHash: '0x...' });
// or
mockCreate.mockRejectedValue(new Error('insufficient balance'));
```

See
[`useCreateStream.test.tsx`](../packages/react/src/__tests__/useCreateStream.test.tsx)
for the full test, including asserting on `loading`/`error`/`result` state transitions.

## Notes

- `StreamInfo` fields that are `bigint` (`id`, `ratePerSecond`, `withdrawn`) need real `bigint`
  literals (`42n`), not numbers — the SDK's types don't accept a plain `number` there.
- If your component only needs a subset of `client.streams` (e.g. just `get`), only fake that
  subset — you don't need to stub every `StreamsModule` method to satisfy TypeScript, since the
  mock factory replaces the whole module import rather than being type-checked against
  `ConduitClient`.
- `client.factory` and `client.governor` follow the same pattern if your component reads from
  them directly — fake only the methods you call, e.g. `{ factory: { ... }, streams: { ... } }`.
