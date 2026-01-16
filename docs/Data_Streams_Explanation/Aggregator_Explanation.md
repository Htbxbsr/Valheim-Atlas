# Data Streams & Aggregator Startup (Detailed)

This document explains how the Python aggregator (`aggregator.py`) ingests input streams,
initializes state on startup, and emits frames/manifest outputs.

## 1) Input Streams (JSONL)

The aggregator tails these files (relative to the configured input directory):

- `player_positions.jsonl`
- `player_flow.jsonl`
- `hotspots_world_zdos.jsonl`

Each line is a JSON object and must include:
- `t` (ISO‑8601 UTC, ending with `Z`)
- `type` (stream identifier)

Lines that fail JSON parsing or timestamp validation are ignored.
For `hotspots_world_zdos`, `schema` is required and must be `zdo_schema`; missing/unknown schema is dropped and counted as a schema error.

## 2) State Files

The aggregator persists state in `state/`:

- `state/offsets.json` — per‑stream offsets and counters
- `state/world_zdos_cache.json` — world ZDO cache for fast startup

## 3) Startup Sequence (Order of Operations)

On startup, `aggregator.py`:

1) **Loads offsets**
   - Reads `state/offsets.json` if present.
   - Each stream has: file signature, offset, total lines, total events, last event timestamp.
2) **Initializes live state**
   - Builds empty in‑memory structures for players, flow, and world ZDO cache.
3) **World ZDO cache rehydration**
   - Attempts to load `state/world_zdos_cache.json`.
   - If missing, tail‑rehydrates the last 120 buckets from `hotspots_world_zdos.jsonl`.
4) **Offsets normalization**
   - If offsets are missing for the world ZDO stream, it sets the world_zdos offset to EOF.
   - This avoids replaying historical data after a tail‑rehydrate.
5) **Enters main loop**
   - Polls each input file for new lines.
   - Ingests events and updates in‑memory state.
   - Emits frames every cadence bucket (default 30s).

## 4) Per‑Stream Ingestion Behavior

### 4.1 player_positions

- Each event includes a `players` list.
- The aggregator stores the latest position per player ID.
- TTL is applied on frame emission (10 frames).

### 4.2 player_flow

- Each event includes a `transitions` list.
- Edges are directed: `(fx, fy) -> (tx, ty)`.
- TTL is applied on frame emission (10 frames).
- Edge intensity persists while TTL > 0.

### 4.3 hotspots_world_zdos

- Each event includes `zones` with `{zx, zy, count}` and `epoch`.
- Counts are **chunk deltas** for a scan slice.
- The aggregator maintains a per‑zone cache:
  - On epoch change, cache is not wiped.
  - The first time a zone appears in a new epoch, its count is replaced.
  - Subsequent chunks in the same epoch add to that zone’s count.

## 5) Frame Emission (Every Cadence Bucket)

On each cadence boundary:

1) TTL is applied:
   - Players and flow edges are decremented or removed.
2) Quantiles are recomputed:
   - World ZDO p90/p99 every 10 frames.
3) Frame is written:
   - `out/frame_live.json`
   - `out/frames/frame_YYYYMMDDTHHMMSS.json`
4) Manifest is updated periodically:
   - `out/manifest.json`

## 6) Failure Handling & Resets

- If an input file is replaced/truncated:
  - The stream state is reset (offset, counters, last timestamp).
- If a line is malformed:
  - It is skipped (no crash).
- World ZDO cache rehydration is best‑effort:
  - If cache load fails and tail rehydrate fails, the cache starts empty.

## 7) Practical Notes

- The aggregator is **file-tailing** only; it does not open sockets or run a server.
- Frames are deterministic by cadence bucket time.
- The viewer renders whatever frames contain; it does not apply TTL itself.

## 8) Ops Quick Check

Use these quick checks to validate a healthy deployment:

- `out/health.json` updates every few seconds.
- `out/frame_live.json` updates every cadence bucket (default 30s).
- `out/frames/frame_*.json` grows over time (archive frames).
- `out/manifest.json` updates frequently (about every 2s).
- Stream health in `out/health.json` shows:
  - increasing `lines_read` and `events_parsed`
  - low `parse_errors`/`schema_errors`
  - recent `last_event_ts` and `last_ingest_ts`

If `scan_disabled_reason` appears in `hotspots_world_zdos.jsonl`, the world ZDO scan has been disabled by the plugin for this session.

## 9) Monthly Rotation (raw JSONL + frames)

Use `tools/rotate_monthly.py` during a restart window (before the plugin starts) to rotate raw JSONL streams and archive previous-month frames.
Defaults auto-discover raw/frames directories under the repo root; override with `--raw-dir`, `--frames-dir`, `--archive-dir`.

Examples:
- `python tools/rotate_monthly.py --dry-run`
- `python tools/rotate_monthly.py`
