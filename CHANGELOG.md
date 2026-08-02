# Changelog

All notable changes are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `StreamsModule.estimateFee(operation)` runs a Soroban simulation for any stream operation and returns the exact estimated network fee (`FeeEstimate` with `totalFee`, `resourceFee`, `baseFee`, `instructions`) so the UI can display the fee before the user clicks "Create Stream".
- `Module36` stream snapshot diff engine with LRU memoization for Feature #36 (#370); `getPerformanceMetrics()` reports an honest, workload-dependent measured speedup rather than a fixed percentage
- `Module26` stream portfolio aggregator with LRU memoization for Feature #26 (#360); `getPerformanceMetrics()` reports an honest, workload-dependent measured speedup rather than a fixed percentage

### Performance
- `FactoryModule.streamAddress()` now caches resolved stream→contract-address lookups in-memory, since the mapping is fixed at stream creation and never changes. Eliminates redundant RPC round trips on every `StreamsModule` read/write operation (`get`, `withdraw`, `cancel`, `pause`, `resume`, `topUp`, `clawback`) and on each page of `list()`, which previously re-resolved the same address for every stream on every call.
- `buildBatchTransactions()` (the RPC-prepared batch path) now simulates all operations in a batch concurrently instead of one at a time, cutting the wall-clock time of an N-operation batch from N sequential RPC round trips to one.

### Documentation
- Added an API reference section for `GraphQLIndexer`, which was previously exported but undocumented.
- Added a "Wallet Adapters" API reference section documenting `KeypairWalletAdapter`.
- Documented `ConduitClient`'s `pauseStream()`, `unpauseStream()`, and `setWallet()` convenience methods in `docs/api.md`, and fixed `setWallet()`'s JSDoc block, which had been orphaned above `pauseStream()`/`unpauseStream()` and left `setWallet()` itself undocumented.

### Fixed
- **Critical:** `FeeEstimator.estimateFee()` now uses `bigint` stroops instead of floating-point for fee representation, eliminating IEEE-754 precision loss. All monetary amounts in the SDK now consistently use bigint to avoid rounding errors.
- **Critical:** `WalletConnectAdapter.signTransaction()` now requires `networkPassphrase` to be explicitly provided, preventing silently reconstructed Transaction objects with empty passphrases. Throws clear error if passphrase is missing.
- **Critical:** `StreamBuilder.submit()` now properly removes failed payloads from `pendingQueue` in a finally block, preventing queue overflow from accumulated failed submissions under sustained network failures.
- **Breaking:** `ConduitBatcher` state is now instance-based instead of process-wide static singleton. Each `new ConduitBatcher()` instance maintains independent queue and destroy state. Existing code using static methods must be updated to create instances.
- **Critical:** Validation bypass in `ConduitBatcher.execute()` — duplicate method definition allowed invalid payloads to bypass client-side validation. Now enforces mandatory schema validation before submission.
- **Critical:** Unsafe non-null assertions in `WalletConnectAdapter.getPublicKeyFromSession()` — replaced with safe fallback handling using optional chaining and nullish coalescing. Prevents crashes on malformed CAIP-10 formats.
- RPC timeout handling in `WalletConnectAdapter.connect()` — properly clears timeout promise on success to prevent hanging when network drops during handshake.

### Planned
- `@conduit-protocol/react` hooks package (`useStream`, `useWithdraw`, `useStreamList`)
- Support for `transfer_recipient()` contract function
- `streams.forceCancel()` wrapping the new `force_cancel()` contract function

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
