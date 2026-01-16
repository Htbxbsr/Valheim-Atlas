# Hotspots State (Aggregator)

Hotspots are derived from **World ZDO Density (Potential Load)**. 

## Stream: `hotspots_world_zdos` (zdo_schema)

The plugin emits incremental chunk deltas per 30s bucket:

```
{
  "type": "hotspots_world_zdos",
  "schema": "zdo_schema",
  "t": "<ISO-8601 UTC>",
  "bucket_s": 30,
  "epoch": <int>,
  "zones": [{ "zx": <int>, "zy": <int>, "count": <int> }]
}
```

## Aggregator Semantics

- Maintains a **full per-zone cache** of counts for the current epoch.
- On epoch change, the cache is **not wiped**; counts are overwritten lazily:
  - The first time a zone is seen in the new epoch, its count is replaced with the new value.
  - Subsequent chunk entries for that zone in the same epoch are additive.
- Each zone entry in `zones` is an **additive delta** to the cache (after the first seen replacement).
- Every emitted frame includes:
  - `frame.hotspots.world_zdos`: top 500 zones by count.
  - `frame.hotspots_meta.world_zdos.p90` and `.p99` computed from **all** cached zones.
  - `frame.hotspots_meta.world_zdos.epoch` reflecting the current scan epoch.

## Quantiles

- `p90` and `p99` are recomputed every 10 frames (~5 minutes at 30s cadence).
- Viewer uses these thresholds with minimum guards:
  - `yellow_th = max(p90, 800)`
  - `red_th = max(p99, 2000)`
  - Green: `< yellow_th`
  - Yellow: `>= yellow_th`
  - Red: `>= red_th`

## Startup Rehydration

On aggregator startup, world ZDO density follows a 3-step path:
1) Load persisted cache from `state/world_zdos_cache.json` (instant).
2) If no cache, tail-rehydrate the last 120 buckets from `hotspots_world_zdos.jsonl`.
3) Continue live ingestion from offsets; if the world-zdos offset is missing, it is set to EOF to avoid double counting.

## Manual Regression Checklist

1) PlayerPositions TTL still removes markers after 10 frames.
2) PlayerFlow TTL still expires edges after 10 frames (no restart refresh).
3) World ZDO Density:
   - `hotspots_world_zdos.jsonl` lines appear every 30s with `epoch`.
   - Viewer shows green/yellow/red heatmap once quantiles exist.
   - Quantiles update roughly every 5 minutes.

No other streams (player_positions/player_flow) are modified by this logic.
