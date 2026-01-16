# Valheim Atlas - System Documentation (Current Codebase)

This document describes the current codebase behavior and structure.
It is subordinate to CONTRACT.md.
If SYSTEM.md and CONTRACT.md disagree, CONTRACT.md always wins.


## 1) Overview

Valheim Atlas is a Valheim performance visualization pipeline:

- **Plugin (C#)** emits JSONL streams from a running Valheim server.
- **Aggregator (Python)** ingests JSONL streams and produces time-bucketed frames.
- **Viewer (HTML/JS)** renders frames on a map with overlays.

It is an analysis/diagnostics tool, not a replay system.


## 2) Repository Structure

Top-level folders and roles:

- `ValheimHeatFlowPlugin/` — BepInEx plugin source + build artifacts.
- `input/` — JSONL inputs consumed by the aggregator.
- `out/` — Viewer assets and frame outputs.
- `state/` — Aggregator offsets + cached world ZDO state.
- `docs/` — Technical notes and audits.


## 3) Plugin (ValheimHeatFlowPlugin)

**Primary files:** `ValheimHeatFlowPlugin/Class1.cs`, `ValheimHeatFlowPlugin/Class2.cs`

### 3.1 Role

The plugin runs inside the Valheim server and emits JSONL streams:

- `player_positions.jsonl`
- `player_flow.jsonl`
- `hotspots_world_zdos.jsonl` (`zdo_schema`)

### 3.2 World ZDO Density (hotspots_world_zdos)

- Emission cadence is fixed to 30 seconds.
- Each event carries **chunk deltas** (`zones` list) plus an `epoch` that increments when the scan cursor wraps.
- Zone coordinates are derived by math only: `zx = floor(x/64)`, `zy = floor(z/64)`.

### 3.3 Player Flow / Positions

- Flow is aggregated per zone-to-zone transition inside a bucket.
- Player positions are sampled from current peers and emitted per bucket.


## 4) Aggregator (aggregator.py)

### 4.1 Role

The aggregator ingests JSONL streams and writes frame outputs:

- `out/frame_live.json`
- `out/frames/frame_YYYYMMDDTHHMMSS.json`
- `out/manifest.json`

It is a data-processing component only. It does not render and does not compute biomes.

### 4.2 Inputs

Expected JSONL inputs (`input/`):

- `player_positions.jsonl`
- `player_flow.jsonl`
- `hotspots_world_zdos.jsonl`

### 4.3 World ZDO Cache and Epochs

- Maintains a full per-zone cache of world ZDO counts.
- On `epoch` change, the cache is **not wiped**; counts are overwritten lazily:
  - First observation of a zone in a new epoch replaces the cached count.
  - Subsequent chunk entries for that zone in the same epoch are additive.
- Frames include `hotspots.world_zdos` (TopN by count) and `hotspots_meta.world_zdos` (p90/p99 + epoch).

### 4.4 TTL (Players and Flow)

TTL is frames-based and enforced in the aggregator:

- Player markers persist for 10 emitted frames after last update.
- Flow edges persist for 10 emitted frames after last update, keyed by directed transitions.


## 5) Viewer (out/index.html + viewer modules)

### 5.1 Role

The viewer loads frames + manifest and renders via `out/viewer.data.js`, `out/viewer.render.js`, `out/viewer.ui.js`.

- World ZDO density heatmap.
- Player positions.
- Player flow.
- Optional locations overlay.

### 5.2 Projection

World coordinates are projected to pixels for display only.
Projection does not affect aggregation or data logic.

### 5.3 Biomes (TileGrid Lookup)

Biome lookup is performed client-side using:

- `out/map/data/map.json`
- `out/map/data/tiles/*.bin.gz`

The viewer reads the tile sample `uint16 biome` field and decodes it as a bitmask.

### 5.4 UI Behavior

- LIVE mode polls `frame_live.json`.
- ARCHIVE mode scrubs `out/frames/` using `manifest.json`.
- ARCHIVE uses a bounded frame buffer; LIVE uses a bounded ring buffer.
- Hotspot rendering can use a union window over the last N frames in the current buffer/ring.
- Transport controls advance ARCHIVE frames at fixed frames/sec; seek jumps to nearest frame by time.
- Debug overlay is always visible and shows inspection information.


## 6) Data Flow Summary

Valheim Server
-> Plugin JSONL (input/)
-> Aggregator (frames + manifest)
-> Viewer (rendered map + overlays)


## 7) Local Running (Typical)

- Start the plugin in a Valheim server with BepInEx.
- Run `aggregator.py` to ingest JSONL and emit frames.
- Serve `out/` via a static HTTP server and open `out/index.html`.


## 8) Non-Goals

- No server-side API.
- No map edits or gameplay effects.
- No biome computation in the aggregator.
