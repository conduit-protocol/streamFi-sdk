# Changelog

All notable changes are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
