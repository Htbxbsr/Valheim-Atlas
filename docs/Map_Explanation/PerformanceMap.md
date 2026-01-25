# Valheim Atlas - Performance Map

This document describes the **Performance Map** feature in the Valheim Atlas system.
It follows the conventions and terminology used in `CONTRACT/CONTRACT.md` and `CONTRACT/SYSTEM.md`.

If this document conflicts with the contract, `CONTRACT/CONTRACT.md` wins.


## 1. Purpose and Overview

The Performance Map is a **visual analysis tool** for Valheim server activity.
It aggregates server-side data into time-based frames and renders them on a world map:

- world ZDO density hotspots
- player positions
- player flow (movement between zones)

The Performance Map is **not** a replay system; it is a heat/flow analysis layer.
It never modifies server data and never feeds back into gameplay logic.


## 2. System Architecture

The system has three strictly separated layers:

```
Valheim Server
  -> Input JSONL (World/Zone space)
  -> Aggregator (Python)
  -> JSON Frames (out/)
  -> Viewer (JS/Canvas)
  -> Map rendering
```

### 2.1 Data Sources

Inputs are JSONL streams written by the Valheim server/plugin:

- `player_positions.jsonl`
- `player_flow.jsonl`
- `hotspots_world_zdos.jsonl` (`zdo_schema`)

All spatial values are interpreted in **World Space (x,z in meters)** or **Zone Space (zx,zy)**.

### 2.2 Data Flow

1) **Aggregator** reads input streams, tracks offsets, and aggregates into time buckets.
2) **Frames** are written to `out/frame_live.json` and `out/frames/frame_*.json`.
3) **Manifest** `out/manifest.json` describes cadence and available frames.
4) **Viewer** loads frames and renders the map in the browser.

### 2.3 Update Logic

Aggregator:
- Polls input files on a fixed interval (`--poll`, default 1s).
- Buckets output frames by cadence (`--cadence`, default 30s).
- Writes:
  - `frame_live.json` (latest state)
  - archived frames per cadence bucket
  - `manifest.json` (refreshed periodically)

Viewer:
- Live mode pulls `frame_live.json` on a fixed interval.
- Scrub mode loads archived frames by index from the manifest list.
- Flow visualization aggregates a short window of recent frames (N=5).
- Archive mode uses a bounded frame buffer; LIVE uses a bounded ring buffer.
- Hotspots can be rendered as a union window over the last N frames in the current buffer/ring.
- Transport controls advance ARCHIVE frames at fixed frames/sec (1x/3x/5x); seek jumps to nearest frame by time.
- A top-left Players HUD lists the frame-scoped players and supports click-to-center + follow (follow is reliable in Firefox; Chrome may be inconsistent).


## 3. Core Components

### 3.1 Aggregator (Python)

**Location:** `aggregator.py`

Responsibilities:
- Read JSONL input streams.
- Aggregate hotspots per zone.
- Aggregate player flow per zone-to-zone transition.
- Record player positions (world or zone space as provided).
- Persist offsets and basic stream counters.

Does NOT:
- Compute biomes
- Interpret PNG pixels
- Perform any rendering logic

Key behaviors:
- Zone aggregation uses fixed `ZoneSize = 64` (see contract).
- Flow counts are additive per edge key (`zx,zy -> zx,zy`).
- Per-cadence aggregates are reset after each frame is written.

### 3.2 Output JSON Structures

`out/frame_live.json` and `out/frames/frame_*.json`:

```json
{
  "meta": {
    "schema": "...",
    "t": "YYYY-MM-DDTHH:MM:SSZ",
    "counts": { "...": 123 },
    "presence": "ignored"
  },
  "players": [
    {"id": "...", "name": "...", "x": ..., "z": ..., "zx": ..., "zy": ...}
  ],
  "flow": [
    {"a":{"zx":...,"zy":...}, "b":{"zx":...,"zy":...}, "c": 5}
  ],
  "hotspots": {
    "world_zdos": [{"zx":...,"zy":...,"count":...}]
  },
  "hotspots_meta": {
    "world_zdos": {"p90":..., "p99":..., "epoch":...}
  }
}
```

### 3.3 Player Position TTL (Frames-Based)

Player markers use a **frames-based TTL**:

- A player persists for **10 emitted frames** after the last update.
- Any new update resets TTL to 10 and moves the marker in the next frame.
- If no updates arrive, the player is removed after 10 frames.

This TTL is enforced in the **Aggregator** so frames remain authoritative.

### 3.4 Player Flow TTL (Frames-Based)

Flow edges use a **frames-based TTL** keyed by directed zone transitions:

- Edge key: `(a.zx, a.zy) -> (b.zx, b.zy)` (directional).
- TTL is **10 emitted frames** after the last update.
- “c” persists as the **last known intensity** while TTL > 0 (Variant 1).
- When a new flow event arrives, its edge intensity is updated for the current frame and TTL resets.

