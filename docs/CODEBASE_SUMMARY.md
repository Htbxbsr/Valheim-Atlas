# Valheim Atlas Codebase Summary

## 1) Executive Summary

- This repository implements a Valheim **Performance Map**: a pipeline that logs server activity, aggregates it into time buckets, and renders it on a world map.
- A BepInEx plugin (`ValheimHeatFlowPlugin/Class1.cs`, `ValheimHeatFlowPlugin/Class2.cs`) emits JSONL streams for player positions, player flow, and world ZDO density.
- A Python aggregator (`aggregator.py`) ingests JSONL streams, tracks offsets, applies TTL to players/flow, and writes `out/frame_live.json`, `out/frames/frame_*.json`, and `out/manifest.json`.
- A browser viewer (`out/index.html`, `out/viewer.data.js`, `out/viewer.render.js`, `out/viewer.ui.js`) renders the map and overlays (players, flow, hotspots, locations) using HTML canvas.
- Chromium playback offloads heavy work to `out/viewer.decode.worker.js` (flow aggregation, JSON parse, union hotspots/buckets, flow/player rendering).
- Hotspots are currently **World ZDO Density** (`hotspots_world_zdos`, `zdo_schema`), computed as incremental deltas per bucket.
- Player positions and flow are TTL-based in the aggregator (10 emitted frames), and the viewer renders frames verbatim (`aggregator.py`, `docs/PlayerPositions_Audit.md`).
- The pipeline is file-based; no server-side API or database is present in code (`aggregator.py`, viewer modules).
- The viewer uses TileGrid data for biome lookup (`out/map/data/map.json`, viewer modules) and treats PNG pixels as visualization only.
- The plugin and aggregator are intentionally decoupled via JSONL streams (no direct RPC).
- Contract/system references live in `CONTRACT/CONTRACT.md` and `CONTRACT/SYSTEM.md`.

## 2) Architecture Overview

### Top-level folders

- `ValheimHeatFlowPlugin/` — BepInEx plugin (C#) that emits JSONL streams. Includes `lib/` with Valheim/Unity DLLs and build artifacts.
- `input/` — JSONL inputs for the aggregator (expected filenames from `STREAM_FILES` in `aggregator.py`).
- `out/` — Viewer assets and aggregator outputs (HTML/JS, manifest, frames, map data).
- `state/` — Aggregator state (offsets and world ZDO cache).
- `docs/` — Documentation and audits.

### Main components

- **Plugin**: `ValheimHeatFlowPlugin/Class1.cs`, `ValheimHeatFlowPlugin/Class2.cs`
  - Emits `player_positions.jsonl`, `player_flow.jsonl`, and `hotspots_world_zdos.jsonl`.
  - Uses BepInEx (`BepInEx.*`) and UnityEngine types.
- **Aggregator**: `aggregator.py`
  - Ingests JSONL streams (`STREAM_FILES`) and produces frames/manifest in `out/`.
  - Maintains offsets in `state/offsets.json` and a world ZDO cache in `state/world_zdos_cache.json`.
- **Viewer**: `out/viewer.data.js`, `out/viewer.render.js`, `out/viewer.ui.js`, `out/index.html`
  - Loads `out/manifest.json`, `out/frame_live.json`, and `out/frames/frame_*.json`.
  - Renders map overlays on canvas and provides an inspection/debug HUD.
  - Uses split canvases (`mapCanvas` + overlay `canvas`) and cached overlay layers.
  - Playback tuning params are exposed via query string (Chromium only).

### Data & control flow (high level)

1) **Plugin** writes JSONL streams to its config directory (`ValheimHeatFlowPlugin/Class1.cs`, `Class2.cs`).
2) **Aggregator** tails those files, aggregates per-cadence frames, and writes JSON frames + manifest (`aggregator.py`).
3) **Viewer** loads frames + manifest and renders overlays (viewer modules + `out/index.html`).

## 3) How It Works (End-to-End)

### Entry points and runtime flow

- **Plugin**:
  - `HeatFlowPlugin.Awake()` initializes config, writers, and bucket timers (`ValheimHeatFlowPlugin/Class1.cs`).
  - `HeatFlowPlugin.Update()` drives periodic sampling and bucket emission.
  - `PlayerPositionsLogger.Flush()` writes player positions (`ValheimHeatFlowPlugin/Class2.cs`).
  - `WriteFlowJsonl()` and `WriteWorldZdosJsonl()` write JSONL lines.
