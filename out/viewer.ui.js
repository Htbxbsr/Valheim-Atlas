'use strict';

// ---------- UI wiring ----------
  function setMode(nextMode, source) {
    const prev = state.mode;
    if (state.modeLock && nextMode !== state.modeLock) {
      return;
    }
    if (prev === nextMode && state.modeLast?.source === source) {
      return;
    }
    state.mode = nextMode;
    state.modeLast = {
      atMs: Date.now(),
      from: prev,
      to: nextMode,
      source: source || 'unknown',
    };
    setPill(el.modePill, nextMode, true);
    updateModeButtons();
    updateTransportUI();
  }

  function updateModeButtons() {
    const isLive = state.mode === 'LIVE';
    el.btnLive?.classList.toggle('active', isLive);
    el.btnArchive?.classList.toggle('active', !isLive);
  }

  function isArchiveMode() {
    return state.modeLock === 'ARCHIVE' || state.mode === 'ARCHIVE';
  }

  function updateTransportUI() {
    const enabled = isArchiveMode();
    const t = state.transport;
    const btns = [el.btnRew, el.btnPlayPause, el.btnFwd, el.btnSpeed1, el.btnSpeed3, el.btnSpeed5];
    for (const b of btns) {
      if (b) b.disabled = !enabled;
    }
    if (el.btnPlayPause) el.btnPlayPause.textContent = t.playing ? 'Pause' : 'Play';
    el.btnRew?.classList.toggle('active', t.playing && t.direction < 0);
    el.btnFwd?.classList.toggle('active', t.playing && t.direction > 0);
    el.btnSpeed1?.classList.toggle('active', t.speed === 1);
    el.btnSpeed3?.classList.toggle('active', t.speed === 3);
    el.btnSpeed5?.classList.toggle('active', t.speed === 5);
    if (el.seekInput) el.seekInput.disabled = !enabled;
    if (el.seekGo) el.seekGo.disabled = !enabled;
  }

  function formatDeltaSec(deltaSec) {
    if (!Number.isFinite(deltaSec)) return '+00:00:00';
    const sign = deltaSec >= 0 ? '+' : '-';
    const abs = Math.abs(Math.floor(deltaSec));
    const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
    const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
    const ss = String(abs % 60).padStart(2, '0');
    return `${sign}${hh}:${mm}:${ss}`;
  }

  function setDeltaLabel(deltaSec) {
    if (!el.selectedDelta) return;
    el.selectedDelta.textContent = formatDeltaSec(deltaSec);
  }

  function updateArchiveDelta(idx) {
    if (!el.selectedDelta) return;
    if (state.mode !== 'ARCHIVE') {
      el.selectedDelta.parentElement.style.display = 'none';
      return;
    }
    el.selectedDelta.parentElement.style.display = '';
    if (!Array.isArray(state.frames) || state.frames.length === 0 || !Number.isFinite(idx)) {
      setDeltaLabel(0);
      return;
    }
    const i = Math.max(0, Math.min(state.frames.length - 1, Number(idx)));
    const cur = state.frames[i]?.sec;
    const anchor = Number.isFinite(state.deltaAnchorSec) ? state.deltaAnchorSec : cur;
    const delta = Number.isFinite(cur) && Number.isFinite(anchor) ? (cur - anchor) : 0;
    setDeltaLabel(delta);
  }

  function stopTransport() {
    state.transport.playing = false;
    if (state.transport.timerId) {
      clearTimeout(state.transport.timerId);
      state.transport.timerId = null;
    }
    updateTransportUI();
  }

  function applyArchiveIndex(idx, source, isScrubbing, stopForSlider = false) {
    if (!Array.isArray(state.frames) || state.frames.length === 0) return;
    const maxIdx = state.frames.length - 1;
    let next = Math.round(Number(idx));
    if (!Number.isFinite(next)) return;
    next = Math.max(0, Math.min(maxIdx, next));
    state.modeLock = 'ARCHIVE';
    setMode('ARCHIVE', source || 'program');
    state.userScrubbing = !!isScrubbing;
    if (stopForSlider) stopTransport();
    state.selectedFrameIdx = next;
    state.selectedEpochS = state.frames[next].sec;
    if (el.timeSlider) el.timeSlider.value = String(next);
    updateSelectedLabel(state.selectedEpochS, next);
    updateArchiveDelta(next);
    updateStatusLine();
    scheduleFlowRebuild();
    ensureArchiveBuffer(next);
    scheduleScrubLoad(next);
  }

  function setSeekError(msg) {
    if (!el.seekError) return;
    if (msg) {
      el.seekError.textContent = msg;
      el.seekError.style.display = '';
    } else {
      el.seekError.textContent = '';
      el.seekError.style.display = 'none';
    }
  }

  function getTransportFramesPerSec() {
    if (state.transport.speed === 5) return 20;
    if (state.transport.speed === 3) return 12;
    return 4;
  }

  function getTransportTickMs() {
    const fps = getTransportFramesPerSec();
    const tickMs = Math.max(16, Math.round(1000 / fps));
    state.transport.framesPerSec = fps;
    state.transport.tickMs = tickMs;
    return tickMs;
  }

  function scheduleTransportTick() {
    if (!state.transport.playing || !isArchiveMode()) return;
    if (state.transport.timerId) clearTimeout(state.transport.timerId);
    const tickMs = getTransportTickMs();
    state.transport.timerId = setTimeout(() => {
      state.transport.timerId = null;
      if (!state.transport.playing || !isArchiveMode()) return;
      if (DIAG_MODE) {
        console.info(`transport:tick idx=${state.selectedFrameIdx} dir=${state.transport.direction} speed=${state.transport.speed}`);
      }
      stepArchive(state.transport.direction);
      scheduleTransportTick();
    }, tickMs);
  }

  function stepArchive(direction) {
    if (!Array.isArray(state.frames) || state.frames.length === 0) return;
    const cur = Number.isFinite(state.selectedFrameIdx) ? state.selectedFrameIdx : 0;
    const next = Math.max(0, Math.min(state.frames.length - 1, cur + direction));
    if (next === cur) {
      stopTransport();
      return;
    }
    applyArchiveIndex(next, 'transport', false, false);
  }

  function wireUi() {
    // mode button
    el.btnLive?.addEventListener('click', () => {
      state.modeLock = 'LIVE';
      setMode('LIVE', 'user_live_button');
      state.userScrubbing = false;
      stopTransport();
      if (state.frames.length > 0) {
        const idx = state.frames.length - 1;
        state.selectedFrameIdx = idx;
        state.selectedEpochS = state.frames[idx].sec;
        el.timeSlider.value = String(idx);
        updateSelectedLabel(state.selectedEpochS, idx);
        updateStatusLine();
        state.renderedFrameIdx = idx;
      }
      state.deltaAnchorSec = null;
      console.info('mode=LIVE via button');
      scheduleFlowRebuild();
      draw();
    });
    el.btnArchive?.addEventListener('click', () => {
      state.modeLock = 'ARCHIVE';
      setMode('ARCHIVE', 'user_archive_button');
      state.userScrubbing = false;
      stopTransport();
      if (Number.isFinite(state.selectedFrameIdx)) {
        state.deltaAnchorSec = state.frames[state.selectedFrameIdx]?.sec ?? state.deltaAnchorSec;
        ensureArchiveBuffer(state.selectedFrameIdx);
        updateArchiveDelta(state.selectedFrameIdx);
      }
      draw();
    });

    // time slider
    el.timeSlider?.addEventListener('pointerdown', () => {
      state.modeLock = 'ARCHIVE';
      setMode('ARCHIVE', 'user_archive_slider');
      state.userScrubbing = true;
      stopTransport();
      console.info('mode=ARCHIVE via slider');
    });
    el.timeSlider?.addEventListener('mousedown', () => {
      state.modeLock = 'ARCHIVE';
      setMode('ARCHIVE', 'user_archive_slider');
      state.userScrubbing = true;
      stopTransport();
      console.info('mode=ARCHIVE via slider');
    });
    el.timeSlider?.addEventListener('touchstart', () => {
      state.modeLock = 'ARCHIVE';
      setMode('ARCHIVE', 'user_archive_slider');
      state.userScrubbing = true;
      stopTransport();
      console.info('mode=ARCHIVE via slider');
    }, { passive: true });
    el.timeSlider?.addEventListener('input', () => {
      if (state.frames.length === 0) return;
      const idx = Math.round(Number(el.timeSlider.value));
      if (Number.isFinite(idx) && Array.isArray(state.frames) && state.frames[idx]) {
        state.deltaAnchorSec = state.frames[idx].sec;
      }
      applyArchiveIndex(el.timeSlider.value, 'user_archive_slider', true, true);
    });

    el.timeSlider?.addEventListener('change', async () => {
      if (state.mode !== 'ARCHIVE') return;
      state.userScrubbing = false;
      scheduleScrubLoad(state.selectedFrameIdx);
    });
    el.timeSlider?.addEventListener('pointerup', () => { state.userScrubbing = false; });
    el.timeSlider?.addEventListener('mouseup', () => { state.userScrubbing = false; });
    el.timeSlider?.addEventListener('touchend', () => { state.userScrubbing = false; }, { passive: true });

    // transport controls (archive only)
    el.btnRew?.addEventListener('click', () => {
      if (!isArchiveMode()) return;
      if (DIAG_MODE) console.info('transport:rewind click');
      if (!Number.isFinite(state.deltaAnchorSec) && Number.isFinite(state.selectedFrameIdx)) {
        state.deltaAnchorSec = state.frames[state.selectedFrameIdx]?.sec ?? state.deltaAnchorSec;
      }
      state.transport.direction = -1;
      state.transport.playing = true;
      updateTransportUI();
      scheduleTransportTick();
    });
    el.btnFwd?.addEventListener('click', () => {
      if (!isArchiveMode()) return;
      if (DIAG_MODE) console.info('transport:forward click');
      if (!Number.isFinite(state.deltaAnchorSec) && Number.isFinite(state.selectedFrameIdx)) {
        state.deltaAnchorSec = state.frames[state.selectedFrameIdx]?.sec ?? state.deltaAnchorSec;
      }
      state.transport.direction = 1;
      state.transport.playing = true;
      updateTransportUI();
      scheduleTransportTick();
    });
    el.btnPlayPause?.addEventListener('click', () => {
      if (!isArchiveMode()) return;
      if (DIAG_MODE) console.info('transport:toggle click');
      if (!state.transport.playing && !state.transport.direction) state.transport.direction = 1;
      state.transport.playing = !state.transport.playing;
      updateTransportUI();
      if (state.transport.playing) scheduleTransportTick();
    });
    el.btnSpeed1?.addEventListener('click', () => {
      if (!isArchiveMode()) return;
      if (DIAG_MODE) console.info('transport:speed=1x click');
      state.transport.speed = 1;
      updateTransportUI();
      if (state.transport.playing) scheduleTransportTick();
    });
    el.btnSpeed3?.addEventListener('click', () => {
      if (!isArchiveMode()) return;
      if (DIAG_MODE) console.info('transport:speed=3x click');
      state.transport.speed = 3;
      updateTransportUI();
      if (state.transport.playing) scheduleTransportTick();
    });
    el.btnSpeed5?.addEventListener('click', () => {
      if (!isArchiveMode()) return;
      if (DIAG_MODE) console.info('transport:speed=5x click');
      state.transport.speed = 5;
      updateTransportUI();
      if (state.transport.playing) scheduleTransportTick();
    });

    const doSeek = () => {
      if (!isArchiveMode()) return;
      if (!Array.isArray(state.frames) || state.frames.length === 0) {
        setSeekError('No archive frames loaded yet');
        return;
      }
      stopTransport();
      const currentSec = Number.isFinite(state.selectedFrameIdx)
        ? state.frames[state.selectedFrameIdx]?.sec
        : null;
      const input = el.seekInput?.value || '';
      const targetMs = parseTimeInputLocalOrUTC(input, { currentSec });
      if (!Number.isFinite(targetMs)) {
        setSeekError('Invalid time format');
        state.diag.seek = { input, targetMs: null, nearestIdx: null, nearestSec: null, deltaSec: null };
        return;
      }
      const nearestIdx = findNearestFrameIndexByEpochMs(targetMs, state.frames);
      if (nearestIdx == null) {
        setSeekError('No archive frames loaded yet');
        state.diag.seek = { input, targetMs, nearestIdx: null, nearestSec: null, deltaSec: null };
        return;
      }
      const nearestSec = state.frames[nearestIdx]?.sec;
      const deltaSec = Number.isFinite(nearestSec) ? (targetMs / 1000 - nearestSec) : null;
      state.diag.seek = { input, targetMs, nearestIdx, nearestSec, deltaSec };
      setSeekError('');
      if (Number.isFinite(nearestSec)) {
        state.deltaAnchorSec = nearestSec;
      }
      applyArchiveIndex(nearestIdx, 'user_seek', false, false);
    };
    el.seekGo?.addEventListener('click', doSeek);
    el.seekInput?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        doSeek();
      }
    });

    // layer toggles
    for (const n of [el.togPlayers, el.togWorldZdo]) {
      n?.addEventListener('change', draw);
    }
    el.togFlow?.addEventListener('change', () => {
      if (!el.togFlow?.checked && el.flowTooltip) el.flowTooltip.style.display = 'none';
      scheduleFlowRebuild();
      draw();
    });
    el.toggleLocations?.addEventListener('change', async () => {
      state.locationsEnabled = !!el.toggleLocations?.checked;
      if (state.locationsEnabled) {
        await ensureLocationsLoaded();
      }
      maybeUpdateDebug(true);
      draw();
    });
    el.filterLocStart?.addEventListener('change', () => {
      state.locationFilters.START = !!el.filterLocStart?.checked;
      draw();
    });
    el.filterLocBoss?.addEventListener('change', () => {
      state.locationFilters.BOSS = !!el.filterLocBoss?.checked;
      draw();
    });
    el.filterLocSpecial?.addEventListener('change', () => {
      state.locationFilters.SPECIAL = !!el.filterLocSpecial?.checked;
      draw();
    });
    el.filterLocDungeons?.addEventListener('change', () => {
      state.locationFilters.DUNGEON = !!el.filterLocDungeons?.checked;
      draw();
    });
    el.filterLocTarPit?.addEventListener('change', () => {
      state.locationFilters.TARPIT = !!el.filterLocTarPit?.checked;
      draw();
    });
    el.filterLocRunestone?.addEventListener('change', () => {
      state.locationFilters.RUNESTONE = !!el.filterLocRunestone?.checked;
      draw();
    });
    // heat sliders
    if (el.heatRadius) {
      // force reset (ignore browser restore)
      el.heatRadius.value = String(visuals.heatRadiusPx);
      el.heatRadius.addEventListener('input', () => {
        visuals.heatRadiusPx = Number(el.heatRadius.value);
        updateVisualLabels();
        draw();
      });
    }


    // zoom / pan / viewport
    el.btnZoomIn?.addEventListener('click', () => { zoomAt(el.canvas.clientWidth/2, el.canvas.clientHeight/2, 1.10); });
    el.btnZoomOut?.addEventListener('click', () => { zoomAt(el.canvas.clientWidth/2, el.canvas.clientHeight/2, 0.90); });
    el.btnResetView?.addEventListener('click', () => { state.view = { zoom: 1.0, panX: 0, panY: 0 }; fitMap(); draw(); });

    // mouse pan
    el.canvas.addEventListener('mousedown', (ev) => {
      state.dragging = true;
      state.dragLast.x = ev.clientX;
      state.dragLast.y = ev.clientY;
    });
    window.addEventListener('mouseup', () => { state.dragging = false; });
    window.addEventListener('mousemove', (ev) => {
      if (!state.dragging) return;
      const dx = ev.clientX - state.dragLast.x;
      const dy = ev.clientY - state.dragLast.y;
      state.dragLast.x = ev.clientX;
      state.dragLast.y = ev.clientY;
      state.view.panX += dx;
      state.view.panY += dy;
      draw();
    });
    el.canvas.addEventListener('mousemove', (ev) => {
      state.cursor = { x: ev.clientX, y: ev.clientY };
      state.cursorSeq++;
      if (!state.debugTimerId) {
        state.debugTimerId = setInterval(() => {
          if (!state.cursor) return;
          maybeUpdateDebug();
        }, 250);
      }
      maybeUpdateDebug();
    });
    el.canvas.addEventListener('mouseleave', () => {
      state.cursor = null;
      if (state.debugTimerId) {
        clearInterval(state.debugTimerId);
        state.debugTimerId = null;
      }
      maybeUpdateDebug(true);
    });

    // wheel zoom at cursor
    el.canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const rect = el.canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const delta = Math.sign(ev.deltaY);
      const factor = delta > 0 ? 0.90 : 1.10;
      zoomAt(mx, my, factor);
    }, { passive: false });

    window.addEventListener('resize', () => { fitMap(); draw(); });
  }

  function zoomAt(mx, my, factor) {
    const beforeX = (mx - state.view.panX) / state.view.zoom;
    const beforeY = (my - state.view.panY) / state.view.zoom;
    const newZoom = clamp(state.view.zoom * factor, 0.05, 30);
    state.view.zoom = newZoom;
    state.view.panX = mx - beforeX * newZoom;
    state.view.panY = my - beforeY * newZoom;
    draw();
  }

  function scheduleScrubLoad(idx) {
    if (!Number.isFinite(idx)) return;
    state.scrubPendingIdx = idx;
    if (state.scrubRaf) return;
    state.scrubRaf = requestAnimationFrame(() => {
      state.scrubRaf = 0;
      const target = state.scrubPendingIdx;
      state.scrubPendingIdx = null;
      if (!Number.isFinite(target)) return;
      if (state.renderedFrameIdx === target) return;
      const reqId = ++state.scrubRequestId;
      loadAndRenderScrub(target, reqId);
    });
  }

  async function loadAndRenderScrub(targetIdx, requestId = null) {
    if (state.busy) {
      state.scrubPendingIdx = targetIdx;
      return;
    }
    state.busy = true;
    try {
      const res = await loadArchivedFrameWithFallback(Number(targetIdx));
      if (!res) {
        updateStatusLine('No archived frames available');
        return;
      }

      ensureArchiveBuffer(res.idx);
      if (requestId != null && requestId !== state.scrubRequestId) return;
      setCurrentFrame(res.fr);
      el.datasource.textContent = res.url;
      el.lastUpdate.textContent = state.frame?.meta?.t || epochSToIso(res.resolvedSec);
      el.timeSlider.value = String(res.idx);
      state.selectedFrameIdx = res.idx;
      state.selectedEpochS = res.resolvedSec;
      updateSelectedLabel(res.resolvedSec, res.idx);
      updateStatusLine();
      scheduleFlowRebuild();
      draw();
      state.renderedFrameIdx = res.idx;
    } catch (e) {
      setPill(el.connPill, 'ERROR', false);
    } finally {
      state.busy = false;
      if (state.scrubPendingIdx != null) {
        scheduleScrubLoad(state.scrubPendingIdx);
      }
    }
  }

  function normalizeFrame(fr) {
    // normalize flow formats:
    // - some aggregators emit flow as {transitions:[...], presence:[...]}
    // - some emit as player_flow:{...}
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

  function setCurrentFrame(fr) {
    const norm = normalizeFrame(fr);
    state.frameRaw = norm;
    let renderFrame = norm;
    if (cfg.unionEnabled) {
      const n = Math.max(1, Math.floor(cfg.unionN));
      const unionFrames = (state.mode === 'LIVE')
        ? getLiveUnionFrames(n)
        : getArchiveUnionFrames(state.selectedFrameIdx, n);
      if (unionFrames.length > 0) {
        renderFrame = buildUnionFrame(unionFrames, norm);
      }
      let wanted = 0;
      if (state.mode === 'LIVE') {
        wanted = Math.min(n, state.liveRing.length);
      } else if (Number.isFinite(state.selectedFrameIdx)) {
        const endIdx = state.selectedFrameIdx;
        const startIdx = Math.max(0, endIdx - (n - 1));
        let available = 0;
        for (let i = startIdx; i <= endIdx; i++) {
          if (state.frameCache.has(i)) available += 1;
        }
        wanted = Math.min(n, available);
      }
      state.diag.union = {
        enabled: cfg.unionEnabled,
        n,
        loaded: unionFrames.length,
        wanted,
      };
    }
    state.frame = renderFrame;
    const idx = buildWorldZdosIndex(renderFrame);
    state.worldZdosByZone = idx.map;
    state.worldZdosZones = idx.zones;
    state.worldZdosAvailable = idx.available;
    return norm;
  }

  function addLiveFrame(fr) {
    state.liveSeq += 1;
    state.liveRing.push({ seq: state.liveSeq, fr });
    const maxN = Math.max(1, Math.floor(cfg.liveRingSize));
    while (state.liveRing.length > maxN) {
      state.liveRing.shift();
    }
  }

  function buildLiveFallbackSig(fr) {
    const zones = fr?.hotspots?.world_zdos || [];
    const players = fr?.players || [];
    const zLen = Array.isArray(zones) ? zones.length : 0;
    const pLen = Array.isArray(players) ? players.length : 0;
    let zFirst = '';
    let zLast = '';
    if (zLen > 0) {
      const a = zones[0];
      const b = zones[zLen - 1];
      zFirst = `${a?.zx ?? ''},${a?.zy ?? ''},${a?.count ?? a?.v ?? ''}`;
      zLast = `${b?.zx ?? ''},${b?.zy ?? ''},${b?.count ?? b?.v ?? ''}`;
    }
    let pFirst = '';
    let pLast = '';
    if (pLen > 0) {
      const a = players[0];
      const b = players[pLen - 1];
      pFirst = `${a?.id ?? a?.name ?? ''}@${a?.zx ?? a?.x ?? ''},${a?.zy ?? a?.z ?? ''}`;
      pLast = `${b?.id ?? b?.name ?? ''}@${b?.zx ?? b?.x ?? ''},${b?.zy ?? b?.z ?? ''}`;
    }
    return `z${zLen}|${zFirst}|${zLast}|p${pLen}|${pFirst}|${pLast}`;
  }

  function removeLegacyTimeControls() {
    const ids = ['btnStepBack', 'btnStepFwd', 'btnRefreshFrames'];
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node && node.parentElement) node.parentElement.removeChild(node);
      if (el && id in el) el[id] = null;
    }
  }

  // ---------- loop ----------
  async function main() {
    setMode('LIVE', 'init');
    setPill(el.connPill, 'INIT', true);
    updateVisualLabels();
    if (!DIAG_MODE) {
      if (el.datasource?.parentElement) el.datasource.parentElement.style.display = 'none';
      if (el.manifestPath?.parentElement) el.manifestPath.parentElement.style.display = 'none';
      if (el.infoCard) el.infoCard.style.display = 'none';
    }
    updateArchiveDelta(state.selectedFrameIdx);

    removeLegacyTimeControls();
    // Wire UI first (so fitMap/resize works)
    wireUi();
    state.debugEnabled = true;
    state.lockBiomeMode = !!el.chkLockBiome?.checked;
    if (el.btnBiomeMode) el.btnBiomeMode.disabled = state.lockBiomeMode;
    if (el.toggleLocations) el.toggleLocations.checked = state.locationsEnabled;
    if (el.filterLocStart) el.filterLocStart.checked = state.locationFilters.START;
    if (el.filterLocBoss) el.filterLocBoss.checked = state.locationFilters.BOSS;
    if (el.filterLocSpecial) el.filterLocSpecial.checked = state.locationFilters.SPECIAL;
    if (el.filterLocDungeons) el.filterLocDungeons.checked = state.locationFilters.DUNGEON;
    if (el.filterLocTarPit) el.filterLocTarPit.checked = state.locationFilters.TARPIT;
    if (el.filterLocRunestone) el.filterLocRunestone.checked = state.locationFilters.RUNESTONE;
    updateVisualLabels();

    // Load map
    try {
      await loadMap();
    } catch (e) {
      setPill(el.connPill, 'ERROR', false);
      if (el.overlayTopRight) el.overlayTopRight.textContent = 'ERROR: map.png missing/unreadable';
      return;
    }

    // Reset view + fit
    state.view = { zoom: 1.0, panX: 0, panY: 0 };
    fitMap();
    draw();

    // Load manifest (loop until available)
    await loadManifestLoop();

    // Load tile metadata for biome lookup
    state.tileMeta = await loadTileMeta();
    maybeUpdateDebug(true);

    // Start polling
    async function tick() {
      try {
        if (!state.manifest) return;

        if (state.mode === 'LIVE') {
          const fr = await loadLiveFrame();
          let pushed = false;
          let skippedDuplicate = false;
          const incomingT = (typeof fr?.meta?.t === 'string' && fr.meta.t.length > 0) ? fr.meta.t : null;
          const lastTBefore = state.lastLiveFrameT;
          let sameT = false;
          if (incomingT) {
            sameT = incomingT === lastTBefore;
            if (sameT) {
              skippedDuplicate = true;
            } else {
              state.lastLiveFrameT = incomingT;
              addLiveFrame(fr);
              pushed = true;
            }
          } else {
            addLiveFrame(fr);
            pushed = true;
          }
          const lastTAfter = state.lastLiveFrameT;
          state.diag.live = {
            ringSize: state.liveRing.length,
            ringCap: Math.max(1, Math.floor(cfg.liveRingSize)),
            lastT: state.lastLiveFrameT,
            skippedDuplicate,
            polls: (state.diag.live?.polls ?? 0) + 1,
            pushed: (state.diag.live?.pushed ?? 0) + (pushed ? 1 : 0),
            incomingT,
            lastTBefore,
            lastTAfter,
            sameT,
            pushedThisPoll: pushed,
          };
          if (pushed) {
            setCurrentFrame(fr);
            const sec = isoToEpochS(fr?.meta?.t);
            if (Number.isFinite(sec)) {
              const prev = state.lastLiveRenderedSec;
              const delta = Number.isFinite(prev) ? (sec - prev) : 0;
              state.lastLiveRenderedSec = sec;
              if (el.selectedDelta?.parentElement) {
                el.selectedDelta.parentElement.style.display = 'none';
              }
            }
          }
          setPill(el.connPill, 'OK', true);

          const latestS = isoToEpochS(state.frame?.meta?.t || state.manifest?.time?.latest);
          if (latestS != null) {
            state.latestEpochS = latestS;
            if (state.frames.length > 0) {
              const idx = state.frames.length - 1;
              state.selectedFrameIdx = idx;
              state.selectedEpochS = state.frames[idx].sec;
              el.timeSlider.value = String(idx);
              updateSelectedLabel(state.selectedEpochS, idx);
              updateStatusLine();
            }
          }

          el.lastUpdate.textContent = state.frame?.meta?.t || '';
          el.datasource.textContent = resolveAgainstManifest(getFrameLivePath());
          updateStatusLine();
          scheduleFlowRebuild();
          draw();
        }
      } catch (e) {
        // Keep UI alive
        setPill(el.connPill, 'ERROR', false);
      }
    }

    // immediate tick + interval
    await tick();
    setInterval(tick, cfg.pollMs);

    const manifestIntervalMs = 12000;
    setInterval(async () => {
      if (state.mode !== 'LIVE') return;
      try {
        await refreshManifestAndFrames(false);
      } catch (e) {
        // ignore transient refresh errors
      }
    }, manifestIntervalMs);
  }

  if (!window.initViewer) {
    window.initViewer = function () {
      if (window.__viewerInitDone) return;
      window.__viewerInitDone = true;
      // hard-reset form-ish controls (ignore browser restore)
      if (el.timeSlider) el.timeSlider.value = el.timeSlider.max || '0';
      if (el.heatRadius) el.heatRadius.value = String(visuals.heatRadiusPx);
      main();
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    window.initViewer();
  });