Flow remains anonymous; the Viewer does not enforce TTL and renders exactly what frames contain.

Startup behavior:
- Rehydration from tail logs does **not** refresh flow TTL.
- Only truly new flow events reset the TTL window.

`out/manifest.json`:
- Lists available frames (`frames: [{sec, url}, ...]`).
- Provides cadence and time range metadata.

### 3.5 Viewer (JS/Canvas)

**Location:** `out/index.html` + viewer modules (`out/viewer.data.js`, `out/viewer.render.js`, `out/viewer.ui.js`)

Responsibilities:
- Load frames and manifest.
- Project world coordinates to pixel space for drawing.
- Render:
  - hotspots (world ZDO density)
  - player positions
  - player flow
- Provide inspection overlays and cursor coordinate HUD.

Rendering architecture:
- Two canvases: `mapCanvas` for the base map and `canvas` for overlays.
- Overlays are cached in map-space offscreen layers to reduce per-frame work.
- Chromium playback offloads heavy work to `out/viewer.decode.worker.js`:
  - Flow aggregation
  - Frame JSON parse/normalize
  - Union hotspots + buckets
  - Flow + player overlay rendering (ImageBitmap)
- If `OffscreenCanvas` is unavailable or the worker errors, the viewer falls back to main-thread rendering.

Biome lookup:
- Uses TileGrid data (`out/map/data/map.json` + `tiles/*.bin.gz`).
- Uses World Space (x,z) only; PNG is visualization only.
- Biome decoding uses bitmask values per contract.
- Tile gzip inflate + decode runs in a Web Worker (`out/viewer.tile.worker.js`) to keep UI responsive.

Flow rendering:
- Aggregates a window of recent frames (N=5) into edge counts.
- Clusters nearby, similarly directed edges to reduce clutter.
- Renders directional segments with width scaled by intensity.
Hotspot union window:
- In ARCHIVE, union uses only cached frames in the current buffer window.
- In LIVE, union uses only frames in the live ring buffer.
- Union uses max(count) per zone and applies TopN after merging.


## 4. Configuration

### 4.1 Required Files and Directories

```
input/
  player_positions.jsonl
  player_flow.jsonl
  hotspots_world_zdos.jsonl

out/
  index.html
  viewer.data.js
  viewer.render.js
  viewer.ui.js
  viewer.decode.worker.js
  frame_live.json
  frames/frame_*.json
  manifest.json
  map/
    data/
      map.json
      tiles/*.bin.gz
```

### 4.2 Aggregator Settings (CLI / Env)

Aggregator flags (see `aggregator.py`):

- `--root` (or `HEATFLOW_ROOT`)
- `--input` (or `HEATFLOW_INPUT_DIR`)
- `--out` (or `HEATFLOW_OUT_DIR`)
- `--state` (or `HEATFLOW_STATE_DIR`)
- `--poll` (or `HEATFLOW_POLL_S`)
- `--cadence` (or `HEATFLOW_CADENCE_S`)
- `--heartbeat` (or `HEATFLOW_HEARTBEAT_S`)

### 4.3 Viewer Settings

Viewer uses static assets under `out/` and a manifest-driven frame list.
UI toggles control visibility of layers (players, flow, world ZDO density, locations).
Query params (from `out/viewer.data.js`) control buffering and union behavior:
- `archiveBuffer` (default 120): archive cache window size.
- `archivePrefetch` (default 20): max archive prefetch per pump batch.
- `liveRing` (default 30): live ring buffer size.
- `union` (default 1): enable/disable union aggregation.
- `unionN` (default 5): union window size.
- `unionTopN` (default 500): TopN applied after union merge.

Playback tuning (Chromium only, optional):
- `playOverlayFps` (default 28): overlay rebuild cap during playback.
- `playOverlayScale` (default 0.7): downscale flow+players overlays during playback.
- `playFlowFps`, `playPlayersFps`: per-layer FPS overrides.
- `playFlowScale`, `playPlayersScale`: per-layer scale overrides.


## 5. Limitations and Design Decisions

- **World Space is the only logic source**; PNG is visualization only.
- **ZoneSize is fixed** at 64 meters.
- Flow data is aggregated and **anonymous**; it represents counts, not identities.
- The Viewer aggregates a short window of frames for flow to reduce noise.
- Static hosting: no backend services; all data is read from `out/`.


## 6. Future Extension Hooks

Safe extension points:
- Add new JSONL input streams and extend aggregator ingestion.
- Add new overlay layers in the Viewer that read the existing frame schema.
- Extend TileGrid usage for new metadata (if it remains World Space driven).

Changes that require refactoring:
- Altering output schemas without updating Viewer and contract.
- Introducing new coordinate systems for logic.
- Using PNG pixels for biome logic (explicitly forbidden).


## 7. Contract Alignment

This document adheres to the rules defined in:

- `CONTRACT/CONTRACT.md`
- `CONTRACT/SYSTEM.md`
