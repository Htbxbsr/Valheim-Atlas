# Debug Runbook

This runbook enumerates **all debugging/observability options present in code** and explains how to use each option. Every entry includes: identifier, behavior, default, usage, and code location.

## 0) 2-minute smoke test (after restart)

Checklist:
- **Raw JSONL updates** (plugin output): confirm these files exist and grow:
  - `player_positions.jsonl`
  - `player_flow.jsonl`
  - `hotspots_world_zdos.jsonl`
  - Location: `BepInEx/Config/heatflow/` (derived from `Paths.ConfigPath` in `ValheimHeatFlowPlugin/Class1.cs:61–66`).
- **Aggregator outputs update**:
  - `out/health.json` updates every few seconds (`aggregator.py: HEALTH_WRITE_EVERY_S=3.0`, `write_health` at `aggregator.py:669–691`).
  - `out/frame_live.json` updates every cadence bucket (default 30s).
  - `out/manifest.json` updates every ~2s (`aggregator.py` main loop).
  - `out/frames/frame_*.json` grows (archive frames).
- **Viewer checks (browser)**:
  - Open `out/index.html`.
  - Devtools → Network: `manifest.json` and `frame_live.json` should be fetched repeatedly.
  - Console should **not** show repeated init errors (init guard is enforced).

## 1) Plugin (ValheimHeatFlowPlugin)

### 1.1 Config toggles & constants

All plugin config is in `ValheimHeatFlowPlugin/Class1.cs` and uses `Config.Bind` (BepInEx config system). Defaults are baked in code; change in BepInEx config file for this plugin.

**Config keys (BepInEx):**
- `General/BucketSeconds`
  - **Default:** `30`
  - **What it does:** cadence for player positions + flow aggregation.
  - **How to use:** edit the plugin config (BepInEx) and restart.
  - **Where:** `Class1.cs:52`
- `General/TopN`
  - **Default:** `50`
  - **What it does:** Top-N truncation for player flow transitions and player presence.
  - **How to use:** edit config and restart.
  - **Where:** `Class1.cs:53`
- `General/ZoneSize`
  - **Default:** `64`
  - **What it does:** zone size used for player position and flow zone calculations.
  - **How to use:** edit config and restart.
  - **Where:** `Class1.cs:54`
- `IO/RotateMB`
  - **Default:** `64`
  - **What it does:** JSONL rotation size; see `RotatingJsonlWriter`.
  - **How to use:** edit config and restart.
  - **Where:** `Class1.cs:56`, rotation behavior in `Class2.cs:101–170`
- `Hotspots/WorldZdoScanPerBucket`
  - **Default:** `10000`
  - **What it does:** how many ZDOs are scanned per 30s bucket for world density.
  - **How to use:** edit config and restart.
  - **Where:** `Class1.cs:57`, used in `SnapshotWorldZdosChunk` (`Class1.cs:205–228`)
- `Hotspots/WorldZdoPayloadCapEnabled`
  - **Default:** `false`
  - **What it does:** if `true`, emit only Top-N zone counts for each bucket.
  - **How to use:** edit config and restart.
  - **Where:** `Class1.cs:58`, used in `WriteWorldZdosJsonl` (`Class1.cs:411–415`)
- `Hotspots/WorldZdoPayloadCapTopN`
  - **Default:** `500`
  - **What it does:** Top-N limit applied if payload cap is enabled.
  - **How to use:** edit config and restart.
  - **Where:** `Class1.cs:59`, `Class1.cs:413–415`

**Constants (code-level):**
- `WorldZdoBucketSeconds = 30`
  - **What it does:** hard-coded world ZDO bucket duration.
  - **Where:** `Class1.cs:40`
  - **How to use:** requires code change + rebuild.
- `ZoneSizeMeters = 64f`
  - **What it does:** zone size for world ZDO scan (independent of `General/ZoneSize`).
  - **Where:** `Class1.cs:39`
  - **How to use:** code change + rebuild.

### 1.2 Diagnostic events & outputs

