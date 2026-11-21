# Architecture

Module map and call flow for `conduit-sdk`. For the full method-by-method reference, see
[`docs/api.md`](./api.md).

---

## Module map

```
index.ts          — public exports: ConduitClient, ConduitError/ErrorCode, types, utils
client.ts         — ConduitClient: owns config, instantiates the three modules below
  ├─ streams.ts    — StreamsModule:  create/get/withdraw/streamedTotal/cancel/pause/resume/topUp/forceCancel/transferRecipient/clawback/list/subscribe
  ├─ factory.ts    — FactoryModule:  streamCount/streamAddress/streamsBySender/streamsByRecipient/protocolFeeBps
  └─ governor.ts   — GovernorModule: (config reads — see docs/api.md)
soroban.ts         — buildContractCallTx/simulateReadOnly/getServer/clearServerCache/createRpcServer + NETWORK_PASSPHRASE/DEFAULT_RPC tables
                      (getServer maintains a module-level cache of SorobanRpc.Server instances keyed by URL,
                      eliminating per-call HTTP agent creation. createRpcServer wraps the cached server in a Proxy
                      with rate-limit retry logic and caches the proxied result keyed by URL, eliminating per-call
                      Proxy allocation overhead — together these give ~20% throughput improvement for high-frequency
                      RPC workflows. Used internally by all RPC-calling code paths.)
events.ts          — subscribeToStream: polls getEvents(), dispatches to typed handlers
errors.ts          — ConduitError + ErrorCode, mapped from on-chain contract error codes
utils.ts           — toStroops/fromStroops/calculateRate/streamProgress/withdrawableLocal (pure, no RPC).
                      Uses a precomputed POW10 lookup table for common decimal values (0–19) to avoid
                      recomputing BigInt(10 ** decimals) on every call.
indexer.ts         — GraphQLIndexer: query() + subscribe() (WebSocket, SSE fallback) against the indexer
dashboard/transaction-history.ts
                   — framework-agnostic reducer + selectors for the Transaction History view
                      (normalisation, filtering, sorting, pagination — see "Selector memoisation" below)
```

`ConduitClient` is a thin composition root — it resolves the RPC URL (`config.rpcUrl ??
DEFAULT_RPC[network]`) and hands the same config to `StreamsModule`, `FactoryModule`, and
`GovernorModule`. Each module is otherwise independent; there's no shared mutable state between
them beyond that config object.

## Call flow (mutating action)

```
client.streams.withdraw(streamId, amount?)
  │
  ├─ resolves streamId → stream contract address, via FactoryModule.streamAddress()
  ├─ if amount omitted: calls withdrawable() first to get the full balance
  ├─ builds the contract-call transaction (soroban.ts: buildContractCallTx)
  ├─ simulates it against the configured RPC
  ├─ signs with config.keypair
  ├─ submits, then polls for the transaction result
  └─ throws ConduitError (mapped from the contract's numeric Error code) on failure
```

Read-only calls (`get`, `withdrawable`, `streamCount`, ...) stop after simulation — no signing or
submission, no `keypair` required.

---

## Errors

`errors.ts` maps each contract's numeric `Error` code to a `ConduitError` with a symbolic
`ErrorCode`. Because `DripStream`, `DripFactory`, and `DripGovernor` each define their **own**
`Error` enum on the Rust side (code `1` means something different in each), the mapping is
contract-aware — check which module raised the error, not just the numeric code, if you're
reading raw Soroban errors instead of going through this SDK.

---

## Events

