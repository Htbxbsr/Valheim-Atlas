#!/usr/bin/env python3
"""Valheim Heatflow Aggregator V2 Robust + Heartbeat (platform-neutral)

Key properties:
- Platform-neutral (Windows/Linux). No hardcoded absolute paths.
- Robust file tracking:
  - Files can appear after startup (hot-plug).
  - Detect truncate/replace and safely reset per-stream state.
- Single state file: state/offsets.json holds offsets + counters + file signature.
- Heartbeat logs (low spam, configurable).
- Reads the plugin's JSONL snapshot schemas.

IMPORTANT semantics (as requested):
- On restart: loads the last saved offsets + totals from offsets.json (so it doesn't look like 0).
- If a stream file is detected as "new" (replaced/truncated/new identity): that stream's counters are reset
  (offset=0, total_lines=0, total_events=0, last_event_ts=None) and then it backfills from the new file.

Outputs:
- out/frame_live.json
- out/frames/frame_YYYYMMDDTHHMMSS.json
- out/manifest.json

Presence in player_flow is accepted but ignored (MVP).
"""

from __future__ import annotations

import argparse
import calendar
import math
import json
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set, Tuple

SCHEMA_VERSION = "2.1-hb-cadence-rehydrate"

HEALTH_FILENAME = "health.json"
HEALTH_WRITE_EVERY_S = 3.0
MAX_FUTURE_EVENT_S = 86400  # 24h guardrail for timestamps

# Stream filenames (fixed names; dirs are configurable)
STREAM_FILES = {
    "player_positions": "player_positions.jsonl",
    "player_flow": "player_flow.jsonl",
    "hotspots_world_zdos": "hotspots_world_zdos.jsonl",
}

WORLD_ZDOS_TYPE = "hotspots_world_zdos"
WORLD_ZDOS_SCHEMA = "zdo_schema"

WORLD_ZDOS_TOPN = 500
WORLD_ZDOS_QUANTILE_EVERY = 10
WORLD_ZDOS_REHYDRATE_FRAMES = 120
WORLD_ZDOS_CACHE_FILENAME = "world_zdos_cache.json"

def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.environ.get(name)
    return v if v not in (None, "") else default

def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except Exception:
        return default

def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except Exception:
        return default

def script_dir() -> str:
    try:
        return os.path.dirname(os.path.abspath(__file__))
    except Exception:
        return os.path.abspath(".")

def ensure_dir(p: str) -> None:
    os.makedirs(p, exist_ok=True)

def atomic_write_text(path: str, text: str) -> None:
    ensure_dir(os.path.dirname(path) or ".")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    # Windows can be picky if file is open elsewhere; retry a bit.
    retries = 25 if os.name == "nt" else 3
    for i in range(retries):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if i == retries - 1:
                raise
            time.sleep(0.04)

def atomic_write_json(path: str, obj: Any) -> None:
    atomic_write_text(path, json.dumps(obj, ensure_ascii=False, separators=(",", ":")))

def parse_ts_to_epoch_s(ts: Any) -> Optional[int]:
    if not isinstance(ts, str) or not ts.endswith("Z"):
        return None
    core = ts[:-1]
    if "." in core:
        core = core.split(".", 1)[0]
    try:
        st = time.strptime(core, "%Y-%m-%dT%H:%M:%S")
        return int(calendar.timegm(st))
    except Exception:
        return None

def iso_utc(epoch_s: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch_s))

def hms_compact(epoch_s: int) -> str:
    return time.strftime("%Y%m%dT%H%M%S", time.gmtime(epoch_s))



def parse_compact_to_epoch_s(compact: str) -> Optional[int]:
    """Parse YYYYMMDDTHHMMSS (UTC) to epoch seconds."""
    try:
        st = time.strptime(compact, "%Y%m%dT%H%M%S")
        return int(calendar.timegm(st))
    except Exception:
        return None

def compute_world_quantiles(values: List[int]) -> Dict[str, Any]:
    if not values:
        return {"p90": None, "p99": None, "n_zones": 0, "max": 0}
    vals = sorted(values)
    n = len(vals)
    def q_at(q: float) -> int:
        idx = int(math.ceil(q * (n - 1)))
        if idx < 0:
            idx = 0
        if idx >= n:
            idx = n - 1
        return int(vals[idx])
    return {
        "p90": q_at(0.90),
        "p99": q_at(0.99),
        "n_zones": n,
        "max": int(vals[-1]),
    }

def apply_world_zdos_event(live: LiveAgg, evt: Dict[str, Any]) -> bool:
    schema = evt.get("schema")
    if schema != WORLD_ZDOS_SCHEMA:
        return False
    epoch = evt.get("epoch")
    if not isinstance(epoch, int):
        return False
    if epoch != live.hotspots_world_epoch:
        live.hotspots_world_epoch = epoch
        live.hotspots_world_seen.clear()
    zones = evt.get("zones")
    if not isinstance(zones, list):
        return False
    ok = False
    for z in zones:
        if not isinstance(z, dict):
            continue
        zx_, zy_ = z.get("zx"), z.get("zy")
        cnt = z.get("count")
        if not (isinstance(zx_, (int, float)) and isinstance(zy_, (int, float)) and isinstance(cnt, (int, float))):
            continue
        val = int(cnt)
        if val <= 0:
            continue
        key = zk(int(zx_), int(zy_))
        if key not in live.hotspots_world_seen:
            live.hotspots_world_counts[key] = val
            live.hotspots_world_seen.add(key)
        else:
            live.hotspots_world_counts[key] = live.hotspots_world_counts.get(key, 0) + val
        ok = True
    return ok