- **Aggregator**:
  - Main loop in `aggregator.py` reads new JSONL lines, ingests events, and writes frames each cadence bucket.
  - `build_frame_live()` produces output for `frame_live.json` and archived frames.
  - `apply_player_ttl()` and `apply_flow_ttl()` enforce 10-frame TTL.
- **Viewer**:
- `out/index.html` loads viewer modules (`out/viewer.data.js`, `out/viewer.render.js`, `out/viewer.ui.js`).
- `main()` in `viewer.ui.js` loads map assets, manifest, then polls `frame_live.json` in LIVE mode.
  - Archive scrubbing uses `manifest.frames` with a bounded cache window; LIVE uses a bounded ring buffer of recent `frame_live.json` frames.
  - A union window (max‑per‑zone) can render hotspots across the last N frames in the current buffer/ring; the rendered frame is `state.frame`.
  - Transport controls advance ARCHIVE frames at fixed frames/sec (1x/3x/5x), and a seek input jumps to the nearest frame.

### Configuration sources

- **Plugin** (BepInEx config bindings in `ValheimHeatFlowPlugin/Class1.cs`):
  - `BucketSeconds`, `TopN`, `ZoneSize`, `RotateMB`, `WorldZdoScanPerBucket`.
- **Aggregator** CLI and environment variables (`aggregator.py`):
  - Flags: `--root`, `--input`, `--out`, `--state`, `--poll`, `--cadence`, `--heartbeat`.
  - Env: `HEATFLOW_ROOT`, `HEATFLOW_INPUT_DIR`, `HEATFLOW_OUT_DIR`, `HEATFLOW_STATE_DIR`, `HEATFLOW_POLL_S`, `HEATFLOW_CADENCE_S`, `HEATFLOW_HEARTBEAT_S`.
- **Viewer** URL query params in `out/viewer.data.js`:
  - `manifest`, `live`, `frames`, `hr`, `flowMax`, `flowMin`, `debugZones`, `diag`,
    `archiveBuffer`, `archivePrefetch`, `liveRing`, `union`, `unionN`, `unionTopN`,
    `playOverlayFps`, `playOverlayScale`, `playFlowFps`, `playPlayersFps`, `playFlowScale`, `playPlayersScale` (Chromium playback only).
  - Tile decoding uses a Web Worker (`out/viewer.tile.worker.js`) to keep the UI responsive.

### External dependencies/services

- **Valheim server + BepInEx**: Required to run the plugin (`ValheimHeatFlowPlugin/`).
- **Browser**: Static hosting of `out/` (no backend in code).
- The viewer is typically served by a static HTTP server; no server script exists in this repo.

## 4) Interfaces & Data Formats

### JSONL input streams (plugin → aggregator)

- **player_positions.jsonl** (`ValheimHeatFlowPlugin/Class2.cs`)
  - Shape:
    ```json
    {"t":"...","type":"player_positions","bucket_s":30,"players":[{"id":"...","pfid":"...","name":"...","zx":1,"zy":2,"x":100.0,"z":200.0}]}
    ```
- **player_flow.jsonl** (`ValheimHeatFlowPlugin/Class1.cs`)
  - Shape:
    ```json
    {"t":"...","type":"player_flow","bucket_s":30,"transitions":[{"fx":1,"fy":2,"tx":3,"ty":4,"n":5}]}
    ```
- **hotspots_world_zdos.jsonl** (`ValheimHeatFlowPlugin/Class1.cs`, `docs/HOTSPOTS.md`)
  - Shape:
    ```json
    {"t":"...","type":"hotspots_world_zdos","schema":"zdo_schema","bucket_s":30,"epoch":0,"zones":[{"zx":1,"zy":2,"count":10}]}
    ```

### Aggregator outputs (`out/`)

