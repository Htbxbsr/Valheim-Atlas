'use strict';

  let drawPending = false;
  let lastCanvasW = 0;
  let lastCanvasH = 0;
  let lastCanvasDpr = 0;
  let lastMapViewKey = '';
  let overlayCtx = null;
  let mapCtx = null;
  let flowLayerCtx = null;
  let playersLayerCtx = null;
  let lastDrawnView = null;
  let flowWorker = null;
  let flowWorkerFailed = false;
  let flowWorkerReqId = 0;
  const flowWorkerPending = new Map();
  let flowWorkerNoOffscreenLogged = false;
  let flowWorkerErrorLogged = false;

  function scheduleDraw() {
    if (drawPending) return;
    const now = performance.now();
    if (state.interaction?.active) {
      const fps = Number(state.interactionFpsCap || 0);
      if (Number.isFinite(fps) && fps > 0) {
        const minMs = 1000 / fps;
        const last = Number(state.interactionLastDrawMs || 0);
        if (now - last < minMs) {
          if (!drawPending) {
            drawPending = true;
            const delay = Math.max(0, minMs - (now - last));
            setTimeout(() => {
              drawPending = false;
              scheduleDraw();
            }, delay);
          }
          return;
        }
      }
    }
    drawPending = true;
    requestAnimationFrame(() => {
      drawPending = false;
      if (state.interaction?.active) {
        state.interactionLastDrawMs = performance.now();
      }
      if (PERF_MODE && state?.perf?.enabled) {
        const now = performance.now();
        const last = state.perf.lastRafTs;
        if (Number.isFinite(last)) {
          state.perf.frameGapMs = now - last;
        }
        state.perf.lastRafTs = now;
      }
      draw();
    });
  }

  function getVisibleMapBounds(cw, ch, view, pad) {
    const zoom = Math.max(0.0001, view?.zoom || 1);
    const panX = view?.panX || 0;
    const panY = view?.panY || 0;
    const left = (-panX) / zoom - pad;
    const top = (-panY) / zoom - pad;
    const right = (cw - panX) / zoom + pad;
    const bottom = (ch - panY) / zoom + pad;
    return { left, top, right, bottom };
  }

  function getMapViewKey(cw, ch, dpr, view) {
    const z = view?.zoom ?? 1;
    const px = view?.panX ?? 0;
    const py = view?.panY ?? 0;
    const iw = state.mapImg?.width ?? 0;
    const ih = state.mapImg?.height ?? 0;
    const bm = state.mapBitmap ? 1 : 0;
    return `${cw}x${ch}@${dpr}|z=${z}|px=${px}|py=${py}|img=${iw}x${ih}|bm=${bm}`;
  }

  function snapCssTransform(tx, ty) {
    const dpr = window.devicePixelRatio || 1;
    const snap = 1 / dpr;
    return {
      tx: Math.round(tx / snap) * snap,
      ty: Math.round(ty / snap) * snap,
    };
  }

  function applyPendingInteraction() {
    const it = state.interaction;
    if (!it) return;
    const prevZoom = state.view.zoom;
    if (it.pendingPanDx || it.pendingPanDy) {
      state.view.panX += it.pendingPanDx;
      state.view.panY += it.pendingPanDy;
      it.pendingPanDx = 0;
      it.pendingPanDy = 0;
    }
    const zf = Number(it.pendingZoomFactor || 1.0);
    const center = it.pendingZoomCenter;
    if (Number.isFinite(zf) && zf !== 1 && center) {
      const mx = center.x;
      const my = center.y;
      const beforeX = (mx - state.view.panX) / state.view.zoom;
      const beforeY = (my - state.view.panY) / state.view.zoom;
      const newZoom = clamp(state.view.zoom * zf, 0.05, 30);
      state.view.zoom = newZoom;
      state.view.panX = mx - beforeX * newZoom;
      state.view.panY = my - beforeY * newZoom;
      it.pendingZoomFactor = 1.0;
      it.pendingZoomCenter = null;
    }
    if (state.view.zoom !== prevZoom) {
      const labelOn = state.view.zoom >= 0.55;
      if (state.playersLayerLabelOn == null || state.playersLayerLabelOn !== labelOn) {
        state.playersLayerDirty = true;
      }
    }
  }

  function ensureWorldZdosLayerCanvas() {
    if (!state.mapReady || !state.mapImg) return null;
    const w = state.mapImg.width;
    const h = state.mapImg.height;
    const needsNew =
      !state.worldZdosLayerCanvas ||
      state.worldZdosLayerCanvas.width !== w ||
      state.worldZdosLayerCanvas.height !== h;
    if (needsNew) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      state.worldZdosLayerCanvas = c;
      state.worldZdosLayerCtx = c.getContext('2d');
      state.worldZdosLayerDirty = true;
    }
    return state.worldZdosLayerCanvas;
  }

  function ensureFlowLayerCanvas() {
    if (!state.mapReady || !state.mapImg) return null;
    const w = state.mapImg.width;
    const h = state.mapImg.height;
    const needsNew =
      !state.flowLayerCanvas ||
      state.flowLayerCanvas.width !== w ||
      state.flowLayerCanvas.height !== h;
    if (needsNew) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      state.flowLayerCanvas = c;
      flowLayerCtx = c.getContext('2d');
      state.flowLayerDirty = true;
    }
    return state.flowLayerCanvas;
  }

  function rebuildWorldZdosLayer() {
    const canvas = ensureWorldZdosLayerCanvas();
    const ctx = state.worldZdosLayerCtx;
    if (!canvas || !ctx) return false;
    if (!state.worldZdosBuckets) return false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const r = visuals.heatRadiusPx;
    const drawAmpel = (entry, count, sev) => {
      if (count < 1) return;
      const px = Number(entry.px);
      const py = Number(entry.py);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return;
      let col = { r: 0, g: 200, b: 83, a: 0.45 };
      if (sev === 'red') col = { r: 213, g: 0, b: 0, a: 0.35 };
      else if (sev === 'yellow') col = { r: 255, g: 214, b: 0, a: 0.40 };
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(${col.r},${col.g},${col.b},${col.a})`);
      g.addColorStop(0.55, `rgba(${col.r},${col.g},${col.b},${col.a * 0.55})`);
      g.addColorStop(1, `rgba(${col.r},${col.g},${col.b},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    };
    // Severity draw order: red > yellow > green (higher severity on top).
    for (const entry of state.worldZdosBuckets.green) {
      drawAmpel(entry, Number(entry.count ?? entry.v) || 0, 'green');
    }
    for (const entry of state.worldZdosBuckets.yellow) {
      drawAmpel(entry, Number(entry.count ?? entry.v) || 0, 'yellow');
    }
    for (const entry of state.worldZdosBuckets.red) {
      drawAmpel(entry, Number(entry.count ?? entry.v) || 0, 'red');
    }
    state.worldZdosLayerDirty = false;
    state.worldZdosLayerKey = `${state.frame?.meta?.t || ''}|hr=${r}|p90=${state.worldZdosThresholds?.p90}|p99=${state.worldZdosThresholds?.p99}`;
    return true;
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

  function rebuildFlowLayer() {
    const canvas = ensureFlowLayerCanvas();
    if (!canvas) return false;
    if (!flowLayerCtx) flowLayerCtx = canvas.getContext('2d');
    if (!flowLayerCtx) return false;
    const segments = state.flowAgg?.segments || [];
    const scaleRaw = Number(cfg.playbackFlowScale || 0) || Number(cfg.playbackOverlayScale || 1);
    const scale = Math.max(0.25, Math.min(1, scaleRaw));
    const key = `${state.frame?.meta?.t || ''}|flow:${segments.length}|s=${scale}`;
    const useWorker = state.isChromium && state.mode === 'ARCHIVE' && !!state.transport?.playing;
    if (useWorker) {
      const fps = Number(cfg.playbackFlowFps || cfg.playbackOverlayFps || 0);
      if (fps > 0) {
        const now = performance.now();
        const minMs = 1000 / fps;
        if (state.flowLayerBitmap && (now - (state.flowLayerLastBuildMs || 0) < minMs)) {
          return false;
        }
      }
      if (state.flowLayerKey === key && state.flowLayerBitmap) {
        state.flowLayerDirty = false;
        return true;
      }
      if (state.flowLayerPendingKey === key) return false;
      state.flowLayerPendingKey = key;
      state.flowLayerLastBuildMs = performance.now();
      runFlowLayerWorker({
        type: 'flowLayer',
        key,
        width: Math.max(1, Math.floor(canvas.width * scale)),
        height: Math.max(1, Math.floor(canvas.height * scale)),
        scale,
        segments,
      }).then((msg) => {
        if (!msg || msg.type === 'flowLayerError') {
          state.flowLayerPendingKey = null;
          state.flowLayerDirty = true;
          if (!flowWorkerErrorLogged) {
            flowWorkerErrorLogged = true;
            console.warn('[Valheim Atlas] Flow layer worker error. Falling back.');
          }
          scheduleDraw();
          return;
        }
        if (msg.type !== 'flowLayerResult' || msg.key !== key) return;
        if (state.flowLayerPendingKey !== key) return;
        if (msg.bitmap) {
          if (state.flowLayerBitmap && typeof state.flowLayerBitmap.close === 'function') {
            state.flowLayerBitmap.close();
          }
          state.flowLayerBitmap = msg.bitmap;
          state.flowLayerKey = key;
          state.flowLayerDirty = false;
          state.flowLayerPendingKey = null;
          scheduleDraw();
        } else {
          // Keep previous bitmap to avoid flicker if worker didn't return a new one.
          state.flowLayerPendingKey = null;
          state.flowLayerDirty = false;
          scheduleDraw();
        }
      });
      return false;
    }
    if (state.flowLayerBitmap && typeof state.flowLayerBitmap.close === 'function') {
      state.flowLayerBitmap.close();
    }
    state.flowLayerBitmap = null;
    state.flowLayerPendingKey = null;
    state.flowLayerLastBuildMs = 0;
    flowLayerCtx.setTransform(1, 0, 0, 1, 0, 0);
    flowLayerCtx.clearRect(0, 0, canvas.width, canvas.height);
    drawFlowLayer(flowLayerCtx, segments);
    state.flowLayerDirty = false;
    state.flowLayerKey = key;
    return true;
  }

  function ensurePlayersLayerCanvas() {
    if (!state.mapReady || !state.mapImg) return null;
    const w = state.mapImg.width;
    const h = state.mapImg.height;
    const needsNew =
      !state.playersLayerCanvas ||
      state.playersLayerCanvas.width !== w ||
      state.playersLayerCanvas.height !== h;
    if (needsNew) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      state.playersLayerCanvas = c;
      playersLayerCtx = c.getContext('2d');
      state.playersLayerDirty = true;
    }
    return state.playersLayerCanvas;
  }

  function drawPlayersLayer(ctx, arr) {
    if (!Array.isArray(arr) || arr.length === 0 || !ctx) return;
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
        ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", monospace';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillText(name, px + 11, py + 1);
        ctx.fillStyle = 'rgba(230,250,255,0.95)';
        ctx.fillText(name, px + 10, py);
      }
    }
    ctx.restore();
  }

  function rebuildPlayersLayer() {
    const canvas = ensurePlayersLayerCanvas();
    if (!canvas) return false;
    if (!playersLayerCtx) playersLayerCtx = canvas.getContext('2d');
    if (!playersLayerCtx) return false;
    const players = Array.isArray(state.frame?.players) ? state.frame.players : [];
    const labelOn = state.view.zoom >= 0.55;
    const scaleRaw = Number(cfg.playbackPlayersScale || 0) || Number(cfg.playbackOverlayScale || 1);
    const scale = Math.max(0.25, Math.min(1, scaleRaw));
    const key = `${state.frame?.meta?.t || ''}|players:${players.length}|z=${labelOn}|s=${scale}`;
    const now = performance.now();
    const useWorker = state.isChromium && state.mode === 'ARCHIVE' && !!state.transport?.playing;
    if (useWorker) {
      const fps = Number(cfg.playbackPlayersFps || cfg.playbackOverlayFps || 0);
      if (fps > 0) {
        const minMs = 1000 / fps;
        if (state.playersLayerBitmap && (now - (state.playersLayerLastBuildMs || 0) < minMs)) {
          return false;
        }
      }
      if (state.playersLayerKey === key && state.playersLayerBitmap) {
        state.playersLayerDirty = false;
        return true;
      }
      if (state.playersLayerPendingKey && state.playersLayerPendingKey !== key) {
        state.playersLayerPendingKey = null;
        state.playersLayerPendingAt = 0;
      }
      if (state.playersLayerPendingKey === key) {
        if (state.playersLayerPendingAt && (now - state.playersLayerPendingAt > 600)) {
          state.playersLayerPendingKey = null;
          state.playersLayerPendingAt = 0;
        } else {
          return false;
        }
      }
      state.playersLayerPendingKey = key;
      state.playersLayerPendingAt = now;
      state.playersLayerLastBuildMs = performance.now();
      runPlayersLayerWorker({
        type: 'playersLayer',
        key,
        players,
        scale,
        mapCal: {
          mapCxPx: state.mapCal.mapCxPx,
          mapCyPx: state.mapCal.mapCyPx,
          mapRadiusPx: state.mapCal.mapRadiusPx,
          worldRadius: state.mapCal.worldRadius,
          offsetXPx: state.mapCal.offsetXPx,
          offsetYPx: state.mapCal.offsetYPx,
        },
        width: Math.max(1, Math.floor(canvas.width * scale)),
        height: Math.max(1, Math.floor(canvas.height * scale)),
        labelOn,
      }).then((msg) => {
        if (!msg || msg.type === 'playersLayerError') {
          state.playersLayerPendingKey = null;
          state.playersLayerPendingAt = 0;
          state.playersLayerDirty = true;
          if (!flowWorkerErrorLogged) {
            flowWorkerErrorLogged = true;
            console.warn('[Valheim Atlas] Players layer worker error. Falling back.');
          }
          scheduleDraw();
          return;
        }
        if (msg.type !== 'playersLayerResult' || msg.key !== key) return;
        if (state.playersLayerPendingKey !== key) return;
        if (msg.bitmap) {
          if (state.playersLayerBitmap && typeof state.playersLayerBitmap.close === 'function') {
            state.playersLayerBitmap.close();
          }
          state.playersLayerBitmap = msg.bitmap;
          state.playersLayerKey = key;
          state.playersLayerLabelOn = labelOn;
          state.playersLayerDirty = false;
          state.playersLayerPendingKey = null;
          state.playersLayerPendingAt = 0;
          scheduleDraw();
        } else {
          // Keep previous bitmap to avoid flicker if worker didn't return a new one.
          state.playersLayerPendingKey = null;
          state.playersLayerPendingAt = 0;
          state.playersLayerDirty = false;
          scheduleDraw();
        }
      });
      return false;
    }
    if (state.playersLayerBitmap && typeof state.playersLayerBitmap.close === 'function') {
      state.playersLayerBitmap.close();
    }
    state.playersLayerBitmap = null;
    state.playersLayerPendingKey = null;
    state.playersLayerLastBuildMs = 0;
    playersLayerCtx.setTransform(1, 0, 0, 1, 0, 0);
    playersLayerCtx.clearRect(0, 0, canvas.width, canvas.height);
    drawPlayersLayer(playersLayerCtx, players);
    state.playersLayerDirty = false;
    state.playersLayerLabelOn = labelOn;
    state.playersLayerKey = key;
    return true;
  }