**JSONL event: `scan_disabled_reason`**
- **What it does:** one-time diagnostic event when world ZDO scan is disabled.
- **How to trigger:** cause reflection failure or missing `m_objectsByID` container.
- **Where emitted:** `Class1.cs:429–472`
- **Example fields:**
  - `type`: `"scan_disabled_reason"`
  - `feature`: `"world_zdo_scan"`
  - `reason`: string
  - `exception_type`, `exception_message`
  - `plugin_version`, `game_version`
  - `t`, `timestamp_utc`

**Log patterns (rate‑limited):**
- `"World ZDO scan: scanned=... epoch=... wrapped=... zonesEmitted=..."`
  - **Where:** `Class1.cs:231–233`
  - **How to use:** confirm scan is active and producing zones.
- `"World ZDO scan disabled: ..."`
  - **Where:** `Class1.cs:440–442`
  - **How to use:** indicates scan disabled for session.
- `"World ZDO scan: ZDOMan not ready; skipping bucket."`
  - **Where:** `Class1.cs:160–162`

### 1.3 Common failure modes
- **Reflection missing container (`m_objectsByID`)**
  - **Behavior:** disables world ZDO scan for session and emits `scan_disabled_reason`.
  - **Where:** `Class1.cs:166–188`, `DisableWorldZdoScan`.
- **Payload cap activated**
  - **Behavior:** world ZDO output truncated to Top-N per bucket.
  - **Where:** `Class1.cs:411–415`
- **Rotation on raw JSONL**
  - **Behavior:** `RotatingJsonlWriter` rotates when file exceeds `RotateMB`.
  - **Where:** `Class2.cs:129–168`

## 2) Aggregator (aggregator.py)

### 2.1 CLI / runtime options

**CLI flags (also settable by env vars):**
- `--root` (env: `HEATFLOW_ROOT`) default = script dir
  - **Use:** `python aggregator.py --root .`
  - **Where:** `aggregator.py:971–973`
- `--input` (env: `HEATFLOW_INPUT_DIR`) default = `<root>/input`
  - **Use:** `python aggregator.py --input ./input`
  - **Where:** `aggregator.py:974`
- `--out` (env: `HEATFLOW_OUT_DIR`) default = `<root>/out`
  - **Where:** `aggregator.py:975`
- `--state` (env: `HEATFLOW_STATE_DIR`) default = `<root>/state`
  - **Where:** `aggregator.py:976`
- `--poll` (env: `HEATFLOW_POLL_S`) default = `1.0`
  - **Where:** `aggregator.py:977`
- `--cadence` (env: `HEATFLOW_CADENCE_S`) default = `30`
  - **Where:** `aggregator.py:978`
  - **Where:** `aggregator.py:979`
- `--heartbeat` (env: `HEATFLOW_HEARTBEAT_S`) default = `5.0`
  - **Where:** `aggregator.py:980`

### 2.2 Telemetry outputs

**out/health.json** (updated every ~3s):
- **Where built:** `build_health_report` at `aggregator.py:628–666`.
- **Fields:**
  - `start_time_utc`, `uptime_seconds`
  - `input_dir`, `output_dir`
  - `streams.<stream>`:
    - `lines_read`, `events_parsed`
    - `parse_errors`, `schema_errors`, `dropped_events`
    - `legacy_world_zdos`
    - `last_event_ts`, `last_ingest_ts`
  - `state_sizes`: `players`, `flow_edges`, `world_zdos_zones`
  - `last_write_ts`: `manifest`, `frame_live`, `frame_archive`

**out/manifest.json**
- **Where built:** `build_manifest` at `aggregator.py:906–952`
- **Key fields:** `frames` list, `streams` counters, `time` earliest/latest, and `paths.web` for viewer.

**state/offsets.json**
- **Where written:** `save_offsets` at `aggregator.py:456–479`
- **Contains:** per-stream offsets and counters; safe to inspect read-only.

### 2.3 Error handling behavior

- Malformed JSONL line:
  - **Behavior:** increments `parse_errors` and continues.
  - **Where:** `aggregator.py:1119–1124`
- Missing/invalid `t` or `type`:
  - **Behavior:** increments `schema_errors` and `dropped_events`.
  - **Where:** `aggregator.py:1126–1130`
- Unknown event type:
  - **Behavior:** increments `dropped_events` only.
  - **Where:** `aggregator.py:1137–1140`
