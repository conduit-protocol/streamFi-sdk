# Module 26

Stream portfolio aggregator (SDK Feature #26) with LRU-memoized summaries.

## API

### `aggregatePortfolio(items, nowSec?)`

Aggregates withdrawable totals, active rate-per-second, and lifecycle counts (`active` / `paused` / `cancelled` / `ended`).

### `projectRemaining(stream, horizonSecs, nowSec?)`

Projects remaining BigInt accrual for an active stream over a horizon, capped by `endTime`.

### `getPerformanceMetrics()`

Returns `totalAggregations`, `cacheHits`, `cacheMisses`, `averageExecutionTimeMs`, and `measuredSpeedupPercent` — the last one is computed from this instance's own accumulated hit/miss timings (`(avgMissMs - avgHitMs) / avgMissMs * 100`), not a fixed assumption. It's `null` until at least one hit and one miss have both been recorded.