def load_world_zdos_cache(path: str, live: LiveAgg) -> bool:
    if not os.path.exists(path):
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, dict) or raw.get("schema") != "world_zdos_cache.v1":
            return False
        if int(raw.get("bucket_s", 0) or 0) != 30:
            return False
        epoch = raw.get("epoch")
        if not isinstance(epoch, int):
            return False
        counts = raw.get("counts")
        if not isinstance(counts, list):
            return False
        live.hotspots_world_counts = {}
        live.hotspots_world_seen = set()
        for z in counts:
            if not isinstance(z, dict):
                continue
            zx_, zy_ = z.get("zx"), z.get("zy")
            cnt = z.get("count")
            if not (isinstance(zx_, (int, float)) and isinstance(zy_, (int, float)) and isinstance(cnt, (int, float))):
                continue
            val = int(cnt)
            if val <= 0:
                continue
            key = zk(int(zx_), int(zy_))
            live.hotspots_world_counts[key] = val
            live.hotspots_world_seen.add(key)
        live.hotspots_world_epoch = epoch
        meta = raw.get("meta")
        if isinstance(meta, dict):
            live.hotspots_world_meta = {
                "p90": meta.get("p90"),
                "p99": meta.get("p99"),
                "n_zones": meta.get("n_zones"),
                "max": meta.get("max"),
            }
        return True
    except Exception:
        return False

def save_world_zdos_cache(path: str, live: LiveAgg, last_event_t: Optional[str] = None) -> None:
    counts = [
        {"zx": parse_zk(k)[0], "zy": parse_zk(k)[1], "count": int(v)}
        for k, v in live.hotspots_world_counts.items()
        if v > 0
    ]
    obj = {
        "schema": "world_zdos_cache.v1",
        "bucket_s": 30,
        "epoch": int(live.hotspots_world_epoch),
        "last_event_t": last_event_t,
        "counts": counts,
        "meta": live.hotspots_world_meta,
    }
    atomic_write_json(path, obj)

def read_tail_lines(path: str, want_lines: int, max_bytes: int = 10_000_000) -> List[str]:
    try:
        size = os.path.getsize(path)
    except Exception:
        return []
    if size <= 0:
        return []
    chunk = 2_000_000
    data = ""
    while chunk <= max_bytes:
        start = max(0, size - chunk)
        try:
            with open(path, "rb") as f:
                f.seek(start)
                data = f.read().decode("utf-8", errors="replace")
        except Exception:
            return []
        lines = data.splitlines()
        if len(lines) >= want_lines or start == 0:
            return lines
        chunk *= 2
    return data.splitlines()

def rehydrate_world_zdos_from_tail(live: LiveAgg, path: str) -> Tuple[bool, int, int, Optional[str]]:
    if not os.path.exists(path):
        return False, 0, 0, None
    lines = read_tail_lines(path, WORLD_ZDOS_REHYDRATE_FRAMES * 4)
    if not lines:
        return False, 0, 0, None
    by_bucket: Dict[int, Dict[str, Any]] = {}
    latest_ts = None
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        try:
            evt = json.loads(ln)
        except Exception:
            continue
        if not isinstance(evt, dict):
            continue
        if evt.get("type") != WORLD_ZDOS_TYPE or evt.get("schema") != WORLD_ZDOS_SCHEMA:
            continue
        try:
            if int(evt.get("bucket_s", 0) or 0) != 30:
                continue
        except (TypeError, ValueError):
            # Malformed bucket_s in tail; skip (main loop would count schema error).
            continue
        ts = evt.get("t")
        if not isinstance(ts, str) or not ts.endswith("Z"):
            continue
        if latest_ts is None or ts > latest_ts:
            latest_ts = ts
        bucket_s = parse_ts_to_epoch_s(ts)
        if bucket_s is None:
            continue
        prev = by_bucket.get(bucket_s)
        if prev is None:
            by_bucket[bucket_s] = evt
        else:
            prev_ts = prev.get("t")
            if isinstance(prev_ts, str) and prev_ts < ts:
                by_bucket[bucket_s] = evt
    if not by_bucket:
        return False, 0, 0, None
    buckets = sorted(by_bucket.keys())
    buckets = buckets[-WORLD_ZDOS_REHYDRATE_FRAMES:]
    live.hotspots_world_counts = {}
    live.hotspots_world_seen = set()
    live.hotspots_world_epoch = 0
    for b in buckets:
        apply_world_zdos_event(live, by_bucket[b])
    live.hotspots_world_meta = compute_world_quantiles(list(live.hotspots_world_counts.values()))
    return True, len(by_bucket), len(buckets), latest_ts

def scan_frame_time_range(frames_dir: str) -> Tuple[Optional[int], Optional[int]]:
    """Return (earliest_bucket_s, latest_bucket_s) based on existing archive frames."""
    try:
        names = os.listdir(frames_dir)
    except Exception:
        return None, None

    earliest = None
    latest = None
    for fn in names:
        # Expected: frame_YYYYMMDDTHHMMSS.json
        if not (fn.startswith("frame_") and fn.endswith(".json")):
            continue
        core = fn[len("frame_"):-len(".json")]
        es = parse_compact_to_epoch_s(core)
        if es is None:
            continue
        if earliest is None or es < earliest:
            earliest = es
        if latest is None or es > latest:
            latest = es
    return earliest, latest

