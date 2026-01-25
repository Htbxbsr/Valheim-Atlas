'use strict';

self.onmessage = (ev) => {
  const msg = ev?.data;
  if (!msg || !msg.type) return;
  if (msg.type === 'flowAgg') {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    try {
      const res = buildFlowAggregation(msg);
      const t1 = typeof performance !== 'undefined' ? performance.now() : 0;
      self.postMessage({
        type: 'flowAggResult',
        id: msg.id,
        key: msg.key,
        windowLabel: msg.windowLabel,
        segments: res.segments,
        clusters: res.clusters,
        ms: t1 - t0,
      });
    } catch (err) {
      self.postMessage({
        type: 'flowAggError',
        id: msg.id,
        key: msg.key,
        error: err && err.message ? err.message : String(err),
      });
    }
    return;
  }
  if (msg.type === 'playersLayer') {
    try {
      const res = buildPlayersLayer(msg);
      self.postMessage(
        {
          type: 'playersLayerResult',
          id: msg.id,
          key: msg.key,
          bitmap: res.bitmap,
        },
        res.bitmap ? [res.bitmap] : []
      );
    } catch (err) {
      self.postMessage({
        type: 'playersLayerError',
        id: msg.id,
        key: msg.key,
        error: err && err.message ? err.message : String(err),
      });
    }
    return;
  }
  if (msg.type === 'parseFrame') {
    try {
      const parsed = parseFrameJson(msg.text || '');
      self.postMessage({
        type: 'parseFrameResult',
        id: msg.id,
        key: msg.key,
        frame: parsed,
      });
    } catch (err) {
      self.postMessage({
        type: 'parseFrameError',
        id: msg.id,
        key: msg.key,
        error: err && err.message ? err.message : String(err),
      });
    }
    return;
  }
  if (msg.type === 'unionBuckets') {
    try {
      const res = buildUnionBuckets(msg);
      self.postMessage({
        type: 'unionBucketsResult',
        id: msg.id,
        key: msg.key,
        unionZones: res.unionZones,
        buckets: res.buckets,
        thresholds: res.thresholds,
      });
    } catch (err) {
      self.postMessage({
        type: 'unionBucketsError',
        id: msg.id,
        key: msg.key,
        error: err && err.message ? err.message : String(err),
      });
    }
    return;
  }
  if (msg.type === 'flowLayer') {
    try {
      const res = buildFlowLayer(msg);
      self.postMessage(
        {
          type: 'flowLayerResult',
          id: msg.id,
          key: msg.key,
          bitmap: res.bitmap,
        },
        res.bitmap ? [res.bitmap] : []
      );
    } catch (err) {
      self.postMessage({
        type: 'flowLayerError',
        id: msg.id,
        key: msg.key,
        error: err && err.message ? err.message : String(err),
      });
    }
  }
};

function buildPlayersLayer(msg) {
  const width = Math.max(1, Math.floor(Number(msg.width || 0)));
  const height = Math.max(1, Math.floor(Number(msg.height || 0)));
  const scale = Math.max(0.25, Math.min(1, Number(msg.scale || 1)));
  const players = Array.isArray(msg.players) ? msg.players : [];
  const mapCal = msg.mapCal || {};
  const labelOn = !!msg.labelOn;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return { bitmap: null };
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  drawPlayersLayer(ctx, players, mapCal, labelOn);
  const bitmap = canvas.transferToImageBitmap();
  return { bitmap };
}

