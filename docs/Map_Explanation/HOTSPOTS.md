# Hotspots: World ZDO Density (Potential Load)

The plugin emits a single hotspot stream representing persistent world ZDO density.


Key behavior:
- Zones are computed by math only: `zx = floor(x / 64f)`, `zy = floor(z / 64f)`.
- The scan is **incremental**: only a chunk of ZDOs is scanned per 30s bucket.
- Each emitted event carries **chunk deltas** for that bucket.
- The aggregator builds a full cache and derives quantiles (p90/p99) for ampel colors.

## Config

```
[Hotspots]
WorldZdoScanPerBucket = 10000  ; number of ZDOs scanned per 30s bucket
WorldZdoPayloadCapEnabled = false  ; optional payload cap (Top-N only when enabled)
WorldZdoPayloadCapTopN = 500       ; Top-N zones per bucket when cap is enabled
```

## Contract (zdo_schema)

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

Semantics:
- `count` is the **chunk delta** for this bucket only.
- `epoch` increments when the scan cursor wraps; the aggregator lazily overwrites counts on first sight per epoch.

## Scan Disabled Event

If the world ZDO scan is disabled due to reflection failure, a one-time JSONL line is emitted:

```
{
  "type": "scan_disabled_reason",
  "feature": "world_zdo_scan",
  "reason": "...",
  "exception_type": "...",
  "exception_message": "...",
  "plugin_version": "...",
  "game_version": "...",
  "t": "<ISO-8601 UTC>",
  "timestamp_utc": "<ISO-8601 UTC>"
}
```

This line is written to `hotspots_world_zdos.jsonl` and is informational only.

## Telemetry

Rate-limited (about once per minute) in the server log:
- `World ZDO scan: scanned=<n> epoch=<n> wrapped=<true|false> zonesEmitted=<n>`

## Manual Test

1) Start server and plugin, wait a few buckets.
2) Verify `hotspots_world_zdos.jsonl` is being appended and `bucket_s` is always 30.
3) Confirm `zones` are non-empty while scanning the world and `zx/zy` are signed.
4) Watch telemetry lines to ensure scanning progresses and wraps over time.
