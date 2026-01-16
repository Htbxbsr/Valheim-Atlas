# Player Positions TTL Audit

This document audits the player position TTL behavior across `aggregator.py` and the viewer modules (`out/viewer.data.js`, `out/viewer.render.js`, `out/viewer.ui.js`).
It compares current implementation against the intended frames-based TTL spec.


## 1) Code Pointers

Aggregator:
- `aggregator.py`
  - `ingest_event()` (player_positions ingestion)
  - `apply_player_ttl()` (frames-based TTL)
  - `build_frame_live()` (frame output)
  - main loop frame emission (cadence bucket)

Viewer:
- `out/viewer.render.js`
  - `drawPlayers()` (render path)
- `out/viewer.ui.js`
  - `normalizeFrame()` (input normalization)


## 2) Intended TTL Spec (Authoritative)

Frames-based TTL, not wall-clock:
- Player persists **10 emitted frames** after last update.
- Any update resets TTL to 10.
- If 10 frames elapse with no update, player disappears from frames and map.
- Viewer must render exactly what frames contain; no extra TTL in viewer.


## 3) Current Behavior (Derived from Code)

### Aggregator

Ingestion:
- Source: `player_positions.jsonl`
- Parser: `ingest_event()` for `type == "player_positions"`
- Expected event shape:
  - `{"type":"player_positions","t":"...Z","players":[...]}`
  - Each player entry must include:
    - `id` (string, required key)
    - `name` (string, optional)
    - `x`, `z` (world coordinates) and/or `zx`, `zy` (zone coords)

State:
- `live.players_latest[pid]` stores the last known position per player.
- `live.players_updated` collects player IDs updated in the current cadence bucket.
- `live.players_ttl[pid]` stores remaining frames.

Frame emission:
- `apply_player_ttl(live, ttl_frames=10)` runs once per emitted frame.
- If a player was updated in the bucket, TTL is set to 10.
- If not updated, TTL is decremented by 1.
- When TTL reaches 0, the player is removed from `players_latest`.
- Output frames contain only players with TTL > 0.

Answering the audit questions:
- a) If updates stop, a player disappears after **10 emitted frames**.
- b) If updates resume, marker moves in the **next emitted frame** (TTL resets to 10).
- c) TTL is enforced in the **Aggregator**; Viewer does not apply TTL.

### Viewer

Render path:
- `drawPlayers(ctx, arr)` renders the `frame.players` list.
- The Viewer does **not** cache players or apply TTL.
- Disappearance is driven solely by the players present in incoming frames.


## 4) Spec Comparison

Result: **Matches the intended TTL behavior**.

The TTL is frames-based and authoritative in the Aggregator.
The Viewer renders only what frames contain.


## 5) Manual Test Procedure

This test uses a synthetic `player_positions.jsonl` file and a short cadence.

1) Configure Aggregator:
   - Run with `--cadence 1` (1s per frame) to simplify counting.

2) Create input file (single update):

```
{"type":"player_positions","t":"2026-01-01T00:00:00Z","players":[{"id":"p1","name":"Alice","x":100,"z":200,"zx":1,"zy":3}]}
```

3) Observe:
   - Player appears in the next emitted frame.
   - Count frames: the marker should persist for **10 frames** after the update.

4) Stop updates:
   - Do not append any new player positions.
   - After 10 emitted frames, the player disappears from output frames and the map.

5) Resume updates:
   - Append another player_positions event for `p1` with new x/z.
   - Player reappears/moves in the next emitted frame, TTL resets to 10.


## 6) Findings

- The implementation matches the frames-based TTL spec.
- Viewer is passive and does not extend TTL beyond frame contents.


## 7) How to Test (Checklist)

- Confirm `frame_live.json` contains `players` for 10 frames after last update.
- Confirm `players` array is empty after the 10th frame.
- Confirm Viewer removes marker exactly when frames stop containing it.
