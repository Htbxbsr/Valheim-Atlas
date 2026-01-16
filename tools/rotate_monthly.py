#!/usr/bin/env python3
"""
Monthly rotation tool for Heatflow raw JSONL and playback frames.
Run during a restart window before the plugin initializes.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import os
import re
import shutil
import subprocess
import tarfile
from typing import Dict, List, Optional, Tuple

PREFERRED_RAW_DIR_NAMES = ("heatflow", "input", "in", "raw", "data")
ROTATION_STATE_NAME = ".rotation_state.json"

FRAME_RE = re.compile(r"^frame_(\d{8})T(\d{6})\.json$")

def find_repo_root(start: str) -> str:
    cur = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(cur, ".git")):
            return cur
        if os.path.exists(os.path.join(cur, "aggregator.py")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            return os.path.abspath(start)
        cur = parent

def month_str(d: dt.date) -> str:
    return f"{d.year:04d}-{d.month:02d}"

def prev_month(d: dt.date) -> dt.date:
    y, m = d.year, d.month
    if m == 1:
        return dt.date(y - 1, 12, 1)
    return dt.date(y, m - 1, 1)

def load_state(path: str) -> Dict[str, str]:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}

def save_state(path: str, data: Dict[str, str], dry_run: bool) -> None:
    if dry_run:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

def find_jsonl_candidates(root: str) -> List[str]:
    candidates = {}
    for dirpath, dirnames, filenames in os.walk(root):
        if any(fn.lower().endswith(".jsonl") for fn in filenames):
            count = sum(1 for fn in filenames if fn.lower().endswith(".jsonl"))
            candidates[dirpath] = count
    if not candidates:
        return []
    # prefer named dirs, then highest count
    def score(path: str) -> Tuple[int, int]:
        base = os.path.basename(path).lower()
        pref = 1 if base in PREFERRED_RAW_DIR_NAMES else 0
        return (pref, candidates[path])
    best = sorted(candidates.keys(), key=lambda p: score(p), reverse=True)
    return best

def find_frames_dir(root: str) -> Optional[str]:
    preferred = os.path.join(root, "out", "frames")
    if os.path.isdir(preferred):
        return preferred
    best = None
    best_count = 0
    for dirpath, _, filenames in os.walk(root):
        count = sum(1 for fn in filenames if FRAME_RE.match(fn))
        if count > best_count:
            best = dirpath
            best_count = count
    return best

def unique_path(path: str) -> str:
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    n = 2
    while True:
        candidate = f"{base}_{n}{ext}"
        if not os.path.exists(candidate):
            return candidate
        n += 1

def gzip_file(src: str, dst: str, dry_run: bool) -> None:
    if dry_run:
        return
    with open(src, "rb") as f_in, gzip.open(dst, "wb") as f_out:
        shutil.copyfileobj(f_in, f_out)

def rotate_raw_jsonl(raw_dir: str, archive_dir: str, cur_month: str, dry_run: bool) -> int:
    if not os.path.isdir(raw_dir):
        return 0
    out_dir = os.path.join(archive_dir, cur_month, "raw")
    os.makedirs(out_dir, exist_ok=True)
    count = 0
    for name in os.listdir(raw_dir):
        if not name.lower().endswith(".jsonl"):
            continue
        src = os.path.join(raw_dir, name)
        if not os.path.isfile(src):
            continue
        base = os.path.basename(name)
        dest = os.path.join(out_dir, f"{base}.{cur_month}.jsonl")
        dest = unique_path(dest)
        moved = False
        try:
            if not dry_run:
                os.makedirs(out_dir, exist_ok=True)
                shutil.move(src, dest)
                moved = True
            gz_path = dest + ".gz"
            gz_path = unique_path(gz_path)
            gzip_file(dest, gz_path, dry_run)
            if not dry_run:
                try:
                    os.remove(dest)
                except Exception:
                    pass
            count += 1
        finally:
            if not dry_run:
                # always recreate the original path for the next startup
                try:
                    with open(src, "a", encoding="utf-8"):
                        pass
                except Exception:
                    if moved:
                        # best-effort: do not fail the whole run if touch fails
                        pass
    return count

def archive_frames(frames_dir: str, archive_dir: str, target_month: str, dry_run: bool) -> int:
    if not os.path.isdir(frames_dir):
        return 0
    to_archive = []
    for name in os.listdir(frames_dir):
        m = FRAME_RE.match(name)
        if not m:
            continue
        ymd = m.group(1)
        month = f"{ymd[0:4]}-{ymd[4:6]}"
        if month != target_month:
            continue
        to_archive.append(os.path.join(frames_dir, name))
    if not to_archive:
        return 0
    out_dir = os.path.join(archive_dir, target_month, "frames")
    os.makedirs(out_dir, exist_ok=True)
    tar_base = os.path.join(out_dir, f"frames_{target_month}.tar")

    used_zstd = False
    zstd_path = shutil.which("zstd")
    if zstd_path:
        tar_path = unique_path(tar_base)
        if not dry_run:
            with tarfile.open(tar_path, "w") as tf:
                for p in to_archive:
                    tf.add(p, arcname=os.path.basename(p))
            zst_path = unique_path(tar_path + ".zst")
            try:
                subprocess.run([zstd_path, "-q", "-f", tar_path, "-o", zst_path], check=True)
                used_zstd = True
                os.remove(tar_path)
            except Exception:
                used_zstd = False
        else:
            used_zstd = True
    if not used_zstd:
        tgz_path = unique_path(tar_base + ".gz")
        if not dry_run:
            with tarfile.open(tgz_path, "w:gz") as tf:
                for p in to_archive:
                    tf.add(p, arcname=os.path.basename(p))

    if not dry_run:
        for p in to_archive:
            try:
                os.remove(p)
            except Exception:
                pass
    return len(to_archive)

def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=None, help="Repo root (auto-detect if omitted)")
    ap.add_argument("--raw-dir", default=None, help="Raw JSONL directory override")
    ap.add_argument("--frames-dir", default=None, help="Frames directory override")
    ap.add_argument("--archive-dir", default=None, help="Archive output directory override")
    ap.add_argument("--dry-run", action="store_true", help="Show actions without modifying files")
    ap.add_argument("--force", action="store_true", help="Rotate even if already done this month")
    return ap.parse_args()

def main() -> int:
    args = parse_args()
    root = find_repo_root(args.root or os.getcwd())
    archive_dir = os.path.abspath(args.archive_dir or os.path.join(root, "archive"))
    state_path = os.path.join(archive_dir, ROTATION_STATE_NAME)
    state = load_state(state_path)

    today = dt.date.today()
    cur_month = month_str(today)
    prev = prev_month(today)
    prev_month_str = month_str(prev)

    if not args.force and state.get("last_rotated_month") == cur_month:
        print(f"[rotate] already rotated for {cur_month}; use --force to override")
        return 0

    raw_dir = args.raw_dir
    if not raw_dir:
        candidates = find_jsonl_candidates(root)
        raw_dir = candidates[0] if candidates else None
    frames_dir = args.frames_dir or find_frames_dir(root)

    print(f"[rotate] root={root}")
    print(f"[rotate] raw_dir={raw_dir or 'N/A'}")
    print(f"[rotate] frames_dir={frames_dir or 'N/A'}")
    print(f"[rotate] archive_dir={archive_dir}")
    print(f"[rotate] month={cur_month} prev={prev_month_str}")

    raw_count = rotate_raw_jsonl(raw_dir, archive_dir, cur_month, args.dry_run) if raw_dir else 0
    frame_count = archive_frames(frames_dir, archive_dir, prev_month_str, args.dry_run) if frames_dir else 0

    print(f"[rotate] raw_rotated={raw_count} frames_archived={frame_count}")

    state = {
        "last_rotated_month": cur_month,
        "raw_dir": raw_dir or "",
        "frames_dir": frames_dir or "",
        "archive_dir": archive_dir,
    }
    save_state(state_path, state, args.dry_run)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