// ---------- render ----------
  function draw() {
    const perfOn = PERF_MODE && state?.perf?.enabled;
    const t0 = perfOn ? performance.now() : 0;
    applyPendingInteraction();

    const deviceDpr = window.devicePixelRatio || 1;
    const freezeRaster = state.interaction?.active && state.interactionTransform;
    let dpr = deviceDpr;
    if (!freezeRaster && state.interaction?.active) {
      const cap = Number(state.interactionDprCap || 1.0);
      if (Number.isFinite(cap) && cap > 0) dpr = Math.min(dpr, cap);
    }
    if (freezeRaster && lastCanvasDpr) {
      dpr = lastCanvasDpr;
    }
    const overlayCanvas = el.canvas;
    const mapCanvas = el.mapCanvas || el.canvas;
    const cw = overlayCanvas.clientWidth;
    const ch = overlayCanvas.clientHeight;

    // Layout guard: wait until canvas has size.
    if (cw === 0 || ch === 0) {
      requestAnimationFrame(draw);
      return;
    }

    let nextW = Math.floor(cw * dpr);
    let nextH = Math.floor(ch * dpr);
    const canResize = !freezeRaster || lastCanvasW === 0 || lastCanvasH === 0;
    if (!canResize) {
      nextW = lastCanvasW;
      nextH = lastCanvasH;
    }
    if ((nextW !== lastCanvasW || nextH !== lastCanvasH || dpr !== lastCanvasDpr) && canResize) {
      overlayCanvas.width = nextW;
      overlayCanvas.height = nextH;
      if (mapCanvas) {
        mapCanvas.width = nextW;
        mapCanvas.height = nextH;
      }
      lastCanvasW = nextW;
      lastCanvasH = nextH;
      lastCanvasDpr = dpr;
    }

    if (!overlayCtx) {
      try {
        overlayCtx = overlayCanvas.getContext('2d', { alpha: true, desynchronized: true });
      } catch {
        overlayCtx = overlayCanvas.getContext('2d');
      }
    }
    const ctx = overlayCtx;
    if (!ctx) return;
    if (mapCanvas && !mapCtx) {
      try {
        mapCtx = mapCanvas.getContext('2d', { alpha: false, desynchronized: true });
      } catch {
        mapCtx = mapCanvas.getContext('2d');
      }
    }

    // Map must exist to render
    if (!state.mapReady) return;

    const tSetup = perfOn ? performance.now() : 0;
    const holdBg = 'rgba(52, 62, 72, 1)';
    const idleBg = '#05070a';

    // Draw base map on its own canvas only when view changes.
    if (mapCtx) {
      const key = getMapViewKey(cw, ch, dpr, state.view);
      let shouldDrawMap = key !== lastMapViewKey;
      let throttled = false;
      if (state.interaction?.active) {
        const fps = Number(state.interactionMapFps || 0);
        if (fps > 0) {
          const now = performance.now();
          const minMs = 1000 / fps;
          if (now - (state.interactionLastMapDrawMs || 0) < minMs) {
            shouldDrawMap = false;
            throttled = true;
          } else {
            state.interactionLastMapDrawMs = now;
          }
        }
      } else {
        state.interactionLastMapDrawMs = 0;
      }
      if (!shouldDrawMap && state.interaction?.active && state.interactionTransform && lastDrawnView) {
        const ratio = state.view.zoom / lastDrawnView.zoom;
        let tx = state.view.panX - ratio * lastDrawnView.panX;
        let ty = state.view.panY - ratio * lastDrawnView.panY;
        ({ tx, ty } = snapCssTransform(tx, ty));
        const m = `matrix(${ratio},0,0,${ratio},${tx},${ty})`;
        mapCanvas.style.transformOrigin = '0 0';
        overlayCanvas.style.transformOrigin = '0 0';
        mapCanvas.style.transform = m;
        overlayCanvas.style.transform = m;
        mapCanvas.style.backgroundColor = holdBg;
        if (perfOn) {
          const tEnd = performance.now();
          state.perf.last = {
            total: tEnd - t0,
            setup: 0,
            map: 0,
            hotspots: 0,
            flow: 0,
            players: 0,
            ui: 0,
          };
        }
        return;
      }
      if (shouldDrawMap) {
        mapCtx.setTransform(1, 0, 0, 1, 0, 0);
        mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
        mapCtx.scale(dpr, dpr);
        mapCtx.translate(state.view.panX, state.view.panY);
        mapCtx.scale(state.view.zoom, state.view.zoom);
        const src = state.mapBitmap || state.mapImg;
        if (src) mapCtx.drawImage(src, 0, 0);
        lastMapViewKey = key;
        mapCanvas.style.transform = '';
        state.interactionHoldView = null;
        overlayCanvas.style.transform = '';
        lastDrawnView = {
          panX: state.view.panX,
          panY: state.view.panY,
          zoom: state.view.zoom,
        };
        mapCanvas.style.backgroundColor = idleBg;
      } else if (throttled && state.interaction?.active) {
        // Keep overlays in lockstep with the map by transforming both canvases from last drawn view.
        if (lastDrawnView) {
          const ratio = state.view.zoom / lastDrawnView.zoom;
          let tx = state.view.panX - ratio * lastDrawnView.panX;
          let ty = state.view.panY - ratio * lastDrawnView.panY;
          ({ tx, ty } = snapCssTransform(tx, ty));
          const m = `matrix(${ratio},0,0,${ratio},${tx},${ty})`;
          mapCanvas.style.transformOrigin = '0 0';
          overlayCanvas.style.transformOrigin = '0 0';
          mapCanvas.style.transform = m;
          overlayCanvas.style.transform = m;
        }
        mapCanvas.style.backgroundColor = holdBg;
        if (perfOn) {
          const tEnd = performance.now();
          state.perf.last = {
            total: tEnd - t0,
            setup: 0,
            map: 0,
            hotspots: 0,
            flow: 0,
            players: 0,
            ui: 0,
          };
        }
        return;
      }
    }

    // Clear overlays after throttling decision
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    // DPR scale once
    ctx.scale(dpr, dpr);

    // Apply viewport transform in CSS pixels (overlays)
    ctx.translate(state.view.panX, state.view.panY);
    ctx.scale(state.view.zoom, state.view.zoom);

    const tMap = perfOn ? performance.now() : 0;

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
      if (state.worldZdosLayerDirty) {
        rebuildWorldZdosLayer();
      }
      const layer = state.worldZdosLayerCanvas;
      if (layer) {
        ctx.save();
        ctx.drawImage(layer, 0, 0);
        ctx.restore();
      }
    }

    const tHot = perfOn ? performance.now() : 0;

    // Locations overlay
    drawLocations(ctx);
    if (state.locationsEnabled) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
      ctx.fillText('LOC ON', 10, 16);
      ctx.restore();
    }

    if (showFlow) {
      if (state.flowLayerDirty) {
        rebuildFlowLayer();
      }
      const useWorker = state.isChromium && state.mode === 'ARCHIVE' && !!state.transport?.playing;
      const bitmap = useWorker ? state.flowLayerBitmap : null;
      if (bitmap) {
        const mapW = state.mapImg?.width || bitmap.width;
        const mapH = state.mapImg?.height || bitmap.height;
        ctx.save();
        ctx.drawImage(bitmap, 0, 0, mapW, mapH);
        ctx.restore();
      } else {
        const layer = state.flowLayerCanvas;
        if (layer) {
          ctx.save();
          ctx.drawImage(layer, 0, 0);
          ctx.restore();
        } else {
          drawFlowLayer(ctx, state.flowAgg?.segments || []);
        }
      }
      updateFlowTooltip(state.flowAgg?.segments || []);
    } else {
      if (el.flowTooltip) el.flowTooltip.style.display = 'none';
    }
    const tFlow = perfOn ? performance.now() : 0;
    if (showPlayers) {
      if (state.playersLayerDirty) {
        rebuildPlayersLayer();
      }
      const useWorker = state.isChromium && state.mode === 'ARCHIVE' && !!state.transport?.playing;
      const bitmap = useWorker ? state.playersLayerBitmap : null;
      if (bitmap) {
        const mapW = state.mapImg?.width || bitmap.width;
        const mapH = state.mapImg?.height || bitmap.height;
        ctx.save();
        ctx.drawImage(bitmap, 0, 0, mapW, mapH);
        ctx.restore();
      } else {
        const layer = state.playersLayerCanvas;
        if (layer) {
          ctx.save();
          ctx.drawImage(layer, 0, 0);
          ctx.restore();
        } else {
          drawPlayersLayer(ctx, fr?.players ?? []);
        }
      }
    }
    const tPlayers = perfOn ? performance.now() : 0;

    // overlay counter top right (show per-frame counts)
    const c = fr?.meta?.counts || {};

    // players: match the player list filtering (exclude spawn ghost)
    let playersN = 0;
    if (Array.isArray(fr?.players)) {
      const byKey = new Map();
      for (const p of fr.players) {
        if (!p || typeof p !== 'object') continue;
        const name = (p?.name ?? '').toString().trim();
        const id = (p?.id ?? '').toString().trim();
        const uid = p?.uid ?? p?.player_id ?? p?.playerId ?? null;
        const uidStr = uid != null ? String(uid).trim() : '';
        const label = name || id || 'uid:unknown';
        const ghost =
          uid === 0 || uidStr === '0' ||
          ((!name && !id) && (uid === 0 || uidStr === '0')) ||
          label === 'uid:0';
        if (ghost) continue;
        const key = label || '__unknown__';
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

    if (perfOn) {
      const tEnd = performance.now();
      const setup = tSetup - t0;
      const map = tMap - tSetup;
      const hotspots = tHot - tMap;
      const flow = tFlow - tHot;
      const players = tPlayers - tFlow;
      const ui = tEnd - tPlayers;
      if (performance?.memory?.usedJSHeapSize) {
        const heapMb = performance.memory.usedJSHeapSize / (1024 * 1024);
        const lastMb = state.perf.lastHeapMb;
        state.perf.lastHeapMb = heapMb;
        if (Number.isFinite(lastMb)) {
          state.perf.heapDeltaMb = heapMb - lastMb;
        }
      }
      state.perf.last = {
        total: tEnd - t0,
        setup,
        map,
        hotspots,
        flow,
        players,
        ui,
      };
    }
  }

  function heatColorFromCount(cnt) {
    if (!Number.isFinite(cnt)) return { r: 0, g: 220, b: 90 };
    if (cnt < 500) return { r: 0, g: 220, b: 90 };    // green
    if (cnt <= 1500) return { r: 255, g: 235, b: 70 }; // yellow
    if (cnt <= 3000) return { r: 255, g: 150, b: 40 }; // orange
    return { r: 255, g: 40, b: 40 };                   // red
  }

  // drawPlayers moved to drawPlayersLayer + cached canvas


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

  function ensureFlowWorker() {
    if (flowWorker || flowWorkerFailed) return flowWorker;
    if (!state?.isChromium || typeof Worker === 'undefined') return null;
    if (typeof OffscreenCanvas === 'undefined' || typeof OffscreenCanvas.prototype?.transferToImageBitmap !== 'function') {
      flowWorkerFailed = true;
      if (!flowWorkerNoOffscreenLogged) {
        flowWorkerNoOffscreenLogged = true;
        console.info('[Valheim Atlas] Worker offload disabled: OffscreenCanvas not supported.');
      }
      return null;
    }
    try {
      flowWorker = new Worker('./viewer.decode.worker.js');
      flowWorker.onmessage = (ev) => {
        const msg = ev?.data;
        const id = msg?.id;
        if (!id) return;
        const resolve = flowWorkerPending.get(id);
        if (!resolve) return;
        flowWorkerPending.delete(id);
        resolve(msg);
      };
      flowWorker.onerror = () => {
        flowWorkerFailed = true;
        if (!flowWorkerErrorLogged) {
          flowWorkerErrorLogged = true;
          console.warn('[Valheim Atlas] Worker offload disabled: worker error.');
        }
        try { flowWorker.terminate(); } catch {}
        flowWorker = null;
        for (const resolve of flowWorkerPending.values()) resolve(null);
        flowWorkerPending.clear();
      };
    } catch {
      flowWorkerFailed = true;
      flowWorker = null;
    }
    return flowWorker;
  }

  function runFlowAggWorker(payload) {
    return new Promise((resolve) => {
      const worker = ensureFlowWorker();
      if (!worker) return resolve(null);
      const id = ++flowWorkerReqId;
      payload.id = id;
      flowWorkerPending.set(id, resolve);
      worker.postMessage(payload);
    });
  }

  function runPlayersLayerWorker(payload) {
    return new Promise((resolve) => {
      const worker = ensureFlowWorker();
      if (!worker) return resolve(null);
      const id = ++flowWorkerReqId;
      payload.id = id;
      flowWorkerPending.set(id, resolve);
      worker.postMessage(payload);
    });
  }

  function runFlowLayerWorker(payload) {
    return new Promise((resolve) => {
      const worker = ensureFlowWorker();
      if (!worker) return resolve(null);
      const id = ++flowWorkerReqId;
      payload.id = id;
      flowWorkerPending.set(id, resolve);
      worker.postMessage(payload);
    });
  }

  function runParseFrameWorker(payload) {
    return new Promise((resolve) => {
      const worker = ensureFlowWorker();
      if (!worker) return resolve(null);
      const id = ++flowWorkerReqId;
      payload.id = id;
      flowWorkerPending.set(id, resolve);
      worker.postMessage(payload);
    });
  }

  function runUnionBucketsWorker(payload) {
    return new Promise((resolve) => {
      const worker = ensureFlowWorker();
      if (!worker) return resolve(null);
      const id = ++flowWorkerReqId;
      payload.id = id;
      flowWorkerPending.set(id, resolve);
      worker.postMessage(payload);
    });
  }

  async function parseFrameTextInWorker(text, key) {
    const msg = await runParseFrameWorker({ type: 'parseFrame', key, text });
    if (msg && msg.type === 'parseFrameResult' && msg.key === key && msg.frame) {
      return msg.frame;
    }
    return null;
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
    const perfOn = PERF_MODE && state?.perf?.enabled;
    const t0 = perfOn ? performance.now() : 0;
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

      const useWorker = state.isChromium && state.mode === 'ARCHIVE' && !!state.transport?.playing;
      if (useWorker) {
        const payloadFrames = frames.map((it) => ({
          idx: it.idx,
          players: Array.isArray(it.fr?.players) ? it.fr.players : [],
          flow: it.fr?.flow ?? null,
        }));
        const workerRes = await runFlowAggWorker({
          type: 'flowAgg',
          key,
          windowLabel,
          frames: payloadFrames,
          flowMin: Number(cfg.flowMinC || 1),
          flowMax: Math.max(0, Math.floor(Number(cfg.flowMaxEdges || 180))),
          zoneSize: Number(cfg.zoneSize || 64),
          mapCal: {
            mapCxPx: state.mapCal.mapCxPx,
            mapCyPx: state.mapCal.mapCyPx,
            mapRadiusPx: state.mapCal.mapRadiusPx,
            worldRadius: state.mapCal.worldRadius,
            offsetXPx: state.mapCal.offsetXPx,
            offsetYPx: state.mapCal.offsetYPx,
          },
        });
        if (workerRes && workerRes.type === 'flowAggResult' && workerRes.key === key) {
          state.flowAgg = {
            segments: Array.isArray(workerRes.segments) ? workerRes.segments : [],
            clusters: Array.isArray(workerRes.clusters) ? workerRes.clusters : [],
            windowLabel,
          };
          state.flowAggDirty = false;
          state.flowLayerDirty = true;
          return;
        }
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
      state.flowLayerDirty = true;
    } finally {
      state.flowAggBuilding = false;
      if (perfOn) {
        const t1 = performance.now();
        state.perf.lastFlowAgg = { ms: t1 - t0 };
      }
      if (state.flowAggDirty) scheduleFlowRebuild();
    }
  }

  function scheduleFlowRebuild() {
    state.flowAggDirty = true;
    if (state.flowAggBuilding) return;
    if (state.flowRebuildTimer) return;
    state.flowRebuildTimer = setTimeout(() => {
      state.flowRebuildTimer = null;
      buildFlowAggregation().then(() => scheduleDraw());
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

  function updateFlowTooltip(segments) {
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

  