function buildFlowAggregation(msg) {
  const frames = Array.isArray(msg.frames) ? msg.frames : [];
  const flowMin = Number(msg.flowMin || 1);
  const flowMax = Math.max(0, Math.floor(Number(msg.flowMax || 0)));
  const zoneSize = Number(msg.zoneSize || 64);
  const mapCal = msg.mapCal || {};

  const edgeMap = new Map();
  const edgeNames = new Map();

  // Infer players per edge by comparing player zones across consecutive frames.
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const cur = frames[i];
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
          zx = Math.floor(x / zoneSize);
          zy = Math.floor(z / zoneSize);
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
          zx = Math.floor(x / zoneSize);
          zy = Math.floor(z / zoneSize);
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
    const transitions = getFlowTransitionsFromFrame(it);
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

  for (const [ekey, ns] of edgeNames.entries()) {
    const entry = edgeMap.get(ekey);
    if (!entry) continue;
    for (const nm of ns) entry.names.add(nm);
  }

  const edges = Array.from(edgeMap.values())
    .filter((e) => e.count >= flowMin)
    .map((e) => {
      const a = zoneCenterWorld(e.fx, e.fy, zoneSize);
      const b = zoneCenterWorld(e.tx, e.ty, zoneSize);
      const A = worldToMapPx(a.x, a.z, mapCal);
      const B = worldToMapPx(b.x, b.z, mapCal);
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

  return { segments, clusters };
}

function getFlowTransitionsFromFrame(frame) {
  const flowLike = frame?.flow;
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
  const fx = tr?.fx ?? tr?.from_zx ?? tr?.fromX ?? tr?.fromZX ?? tr?.from?.zx ?? tr?.a?.zx ?? (Array.isArray(tr?.from) ? tr.from[0] : undefined);
  const fy = tr?.fy ?? tr?.from_zy ?? tr?.fromY ?? tr?.fromZY ?? tr?.from?.zy ?? tr?.a?.zy ?? (Array.isArray(tr?.from) ? tr.from[1] : undefined);
  const tx = tr?.tx ?? tr?.to_zx   ?? tr?.toX   ?? tr?.toZX   ?? tr?.to?.zx   ?? tr?.b?.zx ?? (Array.isArray(tr?.to) ? tr.to[0] : undefined);
  const ty = tr?.ty ?? tr?.to_zy   ?? tr?.toY   ?? tr?.toZY   ?? tr?.to?.zy   ?? tr?.b?.zy ?? (Array.isArray(tr?.to) ? tr.to[1] : undefined);
  const ok = [fx, fy, tx, ty].every((q) => q !== undefined && q !== null && q !== '' && Number.isFinite(Number(q)));
  if (!ok) return null;
  return { fx: Number(fx), fy: Number(fy), tx: Number(tx), ty: Number(ty) };
}

function zoneCenterWorld(zx, zy, zoneSize) {
  const x = (Number(zx) + 0.5) * zoneSize;
  const z = (Number(zy) + 0.5) * zoneSize;
  return { x, z };
}

function worldToMapPx(x, z, mapCal) {
  const px = (mapCal.mapCxPx || 0) + (x / (mapCal.worldRadius || 1)) * (mapCal.mapRadiusPx || 0) + (mapCal.offsetXPx || 0);
  const py = (mapCal.mapCyPx || 0) - (z / (mapCal.worldRadius || 1)) * (mapCal.mapRadiusPx || 0) + (mapCal.offsetYPx || 0);
  return { px, py };
}

function clusterFlowEdges(edges) {
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

function drawPlayersLayer(ctx, arr, mapCal, labelOn) {
  if (!Array.isArray(arr) || arr.length === 0 || !ctx) return;
  const byKey = new Map();
  for (const p of arr) {
    const key = (p?.name ?? p?.label ?? p?.id ?? p?.pfid ?? '').toString() || '__unknown__';
    byKey.set(key, p);
  }
  ctx.save();
  ctx.globalAlpha = 0.95;

  for (const p of byKey.values()) {
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

    const { px, py } = worldToMapPx(x, z, mapCal);

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

    if (name && labelOn) {
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

function parseFrameJson(text) {
  if (typeof text !== 'string' || !text) return null;
  const fr = JSON.parse(text);
  // normalize flow formats
  if (fr && !fr.flow && fr.player_flow) fr.flow = fr.player_flow;
  if (fr && fr.flow && !Array.isArray(fr.flow) && Array.isArray(fr.flow.transitions)) {
    fr.flow = fr.flow.transitions;
  }
  // normalize hotspots formats
  if (fr && fr.hotspots && Array.isArray(fr.hotspots)) {
    fr.hotspots = { world_zdos: fr.hotspots };
  }
  return fr;
}

function buildUnionBuckets(msg) {
  const framesZones = Array.isArray(msg.framesZones) ? msg.framesZones : [];
  const topN = Math.max(1, Math.floor(Number(msg.topN || 1)));
  const thresholdsMeta = msg.thresholdsMeta || {};
  const mapCal = msg.mapCal || {};

  const zoneMap = new Map();
  for (const zones of framesZones) {
    if (!Array.isArray(zones)) continue;
    for (const z of zones) {
      const zx = Number(z?.zx);
      const zy = Number(z?.zy);
      if (!Number.isFinite(zx) || !Number.isFinite(zy)) continue;
      const count = Number(z?.count ?? z?.v) || 0;
      const key = `${zx},${zy}`;
      const prev = zoneMap.get(key);
      if (!Number.isFinite(prev) || count > prev) zoneMap.set(key, count);
    }
  }

  const unionZones = [];
  for (const [key, count] of zoneMap.entries()) {
    const parts = key.split(',');
    const zx = Number(parts[0]);
    const zy = Number(parts[1]);
    if (!Number.isFinite(zx) || !Number.isFinite(zy)) continue;
    unionZones.push({ zx, zy, count });
  }
  unionZones.sort((a, b) => b.count - a.count);
  const limited = unionZones.slice(0, topN);

  const thresholds = getWorldZdoThresholds({ hotspots_meta: { world_zdos: thresholdsMeta } });
  const buckets = buildWorldZdoBuckets(limited, thresholds, mapCal);

  return { unionZones: limited, buckets, thresholds };
}

function getWorldZdoThresholds(fr) {
  const meta = fr?.hotspots_meta?.world_zdos || {};
  const p90 = Number(meta?.p90);
  const p99 = Number(meta?.p99);
  const metaValid = Number.isFinite(p90) && Number.isFinite(p99) && p99 > p90 && p99 >= 500;
  const minYellow = 800;
  const minRed = 2000;
  const yellowTh = metaValid ? Math.max(p90, minYellow) : minYellow;
  const redTh = metaValid ? Math.max(p99, minRed) : minRed;
  return { p90, p99, yellowTh, redTh, metaValid };
}

function buildWorldZdoBuckets(zones, thresholds, mapCal) {
  const buckets = { green: [], yellow: [], red: [] };
  if (!Array.isArray(zones)) return buckets;
  const th = thresholds || { yellowTh: 800, redTh: 2000 };
  for (const entry of zones) {
    if (entry?.zx == null || entry?.zy == null) continue;
    const count = Number(entry.count ?? entry.v) || 0;
    if (count <= 0) continue;
    const { x, z } = zoneCenterWorld(entry.zx, entry.zy, mapCal);
    const { px, py } = worldToMapPx(x, z, mapCal);
    const item = { zx: entry.zx, zy: entry.zy, count, px, py };
    if (count >= th.redTh) buckets.red.push(item);
    else if (count >= th.yellowTh) buckets.yellow.push(item);
    else buckets.green.push(item);
  }
  buckets.zones = zones;
  return buckets;
}

function zoneCenterWorld(zx, zy, mapCal) {
  const zoneSize = Number(mapCal.zoneSize || 64);
  const x = (Number(zx) + 0.5) * zoneSize;
  const z = (Number(zy) + 0.5) * zoneSize;
  return { x, z };
}

function buildFlowLayer(msg) {
  const width = Math.max(1, Math.floor(Number(msg.width || 0)));
  const height = Math.max(1, Math.floor(Number(msg.height || 0)));
  const scale = Math.max(0.25, Math.min(1, Number(msg.scale || 1)));
  const segments = Array.isArray(msg.segments) ? msg.segments : [];
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return { bitmap: null };
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  drawFlowLayer(ctx, segments);
  const bitmap = canvas.transferToImageBitmap();
  return { bitmap };
}

function drawFlowLayer(ctx, segments) {
  if (!ctx || !Array.isArray(segments) || segments.length === 0) return;
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
  const leftX = backX + px * (size * 0.6);
  const leftY = backY + py * (size * 0.6);
  const rightX = backX - px * (size * 0.6);
  const rightY = backY - py * (size * 0.6);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(leftX, leftY);
  ctx.lineTo(rightX, rightY);
  ctx.closePath();
  ctx.fill();
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}