def list_frames(frames_dir: str) -> List[Dict[str, Any]]:
    """Return sorted list of existing frames as [{sec, url}, ...]."""
    try:
        names = os.listdir(frames_dir)
    except Exception:
        return []

    out: List[Dict[str, Any]] = []
    for fn in names:
        if not (fn.startswith("frame_") and fn.endswith(".json")):
            continue
        core = fn[len("frame_"):-len(".json")]
        es = parse_compact_to_epoch_s(core)
        if es is None:
            continue
        out.append({"sec": es, "url": f"frames/{fn}"})

    out.sort(key=lambda x: x["sec"])
    return out
@dataclass
class FileSig:
    inode: int
    size: int
    mtime_ns: int

@dataclass
class StreamState:
    path: str
    sig: FileSig
    offset: int
    total_lines: int
    total_events: int
    parse_errors: int
    schema_errors: int
    dropped_events: int
    legacy_world_zdos: int
    last_event_ts: Optional[str]
    last_ingest_ts: Optional[str]

def _file_sig(path: str) -> Optional[FileSig]:
    try:
        st = os.stat(path)
        inode = int(getattr(st, "st_ino", 0) or 0)
        size = int(st.st_size)
        mtime_ns = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)))
        return FileSig(inode=inode, size=size, mtime_ns=mtime_ns)
    except FileNotFoundError:
        return None
    except Exception:
        return None

def _sig_dict(sig: FileSig) -> Dict[str, int]:
    return {"inode": sig.inode, "size": sig.size, "mtime_ns": sig.mtime_ns}

def _sig_from_dict(d: Any) -> FileSig:
    if not isinstance(d, dict):
        return FileSig(0, 0, 0)
    return FileSig(
        inode=int(d.get("inode", 0) or 0),
        size=int(d.get("size", 0) or 0),
        mtime_ns=int(d.get("mtime_ns", 0) or 0),
    )

def load_offsets(state_dir: str) -> Dict[str, StreamState]:
    p = os.path.join(state_dir, "offsets.json")
    if not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            raw = json.load(f)

        out: Dict[str, StreamState] = {}

        # Backward compatible: older format might have been {stream:{inode,offset}}
        if isinstance(raw, dict) and "streams" not in raw:
            for k, v in raw.items():
                if not isinstance(v, dict):
                    continue
                out[k] = StreamState(
                    path="",
                    sig=FileSig(inode=int(v.get("inode", 0) or 0), size=0, mtime_ns=0),
                    offset=int(v.get("offset", 0) or 0),
                    total_lines=int(v.get("total_lines", 0) or 0),
                    total_events=int(v.get("total_events", 0) or 0),
                    parse_errors=int(v.get("parse_errors", 0) or 0),
                    schema_errors=int(v.get("schema_errors", 0) or 0),
                    dropped_events=int(v.get("dropped_events", 0) or 0),
                    legacy_world_zdos=int(v.get("legacy_world_zdos", 0) or 0),
                    last_event_ts=v.get("last_event_ts"),
                    last_ingest_ts=v.get("last_ingest_ts"),
                )
            return out

        if not isinstance(raw, dict):
            return {}

        streams = raw.get("streams", {})
        if not isinstance(streams, dict):
            return {}

        for k, v in streams.items():
            if not isinstance(v, dict):
                continue
            out[k] = StreamState(
                path=str(v.get("path", "")),
                sig=_sig_from_dict(v.get("sig")),
                offset=int(v.get("offset", 0) or 0),
                total_lines=int(v.get("total_lines", 0) or 0),
                total_events=int(v.get("total_events", 0) or 0),
                parse_errors=int(v.get("parse_errors", 0) or 0),
                schema_errors=int(v.get("schema_errors", 0) or 0),
                dropped_events=int(v.get("dropped_events", 0) or 0),
                legacy_world_zdos=int(v.get("legacy_world_zdos", 0) or 0),
                last_event_ts=v.get("last_event_ts"),
                last_ingest_ts=v.get("last_ingest_ts"),
            )
        return out
    except Exception:
        return {}

def save_offsets(state_dir: str, states: Dict[str, StreamState]) -> None:
    p = os.path.join(state_dir, "offsets.json")
    raw = {
        "schema": SCHEMA_VERSION,
        "saved_at": iso_utc(int(time.time())),
        "streams": {
            k: {
                "path": v.path,
                "sig": _sig_dict(v.sig),
                "offset": v.offset,
                "total_lines": v.total_lines,
                "total_events": v.total_events,
                "parse_errors": v.parse_errors,
                "schema_errors": v.schema_errors,
                "dropped_events": v.dropped_events,
                "legacy_world_zdos": v.legacy_world_zdos,
                "last_event_ts": v.last_event_ts,
                "last_ingest_ts": v.last_ingest_ts,
            }
            for k, v in states.items()
        },
    }
    atomic_write_json(p, raw)

def _is_sig_equal(a: FileSig, b: FileSig) -> bool:
    return a.inode == b.inode and a.size == b.size and a.mtime_ns == b.mtime_ns

