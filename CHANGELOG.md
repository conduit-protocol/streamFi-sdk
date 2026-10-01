# Changelog

All notable changes are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `@streamfi/react`: `useNetworkSwitcher()` hook and reactive network switching in `StreamFiProvider` (`network`, `setNetwork`, `isSupportedNetwork`, `availableNetworks`), allowing dApps to switch between Stellar networks seamlessly without remounting or managing out-of-band state (#833).
- `ConduitClient.network` getter returning the active configured network (`Network`).
- `NETWORK_NAMES`, `EXPLORER_URLS`, and `NetworkType` provide shared human-readable Stellar network labels and Stellar Expert transaction, contract, and account URL bases (#832).
- `TokenModule` exposes SEP-41 `allowance()` and `approve()` operations through `client.tokens`, and `@streamfi/react` now exports `useTokenAllowance()` for allowance verification and approval state (#851).
- `FactoryModule.streamAddresses(ids[], signal?, options?)` resolves a page of stream IDs to contract addresses in one call, returning a `Map` keyed by decimal stream-id string (`null` for ids the contract reports as not-found). Rendering a page of `streamsBySender()` results no longer costs one simulated RPC round trip per row on a cold cache: duplicate and string/bigint id forms are de-duplicated, only the cache-miss subset is fetched, and in-flight simulations are bounded by `options.maxConcurrency` (default 8) to match a default `stellar-rpc`'s 8 preflight workers. Every id is resolved through `streamAddress()`, so the address cache, its hit/miss counters and the negative-cache TTL are shared with single-id lookups; a resolution that throws propagates and is never cached as a not-found result. `StreamAddressesOptions` is exported from the package entry point (#783).
- `ConduitConfig.governorConfigCacheTtlMs` (default 30_000) bounds how long a `GovernorModule.getConfig()` read is reused. Protocol parameters only change when a governance proposal passes, so a dashboard polling `getConfig()` on an interval no longer pays a simulation per tick for data that is almost always unchanged. Concurrent misses share a single simulation, a failed simulation is never cached, each caller gets its own object so mutating a result cannot corrupt what the next caller sees, and `clearConfigCache()` forces the next call to re-simulate. Set the TTL to `0` to disable caching (#785).
- `timeoutSignal(ms)` utility (exported from the package root and `/utils`) — a portable `AbortSignal` that aborts after `ms`, using the native `AbortSignal.timeout()` when available and falling back to `AbortController` + `setTimeout` (with `unref()` on Node) otherwise. Pass it as `signal` to any method that accepts one (#634).
- `examples/quickstart.ts` — a runnable, end-to-end create -> accrue -> withdraw script on testnet, and the README Quickstart now mirrors it (#633).
- `GraphQLIndexer.query()` now accepts optional `timeoutMs` (default 15s) and `signal` on `GraphQLQueryOptions` and wires a per-request `AbortController` into the underlying `fetch`, so a hung/slow indexer no longer leaves the caller's `await` pending forever. On timeout it rejects with a `IndexerTimeoutError` (endpoint + `timeoutMs` exposed); a caller-supplied `signal` surfaces the underlying `AbortError`. `IndexerTimeoutError` and `DEFAULT_INDEXER_TIMEOUT_MS` are exported from the package entry point (#569).
- `CAIP2_TO_NETWORK` is now exported — a single CAIP-2→network map shared by `ConduitClient`'s wallet-network check and `WalletConnectAdapter`'s construction-time validation, which previously kept independent verbatim copies (#445)
- `NonceManager` (with its `NonceLock` / `NonceManagerOptions` types) is now exported from the package entry point; the bigint-based `src/nonce/NonceManager.ts` is the only implementation (#483)
- `normalizeProgress(value)` utility (exported) — maps `streamProgress()`'s open-ended-stream `NaN` result to the midpoint `0.5`; `Module36` and `Module48` now share it instead of each reimplementing the check (#482)
- `subscribe()` accepts `maxBackoffMs` (default 60000) and `maxConsecutiveFailures` (default 10) — event polling now applies exponential backoff after consecutive failures and stops against a permanently-broken endpoint (#485)
- `StreamsModule.streamedTotal()` — read-only wrapper for `DripStream::streamed_total`, exposing the cumulative amount streamed since start regardless of withdrawals (#455)
- `StreamsModule.estimateFee(operation)` runs a Soroban simulation for any stream operation and returns the exact estimated network fee (`FeeEstimate` with `totalFee`, `resourceFee`, `baseFee`, `instructions`) so the UI can display the fee before the user clicks "Create Stream".
- `Module36` stream snapshot diff engine with LRU memoization for Feature #36 (#370); `getPerformanceMetrics()` reports an honest, workload-dependent measured speedup rather than a fixed percentage
- `Module26` stream portfolio aggregator with LRU memoization for Feature #26 (#360); `getPerformanceMetrics()` reports an honest, workload-dependent measured speedup rather than a fixed percentage
- Direct unit tests closing the `src/soroban.ts` test gaps: `queryXlmBalance()` (mocked `simulateTransaction` responses, incl. the error path) and `estimateRequiredFee()` (fallback value + `minResourceFee`/`fee` extraction shapes) (#460, #461)
- Direct unit tests for `resolvePassphrase()` covering explicit passphrase present/blank, named network known/unknown, and neither-provided branches (#462)
- `StreamsModule.forceCancel()` — wraps the contract's `force_cancel()` so a recipient can force-cancel a stream paused beyond the 30-day threshold (previously only a prose TODO; `StreamErrorCode.PauseThresholdNotMet` is now reachable through the SDK) (#453)
- `StreamsModule.transferRecipient()` — wraps the contract's `transfer_recipient()` so the current recipient can reassign the recipient role (previously only a prose TODO) (#454)
- `ConduitConfig.fee` / `ConduitConfig.feeMultiplier` — configure the inclusion (bid) fee for submitted transactions, via `resolveFee()` (exported from `src/soroban.ts`) and a new `fee` parameter on `buildContractCallTx()`. Previously every transaction hardcoded `fee: BASE_FEE` with no override, so under inclusion-fee pressure a 100-stroop bid would never be selected (#509)
- `StreamEventHandlers.onCreated`, `.onForceCancel`, `.onRecipientTransfer`, `.onOperatorSet`, `.onOperatorRevoke` — `dispatchEvent()` previously silently ignored the `created`, `force_cxl`, `xfer_rec`, `set_op`, and `rm_op` contract topics, so a live subscriber was never notified when the recipient role was transferred, a paused stream was force-cancelled by the recipient, or an operator was delegated/revoked (#506)
- `Module44` stream liquidity-risk / runway calculator for Feature #44 (#378); follows `Module26`/`Module36`/`Module48`'s shared `LruMemoCache` pattern and reports an honest, workload-dependent `measuredSpeedupPercent` rather than a fixed percentage. Classifies each stream's remaining runway into `'inactive' | 'critical' | 'warning' | 'healthy'` and exposes `estimateTopUpNeeded()` to compute the stroops needed to reach a target runway
- `NonceManager` (the bigint-based, queue-with-cancellation implementation) is now exported from the package entry point, along with its `NonceLock`/`NonceManagerOptions` types. Previously neither `NonceManager` implementation was reachable outside SDK source (#483).
- `subscribeToStream()` / `client.streams.subscribe()` now accept `maxBackoffMs` and `maxConsecutiveFailures` options controlling the new exponential-backoff-with-cutoff polling behaviour (#485).
- `paramToScVal(value, type?)` accepts an explicit ScVal type hint (`'u64'`, `'i128'`, ...) and passes already-encoded `xdr.ScVal`s through untouched; `BatchOperation.types` supplies per-field type information for the `params` map (e.g. `{ streamId: 'u64', amount: 'i128' }`) so a u64 stream ID or an i128 amount encodes with the exact width the contract expects instead of the default inference (#497).

### Performance
- `FactoryModule.streamAddress()` now caches resolved stream→contract-address lookups in-memory, since the mapping is fixed at stream creation and never changes. Eliminates redundant RPC round trips on every `StreamsModule` read/write operation (`get`, `withdraw`, `cancel`, `pause`, `resume`, `topUp`, `clawback`) and on each page of `list()`, which previously re-resolved the same address for every stream on every call.
- `buildBatchTransactions()` (the RPC-prepared batch path) now simulates all operations in a batch concurrently instead of one at a time, cutting the wall-clock time of an N-operation batch from N sequential RPC round trips to one.

### Changed
- `ConduitClient.setWallet()` now propagates the new wallet to an already-constructed `FactoryModule`, whose read simulations are sourced from the active wallet. Previously the JSDoc documented `FactoryModule` as "not updated … does not hold a wallet reference and is unaffected by setWallet()", which contradicted the module's own `setWallet()`/`activeWallet` support and left a dApp that swapped wallets with a `client.factory` still simulating as the previous wallet. `FactoryModule.setWallet()` itself is unchanged and remains public API (#784).
- `StreamsModule.topUpStream()` is documented as the string-typed convenience wrapper over `topUp()` that it is, including which one new code should prefer. Both call the same contract method with the same validation; `topUpStream` additionally cannot forward an `AbortSignal` (#786).
- `StreamsModule.getStreamInfos({ maxConcurrency })` now treats a bound below 1 (or a non-finite one) as 1 instead of resolving to no results at all. The shared `mapWithConcurrency` helper and its default bound moved to `src/map-with-concurrency.ts` so the paged `list()` path and `FactoryModule.streamAddresses()` cannot drift apart (#783).
- `u64ToScVal()` now rejects a non-integer `number` or a negative value with a clear `RangeError` naming the argument, and `estimateRequiredFee()` guards every `BigInt(...)` coercion (truncating a numeric input, catching an un-parseable one) and falls through to `fallbackStroops` — a non-conforming RPC response with a float `minResourceFee` no longer aborts a `create()` with a raw `RangeError` out of the fee-estimation path (#577).
- `StreamsModule` now routes all signer-selection logic through its private `_signer()` helper instead of touching `config.signer` directly, removing dead code (#446).
- CAIP-2→network mapping consolidated into a single exported `CAIP2_TO_NETWORK` constant shared by `ConduitClient`'s wallet network check and `WalletConnectAdapter`'s chain validation, so the two can never disagree (#445).
- **Breaking (encoded ScVal types):** `paramToScVal()` no longer forces every integer `number` to `i64` and every `bigint` to `i128`. Untyped positive integers now encode as `u64` and negatives as `i64` — matching the contract's u64 ABI fields (`create_stream`'s `start_time`/`end_time`, stream IDs), which previously arrived with the wrong ScVal type and were rejected contract-side (#497).

### Removed
- Removed orphaned `RoomManager` (`src/room-manager.js`) and `src/server.js` WebSocket server, along with unused `dotenv` production dependency (#442).
- Removed unused `GraphSyncAgent` (`src/graph-sync-agent.ts`) dead code (#443).
- **Breaking (internal only — never exported):** Removed the duplicate, number-based `NonceManager` (`src/nonce-manager.ts`), which stored nonces as a JS `number` and so couldn't represent Stellar int64 sequence numbers above 2^53. `src/nonce/NonceManager.ts`'s bigint-based implementation is now the only `NonceManager` and is exported from the package entry point (#483).
- Removed dead `Module46` string-normalization wrapper (`src/module46.ts`) — never exported from `src/index.ts` and unreferenced elsewhere (#478).


### Documentation
- Added an error-code collision warning to `ConduitError.fromContractError()`
  and `ConduitError.fromSorobanMessage()` so callers are reminded to pass the
  contract that produced the error; the same numeric code has different
  meanings across the stream, factory, and governor contracts (#790).
- Documented the relationship between `StreamsModule.topUp()` and
  `StreamsModule.topUpStream()`: `topUpStream()` is the string-argument
  convenience wrapper for `topUp()`, while both perform the same stream
  deposit operation. New integrations should use whichever argument type best
  matches their input, and upgrades do not require a migration between them
  (#791).
- Removed non-existent `contracts/*-abi.ts` entry from `docs/architecture.md` module map (#440).
- Replaced orphaned `MAX_ROOM_SIZE` `.env.example` with a comprehensive SDK environment configuration template and updated `README.md` (#441).
- Added an API reference section for `GraphQLIndexer`, which was previously exported but undocumented.
- Added a "Wallet Adapters" API reference section documenting `KeypairWalletAdapter`.
- Documented `StreamBuilder.ratePerSecond()` and `StreamBuilder.submit()` (with full `SubmitOptions`) in `docs/api.md`, previously omitted from the Fluent Builder reference (#463).
- Documented `ConduitClient`'s `pauseStream()`, `unpauseStream()`, and `setWallet()` convenience methods in `docs/api.md`, and fixed `setWallet()`'s JSDoc block, which had been orphaned above `pauseStream()`/`unpauseStream()` and left `setWallet()` itself undocumented.
- Documented `subscribe()`'s `onError`, `maxBackoffMs`, and `maxConsecutiveFailures` options and the `getLatestLedger()`-seeded first poll in `docs/api.md` (#484, #485), and removed the stale "internal, not exported" note from the `NonceManager` reference now that it's a public export (#483).
- Removed the stale duplicate `## Configuration` heading in `README.md` (renamed the environment-variables section to `## Environment Variables`), the non-existent `src/contracts/*-abi.ts` entries and `rollup.config.ts` (actual file is `rollup.config.mjs`) from "Directory Structure", and the Quickstart snippet that logged a raw stroops `bigint` labelled `'USDC'`. Replaced the "companion `@conduit-protocol/react` package (coming in v0.2)" claim — `@streamfi/react` (`packages/react`) already ships `StreamFiProvider`/`useStream`/`useCreateStream`/`useStreamFiClient` — with an accurate usage example, and removed the correspondingly stale `### Planned` changelog entries below. Bumped `package.json`'s `version` from `0.1.0` to `0.2.0` to match the already-released `[0.2.0]` entry below it (#495).
- Documented `StreamBuilder.startTime()`/`endTime()`/`clawbackEnabled()`/`toContractArgs()`/`toBatchOperation()` in `docs/api.md`, and added a note under `ConduitBatcher` clarifying that `execute()` alone cannot build a real `create_stream` invocation (#435).

### Fixed
- `formatAmount()` no longer returns a signed-zero string (`"-0"`) for negative stroop values that scale to nothing, and a non-finite `decimals` argument now falls back to 7 instead of producing `NaN`-scaled output. Property/fuzz tests lock the round-trip and no-throw invariants (#618).
- `ConduitBatcher.execute()`'s `create_stream` path now builds ABI-exact positional args — `deposit_amount`/`rate_per_sec` as `i128`, `start_time`/`end_time` as `u64` (honoring `startTime`/`endTime`/`clawbackEnabled` when present) — instead of feeding raw values through the old blanket i64/i128 encoding (#497).
- Removed a duplicate `let consecutiveFailures = 0;` declaration in `src/events.ts` that made the module a `SyntaxError` at load time, breaking `npm run typecheck`, the `npm ci` build, and every event-subscription test.
- `GraphQLIndexer.subscribe()` no longer tears down silently when the WebSocket closes. An unexpected close calls `onError` and retries with the same linear backoff as `WebSocketRelayer` (`reconnectDelayMs * attempt`, default 5 attempts / 1000ms). The subscription is removed only after the retry budget is exhausted or the caller unsubscribes. Optional `maxReconnectAttempts` / `reconnectDelayMs` are rejected if they are not integers in range. SSE fallback is unchanged (#514).
- `FactoryModule` now resolves its read-simulation source address from a configured `wallet` adapter (lazily, `async`, cached, invalidated on the new `FactoryModule.setWallet()`), matching `StreamsModule._resolveCallerAddress`. Previously it pinned `keypair?.publicKey() ?? ZERO_ADDR` at construction, so a wallet-configured client used `ZERO_ADDR` for every factory read while `StreamsModule` resolved the wallet — the same logical caller resolved differently per module (#570).
- `FactoryModule.streamAddress()` now caches a `null` (not-found) result for a short TTL (`NEGATIVE_ADDRESS_CACHE_TTL_MS`, 30s), and adds `FactoryModule.clearAddressCache()`. Previously only a *found* address was cached, so a dashboard polling a `list()` page containing a few archived/pending ids re-issued a `stream_address` simulation for each of them on every refresh (#568).
- `NonceManager.safeAcquire()` now enqueues exactly one waiter and keeps its queue position across every retry (re-arming the per-attempt timeout), instead of `enqueue()`-ing a fresh waiter each attempt. Previously a retrying caller went to the back of the line on every retry while cancelled entries piled up in `lockQueue`, so a caller that kept just missing the window could be starved indefinitely while later arrivals succeeded. Adds an optional `perAttemptTimeoutMs` parameter (default 5000, matching the previous implicit value) (#572).
- `subscribeToStream()` (`client.streams.subscribe()`) now seeds `startLedger` from `server.getLatestLedger()` before its first `getEvents()` call. Previously the first poll omitted `startLedger` entirely (it started at `0` and was only included once `> 0`), so Soroban RPC's `getEvents` rejected every call, the rejection was swallowed, and the subscription never delivered a single event (#484).
- `subscribeToStream()` now backs off exponentially (`pollInterval * 2^(consecutiveFailures - 1)`, capped at the new `maxBackoffMs`) after consecutive polling failures instead of retrying at a fixed interval forever, and stops polling once `maxConsecutiveFailures` consecutive failures have occurred instead of spinning against a permanently-broken RPC endpoint indefinitely (#485).
- `Module36` and `Module48` no longer each maintain their own copy of the "open-ended stream progress (`NaN`) → `0.5`" normalization. It's now a single shared `normalizeProgress()` in `src/utils.ts`, closing the gap where the two modules' progress calculations could in principle drift out of sync at the edges (#482).
- `Module26`, `Module36`, `Module48`, and `Module49` now share a single `LruMemoCache` helper (`src/lru-memo-cache.ts`) for eviction (and, for the first three, hit/miss speedup measurement) instead of each re-implementing the same LRU-memoizer logic (#479).
- `Module26.aggregatePortfolio()` now fingerprints the portfolio with two incremental hashes (FNV-1a + djb2) instead of building a full `items.map(...).join('|')` string on every call, including cache hits — for a large portfolio that string could run to many KB and dominated the "cached" path, so `measuredSpeedupPercent` mostly measured string building rather than the aggregation it memoizes. Two independent hashes are combined into the key rather than one, since a single 32-bit hash would make wrong-portfolio cache collisions realistic at long-running-instance scale (#480).
- `Module48.processSingleItem()` now updates `totalProcessed` and the execution-time accumulator on every call, so `getPerformanceMetrics().averageExecutionTimeMs` is accurate whether streams are processed via `processStreamBatch()` or by calling `processSingleItem()` directly; previously only `processStreamBatch()` touched `totalProcessed`, so direct `processSingleItem()` calls always reported `averageExecutionTimeMs: 0` (#481).
- **Breaking:** `RateLimitError.fromRpcError()` no longer conflates HTTP 503 (Service Unavailable) with 429 (Too Many Requests). A 503 is now reported as a distinct exported `RpcServiceUnavailableError`, and the internal RPC retry wrapper only backoff-retries genuine `RateLimitError`s — a 503 fails fast so consumers can fail over to a different RPC URL instead of retrying a dead endpoint (#456).
- `catchNetworkError()` no longer reclassifies *any* `TypeError` whose text happens to contain `fetch`/`connect`/`network`/etc. It now only reclassifies errors that are provably transport failures: the canonical fetch/axios network messages (`fetch failed`, `Failed to fetch`, `Network Error`, `Load failed`) or an error (or its nested `cause`) carrying a network errno code such as `ECONNREFUSED`/`ENOTFOUND`/`ERR_NETWORK`. A programming `TypeError` (e.g. `Cannot read properties of undefined (reading 'connect')`) is re-thrown as-is instead of being masked as a network outage (#457).
- `NonceManager` now throws a descriptive error for an unparseable nonce string (e.g. `startNonce: 'not-a-number'`) instead of silently coercing it to `0n`, which masked caller bugs as an explicit zero (#458).
- `StreamBuilder.build()` now stringifies a numeric `ratePerSecond` so the runtime value matches the declared `ratePerSecond?: string` return type; previously a `number` input passed through unchanged, so callers trusting the type (`.trim()`, string concatenation) hit runtime errors (#459).
- `StreamsModule.batchWithdraw()` now submits withdrawals one at a time instead of firing them all concurrently via `Promise.allSettled(...map)`. Concurrent submission meant every withdrawal read the same account sequence number from `getAccount()` and built a transaction with the same value — with a single keypair/wallet, at most one of the N withdrawals could ever land, the rest failing with `txBAD_SEQ`, defeating the whole purpose of a batch (#504)
- `src/streams.ts` was missing its `Signer` type import, so `npm run build` / `npm run typecheck` failed unconditionally on `main` (`Cannot find name 'Signer'`) — added the missing `import type { Signer } from './signer.js'`.

- `StreamsModule.withdraw()` / `topUp()` now reject `amount <= 0n` client-side (before any RPC round-trip), matching `create()`'s fail-fast validation philosophy instead of relying on the contract's `InvalidAmount` simulate+reject cycle (#451)
- `StreamsModule.list()` no longer silently drops `recipient` when both `sender` and `recipient` are provided — it now returns the de-duplicated union of both filters (#452)
- **Critical:** `FeeEstimator.estimateFee()` now uses `bigint` stroops instead of floating-point for fee representation, eliminating IEEE-754 precision loss. All monetary amounts in the SDK now consistently use bigint to avoid rounding errors.
- **Critical:** `WalletConnectAdapter.signTransaction()` now requires `networkPassphrase` to be explicitly provided, preventing silently reconstructed Transaction objects with empty passphrases. Throws clear error if passphrase is missing.
- **Critical:** `StreamBuilder.submit()` now properly removes failed payloads from `pendingQueue` in a finally block, preventing queue overflow from accumulated failed submissions under sustained network failures.
- **Breaking:** `ConduitBatcher` state is now instance-based instead of process-wide static singleton. Each `new ConduitBatcher()` instance maintains independent queue and destroy state. Existing code using static methods must be updated to create instances.
- **Critical:** Validation bypass in `ConduitBatcher.execute()` — duplicate method definition allowed invalid payloads to bypass client-side validation. Now enforces mandatory schema validation before submission.
- **Critical:** Unsafe non-null assertions in `WalletConnectAdapter.getPublicKeyFromSession()` — replaced with safe fallback handling using optional chaining and nullish coalescing. Prevents crashes on malformed CAIP-10 formats.
- RPC timeout handling in `WalletConnectAdapter.connect()` — properly clears timeout promise on success to prevent hanging when network drops during handshake.
- `StreamBuilder` now collects `startTime`, `endTime`, and `clawbackEnabled`, and exposes `toContractArgs()`/`toBatchOperation()`, which produce the exact positional, ABI-typed arguments (`sender, recipient, token, deposit_amount: i128, rate_per_sec: i128, start_time: u64, end_time: u64, clawback_enabled: bool`) the real `DripFactory.create_stream` call expects. Previously, passing `StreamBuilder.build()`'s output straight into `ConduitBatcher` produced a camelCase map with `amount` encoded as `i64` and no start/end/clawback fields at all, so a stream built via the Fluent Builder could never successfully invoke the real contract (#435).
- `create-streamfi-app` now scaffolds from a bundled, StreamFi-wired Next.js template (a copy of `examples/nextjs-app`) by default, and writes `.env.local` with the variable names the app actually reads (`NEXT_PUBLIC_NETWORK`, `FACTORY_ADDRESS`, `STELLAR_SECRET`, `NEXT_PUBLIC_ADDRESS`) instead of `NEXT_PUBLIC_STELLAR_NETWORK`/`NEXT_PUBLIC_STELLAR_RPC_URL`/`NEXT_PUBLIC_STELLAR_HORIZON_URL`, which nothing in the codebase ever read. Previously it cloned an unrelated third-party Next.js boilerplate with no Stellar/StreamFi wiring and wrote env vars the scaffolded app ignored, so a freshly-scaffolded project could never connect. `--template <url>` still clones an external starter for anyone who wants one (#436, #494).

---

## [0.2.0] - 2026-03-21

### Added
- Full `StreamsModule` implementation: `create`, `get`, `withdrawable`, `withdraw`, `cancel`, `pause`, `resume`, `topUp`, `clawback`, `list`
- `GovernorModule.getConfig()` — fetches and parses `GovernorConfig` ScMap from chain
- `FactoryModule`: `streamCount()`, `streamAddress()`, `streamsBySender()`, `streamsByRecipient()`, `protocolFeeBps()`
- `buildContractCallTx` helper in `soroban.ts` — builds a fee-bumped, sequence-correct Soroban transaction ready for simulation
- `boolToScVal`, `scValToI128`, `scValToU64` conversion utilities
- Unit tests for `FactoryModule` and `StreamsModule` with mocked RPC

### Changed
- `streams.clawback()` now returns the reclaimed amount (`bigint`) rather than the transaction hash — extracted from the simulation retval before submission
- `streams.withdraw()` `amount` parameter is now optional; defaults to the full withdrawable balance via a preliminary `withdrawable()` call

---

## [0.1.0] - 2026-02-28

### Added
- `ConduitClient` with `streams`, `factory`, and `governor` modules
- `ConduitError` class with `fromContractError()` static constructor
- `ErrorCode` enum matching all 12 contract error codes
- `toStroops`, `fromStroops`, `calculateRate`, `streamProgress`, `withdrawableLocal` utilities
- Event subscription via `streams.subscribe()` and `streams.subscribeAsync()` — polls Soroban event ledger
- Type definitions: `StreamInfo`, `CreateStreamParams`, `CreateStreamResult`, `ListStreamsParams`, `GovernorConfig`, all event types
- ESM + CJS dual bundle output via Rollup
- Unit tests for pure utilities and error handling