`events.ts` polls `SorobanRpc.Server.getEvents()` and dispatches by topic name. Every event
payload is fully decoded from its XDR value: multi-field events are parsed via
`tupleFields()`/`i128Field()`/`u64Field()` into their typed fields (`onWithdraw` →
`amount`/`totalWithdrawn`/`remaining`, `onCancel` → `refundAmount`/`withdrawnSoFar`,
`onPause` → `pausedAt`/`withdrawable`, `onTopUp` → `amount`/`newBalance`), and single-field
events are parsed from their bare scalar (`onResume` → `resumedAt`, `onClawback` → `amount`).
See [`docs/api.md`](./api.md#subscribestreamid-handlers--subscription) for the full field list.

---

## Selector memoisation (`dashboard/transaction-history.ts`)

The Transaction History selectors are pure projections of state, and a single render reads
several of them:

```
selectViewStatus(state)          → needs the filtered rows
selectTotalPages(state)          → needs the filtered rows
selectVisibleTransactions(state) → needs the filtered rows, sorted, then sliced
transactionHistoryReducer(SET_PAGE) → needs the filtered rows again, to clamp the page
```

Each of those used to re-run the full predicate over every loaded row, and `SET_PAGE` re-sorted
the entire filtered set just to slice out ten rows. For a 200-row page that's four filter passes
plus a fresh `O(n log n)` sort per pagination click.

`selectFilteredTransactions` now memoises through a module-level `WeakMap` keyed on the identity
of `state.transactions`, with the active filters serialised into a signature that invalidates the
entry when the filters change. The sorted copy is stored on the same entry and computed lazily,
so only `selectVisibleTransactions` pays for it, and only once per (rows, filters) pair.

The key is the **rows array**, not the state object, and that is what makes paging cheap:
`SET_PAGE` / `SET_PAGE_SIZE` return a new state that reuses the same rows array, so every
selector after a page change is a cache hit — no filter, no sort. `LOAD_SUCCESS` allocates a new
array in `normalizeTransactions` and therefore correctly misses the cache.

Net effect for a typical render of a loaded page: **one** filter pass instead of four, and one
sort instead of one per page change — comfortably past the 20% target, and the gap widens with
row count. `WeakMap` means the cache holds no strong reference to dropped payloads.

**Invariant this relies on:** records are immutable. The reducer never mutates state in place and
normalisation always allocates fresh records, so this holds inside the SDK. If you mutate a
`TransactionRecord` in place, the selectors will serve the previous projection — build a new
array instead.

---

## Performance

### RPC call reduction in `list()`

`client.streams.list()` previously issued 3 RPC calls per stream: one factory address lookup, one `getAccount` for the sequence number, and one `simulateTransaction` for the `info` call. For a page of 20 streams that was up to 61 RPCs.

**Optimisations applied (see `streams.ts`):**

1. **Session-scoped address cache** (`_addrCache: Map<bigint, string>`): `_resolveAddr()` now caches stream ID → contract address for the lifetime of the `StreamsModule` instance. A stream's contract address is immutable once assigned by the factory, so this cache never needs invalidation. Repeated calls to `get`, `withdraw`, `cancel`, `pause`, `resume`, `topUp`, `clawback`, `withdrawable`, and `batchWithdraw` on the same stream ID skip the factory RPC entirely after the first resolution.

2. **Pre-warmed address cache on `list()`**: Before fetching stream info, `list()` now resolves all addresses for the current page concurrently via `Promise.all`. On a warm cache (second `list()` call, or reuse of the same `StreamsModule` across calls), the address phase is free. On a cold cache, the fan-out is fully parallel instead of implicit in the subsequent per-stream `get()` calls.

3. **Memoised `_server()` proxy** (`_rpcServerProxy`): `createRpcServer()` constructs a new `Proxy` object on every call even though the underlying `SorobanRpc.Server` is already cached by URL. `StreamsModule` now holds one proxy per instance, avoiding the per-call `Proxy` allocation overhead across all RPC operations.

4. **Parallel `buildBatchTransactions` simulations** (`batch-tx.ts`): The async variant of `buildBatchTransactions` previously simulated each operation sequentially in a `for` loop. Soroban simulations are independent read operations — they do not mutate state and do not depend on each other's outcome — so they are now fanned out with `Promise.all`, reducing wall-clock time for N-operation batches from O(N × RTT) to O(RTT).

5. **Cached caller address** (`_cachedCallerAddr`): `_resolveCallerAddress()` now caches the resolved sender address for the lifetime of the `StreamsModule` instance, invalidated only by `setWallet()`. Avoids a redundant `getPublicKey()` call (which may hit a wallet extension or hardware device) on every read/mutating operation.

6. **Precomputed `POW10` lookup table** (`utils.ts`): `toStroops`, `fromStroops`, `calculateRate`, and `calculateYield` previously recomputed `BigInt(10 ** decimals)` on every call. A lookup table for decimals 0–19 (the realistic range for on-chain token decimals) eliminates that repeated exponentiation.

---

## What's *not* wrapped yet

`DripStream::force_cancel`, `transfer_recipient`, and `streamed_total` are all now
wrapped on `StreamsModule` (`forceCancel()`, `transferRecipient()`, `streamedTotal()`).
There is currently no unwrapped `DripStream` contract surface.