def detect_reset_reason(prev: StreamState, cur_sig: FileSig) -> Optional[str]:
    """Return a non-empty string reason if this stream should reset its counters."""
    # If file shrank below our offset -> truncated or replaced
    if cur_sig.size < prev.offset:
        return "truncate/replace (size < offset)"

    # Linux: inode change is a strong signal of replace
    if prev.sig.inode != 0 and cur_sig.inode != 0 and cur_sig.inode != prev.sig.inode:
        return "replace (inode changed)"

    # Windows heuristic (inode often 0):
    # If mtime changed and size is <= previous size while we believed we were at EOF,
    # it's likely a replace.
    if prev.sig.inode == 0 and cur_sig.inode == 0:
        if cur_sig.mtime_ns != prev.sig.mtime_ns and cur_sig.size <= prev.sig.size and prev.offset >= prev.sig.size:
            return "replace (win heuristic mtime+size)"

    return None

def read_new_lines_with_reset(state: StreamState) -> Tuple[StreamState, List[str], Optional[str]]:
    """Read new lines; detect file replacement/truncate; if detected, reset counters & offset."""
    sig = _file_sig(state.path)
    if sig is None:
        # File not present yet; keep state, don't reset
        return state, [], None

    reason = detect_reset_reason(state, sig)
    if reason is not None:
        # Reset counters as requested when a new/changed file goes in
        state = StreamState(
            path=state.path,
            sig=FileSig(0, 0, 0),  # will be replaced below
            offset=0,
            total_lines=0,
            total_events=0,
            parse_errors=0,
            schema_errors=0,
            dropped_events=0,
            legacy_world_zdos=0,
            last_event_ts=None,
            last_ingest_ts=None,
        )

    # If this is a brand new signature (first time seeing file), we want to backfill from 0 anyway.
    offset = max(0, state.offset)

    try:
        with open(state.path, "r", encoding="utf-8", errors="replace") as f:
            f.seek(offset)
            data = f.read()
            new_offset = f.tell()
        lines = data.splitlines() if data else []
    except Exception:
        return state, [], None

    new_state = StreamState(
        path=state.path,
        sig=sig,
        offset=new_offset,
        total_lines=state.total_lines,
        total_events=state.total_events,
        parse_errors=state.parse_errors,
        schema_errors=state.schema_errors,
        dropped_events=state.dropped_events,
        legacy_world_zdos=state.legacy_world_zdos,
        last_event_ts=state.last_event_ts,
        last_ingest_ts=state.last_ingest_ts,
    )
    return new_state, lines, reason


def is_ts_sane(ts: Any, now_s: int) -> bool:
    es = parse_ts_to_epoch_s(ts)
    if es is None:
        return False
    if es < 0:
        return False
    if es > now_s + MAX_FUTURE_EVENT_S:
        return False
    return True

def validate_player_positions(evt: Dict[str, Any], now_s: int) -> bool:
    if evt.get("type") != "player_positions":
        return False
    if not is_ts_sane(evt.get("t"), now_s):
        return False
    players = evt.get("players")
    if not isinstance(players, list):
        return False
    for p in players:
        if not isinstance(p, dict):
            continue
        pid = p.get("id")
        if isinstance(pid, str) and pid:
            return True
    return False

def validate_player_flow(evt: Dict[str, Any], now_s: int) -> bool:
    if evt.get("type") != "player_flow":
        return False
    if not is_ts_sane(evt.get("t"), now_s):
        return False
    trans = evt.get("transitions")
    if not isinstance(trans, list):
        return False
    for tr in trans:
        if not isinstance(tr, dict):
            continue
        fx, fy = tr.get("fx"), tr.get("fy")
        tx, ty = tr.get("tx"), tr.get("ty")
        n = tr.get("n")
        if all(isinstance(v, (int, float)) for v in (fx, fy, tx, ty, n)):
            return True
    return False

def validate_world_zdos(evt: Dict[str, Any], now_s: int) -> Tuple[bool, bool]:
    if evt.get("type") != WORLD_ZDOS_TYPE:
        return False, False
    schema = evt.get("schema")
    if not isinstance(schema, str) or schema != WORLD_ZDOS_SCHEMA:
        return False, False
    if not is_ts_sane(evt.get("t"), now_s):
        return False, False
    try:
        bucket_s = int(evt.get("bucket_s", 0) or 0)
    except Exception:
        return False, False
    if bucket_s != 30:
        return False, False
    epoch = evt.get("epoch")
    if not isinstance(epoch, int):
        return False, False
    zones = evt.get("zones")
    if not isinstance(zones, list):
        return False, False
    for z in zones:
        if not isinstance(z, dict):
            continue
        zx_, zy_ = z.get("zx"), z.get("zy")
        cnt = z.get("count")
        if all(isinstance(v, (int, float)) for v in (zx_, zy_, cnt)):
            return True, False
    return (len(zones) == 0), False

def build_health_report(
    now_s: int,
    start_s: int,
    input_dir: str,
    out_dir: str,
    states: Dict[str, StreamState],
    live: LiveAgg,
    last_write_manifest: Optional[str],
    last_write_frame_live: Optional[str],
    last_write_frame_archive: Optional[str],
) -> Dict[str, Any]:
    per_stream: Dict[str, Any] = {}
    for k, st in states.items():
        per_stream[k] = {
            "lines_read": st.total_lines,
            "events_parsed": st.total_events,
            "parse_errors": st.parse_errors,
            "schema_errors": st.schema_errors,
            "dropped_events": st.dropped_events,
            "legacy_world_zdos": st.legacy_world_zdos,
            "last_event_ts": st.last_event_ts,
            "last_ingest_ts": st.last_ingest_ts,
        }
    return {
        "start_time_utc": iso_utc(start_s),
        "uptime_seconds": max(0, now_s - start_s),
        "input_dir": os.path.abspath(input_dir),
        "output_dir": os.path.abspath(out_dir),
        "streams": per_stream,
        "state_sizes": {
            "players": len(live.players_latest),
            "flow_edges": len(live.flow_state),
            "world_zdos_zones": len(live.hotspots_world_counts),
        },
        "last_write_ts": {
            "manifest": last_write_manifest,
            "frame_live": last_write_frame_live,
            "frame_archive": last_write_frame_archive,
        },
    }

