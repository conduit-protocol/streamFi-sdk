# Architecture

Module map and call flow for `conduit-sdk`. For the full method-by-method reference, see
[`docs/api.md`](./api.md).

---

## Module map

```
index.ts          — public exports: ConduitClient, ConduitError/ErrorCode, types, utils
client.ts         — ConduitClient: owns config, instantiates the three modules below
  ├─ streams.ts    — StreamsModule:  create/get/withdraw/cancel/pause/resume/topUp/clawback/list/subscribe
  ├─ factory.ts    — FactoryModule:  streamCount/streamAddress/streamsBySender/streamsByRecipient/protocolFeeBps
  └─ governor.ts   — GovernorModule: (config reads — see docs/api.md)
soroban.ts         — buildContractCallTx/simulateReadOnly + NETWORK_PASSPHRASE/DEFAULT_RPC tables
events.ts          — subscribeToStream: polls getEvents(), dispatches to typed handlers
errors.ts          — ConduitError + ErrorCode, mapped from on-chain contract error codes
utils.ts           — toStroops/fromStroops/calculateRate/streamProgress/withdrawableLocal (pure, no RPC)
contracts/*-abi.ts — generated-style ABI/method-name constants per contract
```

`ConduitClient` is a thin composition root — it resolves the RPC URL (`config.rpcUrl ??
DEFAULT_RPC[network]`) and hands the same config to `StreamsModule`, `FactoryModule`, and
`GovernorModule`. Each module is otherwise independent; there's no shared mutable state between
them beyond that config object.

---

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

## Events — read the caveat before relying on payload fields

`events.ts` polls `SorobanRpc.Server.getEvents()` and dispatches by topic name. As of this
version, only the `amount` field (for `onWithdraw`/`onClawback`) is actually decoded from the
event's XDR value — every other numeric field on the other handlers (`onCancel`, `onPause`,
`onResume`, `onTopUp`) is a hardcoded `0`/`0n` placeholder, because the underlying contract
events publish multi-value tuples and the parser only handles the single-value case so far. See
[`docs/api.md`](./api.md#subscribestreamid-handlers--subscription) for the full list of affected
fields. Treat these events as a "something changed, go refetch" signal rather than a source of
truth, until tuple decoding is implemented.

---

## What's *not* wrapped yet

`DripStream::force_cancel`, `transfer_recipient`, and `streamed_total` exist on the contract
(see `conduit-contracts`) but have no corresponding methods on `StreamsModule` yet.