- Schema validation failures:
  - **Behavior:** increments `schema_errors` and `dropped_events`.
  - **Where:** `aggregator.py:1141–1145`

**Log patterns:**
- `[aggv2] heartbeat ...` via `heartbeat_print` (`aggregator.py:960–969`)
- `[aggv2] stream_reset <stream>: <reason>` (`aggregator.py:1102`)
- `[aggv2] world_zdos frame epoch=...` (`aggregator.py:1196–1203`)

## 3) Viewer (index.html + viewer modules)

### 3.1 Init / loading diagnostics

**Init guard**
- **What it does:** prevents double initialization.
- **Where:** `out/viewer.ui.js:386–399` (`window.initViewer`)

### 3.2 Runtime debug aids (URL params / overlays / logs)

**URL query params (viewer.data.js):**
- `?flowMax=<n>` (default 180)
  - **What:** max flow edges rendered.
  - **Where:** `out/viewer.data.js:54`
- `?flowMin=<n>` (default 1)
  - **What:** min flow count to render.
  - **Where:** `out/viewer.data.js:55`
- `?manifest=<url>` (default `manifest.json`)
  - **What:** manifest URL override.
  - **Where:** `out/viewer.data.js:56`
- `?live=<url>` (default `frame_live.json`)
  - **What:** live frame URL override.
  - **Where:** `out/viewer.data.js:57`
- `?frames=<dir>` (default `frames`)
  - **What:** frames directory override.
  - **Where:** `out/viewer.data.js:58`
- `?hr=<px>` (default `28`)
  - **What:** hotspot radius in pixels.
  - **Where:** `out/viewer.data.js:62`
- `?archiveBuffer=<n>` (default `120`)
  - **What:** archive frame cache window size.
  - **Where:** `out/viewer.data.js:60`
- `?archivePrefetch=<n>` (default `20`)
  - **What:** archive prefetch cap per pump batch.
  - **Where:** `out/viewer.data.js:61`
- `?liveRing=<n>` (default `30`)
  - **What:** live ring buffer size.
  - **Where:** `out/viewer.data.js:62`
- `?union=0|1` (default `1`)
  - **What:** enable/disable union window aggregation.
  - **Where:** `out/viewer.data.js:63`
- `?unionN=<n>` (default `5`)
  - **What:** union window size.
  - **Where:** `out/viewer.data.js:64`
- `?unionTopN=<n>` (default `500`)
  - **What:** TopN applied after union merge.
  - **Where:** `out/viewer.data.js:65`
- `?diag=1`
  - **What:** adds detailed frame/zones info to debug overlay (frame ts/epoch/lookup).
  - **Where:** `out/viewer.data.js:79`, diagnostics at `out/viewer.data.js:768–812`
- `?dev=1`
  - **What:** adds biome anchor/symmetry diagnostics to debug overlay.
  - **Where:** `out/viewer.data.js:841–859`

**UI toggles (index.html):**
- Players, Player Flow, World ZDO Density, Locations + filters.
  - **Where:** `out/index.html` (IDs: `togPlayers`, `togFlow`, `togWorldZdo`, `toggleLocations`, filters)
  - **How to use:** check/uncheck to enable/disable overlays.

**Transport + Seek (Archive only):**
- Transport row: `<<` / Play‑Pause / `>>` advances archive frames at 1x/3x/5x (frames/sec).
  - **Where:** `out/index.html` (IDs: `btnRew`, `btnPlayPause`, `btnFwd`, `btnSpeed1/3/5`), handlers in `out/viewer.ui.js`.
- Seek input: “Go to time” (local by default; trailing `Z` parses as UTC).
  - **Where:** `out/index.html` (`seekInput`, `seekGo`, `seekError`), parsing in `out/viewer.data.js:parseTimeInputLocalOrUTC`.

**Debug overlay**
- Always enabled; content updates on mouse move and is refreshed periodically (~4 Hz) while the cursor is over the canvas.
- The debug panel shows biome/hotspot/location status; world/zone coordinates are shown in the top-left HUD.
- **Where:** `out/viewer.data.js:updateDebugOverlay`, `out/viewer.data.js:maybeUpdateDebug`, timer in `out/viewer.ui.js` mousemove handler.

## 4) Rotation tool (tools/rotate_monthly.py)