def write_health(
    out_dir: str,
    now_s: int,
    start_s: int,
    input_dir: str,
    states: Dict[str, StreamState],
    live: LiveAgg,
    last_write_manifest: Optional[str],
    last_write_frame_live: Optional[str],
    last_write_frame_archive: Optional[str],
) -> None:
    health = build_health_report(
        now_s,
        start_s,
        input_dir,
        out_dir,
        states,
        live,
        last_write_manifest,
        last_write_frame_live,
        last_write_frame_archive,
    )
    atomic_write_json(os.path.join(out_dir, HEALTH_FILENAME), health)


def rehydrate_live_from_tail(live: LiveAgg, states: Dict[str, StreamState], max_bytes: int = 2_000_000, max_lines: int = 5000) -> None:
    """
    Best-effort: rebuild the in-memory live aggregates after restart even when offsets are at EOF.

    Why: offsets.json preserves counters/offsets, but live aggregates are not persisted.
    On restart, if no new lines arrive, the viewer would see empty arrays while meta.counts > 0.

    Strategy (MVP):
    - For each stream file that exists, read the last `max_bytes` bytes, parse up to `max_lines` lines,
      and ingest events into `live` WITHOUT touching total_events counters.
    - This restores last known player positions + accumulated hotspots/flow (as far as present in tail).
    """
    for stream_key in STREAM_FILES.keys():
        st = states.get(stream_key)
        if not st or not st.path:
            continue
        try:
            if not os.path.exists(st.path):
                continue
            size = os.path.getsize(st.path)
            start = max(0, size - int(max_bytes))
            with open(st.path, "rb") as f:
                f.seek(start)
                chunk = f.read()
            text = chunk.decode("utf-8", errors="replace")
            lines = text.splitlines()
            if max_lines and len(lines) > max_lines:
                lines = lines[-max_lines:]
            for ln in lines:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    evt = json.loads(ln)
                except Exception:
                    continue
                if not isinstance(evt, dict):
                    continue
                ts = evt.get("t")
                typ = evt.get("type")
                if not (isinstance(ts, str) and isinstance(typ, str)):
                    continue
                if not ts.endswith("Z"):
                    continue
                if parse_ts_to_epoch_s(ts) is None:
                    continue
                ingest_event(live, evt, is_rehydrate=True)
        except Exception:
            continue

def zk(zx: int, zy: int) -> str:
    return f"{zx},{zy}"

def fk(a: str, b: str) -> str:
    return f"{a}->{b}"

def parse_zk(k: str) -> Tuple[int, int]:
    a, b = k.split(",", 1)
    return int(a), int(b)

def parse_fk(k: str) -> Tuple[int, int, int, int]:
    left, right = k.split("->", 1)
    ax, ay = parse_zk(left)
    bx, by = parse_zk(right)
    return ax, ay, bx, by

@dataclass
class LiveAgg:
    hotspots_world_counts: Dict[str, int]
    hotspots_world_epoch: int
    hotspots_world_meta: Dict[str, Any]
    hotspots_world_seen: Set[str]
    flow_sum: Dict[str, int]
    flow_state: Dict[str, Dict[str, Any]]
    flow_updated: Set[str]
    players_latest: Dict[str, Dict[str, Any]]
    players_ttl: Dict[str, int]
    players_updated: Set[str]
    dirty_flow: bool

def new_live() -> LiveAgg:
    return LiveAgg(
        hotspots_world_counts={},
        hotspots_world_epoch=0,
        hotspots_world_meta={},
        hotspots_world_seen=set(),
        flow_sum={},
        flow_state={},
        flow_updated=set(),
        players_latest={},
        players_ttl={},
        players_updated=set(),
        dirty_flow=False,
    )

def ingest_event(live: LiveAgg, evt: Dict[str, Any], is_rehydrate: bool = False) -> bool:
    typ = evt.get("type")

    if typ == "player_positions":
        players = evt.get("players")
        if not isinstance(players, list):
            return False
        ok = False
        for p in players:
            if not isinstance(p, dict):
                continue
            pid = p.get("id")
            if not isinstance(pid, str) or not pid:
                continue
            live.players_latest[pid] = {
                "id": pid,
                "pfid": p.get("pfid", ""),
                "name": p.get("name", ""),
                "zx": p.get("zx"),
                "zy": p.get("zy"),
                "x": p.get("x"),
                "z": p.get("z"),
            }
            live.players_updated.add(pid)
            ok = True
        return ok

    if typ == "player_flow":
        trans = evt.get("transitions")
        if not isinstance(trans, list):
            return False
        ok = False
        for tr in trans:
            if not isinstance(tr, dict):
                continue
            fx, fy = tr.get("fx"), tr.get("fy")
            tx, ty = tr.get("tx"), tr.get("ty")
            n = tr.get("n")
            if not all(isinstance(v, (int, float)) for v in (fx, fy, tx, ty, n)):
                continue
            a = zk(int(fx), int(fy))
            b = zk(int(tx), int(ty))
            key = fk(a, b)
            live.flow_sum[key] = live.flow_sum.get(key, 0) + int(n)
            if not is_rehydrate:
                live.flow_updated.add(key)
            live.dirty_flow = True
            ok = True
        return ok

    if typ == WORLD_ZDOS_TYPE:
        return apply_world_zdos_event(live, evt)

    return False

