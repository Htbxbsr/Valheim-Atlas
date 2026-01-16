# Valheim-Atlas - Independent performance and activity visualization for Valheim servers.

Valheim Atlas is an independent, unofficial project.
Not affiliated with, endorsed by, or supported by Iron Gate or Valheim.

“Valheim” is a registered trademark of Iron Gate AB.


This repository contains a Valheim server plugin, a Python aggregator, and a static web viewer that together produce a time-bucketed performance map (players, flow, and world ZDO density) for server analysis.

## What’s Included

- **Plugin** (`ValheimHeatFlowPlugin/`)
  - BepInEx plugin that emits JSONL streams:
    - `player_positions.jsonl`
    - `player_flow.jsonl`
    - `hotspots_world_zdos.jsonl` (world ZDO density, incremental deltas)
- **Aggregator** (`aggregator.py`)
  - Tails JSONL streams, applies TTL to players/flow, builds frames, and writes:
    - `out/frame_live.json`
    - `out/frames/frame_*.json`
    - `out/manifest.json`
- **Viewer** (`out/index.html`, `out/viewer.data.js`, `out/viewer.render.js`, `out/viewer.ui.js`)
  - Static HTML/JS viewer that renders the map and overlays from frames.

## Data Flow (End‑to‑End)

```
Valheim Server (BepInEx Plugin)
  -> JSONL streams (input/)
  -> Aggregator (aggregator.py)
  -> Frames + manifest (out/)
  -> Viewer (out/index.html + viewer modules)
```

## Quick Start

### 1) Build/Install the Plugin

- Build `ValheimHeatFlowPlugin/ValheimHeatFlowPlugin.csproj` (BepInEx plugin).
- Deploy the compiled DLL to your Valheim server’s BepInEx plugins folder.
- The plugin writes JSONL files under the server's config path (`Paths.ConfigPath/heatflow`).

### 2) Run the Aggregator

```bash
python aggregator.py --root . --input ./input --out ./out --state ./state
```

The aggregator expects these files in `input/` (or your configured input path):
- `player_positions.jsonl`
- `player_flow.jsonl`
- `hotspots_world_zdos.jsonl`

### 3) Serve the Viewer

```bash
python -m http.server --directory out
```

Then open `http://localhost:8000/` in your browser.

## Viewer Controls

- **Live / Archive**: Live reads `frame_live.json`; Archive scrubs `out/frames/`.
- **Transport (Archive only)**: `<<` / Play‑Pause / `>>` with speed 1x/3x/5x (frames per second).
- **Seek**: “Go to time” input jumps to nearest manifest frame (local time by default; `Z` for UTC).
- **Layers**: Players, Player Flow, World ZDO Density, Locations.
- **Debug HUD**: Bottom-left diagnostics; `?diag=1` enables extra hotspot diagnostics.
- **Buffers + Union window** (query params):
  - `?archiveBuffer=<n>` (default 120) archive cache window size.
  - `?archivePrefetch=<n>` (default 20) max archive prefetch per pump.
  - `?liveRing=<n>` (default 30) live ring buffer size.
  - `?union=0|1` (default 1) toggle union aggregation.
  - `?unionN=<n>` (default 5) union window size.
  - `?unionTopN=<n>` (default 500) TopN after union merge.

## Core Formats

### World ZDO Density (hotspots_world_zdos, zdo_schema)

```json
{
  "type": "hotspots_world_zdos",
  "schema": "zdo_schema",
  "t": "2026-01-01T00:00:00Z",
  "bucket_s": 30,
  "epoch": 0,
  "zones": [{ "zx": 1, "zy": 2, "count": 10 }]
}
```

### Frame Output (out/frame_live.json)

```json
{
  "meta": { "t": "2026-01-01T00:00:00Z", "counts": { "...": 1 } },
  "players": [{ "id": "uid:...", "x": 100, "z": 200, "zx": 1, "zy": 3 }],
  "flow": [{ "a": { "zx": 1, "zy": 2 }, "b": { "zx": 3, "zy": 4 }, "c": 5 }],
  "hotspots": { "world_zdos": [{ "zx": 1, "zy": 2, "count": 10 }] },
  "hotspots_meta": { "world_zdos": { "p90": 100, "p99": 1000, "epoch": 0 } }
}
```

## License
This project is licensed under a custom non-resale license.
Commercial server usage is allowed. Selling the software itself is prohibited.