- **frame_live.json** / **frames/frame_YYYYMMDDTHHMMSS.json** (`aggregator.py`)
  - Shape:
    ```json
    {
      "meta":{"schema":"...","t":"...","counts":{...},"presence":"ignored"},
      "players":[...],
      "flow":[{"a":{"zx":1,"zy":2},"b":{"zx":3,"zy":4},"c":5}],
      "hotspots":{"world_zdos":[{"zx":1,"zy":2,"count":10}]},
      "hotspots_meta":{"world_zdos":{"p90":...,"p99":...,"epoch":...}}
    }
    ```
- **manifest.json** (`aggregator.py`)
  - Contains `frames: [{sec, url}, ...]` and cadence/time metadata.

### Viewer inputs

- **Map assets**: `out/map.png`, `out/map/data/map.json`, `out/map/data/tiles/*.bin.gz`, `out/map/data/locations.json`.
- **Frames + manifest** as above.

## 5) Build / Run / Deploy

### Plugin (C#)

- Build context: `ValheimHeatFlowPlugin/ValheimHeatFlowPlugin.csproj` references BepInEx/Unity DLLs in `ValheimHeatFlowPlugin/lib/`.
- Emits JSONL into Valheim config path (`Paths.ConfigPath/heatflow`) as used by `RotatingJsonlWriter` (`Class1.cs`, `Class2.cs`).
- Built DLL is deployed under BepInEx plugins (standard BepInEx pattern; not scripted in repo).

### Aggregator (Python)

- Entry point: `aggregator.py`.
- Writes `out/frame_live.json`, `out/frames/`, and `out/manifest.json`.
- Uses `state/offsets.json` and `state/world_zdos_cache.json`.
- Run via `python aggregator.py` with optional CLI flags; no wrapper script present.

### Viewer (Static)

- Entry point: `out/index.html` loads viewer modules.
- Served by any static file server; no built-in server script in repo.

## 6) Risks, Weaknesses & Technical Debt

1) `ValheimHeatFlowPlugin/Class1.cs`: World ZDO scan uses reflection on internal fields (`m_objectsByID`) and can disable on type mismatch. This is brittle across game updates. **Priority: High**
2) `ValheimHeatFlowPlugin/Class1.cs`: World ZDO scan is incremental and cache-based; if the cursor never wraps (very large worlds), some zones may remain stale for long periods. **Priority: Medium**
3) `ValheimHeatFlowPlugin/Class1.cs`: `TopN` config applies to flow/presence only; world_zdos has no TopN emission at source, which may create large deltas and heavy aggregation. **Priority: Medium**
4) `aggregator.py`: World ZDO cache persistence is a single JSON file; corruption or partial write could block rehydration (no checksum). **Priority: Medium**
5) `aggregator.py`: Stream ingestion ignores invalid lines without reporting counts, which can mask upstream schema regressions. **Priority: Medium**
6) `aggregator.py`: Only one cadence is supported (30s); it’s fixed for world_zdos and mixed with configurable cadence for other streams, which can cause mismatched expectations. **Priority: Low**
7) Viewer modules: Debug overlay uses URL flags (`diag`, `debugZones`, `dev`) that could be left enabled accidentally in production. **Priority: Low**
8) Viewer modules: Biome lookup relies on browser `DecompressionStream` for gzip; unsupported browsers will fail TileGrid decoding silently. **Priority: Medium**
10) `ValheimHeatFlowPlugin/Class2.cs`: Player ID uses `peer.m_uid` with fallback strings; if IDs are missing or unstable, TTL behavior could be inconsistent across reconnects. **Priority: Low**
11) `docs/Hotspots_State.md`: World ZDO semantics rely on epoch/lazy overwrite; if the plugin changes epoch behavior, docs and aggregator assumptions can diverge. **Priority: Low**
11) Viewer modules: Flow aggregation loads archived frames and clusters each window, which could be CPU heavy on large archives. **Priority: Medium**

## 7) Quick Wins (≤2 hours each)

1) Add lightweight schema validation counters in `aggregator.py` for each stream (e.g., number of rejected lines per interval).
2) Ensure `out/index.html` is used.
3) Add a small compatibility note in `docs/HOTSPOTS.md` about reflection targets and expected Valheim versions.
4) Add a simple health/status panel in `out/index.html` that shows last event times per stream from `manifest.json`.
5) Add a minimal “operations” section to `README.md` listing telemetry lines to monitor in production.
