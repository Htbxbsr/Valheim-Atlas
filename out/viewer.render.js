'use strict';

// ---------- render ----------
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const cw = el.canvas.clientWidth;
    const ch = el.canvas.clientHeight;

    // Layout guard: wait until canvas has size.
    if (cw === 0 || ch === 0) {
      requestAnimationFrame(draw);
      return;
    }

    el.canvas.width = Math.floor(cw * dpr);
    el.canvas.height = Math.floor(ch * dpr);

    const ctx = el.canvas.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);

    // DPR scale once
    ctx.scale(dpr, dpr);

    // Map must exist to render
    if (!state.mapReady) return;

    // Apply viewport transform in CSS pixels
    ctx.translate(state.view.panX, state.view.panY);
    ctx.scale(state.view.zoom, state.view.zoom);

    // Draw base map
    ctx.drawImage(state.mapImg, 0, 0);

    // Draw frame overlays
    // Manual check: start viewer -> confirm fewer reds, lower opacity, toggle still works.
    const fr = state.frame;
    if (!fr) return;

    // Layers toggles
    const showPlayers = !!el.togPlayers?.checked;
    const showFlow = !!el.togFlow?.checked;
    const showWorldZdo = !!el.togWorldZdo?.checked;
    if (!showFlow && el.flowTooltip) el.flowTooltip.style.display = 'none';

    // Hotspots
    if (showWorldZdo) {
      const worldZdos = state.worldZdosZones || [];
      const hotMinCount = 1;
      const th = getWorldZdoThresholds(fr);

      const drawAmpel = (entry, count, sev) => {
        if (count < hotMinCount) return;
        const { x, z: wz } = zoneCenterWorld(entry.zx, entry.zy);
        const { px, py } = worldToMapPx(x, wz);
        let col = { r: 0, g: 200, b: 83, a: 0.45 };
        if (sev === 'red') col = { r: 213, g: 0, b: 0, a: 0.35 };
        else if (sev === 'yellow') col = { r: 255, g: 214, b: 0, a: 0.40 };
        const r = visuals.heatRadiusPx;
        const g = ctx.createRadialGradient(px, py, 0, px, py, r);
        g.addColorStop(0, `rgba(${col.r},${col.g},${col.b},${col.a})`);
        g.addColorStop(0.55, `rgba(${col.r},${col.g},${col.b},${col.a * 0.55})`);
        g.addColorStop(1, `rgba(${col.r},${col.g},${col.b},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      };

      ctx.save();
      worldZdoBuckets.green.length = 0;
      worldZdoBuckets.yellow.length = 0;
      worldZdoBuckets.red.length = 0;
      for (const entry of worldZdos) {
        if (entry?.zx == null || entry?.zy == null) continue;
        const count = Number(entry.count ?? entry.v) || 0;
        if (count >= th.redTh) worldZdoBuckets.red.push(entry);
        else if (count >= th.yellowTh) worldZdoBuckets.yellow.push(entry);
        else worldZdoBuckets.green.push(entry);
      }
      // Severity draw order: red > yellow > green (higher severity on top).
      for (const entry of worldZdoBuckets.green) {
        drawAmpel(entry, Number(entry.count ?? entry.v) || 0, 'green');
      }
      for (const entry of worldZdoBuckets.yellow) {
        drawAmpel(entry, Number(entry.count ?? entry.v) || 0, 'yellow');
      }
      for (const entry of worldZdoBuckets.red) {
        drawAmpel(entry, Number(entry.count ?? entry.v) || 0, 'red');
      }
      ctx.restore();
    }

    // Locations overlay
    drawLocations(ctx);
    if (state.locationsEnabled) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
      ctx.fillText('LOC ON', 10, 16);
      ctx.restore();
    }

    if (showFlow) drawFlow(ctx);
    if (showPlayers) drawPlayers(ctx, fr?.players ?? []);

    // overlay counter top right (show per-frame counts)
    const c = fr?.meta?.counts || {};

    // players: dedupe by name/label/id so overlay matches what we draw
    let playersN = 0;
    if (Array.isArray(fr?.players)) {
      const byKey = new Map();
      for (const p of fr.players) {
        const key = (p?.name ?? p?.label ?? p?.player_id ?? p?.id ?? '').toString() || '__unknown__';
        byKey.set(key, 1);
      }
      playersN = byKey.size;
    } else {
      playersN = (c.player_positions ?? 0);
    }

    // flow: count transitions array length if available; otherwise fall back to meta counts
    let flowN = 0;
    if (Array.isArray(fr?.flow)) flowN = fr.flow.length;
    else if (fr?.flow && Array.isArray(fr.flow.transitions)) flowN = fr.flow.transitions.length;
    else flowN = (c.player_flow ?? 0);

    const wN = (c.hotspots_world_zdos ?? state.worldZdosZones.length);

    if (el.overlayTopRight) {
      el.overlayTopRight.textContent =
        `${state.mode}: players=${playersN} flow=${flowN} hotspots(world_zdos=${wN})`;
    }
    if (state.cursor) {
      maybeUpdateDebug();
    }
    // location tooltip removed
  }

  function heatColorFromCount(cnt) {
    if (!Number.isFinite(cnt)) return { r: 0, g: 220, b: 90 };
    if (cnt < 500) return { r: 0, g: 220, b: 90 };    // green
    if (cnt <= 1500) return { r: 255, g: 235, b: 70 }; // yellow
    if (cnt <= 3000) return { r: 255, g: 150, b: 40 }; // orange
    return { r: 255, g: 40, b: 40 };                   // red
  }

  function drawPlayers(ctx, arr) {
    if (!Array.isArray(arr) || arr.length === 0) return;

    const byKey = new Map();
    for (const p of arr) {
      const key = (p?.name ?? p?.label ?? p?.id ?? p?.pfid ?? '').toString() || '__unknown__';
      byKey.set(key, p);
    }

    ctx.save();
    ctx.globalAlpha = 0.95;

    for (const [key, p] of byKey.entries()) {
      const name = (p?.name ?? p?.label ?? '').toString();
      const x = Number(p?.x);
      const z = Number(p?.z);
      const zx = Number(p?.zx);
      const zy = Number(p?.zy);
      const nameless = !name.trim();
      const nearSpawn = (Number.isFinite(x) && Number.isFinite(z) && Math.abs(x) <= 2 && Math.abs(z) <= 2)
        || (!Number.isFinite(x) && !Number.isFinite(z) && Number.isFinite(zx) && Number.isFinite(zy) && zx === 0 && zy === 0);
      if (nameless && nearSpawn) continue;
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;

      const { px, py } = worldToMapPx(x, z);

      // glow
      const glow = ctx.createRadialGradient(px, py, 0, px, py, 16);
      glow.addColorStop(0, 'rgba(120,200,255,0.55)');
      glow.addColorStop(1, 'rgba(120,200,255,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(px, py, 16, 0, Math.PI * 2);
      ctx.fill();

      // core
      ctx.fillStyle = 'rgba(215,245,255,0.95)';
      ctx.strokeStyle = 'rgba(10,20,30,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      if (name && state.view.zoom >= 0.55) {
        ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillText(name, px + 11, py + 1);
        ctx.fillStyle = 'rgba(230,250,255,0.95)';
        ctx.fillText(name, px + 10, py);
      }
    }
    ctx.restore();
  }


  function getFlowTransitionsFromFrame(fr) {
    const flowLike = fr?.flow;
    const transitions = Array.isArray(flowLike)
      ? flowLike
      : (flowLike && Array.isArray(flowLike.transitions) ? flowLike.transitions : []);
    return Array.isArray(transitions) ? transitions : [];
  }

  function getFlowCount(tr) {
    const n = Number(tr?.n ?? tr?.count ?? tr?.weight ?? tr?.w ?? tr?.events ?? 1);
    return Number.isFinite(n) ? n : 1;
  }

  function getFlowZones(tr) {
    // common schemas:
    // 1) {fx,fy,tx,ty}
    // 2) {from_zx,from_zy,to_zx,to_zy}
    // 3) {from:{zx,zy}, to:{zx,zy}}
    // 4) {a:{zx,zy}, b:{zx,zy}}
    // 5) {from:[zx,zy], to:[zx,zy]}
    const fx = tr?.fx ?? tr?.from_zx ?? tr?.fromX ?? tr?.fromZX ?? tr?.from?.zx ?? tr?.a?.zx ?? (Array.isArray(tr?.from) ? tr.from[0] : undefined);
    const fy = tr?.fy ?? tr?.from_zy ?? tr?.fromY ?? tr?.fromZY ?? tr?.from?.zy ?? tr?.a?.zy ?? (Array.isArray(tr?.from) ? tr.from[1] : undefined);
    const tx = tr?.tx ?? tr?.to_zx   ?? tr?.toX   ?? tr?.toZX   ?? tr?.to?.zx   ?? tr?.b?.zx ?? (Array.isArray(tr?.to) ? tr.to[0] : undefined);
    const ty = tr?.ty ?? tr?.to_zy   ?? tr?.toY   ?? tr?.toZY   ?? tr?.to?.zy   ?? tr?.b?.zy ?? (Array.isArray(tr?.to) ? tr.to[1] : undefined);

    const ok = [fx, fy, tx, ty].every((q) => q !== undefined && q !== null && q !== '' && Number.isFinite(Number(q)));
    if (!ok) return null;
    return { fx: Number(fx), fy: Number(fy), tx: Number(tx), ty: Number(ty) };
  }

  function getFlowWindowIndices(mode, selectedIdx, n) {
    if (!Array.isArray(state.frames) || state.frames.length === 0) return [];
    let endIdx = null;
    if (mode === 'LIVE') endIdx = state.frames.length - 1;
    else if (Number.isFinite(selectedIdx)) endIdx = selectedIdx;
    if (endIdx == null) return [];
    const startIdx = Math.max(0, endIdx - (n - 1));
    const out = [];
    for (let i = startIdx; i <= endIdx; i++) out.push(i);
    return out;
  }

  function clusterFlowEdges(edges) {
    // Clustering heuristic: same direction (cos >= 0.94 ≈ 20deg),
    // midpoints within ~18px map space, and length diff within ~18px.
    // Deterministic: edges sorted by weight desc.
    const cosMin = 0.94;
    const midMax = 18;
    const lenMax = 18;
    const clusters = [];

    for (const e of edges) {
      const dx = e.bx - e.ax;
      const dy = e.by - e.ay;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const dirx = dx / len;
      const diry = dy / len;
      const mx = (e.ax + e.bx) * 0.5;
      const my = (e.ay + e.by) * 0.5;

      let hit = null;
      for (const c of clusters) {
        const dot = dirx * c.dirx + diry * c.diry;
        if (dot < cosMin) continue;
        const mdx = mx - c.mx;
        const mdy = my - c.my;
        const md = Math.sqrt(mdx * mdx + mdy * mdy);
        if (md > midMax) continue;
        if (Math.abs(len - c.len) > lenMax) continue;
        hit = c;
        break;
      }

      if (!hit) {
        clusters.push({
          repr: e,
          total: e.count,
          weight: e.count,
          members: [e],
          frames: new Set(e.frames),
          names: new Set(e.names),
          dirx,
          diry,
          mx,
          my,
          len,
          ax: e.ax * e.count,
          ay: e.ay * e.count,
          bx: e.bx * e.count,
          by: e.by * e.count,
        });
      } else {
        hit.total += e.count;
        hit.members.push(e);
        hit.weight += e.count;
        hit.ax += e.ax * e.count;
        hit.ay += e.ay * e.count;
        hit.bx += e.bx * e.count;
        hit.by += e.by * e.count;
        for (const f of e.frames) hit.frames.add(f);
        for (const n of e.names) hit.names.add(n);
      }
    }

    for (const c of clusters) {
      const w = Math.max(1, c.weight);
      c.ax = c.ax / w;
      c.ay = c.ay / w;
      c.bx = c.bx / w;
      c.by = c.by / w;
      c.mx = (c.ax + c.bx) * 0.5;
      c.my = (c.ay + c.by) * 0.5;
      const dx = c.bx - c.ax;
      const dy = c.by - c.ay;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      c.dirx = dx / len;
      c.diry = dy / len;
      c.len = len;
    }

    return clusters;
  }

  async function buildFlowAggregation() {
    if (state.flowAggBuilding) return;
    state.flowAggBuilding = true;
    const wasDirty = state.flowAggDirty;
    try {
      if (!el.togFlow?.checked) {
        state.flowAgg = { segments: [], clusters: [], windowLabel: '' };
        state.flowAggDirty = false;
        return;
      }

      const n = state.flowWindowN;
      const indices = getFlowWindowIndices(state.mode, state.selectedFrameIdx, n);
      const endIdx = indices.length > 0 ? indices[indices.length - 1] : -1;
      const liveTail = state.liveRing.length > 0 ? state.liveRing[state.liveRing.length - 1].seq : -1;
      const key = `${state.mode}:${state.mode === 'LIVE' ? liveTail : endIdx}:${n}:${state.frames.length}:${state.liveRing.length}`;
      if (key === state.flowAggKey && !wasDirty) {
        state.flowAggDirty = false;
        return;
      }
      state.flowAggKey = key;
      const windowLabel = (state.mode === 'LIVE')
        ? `LIVE last ${Math.min(n, state.liveRing.length) || n}`
        : (indices.length > 0 ? `Frames: ${indices[0]}..${indices[indices.length - 1]}` : 'Frames: -');

      const frames = [];
      if (state.mode === 'LIVE') {
        const start = Math.max(0, state.liveRing.length - n);
        for (const it of state.liveRing.slice(start)) {
          frames.push({ idx: it.seq, fr: normalizeFrame(it.fr) });
        }
      } else {
        for (const idx of indices) {
          const cached = state.frameCache.get(idx);
          if (cached?.fr) frames.push({ idx, fr: normalizeFrame(cached.fr) });
        }
      }
      if (frames.length === 0 && state.frame) {
        frames.push({ idx: state.selectedFrameIdx ?? -1, fr: state.frame });
      }

      const edgeMap = new Map();
      const edgeNames = new Map();

      // Infer players per edge by comparing player zones across consecutive frames.
      for (let i = 1; i < frames.length; i++) {
        const prev = frames[i - 1].fr;
        const cur = frames[i].fr;
        const prevPlayers = Array.isArray(prev?.players) ? prev.players : [];
        const curPlayers = Array.isArray(cur?.players) ? cur.players : [];
        const prevById = new Map();
        for (const p of prevPlayers) {
          const pid = (p?.id ?? p?.pfid ?? p?.name ?? p?.label ?? '').toString();
          if (!pid) continue;
          let zx = p?.zx;
          let zy = p?.zy;
          if (!Number.isFinite(zx) || !Number.isFinite(zy)) {
            const x = Number(p?.x);
            const z = Number(p?.z);
            if (Number.isFinite(x) && Number.isFinite(z)) {
              zx = Math.floor(x / cfg.zoneSize);
              zy = Math.floor(z / cfg.zoneSize);
            }
          }
          if (!Number.isFinite(zx) || !Number.isFinite(zy)) continue;
          prevById.set(pid, { zx, zy });
        }
        for (const p of curPlayers) {
          const pid = (p?.id ?? p?.pfid ?? p?.name ?? p?.label ?? '').toString();
          if (!pid) continue;
          let zx = p?.zx;
          let zy = p?.zy;
          if (!Number.isFinite(zx) || !Number.isFinite(zy)) {
            const x = Number(p?.x);
            const z = Number(p?.z);
            if (Number.isFinite(x) && Number.isFinite(z)) {
              zx = Math.floor(x / cfg.zoneSize);
              zy = Math.floor(z / cfg.zoneSize);
            }
          }
          if (!Number.isFinite(zx) || !Number.isFinite(zy)) continue;
          const prevPos = prevById.get(pid);
          if (!prevPos) continue;
          if (prevPos.zx === zx && prevPos.zy === zy) continue;
          const ekey = `${prevPos.zx},${prevPos.zy}->${zx},${zy}`;
          if (!edgeNames.has(ekey)) edgeNames.set(ekey, new Set());
          const nm = (p?.name ?? p?.label ?? pid).toString();
          if (nm) edgeNames.get(ekey).add(nm);
        }
      }
      for (const it of frames) {
        const transitions = getFlowTransitionsFromFrame(it.fr);
        for (const tr of transitions) {
          const z = getFlowZones(tr);
          if (!z) continue;
          const ncount = getFlowCount(tr);
          if (ncount <= 0) continue;
          const key = `${z.fx},${z.fy}->${z.tx},${z.ty}`;
          let entry = edgeMap.get(key);
          if (!entry) {
            entry = {
              fx: z.fx, fy: z.fy, tx: z.tx, ty: z.ty,
              count: 0,
              frames: new Set(),
              names: new Set(),
            };
            edgeMap.set(key, entry);
          }
          entry.count += ncount;
          if (Number.isFinite(it.idx)) entry.frames.add(it.idx);
          const names = tr?.players ?? tr?.names ?? tr?.player_names ?? tr?.playerNames ?? null;
          if (Array.isArray(names)) {
            for (const nm of names) {
              if (typeof nm === 'string' && nm) entry.names.add(nm);
            }
          }
        }
      }

      const flowMin = Number(cfg.flowMinC || 1);
      const flowMax = Math.max(0, Math.floor(Number(cfg.flowMaxEdges || 180)));

      for (const [ekey, ns] of edgeNames.entries()) {
        const entry = edgeMap.get(ekey);
        if (!entry) continue;
        for (const nm of ns) entry.names.add(nm);
      }

      const edges = Array.from(edgeMap.values())
        .filter((e) => e.count >= flowMin)
        .map((e) => {
          const a = zoneCenterWorld(e.fx, e.fy);
          const b = zoneCenterWorld(e.tx, e.ty);
          const A = worldToMapPx(a.x, a.z);
          const B = worldToMapPx(b.x, b.z);
          return { ...e, ax: A.px, ay: A.py, bx: B.px, by: B.py };
        })
        .filter((e) => Number.isFinite(e.ax + e.ay + e.bx + e.by))
        .sort((a, b) => b.count - a.count)
        .slice(0, flowMax || edgeMap.size);

      const clusters = clusterFlowEdges(edges);
      const segments = clusters.map((c) => ({
        ax: c.ax,
        ay: c.ay,
        bx: c.bx,
        by: c.by,
        count: c.total,
        members: c.members,
        frames: Array.from(c.frames.values()),
        names: Array.from(c.names.values()),
        repr: c.repr,
      }));

      state.flowAgg = { segments, clusters, windowLabel };
      state.flowAggDirty = false;
    } finally {
      state.flowAggBuilding = false;
      if (state.flowAggDirty) scheduleFlowRebuild();
    }
  }

  function scheduleFlowRebuild() {
    state.flowAggDirty = true;
    if (state.flowAggBuilding) return;
    if (state.flowRebuildTimer) return;
    state.flowRebuildTimer = setTimeout(() => {
      state.flowRebuildTimer = null;
      buildFlowAggregation().then(() => draw());
    }, 100);
  }

  function distPointToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    if (dx === 0 && dy === 0) {
      const dxa = px - ax;
      const dya = py - ay;
      return Math.sqrt(dxa * dxa + dya * dya);
    }
    const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    const tt = Math.max(0, Math.min(1, t));
    const cx = ax + tt * dx;
    const cy = ay + tt * dy;
    const ddx = px - cx;
    const ddy = py - cy;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }

  function drawArrowhead(ctx, ax, ay, bx, by, size, color) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(len) || len <= 0.001) return;
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;
    const tipX = bx;
    const tipY = by;
    const backX = bx - ux * size;
    const backY = by - uy * size;
    const wing = size * 0.55;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(backX + px * wing, backY + py * wing);
    ctx.lineTo(backX - px * wing, backY - py * wing);
    ctx.closePath();
    ctx.fill();
  }

  function playerNamesNearEdge(edge) {
    // Heuristic fallback: players within ~2 zones of either endpoint.
    const players = Array.isArray(state.frame?.players) ? state.frame.players : [];
    if (players.length === 0) return [];
    const names = new Set();
    const ra = 2;
    for (const p of players) {
      const name = (p?.name ?? p?.label ?? '').toString();
      if (!name) continue;
      let zx = p?.zx;
      let zy = p?.zy;
      if (!Number.isFinite(zx) || !Number.isFinite(zy)) {
        const x = Number(p?.x);
        const z = Number(p?.z);
        if (Number.isFinite(x) && Number.isFinite(z)) {
          zx = Math.floor(x / cfg.zoneSize);
          zy = Math.floor(z / cfg.zoneSize);
        }
      }
      if (!Number.isFinite(zx) || !Number.isFinite(zy)) continue;
      const d1 = Math.max(Math.abs(zx - edge.fx), Math.abs(zy - edge.fy));
      const d2 = Math.max(Math.abs(zx - edge.tx), Math.abs(zy - edge.ty));
      if (d1 <= ra || d2 <= ra) names.add(name);
    }
    return Array.from(names.values());
  }

  function drawFlow(ctx) {
    const segments = state.flowAgg?.segments || [];
    if (!Array.isArray(segments) || segments.length === 0) {
      if (el.flowTooltip) el.flowTooltip.style.display = 'none';
      return;
    }

    let maxN = 1;
    for (const s of segments) maxN = Math.max(maxN, s.count);
    maxN = Math.max(maxN, 1);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    for (const s of segments) {
      if (!Number.isFinite(s.ax + s.ay + s.bx + s.by)) continue;
      const t = clamp(Math.log(s.count + 1) / Math.log(maxN + 1), 0, 1);
      const width = clamp(1.5 + 6.5 * t, 1.5, 8);
      const alpha = clamp(0.55 + 0.4 * t, 0.55, 0.95);
      const glowAlpha = clamp(0.18 + 0.25 * t, 0.18, 0.5);

      // subtle glow/outline
      ctx.strokeStyle = `rgba(255,138,0,${glowAlpha})`;
      ctx.lineWidth = width + 3;
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      ctx.stroke();

      // main stroke
      ctx.strokeStyle = `rgba(255,138,0,${alpha})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(s.ax, s.ay);
      ctx.lineTo(s.bx, s.by);
      ctx.stroke();

      // direction arrowhead
      const ahSize = clamp(width * 2.4, 5, 14);
      drawArrowhead(ctx, s.ax, s.ay, s.bx, s.by, ahSize, `rgba(255,138,0,${Math.min(1, alpha + 0.1)})`);
    }

    ctx.restore();

    if (!state.cursor || !el.flowTooltip) return;
    const mapPt = screenToMapPx(state.cursor.x, state.cursor.y);
    if (!mapPt) {
      el.flowTooltip.style.display = 'none';
      return;
    }

    const hitDist = 6 / Math.max(0.2, state.view.zoom);
    let best = null;
    let bestD = hitDist;
    for (const s of segments) {
      const d = distPointToSegment(mapPt.px, mapPt.py, s.ax, s.ay, s.bx, s.by);
      if (d <= bestD) {
        bestD = d;
        best = s;
      }
    }

    if (!best) {
      el.flowTooltip.style.display = 'none';
      return;
    }

    let nameLine = '';
    if (best.names && best.names.length > 0) {
      nameLine = `Players: ${best.names.join(', ')}`;
    } else {
      const heuristic = playerNamesNearEdge(best.repr);
      if (heuristic.length > 0) {
        nameLine = `Players near segment (heuristic): ${heuristic.join(', ')}`;
      }
    }

    const aWorld = zoneCenterWorld(best.repr.fx, best.repr.fy);
    const bWorld = zoneCenterWorld(best.repr.tx, best.repr.ty);
    el.flowTooltip.textContent =
      `Flow: ${Math.round(best.count)}\n` +
      `From: ${best.repr.fx},${best.repr.fy} → ${best.repr.tx},${best.repr.ty}\n` +
      `World: x=${aWorld.x.toFixed(0)} z=${aWorld.z.toFixed(0)} → x=${bWorld.x.toFixed(0)} z=${bWorld.z.toFixed(0)}\n` +
      `${state.flowAgg.windowLabel}\n` +
      `Contributors: ${best.members.length}` +
      (nameLine ? `\n${nameLine}` : '');
    el.flowTooltip.style.display = 'block';
  }

  function drawLocations(ctx) {
    if (!state.locationsEnabled || !state.locationsLoaded) return;
    if (!Array.isArray(state.locations)) return;

    const filters = state.locationFilters;
    const projected = [];

    ctx.save();
    ctx.globalAlpha = 0.9;

    for (const loc of state.locations) {
      const cat = classifyLocation(loc.prefab);
      if (cat === 'HIDDEN') continue;
      if (!filters[cat]) continue;
      const { px, py } = worldToMapPx(loc.x, loc.z);
      let r = 3;
      if (cat === 'BOSS') r = 7;
      else if (cat === 'SPECIAL') r = 5;
      else if (cat === 'DUNGEON' || cat === 'TARPIT') r = 4;
      else if (cat === 'RUNESTONE') r = 2;
      else if (cat === 'START') r = 3;
      let color = 'rgba(220,220,220,0.85)';
      if (cat === 'START') color = 'rgba(255,230,120,0.95)';
      else if (cat === 'BOSS') color = 'rgba(255,120,120,0.95)';
      else if (cat === 'SPECIAL') color = 'rgba(160,255,200,0.9)';
      else if (cat === 'DUNGEON') color = 'rgba(120,200,255,0.85)';
      else if (cat === 'TARPIT') color = 'rgba(120,180,140,0.9)';
      else if (cat === 'RUNESTONE') color = 'rgba(210,180,255,0.9)';

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();

      projected.push({
        prefab: loc.prefab,
        x: loc.x,
        y: loc.y,
        z: loc.z,
        px,
        py,
        cat,
      });
    }

    ctx.restore();
    state.locationsProjected = projected;
  }

  