def build_frame_live(live: LiveAgg, bucket_s: int, counts: Dict[str, int]) -> Dict[str, Any]:
    world_items = sorted(live.hotspots_world_counts.items(), key=lambda kv: kv[1], reverse=True)
    if len(world_items) > WORLD_ZDOS_TOPN:
        world_items = world_items[:WORLD_ZDOS_TOPN]
    world_zdos = [{"zx": parse_zk(k)[0], "zy": parse_zk(k)[1], "count": int(v)} for k, v in world_items if v > 0]
    flows: List[Dict[str, Any]] = []
    for k, st in live.flow_state.items():
        v = st.get("c", 0)
        if st.get("ttl", 0) <= 0 or v <= 0:
            continue
        ax, ay, bx, by = parse_fk(k)
        flows.append({"a": {"zx": ax, "zy": ay}, "b": {"zx": bx, "zy": by}, "c": int(v)})

    return {
        "meta": {
            "schema": SCHEMA_VERSION,
            "t": iso_utc(bucket_s),
            "counts": counts,
            "presence": "ignored",
        },
        "players": list(live.players_latest.values()),
        "flow": flows,
        "hotspots": {"world_zdos": world_zdos},
        "hotspots_meta": {"world_zdos": {**live.hotspots_world_meta, "epoch": live.hotspots_world_epoch}},
    }

def apply_player_ttl(live: LiveAgg, ttl_frames: int) -> None:
    """Frame-based TTL for player markers (decrement once per emitted frame)."""
    to_remove: List[str] = []
    for pid in list(live.players_latest.keys()):
        if pid in live.players_updated:
            live.players_ttl[pid] = ttl_frames
        else:
            if pid not in live.players_ttl:
                live.players_ttl[pid] = ttl_frames
            live.players_ttl[pid] -= 1
        if live.players_ttl.get(pid, 0) <= 0:
            to_remove.append(pid)
    for pid in to_remove:
        live.players_latest.pop(pid, None)
        live.players_ttl.pop(pid, None)
    live.players_updated.clear()

def apply_flow_ttl(live: LiveAgg, ttl_frames: int) -> None:
    """Frame-based TTL for directed flow edges (decrement once per emitted frame)."""
    # Update edges seen in this cadence bucket.
    for key, count in live.flow_sum.items():
        live.flow_state[key] = {"ttl": ttl_frames, "c": count}

    # Decrement edges not updated this frame.
    to_remove: List[str] = []
    for key, st in live.flow_state.items():
        if key in live.flow_updated:
            continue
        st["ttl"] = int(st.get("ttl", ttl_frames)) - 1
        if st["ttl"] <= 0:
            to_remove.append(key)
    for key in to_remove:
        live.flow_state.pop(key, None)

    live.flow_updated.clear()

def build_manifest(root: str, input_dir: str, out_dir: str, state_dir: str, states: Dict[str, StreamState], cadence_s: int, now_s: int) -> Dict[str, Any]:
    # Viewer scrubbing MUST be based on what frames actually exist.
    frames_dir = os.path.join(out_dir, "frames")
    earliest, latest = scan_frame_time_range(frames_dir)
    frames = list_frames(frames_dir)

    # Keep event-time info for debugging/ops (not for scrubbing).
    evt_earliest = None
    evt_latest = None
    for st in states.values():
        if st.last_event_ts:
            es = parse_ts_to_epoch_s(st.last_event_ts)
            if es is not None:
                if evt_earliest is None or es < evt_earliest:
                    evt_earliest = es
                if evt_latest is None or es > evt_latest:
                    evt_latest = es
    return {
        "schema": SCHEMA_VERSION,
        "generated_at": iso_utc(now_s),"paths": {
    "root": os.path.abspath(root),
    "input": os.path.abspath(input_dir),
    "out": os.path.abspath(out_dir),
    "state": os.path.abspath(state_dir),
    "web": {
        "manifest": "manifest.json",
        "frame_live": "frame_live.json",
        "frames_dir": "frames",
        "frame_template": "frames/frame_{compact}.json",
        "compact_format": "YYYYMMDDTHHMMSS"
    },
},
        "frames": frames,
        "streams": {
            k: {
                "file": STREAM_FILES.get(k),
                "total_lines": v.total_lines,
                "total_events": v.total_events,
                "last_event_ts": v.last_event_ts,
            }
            for k, v in states.items()
        },
        "time": {
            "earliest": iso_utc(earliest) if earliest is not None else None,
            "latest": iso_utc(latest) if latest is not None else None,
            "cadence_s": int(cadence_s),
            "event_earliest": iso_utc(evt_earliest) if evt_earliest is not None else None,
            "event_latest": iso_utc(evt_latest) if evt_latest is not None else None,
        },
        "notes": {
            "hotspots_world_zdos_type": WORLD_ZDOS_TYPE,
        },
    }

def heartbeat_print(states: Dict[str, StreamState], now_s: int, last_frame_written_s: int, prefix: str = "[aggv2]") -> None:
    parts = []
    for k in STREAM_FILES.keys():
        st = states.get(k)
        if not st:
            continue
        last_ts = st.last_event_ts or "-"
        parts.append(f"{k}: events={st.total_events} offset={st.offset} last={last_ts}")
    live_str = iso_utc(last_frame_written_s) if last_frame_written_s > 0 else "-"
    print(f"{prefix} heartbeat t={iso_utc(now_s)} frame_live={live_str} | " + " | ".join(parts), flush=True)

