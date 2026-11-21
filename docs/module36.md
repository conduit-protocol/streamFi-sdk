# Module 36

Stream snapshot diff engine (SDK Feature #36) with LRU-memoized diffing.

## API

### `diffSnapshots(previous, current)`

Compares two `StreamSnapshot` observations and returns withdrawable/progress deltas plus status-change detection.

### `diffBatch(pairs)`

Diffs many snapshot pairs in a single pass with a pre-sized result buffer.

### `getPerformanceMetrics()`

Returns `totalDiffs`, `cacheHits`, `cacheMisses`, `averageExecutionTimeMs`, and `measuredSpeedupPercent` — the last one is computed from this instance's own accumulated hit/miss timings (`(avgMissMs - avgHitMs) / avgMissMs * 100`), not a fixed assumption. It's `null` until at least one hit and one miss have both been recorded.
