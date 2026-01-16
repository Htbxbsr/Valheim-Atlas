# Valheim Atlas - Architecture Contract (Current Codebase)

This contract reflects the **current working codebase** and its non-negotiable rules.
If future changes are desired, update this contract first.


## 1) Sources of Truth

- **World Space (x,z in meters)** is the source of truth for all logic.
- **TileGrid data** (map.json + tiles/*.bin.gz) is the only source of biome truth.
- PNG images are visualization only.


## 2) World Definition (Current)

Viewer projection uses a fixed world radius:

- `WorldRadius = 10000` (meters)
- `WorldWidth = 20000`
- Projection uses a disc model centered on the map image.

Axis convention (Current Viewer):

- `+X` = East (right on the map)
- `+Z` = North (up on the map)

Note: Projection in the viewer inverts Z for canvas drawing.


## 3) Zones (Fixed)

- `ZoneSize = 64 meters` (fixed)
- World → Zone:
  - `zx = floor(x / ZoneSize)`
  - `zy = floor(z / ZoneSize)`
- Zone → World (zone center):
  - `x = (zx + 0.5) * ZoneSize`
  - `z = (zy + 0.5) * ZoneSize`


## 4) TileGrid Mapping (Current Locked Pipeline)

Tile meta:
- `TileRowCount = meta.TileRowCount`
- `TileSideCount = meta.TileSideCount`
- `WorldSamples = TileRowCount * TileSideCount`

World → normalized:
- `u = (x + WorldHalf) / WorldWidth`
- `u = 1 - u` (mirror X in biome sampling)
- `v = (-z + WorldHalf) / WorldWidth`

Normalized → global sample indices:
- `gx = floor(u * WorldSamples)`
- `gy = floor(v * WorldSamples)`
- clamp:
  - `gx = clamp(gx, 0, WorldSamples - 1)`
  - `gy = clamp(gy, 0, WorldSamples - 1)`

Global sample → tile + intra-tile:
- `tx = gx / TileRowCount`
- `ty = gy / TileRowCount`
- `ix = gx % TileRowCount`
- `iy = gy % TileRowCount`

Tile filename convention (current dataset):
- `tiles/{ty:D2}-{tx:D2}.bin.gz`

In-tile indexing (row-major):
- `index = iy * TileRowCount + ix`
- `offset = index * 10`

Tile transforms are **locked** and must not be changed by UI:
- `swapXY = true`
- `flipTileX = true`
- `flipTileY = true`
- `tileRowOrder = top-down`
- `pixelFlipX = true`
- `pixelFlipY = true`
- `tileIndexMode = row`


## 5) Biomes (Tile Lookup Only)

- `biomeId` is read from tile sample `uint16 biome`.
- Decoding uses bitmask mapping (BITMASK):
  - Meadows=1, Swamp=2, Mountain=4, BlackForest=8,
  - Plains=16, Ashlands=32, DeepNorth=64,
  - Ocean=256, Mistlands=512.
- If multiple flags are set, display `Mixed(0xXXXX)` and choose a dominant color by fixed priority.

Forbidden:
- Do NOT derive biome from PNG pixel colors.
- Do NOT use radial heuristics as the primary biome source.


## 6) Rendering Projection (World → Pixel)

Projection is visualization only and must not affect logic.

- Disc projection:
  - `px = cx + (x / WorldRadius) * rpx + offsetXPx`
  - `py = cy - (z / WorldRadius) * rpx + offsetYPx`
- `cx`, `cy` are the map image center.
- `rpx` uses a configurable scale (current default `discRadiusScale = 0.818`).


## 7) Hotspots (World ZDO Density)

Hotspots represent **World ZDO Density (Potential Load)**.

Input stream:
- `type = "hotspots_world_zdos"`
- `schema = "zdo_schema"`
- `zones = [{zx, zy, count}]` (chunk deltas)
- `epoch` increments on scan wrap.

Aggregator:
- Maintains full per-zone cache.
- On epoch change, counts are overwritten lazily (first seen replaces).
- Frames include TopN (default 500) zones by count.

Viewer rendering:
- Uses thresholds derived from `hotspots_meta.world_zdos` with minimums:
  - `yellow_th = max(p90, 800)`
  - `red_th = max(p99, 2000)`
- Color bands:
  - Green: `< yellow_th`
  - Yellow: `>= yellow_th`
  - Red: `>= red_th`

Filtering:
- `hotMinCount = 1` (counts below are not drawn).


## 8) Responsibilities

Aggregator (Python):
- reads input events and produces frames
- aggregates counts per zone
- enforces TTL for players/flow
- MUST NOT compute biomes

Viewer (JS/HTML):
- reads frames and draws them
- projects world → pixel for display
- performs biome lookup using tiles
- MUST NOT treat PNG pixels as biome truth


## 9) Debug Requirements (Viewer)

Debug overlay must show:
- World coordinates (x,z)
- Zone coordinates (zx,zy)
- Biome name (from tiles)
- Hotspot count for hovered zone

Optional diagnostics (URL flags):
- `?debugZones=1` is defined but currently produces no visible debug output.
- `?diag=1` shows frame/epoch/meta stats.


## 10) Hard Rules

- Do NOT introduce any logic source besides World Space and TileGrid.
- Do NOT use PNG pixels/colors for biome truth.
- Do NOT change output schema without updating documentation.