### 4.1 Options & examples

**CLI args:**
- `--root` (auto-detect repo root if omitted)
- `--raw-dir` (override raw JSONL directory)
- `--frames-dir` (override frames directory)
- `--archive-dir` (override archive output directory)
- `--dry-run` (no changes)
- `--force` (rotate even if already rotated this month)
  - **Where:** `tools/rotate_monthly.py:204–209`

**Examples:**
```bash
python tools/rotate_monthly.py --dry-run
python tools/rotate_monthly.py
python tools/rotate_monthly.py --root . --raw-dir ./input --frames-dir ./out/frames --archive-dir ./archive
```

### 4.2 Auto-discovery rules

- Root detection: walks upward for `.git` or `aggregator.py`; else uses CWD.
  - **Where:** `find_repo_root` (`tools/rotate_monthly.py:26–36`)
- Raw dir selection:
  - Prefer directory names in `("heatflow","input","in","raw","data")` then pick the one with most `.jsonl`.
  - **Where:** `PREFERRED_RAW_DIR_NAMES` + `find_jsonl_candidates` (`tools/rotate_monthly.py:19–84`)
- Frames dir selection:
  - Prefer `<root>/out/frames`, else pick dir with most `frame_YYYYMMDDTHHMMSS.json`.
  - **Where:** `find_frames_dir` (`tools/rotate_monthly.py:86–96`)

The tool prints the selected dirs on run:
```
[rotate] raw_dir=...
[rotate] frames_dir=...
[rotate] archive_dir=...
```
(`tools/rotate_monthly.py:225–230`)

### 4.3 Safety and idempotency

- Rotation state marker: `archive/.rotation_state.json` with `last_rotated_month`.
  - **Where:** `ROTATION_STATE_NAME` (`tools/rotate_monthly.py:20`), `load_state`/`save_state`.
- Never deletes current-month frames:
  - Only archives frames where the filename month equals the **previous** month.
  - **Where:** `archive_frames` (`tools/rotate_monthly.py:148–192`)
- Raw JSONL:
  - Moves `.jsonl` to archive and gzips.
  - Deletes uncompressed archive only after successful gzip.
  - Always recreates the original file path even on gzip failure.
  - **Where:** `rotate_raw_jsonl` (`tools/rotate_monthly.py:106–144`)
- Idempotency: archived filenames get suffix `_2`, `_3`, etc. if collisions.
  - **Where:** `unique_path` (`tools/rotate_monthly.py:98–105`)

## 5) Cross-component troubleshooting (recipes)

**Viewer loads but map is empty**
1) Check `out/manifest.json` timestamps moving and `frames` list non-empty.
2) Check `out/frame_live.json` for `hotspots.world_zdos` entries.
3) Open viewer with `?diag=1` to see `zones_total_in_frame`.
4) If `zones_total_in_frame=0`, check raw `hotspots_world_zdos.jsonl` for new lines and plugin logs.

**Heatmap stops updating**
1) Look for `scan_disabled_reason` lines in `hotspots_world_zdos.jsonl`.
2) Check plugin logs for `"World ZDO scan disabled:"`.
3) Check `out/health.json` → `streams.hotspots_world_zdos.last_event_ts`.

**schema_errors rising**
1) Inspect `out/health.json` for which stream increments `schema_errors`.
2) For world ZDOs, ensure `schema:"zdo_schema"` is present and `bucket_s` is `30`.
3) Check for malformed `t` (must end in `Z`).

**parse_errors rising**
1) Inspect raw JSONL tail for truncated/partial lines.
2) If frequent, reduce `RotateMB` to rotate earlier (plugin config).

**scan_disabled_reason present**
1) Confirm `feature:"world_zdo_scan"` and `reason`.
2) Restart plugin after resolving missing reflection fields; scan stays disabled for that process only.

**Rotation ran but playback didn’t reset**
1) Confirm previous-month frames were removed from `out/frames/`.
2) Confirm archive tar exists in `archive/YYYY-MM/frames/`.
3) Ensure new frames were generated after restart (check `out/frames/frame_*.json` timestamps).

**Wrong raw directory rotated**
1) Use `--dry-run` to see chosen raw dir.
2) Re-run with `--raw-dir` to override.

--- 