def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=_env("HEATFLOW_ROOT", script_dir()))
    ap.add_argument("--input", default=_env("HEATFLOW_INPUT_DIR"))
    ap.add_argument("--out", default=_env("HEATFLOW_OUT_DIR"))
    ap.add_argument("--state", default=_env("HEATFLOW_STATE_DIR"))
    ap.add_argument("--poll", type=float, default=_env_float("HEATFLOW_POLL_S", 1.0))
    ap.add_argument("--cadence", type=int, default=_env_int("HEATFLOW_CADENCE_S", 30))
    ap.add_argument("--frame-every", type=int, default=_env_int("HEATFLOW_FRAME_EVERY_S", 1))  # deprecated
    ap.add_argument("--heartbeat", type=float, default=_env_float("HEATFLOW_HEARTBEAT_S", 5.0))
    return ap.parse_args()

def main() -> None:
    args = parse_args()

    root = args.root
    input_dir = args.input or os.path.join(root, "input")
    out_dir = args.out or os.path.join(root, "out")
    state_dir = args.state or os.path.join(root, "state")

    poll_s = float(args.poll)
    cadence_s = int(args.cadence)
    if cadence_s <= 0:
        cadence_s = 30
    frame_every_s = int(args.frame_every)  # deprecated
    heartbeat_every_s = float(args.heartbeat)

    ensure_dir(input_dir)
    ensure_dir(out_dir)
    ensure_dir(os.path.join(out_dir, "frames"))
    ensure_dir(state_dir)

    offsets_path = os.path.join(state_dir, "offsets.json")
    offsets_exist = os.path.exists(offsets_path)
    states = load_offsets(state_dir)
    states = {k: v for k, v in states.items() if k in STREAM_FILES}
    world_state_missing = "hotspots_world_zdos" not in states

    # Ensure each stream exists in state with correct path
    for k, fn in STREAM_FILES.items():
        p = os.path.join(input_dir, fn)
        if k not in states:
            states[k] = StreamState(
                path=p,
                sig=FileSig(0, 0, 0),
                offset=0,
                total_lines=0,
                total_events=0,
                parse_errors=0,
                schema_errors=0,
                dropped_events=0,
                legacy_world_zdos=0,
                last_event_ts=None,
                last_ingest_ts=None,
            )
        else:
            states[k].path = p

    print(f"[aggv2] root={os.path.abspath(root)}")
    print(f"[aggv2] input={os.path.abspath(input_dir)}")
    print(f"[aggv2] out={os.path.abspath(out_dir)}")
    print(f"[aggv2] state={os.path.abspath(state_dir)}")
    print("[aggv2] presence=ignored (MVP)")
    for k in STREAM_FILES.keys():
        st = states[k]
        print(f"[aggv2] saved {k}: events={st.total_events} offset={st.offset} last_ts={st.last_event_ts}")
    print(f"[aggv2] heartbeat_every_s={heartbeat_every_s} poll_s={poll_s} cadence_s={cadence_s} (frame_every_s deprecated={frame_every_s})")

    live = new_live()

    world_cache_path = os.path.join(state_dir, WORLD_ZDOS_CACHE_FILENAME)
    cache_loaded = load_world_zdos_cache(world_cache_path, live)
    if cache_loaded:
        print(f"[aggv2] world_zdos cache restored: zones={len(live.hotspots_world_counts)} epoch={live.hotspots_world_epoch}", flush=True)
    else:
        tail_ok, events_n, buckets_n, latest_ts = rehydrate_world_zdos_from_tail(live, states["hotspots_world_zdos"].path)
        if tail_ok:
            print(f"[aggv2] world_zdos rehydrated from tail: events={events_n} buckets={buckets_n} zones={len(live.hotspots_world_counts)} epoch={live.hotspots_world_epoch}", flush=True)
            try:
                save_world_zdos_cache(world_cache_path, live)
            except Exception:
                pass
            st = states["hotspots_world_zdos"]
            st.total_events = max(st.total_events, buckets_n)
            if isinstance(latest_ts, str):
                st.last_event_ts = latest_ts
            states["hotspots_world_zdos"] = st
            try:
                save_offsets(state_dir, states)
            except Exception:
                pass

    if (not offsets_exist) or world_state_missing:
        st = states["hotspots_world_zdos"]
        sig = _file_sig(st.path)
        if sig is not None:
            try:
                size = os.path.getsize(st.path)
                st.offset = size
                st.sig = sig
                states["hotspots_world_zdos"] = st
                save_offsets(state_dir, states)
                print("[aggv2] world_zdos offset set to EOF to avoid replay", flush=True)
            except Exception:
                pass

    # Live state starts empty on each startup. Offsets handle catch-up of new lines.

    start_s = int(time.time())
    last_save = 0.0
    last_manifest = 0.0
    last_health = 0.0
    last_bucket_written: Optional[int] = None
    last_frame_written_s = 0
    last_heartbeat = 0.0
    last_world_log = 0.0
    last_write_manifest: Optional[str] = None
    last_write_frame_live: Optional[str] = None
    last_write_frame_archive: Optional[str] = None
    frames_written = 0

    try:
        while True:
            now = time.time()
            now_s = int(now)

            # Process all streams each poll
            for stream_key in STREAM_FILES.keys():
                st = states[stream_key]
                st2, lines, reset_reason = read_new_lines_with_reset(st)
                if reset_reason:
                    print(f"[aggv2] stream_reset {stream_key}: {reset_reason}", flush=True)
                states[stream_key] = st2

                if lines:
                    st2.total_lines += len(lines)

                for ln in lines:
                    ln = ln.strip()
                    if not ln:
                        continue
                    try:
                        evt = json.loads(ln)
                    except Exception:
                        st2.parse_errors += 1
                        continue
                    if not isinstance(evt, dict):
                        st2.parse_errors += 1
                        continue

                    ts = evt.get("t")
                    typ = evt.get("type")
                    if not (isinstance(ts, str) and isinstance(typ, str)):
                        st2.schema_errors += 1
                        st2.dropped_events += 1
                        continue
                    if not ts.endswith("Z"):
                        st2.schema_errors += 1
                        st2.dropped_events += 1
                        continue

                    valid = False
                    legacy_world = False
                    if typ == "player_positions":
                        valid = validate_player_positions(evt, now_s)
                    elif typ == "player_flow":
                        valid = validate_player_flow(evt, now_s)
                    elif typ == WORLD_ZDOS_TYPE:
                        valid, legacy_world = validate_world_zdos(evt, now_s)
                    else:
                        st2.dropped_events += 1
                        continue

                    if not valid:
                        st2.schema_errors += 1
                        st2.dropped_events += 1
                        continue

                    if ingest_event(live, evt):
                        st2.total_events += 1
                        st2.last_event_ts = ts
                        st2.last_ingest_ts = iso_utc(now_s)
                        if legacy_world:
                            st2.legacy_world_zdos += 1
                    else:
                        st2.dropped_events += 1

                states[stream_key] = st2
            # Write one frame per cadence bucket (enables deterministic scrubbing).
            bucket_s = (now_s // cadence_s) * cadence_s
            if last_bucket_written is None or bucket_s != last_bucket_written:
                apply_player_ttl(live, ttl_frames=10)
                apply_flow_ttl(live, ttl_frames=10)
                if frames_written % WORLD_ZDOS_QUANTILE_EVERY == 0 or not live.hotspots_world_meta:
                    live.hotspots_world_meta = compute_world_quantiles(list(live.hotspots_world_counts.values()))
                    try:
                        save_world_zdos_cache(world_cache_path, live, last_event_t=states["hotspots_world_zdos"].last_event_ts)
                    except Exception:
                        pass
                counts = {k: states[k].total_events for k in STREAM_FILES.keys()}
                frame = build_frame_live(live, bucket_s, counts)

                atomic_write_json(os.path.join(out_dir, "frame_live.json"), frame)
                atomic_write_json(os.path.join(out_dir, "frames", f"frame_{hms_compact(bucket_s)}.json"), frame)
                last_write_frame_live = iso_utc(now_s)
                last_write_frame_archive = iso_utc(now_s)
                last_frame_written_s = bucket_s
                last_bucket_written = bucket_s
                frames_written += 1
                if now - last_world_log >= 60.0:
                    zones_out = frame.get("hotspots", {}).get("world_zdos", [])
                    min_zx = min_zy = max_zx = max_zy = None
                    for z in zones_out:
                        try:
                            zx = int(z.get("zx"))
                            zy = int(z.get("zy"))
                        except Exception:
                            continue
                        if min_zx is None or zx < min_zx:
                            min_zx = zx
                        if max_zx is None or zx > max_zx:
                            max_zx = zx
                        if min_zy is None or zy < min_zy:
                            min_zy = zy
                        if max_zy is None or zy > max_zy:
                            max_zy = zy
                    print(
                        f"[aggv2] world_zdos frame epoch={live.hotspots_world_epoch} "
                        f"zones_cache={len(live.hotspots_world_counts)} zones_emitted={len(zones_out)} "
                        f"min_zx={min_zx} max_zx={max_zx} min_zy={min_zy} max_zy={max_zy}",
                        flush=True,
                    )
                    last_world_log = now
                # Reset per-bucket aggregates so flow represents "current" risk, not lifetime accumulation.
                live.flow_sum.clear()
                live.dirty_flow = False


            # Heartbeat (after processing + potential frame write)
            if now - last_heartbeat >= heartbeat_every_s:
                heartbeat_print(states, now_s, last_frame_written_s)
                last_heartbeat = now

            # Save state periodically
            if now - last_save >= 2.0:
                save_offsets(state_dir, states)
                last_save = now

            # Update manifest periodically
            if now - last_manifest >= 2.0:
                atomic_write_json(os.path.join(out_dir, "manifest.json"), build_manifest(root, input_dir, out_dir, state_dir, states, cadence_s, now_s))
                last_manifest = now
                last_write_manifest = iso_utc(now_s)

            # Health output
            if now - last_health >= HEALTH_WRITE_EVERY_S:
                write_health(out_dir, now_s, start_s, input_dir, states, live, last_write_manifest, last_write_frame_live, last_write_frame_archive)
                last_health = now

            time.sleep(poll_s)

    except KeyboardInterrupt:
        print("\n[aggv2] stopped", flush=True)
    finally:
        try:
            save_offsets(state_dir, states)
        except Exception:
            pass
        try:
            atomic_write_json(os.path.join(out_dir, "manifest.json"), build_manifest(root, input_dir, out_dir, state_dir, states, cadence_s, int(time.time())))
        except Exception:
            pass

if __name__ == "__main__":
    main()
