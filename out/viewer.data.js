'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    canvas: $('canvas'),
    overlayTopRight: $('overlayTopRight'),
    modePill: $('modePill'),
    connPill: $('connPill'),
    lastUpdate: $('lastUpdate'),
    datasource: $('datasource'),
    manifestPath: $('manifestPath'),
    selectedTime: $('selectedTime'),
    selectedDelta: $('selectedDelta'),
    frameStatus: $('frameStatus'),
    timeSlider: $('timeSlider'),
    btnStepBack: $('btnStepBack'),
    btnStepFwd: $('btnStepFwd'),
    btnRefreshFrames: $('btnRefreshFrames'),
    btnLive: $('btnLive'),
    btnArchive: $('btnArchive'),
    btnRew: $('btnRew'),
    btnPlayPause: $('btnPlayPause'),
    btnFwd: $('btnFwd'),
    btnSpeed1: $('btnSpeed1'),
    btnSpeed3: $('btnSpeed3'),
    btnSpeed5: $('btnSpeed5'),
    seekInput: $('seekInput'),
    seekGo: $('seekGo'),
    seekError: $('seekError'),
    togPlayers: $('togPlayers'),
    togFlow: $('togFlow'),
    togWorldZdo: $('togWorldZdo'),
    togDebug: null,
    btnZoomIn: $('btnZoomIn'),
    btnZoomOut: $('btnZoomOut'),
    btnResetView: $('btnResetView'),
    btnFit: null,
    heatRadius: $('heatRadius'),
    heatRadiusLabel: $('heatRadiusLabel'),
    worldWidthInfo: $('worldWidthInfo'),
    zoneSizeInfo: $('zoneSizeInfo'),
    debugOverlay: $('debugOverlay'),
    toggleLocations: $('toggleLocations'),
    filterLocStart: $('filterLocStart'),
    filterLocBoss: $('filterLocBoss'),
    filterLocSpecial: $('filterLocSpecial'),
    filterLocDungeons: $('filterLocDungeons'),
    filterLocTarPit: $('filterLocTarPit'),
    filterLocRunestone: $('filterLocRunestone'),
    locationTooltip: null,
    flowTooltip: $('flowTooltip'),
    coordHud: $('coordHud'),
    infoCard: $('infoCard'),
  };

  const qp = new URLSearchParams(location.search);

  const WORLD_RADIUS = 10000;

  const cfg = {
    worldRadius: WORLD_RADIUS,
    worldWidth: WORLD_RADIUS * 2,
    zoneSize: 64,
    pollMs: 1000,
    flowMaxEdges: Number(qp.get('flowMax') || 180),
    flowMinC: Number(qp.get('flowMin') || 1),
    manifestUrl: (qp.get('manifest') || 'manifest.json'),
    frameLiveUrl: (qp.get('live') || 'frame_live.json'),
    framesDir: (qp.get('frames') || 'frames'),
    // Frame buffer + union window params (query overrides)
    archiveBufferSize: Number(qp.get('archiveBuffer') || 120),
    archivePrefetchMin: Number(qp.get('archivePrefetch') || 20),
    liveRingSize: Number(qp.get('liveRing') || 30),
    unionEnabled: (qp.get('union') || '1') !== '0',
    unionN: Number(qp.get('unionN') || 5),
    unionTopN: Number(qp.get('unionTopN') || 500),
  };

  const visuals = {
    heatRadiusPx: Number(qp.get('hr') || 28),
  };


  const LOCKED_TILE_MAPPING = {
    swapXY: true,
    flipTileX: true,
    flipTileY: true,
    tileRowOrder: 'top-down',
    pixelFlipX: true,
    pixelFlipY: true,
    tileIndexMode: 'row',
    biomeDecodeMode: 'BITMASK',
  };

  const LOCKED_BIOME_UV = { zSign: -1 };
  const DEBUG_ZONE_MATCH = qp.get('debugZones') === '1';
  const DIAG_MODE = qp.get('diag') === '1';

  const state = {
    mode: 'LIVE',               // LIVE | ARCHIVE
    modeLock: null,
    modeLast: null,
    manifest: null,
    frame: null,                // currently rendered frame json
    frameRaw: null,             // last base frame (non-unioned)
    selectedEpochS: null,       // archive selection
    selectedFrameIdx: null,     // archive selection (index-based)
    frames: [],                 // available frames [{sec, url}]
    view: { zoom: 1.0, panX: 0, panY: 0 },
    mapImg: null,
    mapReady: false,
    dragging: false,
    dragLast: { x: 0, y: 0 },
    busy: false,
    latestEpochS: null,
    manifestSig: null,
    lastManifestRefresh: 0,
    manifestUrlResolved: null,
    manifestBaseUrl: null,
    debugEnabled: true,
    cursor: null,
    cursorSeq: 0,
    tileMeta: null,
    locations: [],
    tileCacheLast: null,
    frameCache: new Map(),
    flowWindowN: 5,
    flowAggKey: '',
    flowAggDirty: true,
    flowAggBuilding: false,
    flowAgg: { segments: [], clusters: [], windowLabel: '' },
    flowHover: null,
    liveRing: [],
    liveSeq: 0,
    lastLiveFrameT: null,
    lastLiveSig: null,
    deltaAnchorSec: null,
    lastLiveRenderedSec: null,
    transport: { playing: false, direction: 1, speed: 1, timerId: null },
    scrubPendingIdx: null,
    scrubRaf: 0,
    scrubRequestId: 0,
    renderedFrameIdx: null,
    locationsEnabled: false,
    locationsLoaded: false,
    locationsLoading: false,
    locationsLoadError: null,
    locationsProjected: [],
    locationHover: null,
    locationsSummary: [],
    modeLogTs: 0,
    debugLastTs: 0,
    lastValidWorld: null,
    lastValidZone: null,
    debugErrTs: 0,
    debugTimerId: null,
    worldZdosByZone: new Map(),
    worldZdosZones: [],
    worldZdosAvailable: false,
    userScrubbing: false,
    archiveWindow: { start: 0, end: -1 },
    archivePrefetchRunning: false,
    archiveInflight: new Set(),
    archivePumpActive: false,
    archivePumpTimer: null,
    archivePumpIndex: null,
    diag: {},
    locationFilters: {
      START: true,
      BOSS: true,
      SPECIAL: false,
      DUNGEON: false,
      TARPIT: false,
      RUNESTONE: false,
    },
    mapCal: {
      mapCxPx: 0,
      mapCyPx: 0,
      mapRadiusPx: 0,
      worldRadius: WORLD_RADIUS,
      offsetXPx: 0,
      offsetYPx: 0,
      discRadiusScale: 0.818,
    },
  };

  // ---------- helpers ----------

  function isoToEpochS(iso) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }

  function epochSToIso(sec) {
    try { return new Date(sec * 1000).toISOString().replace('.000Z', 'Z'); }
    catch { return ''; }
  }

  function toCompactFromEpochS(sec) {
    // Compact format: YYYYMMDDTHHMMSS
    const d = new Date(sec * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    const mm = pad(d.getUTCMonth() + 1);
    const dd = pad(d.getUTCDate());
    const hh = pad(d.getUTCHours());
    const mi = pad(d.getUTCMinutes());
    const ss = pad(d.getUTCSeconds());
    return `${yyyy}${mm}${dd}T${hh}${mi}${ss}`;
  }

  function zoneCenterWorld(zx, zy) {
    // zone coordinates are centered on (zx,zy) grid in world space
    const x = (Number(zx) + 0.5) * cfg.zoneSize;
    const z = (Number(zy) + 0.5) * cfg.zoneSize;
    return { x, z };
  }

  function worldToZone(x, z) {
    return {
      zx: Math.floor(x / cfg.zoneSize),
      zy: Math.floor(z / cfg.zoneSize),
    };
  }

  function zoneKey(zx, zy) {
    return `${zx},${zy}`;
  }

  function getWorldZdosArray(fr) {
    const src = fr?.hotspots?.world_zdos;
    if (Array.isArray(src)) return src;
    if (src && Array.isArray(src.zones)) return src.zones;
    if (src && Array.isArray(src.list)) return src.list;
    return null;
  }

  function buildWorldZdosIndex(fr) {
    const map = new Map();
    const zones = [];
    const src = getWorldZdosArray(fr);
    if (Array.isArray(src)) {
      for (const z of src) {
        const zx = Number(z?.zx);
        const zy = Number(z?.zy);
        if (!Number.isFinite(zx) || !Number.isFinite(zy)) continue;
        const count = Number(z?.count ?? z?.v) || 0;
        const key = zoneKey(zx, zy);
        map.set(key, count);
        zones.push({ zx, zy, count });
      }
    }
    return { map, zones, available: Array.isArray(src) };
  }

  function getArchiveWindow(idx, total) {
    const size = Math.max(1, Math.floor(cfg.archiveBufferSize));
    const left = Math.floor((size - 1) / 2);
    const right = Math.max(0, size - 1 - left);
    let start = Math.max(0, Number(idx) - left);
    let end = Math.min(total - 1, Number(idx) + right);
    if (end - start + 1 < size) {
      const missing = size - (end - start + 1);
      const extendLeft = Math.min(missing, start);
      start -= extendLeft;
      const extendRight = Math.min(missing - extendLeft, (total - 1) - end);
      end += extendRight;
    }
    return { start, end };
  }

  async function prefetchArchiveWindow(indices) {
    if (state.archivePrefetchRunning) return;
    state.archivePrefetchRunning = true;
    try {
      for (const idx of indices) {
        if (state.frameCache.has(idx)) continue;
        if (state.archiveInflight.has(idx)) continue;
        try { await loadArchivedFrameAtIndex(idx); } catch {}
      }
    } finally {
      state.archivePrefetchRunning = false;
      if (state.mode === 'ARCHIVE' && Number.isFinite(state.archivePumpIndex)) {
        scheduleArchivePump('batch_finished');
      }
    }
  }

  function scheduleArchivePump(reason) {
    if (state.archivePumpActive) return;
    state.archivePumpActive = true;
    state.archivePumpTimer = setTimeout(() => {
      state.archivePumpActive = false;
      if (state.mode !== 'ARCHIVE') return;
      if (!Number.isFinite(state.archivePumpIndex)) return;
      if (Number(state.selectedFrameIdx) !== Number(state.archivePumpIndex)) return;
      ensureArchiveBuffer(state.archivePumpIndex);
    }, 75);
    if (state.diag?.archive) {
      state.diag.archive.pumpActive = true;
      state.diag.archive.lastPumpReason = reason;
    }
  }

  function ensureArchiveBuffer(idx) {
    if (!Array.isArray(state.frames) || state.frames.length === 0) return;
    const maxPrefetch = Math.max(0, Math.floor(cfg.archivePrefetchMin || 0));
    let prefetchedThisCall = 0;
    state.archivePumpIndex = Number(idx);
    const total = state.frames.length;
    const win = getArchiveWindow(idx, total);
    state.archiveWindow = win;
    const keep = new Set();
    for (let i = win.start; i <= win.end; i++) keep.add(i);
    for (const key of Array.from(state.frameCache.keys())) {
      if (!keep.has(key)) state.frameCache.delete(key);
    }
    const missing = [];
    for (let i = win.start; i <= win.end; i++) {
      if (!state.frameCache.has(i)) missing.push(i);
    }
    if (missing.length > 0) {
      const pref = maxPrefetch > 0 ? missing.slice(0, maxPrefetch) : missing;
      prefetchedThisCall = pref.length;
      prefetchArchiveWindow(pref);
      if (state.mode === 'ARCHIVE') {
        scheduleArchivePump('batch_started');
      }
    }
    const cachedKeysSample = Array.from(state.frameCache.keys()).slice(0, 10);
    state.diag.archive = {
      idx: Number(idx),
      windowStart: win.start,
      windowEnd: win.end,
      bufferSize: Math.max(1, Math.floor(cfg.archiveBufferSize)),
      cacheSize: state.frameCache.size,
      missingInWindow: missing.length,
      inflightCount: state.archiveInflight.size,
      prefetchedThisCall,
      prefetchCap: maxPrefetch,
      cachedKeysSample,
      pumpActive: state.archivePumpActive,
      lastPumpReason: state.diag.archive?.lastPumpReason,
    };
    if (missing.length === 0) {
      state.archivePumpIndex = null;
    }
  }

  function getArchiveUnionFrames(currentIdx, n) {
    const frames = [];
    if (!Number.isFinite(currentIdx)) return frames;
    const endIdx = currentIdx;
    const startIdx = Math.max(0, endIdx - (n - 1));
    for (let i = startIdx; i <= endIdx; i++) {
      const cached = state.frameCache.get(i);
      if (cached?.fr) frames.push(normalizeFrame(cached.fr));
    }
    return frames;
  }

  function getLiveUnionFrames(n) {
    const arr = state.liveRing;
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const start = Math.max(0, arr.length - n);
    return arr.slice(start).map((it) => normalizeFrame(it.fr));
  }

  function buildUnionFrame(frames, baseFrame) {
    if (!Array.isArray(frames) || frames.length === 0) return baseFrame;
    const map = new Map();
    for (const fr of frames) {
      const zones = getWorldZdosArray(fr) || [];
      for (const z of zones) {
        const zx = Number(z?.zx);
        const zy = Number(z?.zy);
        if (!Number.isFinite(zx) || !Number.isFinite(zy)) continue;
        const count = Number(z?.count ?? z?.v) || 0;
        const key = zoneKey(zx, zy);
        const prev = map.get(key);
        if (!Number.isFinite(prev) || count > prev) map.set(key, count);
      }
    }
    const unionList = [];
    for (const [key, count] of map.entries()) {
      const [zx, zy] = key.split(',').map((v) => Number(v));
      if (!Number.isFinite(zx) || !Number.isFinite(zy)) continue;
      unionList.push({ zx, zy, count });
    }
    unionList.sort((a, b) => b.count - a.count);
    const topN = Math.max(1, Math.floor(cfg.unionTopN));
    const limited = unionList.slice(0, topN);
    const out = { ...baseFrame };
    const hs = { ...(baseFrame?.hotspots || {}) };
    hs.world_zdos = limited;
    out.hotspots = hs;
    return out;
  }

  function worldToMapPx(x, z) {
    // World to pixel projection (visual only), per contract.
    const c = state.mapCal;
    const px = c.mapCxPx + (x / c.worldRadius) * c.mapRadiusPx + c.offsetXPx;
    const py = c.mapCyPx - (z / c.worldRadius) * c.mapRadiusPx + c.offsetYPx; // invert Z because pixel Y grows downward
    return { px, py };
  }

  async function fetchJson(url, cacheBust = false) {
    const u = cacheBust ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}` : url;
    const res = await fetch(u, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  }

  function setPill(node, text, ok = true) {
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('ok', ok);
    node.classList.toggle('err', !ok);
  }

  function updateVisualLabels() {
    if (el.heatRadiusLabel) el.heatRadiusLabel.textContent = String(visuals.heatRadiusPx);
    if (el.worldWidthInfo) el.worldWidthInfo.textContent = String(cfg.worldWidth);
    if (el.zoneSizeInfo) el.zoneSizeInfo.textContent = String(cfg.zoneSize);
  }

  class LruCache {
    constructor(limit) {
      this.limit = limit;
      this.map = new Map();
    }
    get(key) {
      if (!this.map.has(key)) return null;
      const val = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, val);
      return val;
    }
    has(key) {
      return this.map.has(key);
    }
    set(key, val) {
      if (this.map.has(key)) this.map.delete(key);
      this.map.set(key, val);
      if (this.map.size > this.limit) {
        const oldest = this.map.keys().next().value;
        this.map.delete(oldest);
      }
    }
    clear() {
      this.map.clear();
    }
  }

  const tileCache = new LruCache(16);
  const inflightTileLoads = new Map();
  const tileWorkerPending = new Map();
  const tileJobQueue = [];
  let tileJobsRunning = 0;
  const MAX_TILE_JOBS = 2;
  let lastTileKey = null;
  let lastTileMs = 0;
  let tileWorker = null;
  const worldZdoBuckets = { green: [], yellow: [], red: [] };
  const biomeFlags = [
    { id: 0x0001, name: 'Meadows' },
    { id: 0x0002, name: 'Swamp' },
    { id: 0x0004, name: 'Mountain' },
    { id: 0x0008, name: 'BlackForest' },
    { id: 0x0010, name: 'Plains' },
    { id: 0x0020, name: 'Ashlands' },
    { id: 0x0040, name: 'DeepNorth' },
    { id: 0x0100, name: 'Ocean' },
    { id: 0x0200, name: 'Mistlands' },
  ];

  function decodeBiomeMask(raw16) {
    if (!Number.isFinite(raw16)) {
      return { name: 'N/A', idHex: 'N/A', colorKey: 'Unknown' };
    }
    const idHex = `0x${raw16.toString(16).padStart(4, '0')}`;
    if (raw16 === 0) {
      return { name: 'None', idHex, colorKey: 'Unknown' };
    }
    const known = biomeFlags.filter((b) => (raw16 & b.id) !== 0);
    const knownMask = known.reduce((m, b) => m | b.id, 0);
    const unknownBits = raw16 & ~knownMask;
    if (known.length === 1 && unknownBits === 0) {
      return { name: known[0].name, idHex, colorKey: known[0].name };
    }
    const priority = ['Mistlands', 'Ocean', 'DeepNorth', 'Ashlands', 'Plains', 'BlackForest', 'Mountain', 'Swamp', 'Meadows'];
    let colorKey = 'Unknown';
    for (const name of priority) {
      if (known.some((b) => b.name === name)) {
        colorKey = name;
        break;
      }
    }
    return { name: `Mixed(${idHex})`, idHex, colorKey };
  }

  function biomeCategoriesFromId(id) {
    if (!Number.isFinite(id)) return [];
    const names = [];
    for (const b of biomeFlags) {
      if ((id & b.id) !== 0) names.push(b.name);
    }
    return names;
  }

  function resolveAssetUrl(path) {
    const base = state.manifestBaseUrl || location.href;
    return new URL(path, base).toString();
  }

  function tileKeyFor(tx, ty) {
    return `${ty}-${tx}`;
  }

  function tileFileFor(tx, ty) {
    return `tiles/${String(ty).padStart(2, '0')}-${String(tx).padStart(2, '0')}.bin.gz`;
  }

  async function loadTileMeta() {
    try {
      const metaUrl = resolveAssetUrl('map/data/map.json');
      const meta = await fetchJson(metaUrl, true);
      const m = meta?.meta || meta;
      const worldWidth = Number(m?.WorldWidth);
      const tileRowCount = Number(m?.TileRowCount);
      const tileSideCount = Number(m?.TileSideCount);
      if (!Number.isFinite(worldWidth) || !Number.isFinite(tileRowCount) || !Number.isFinite(tileSideCount)) {
        return null;
      }
      return {
        worldWidth,
        worldHalf: worldWidth / 2,
        tileRowCount,
        tileSideCount,
        worldSamples: tileRowCount * tileSideCount,
      };
    } catch (e) {
      return null;
    }
  }

  function parseLocationPosition(pos) {
    if (typeof pos !== 'string') return null;
    const m = pos.match(/\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
    if (!m) return null;
    const x = Number(m[1]);
    const y = Number(m[2]);
    const z = Number(m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    return { x, y, z };
  }

  async function loadLocations(locUrl) {
    const data = await fetchJson(locUrl, true);
    if (!Array.isArray(data)) return [];
    const out = [];
    for (const row of data) {
      const prefab = row?.PrefabName || row?.prefab || row?.name;
      const pos = row?.Position || row?.position;
      if (typeof prefab !== 'string' || typeof pos !== 'string') continue;
      const p = parseLocationPosition(pos);
      if (!p) continue;
      out.push({ prefab, x: p.x, y: p.y, z: p.z });
    }
    return out;
  }

  const LOCATION_WHITELIST = {
    START: new Set(['StartTemple']),
    BOSS: new Set(['Eikthyrnir', 'GDKing', 'Bonemass', 'GoblinKing', 'Dragonqueen', 'FaderLocation', 'Mistlands_DvergrBossEntrance1']),
    SPECIAL: new Set(['Vendor_BlackForest', 'BogWitch_Camp', 'Mistlands_DvergrTownEntrance1', 'Mistlands_DvergrTownEntrance2']),
    DUNGEON: new Set([
      'Crypt2',
      'Crypt3',
      'Crypt4',
      'SunkenCrypt4',
      'MountainCave02',
      'TrollCave02',
      'MorgenHole1',
      'MorgenHole2',
      'MorgenHole3',
    ]),
    TARPIT: new Set(['TarPit1', 'TarPit2', 'TarPit3']),
    RUNESTONE: new Set(['Runestone_Mistlands']),
  };

  function classifyLocation(prefab) {
    if (!prefab) return 'HIDDEN';
    if (LOCATION_WHITELIST.START.has(prefab)) return 'START';
    if (LOCATION_WHITELIST.BOSS.has(prefab)) return 'BOSS';
    if (LOCATION_WHITELIST.SPECIAL.has(prefab)) return 'SPECIAL';
    if (LOCATION_WHITELIST.DUNGEON.has(prefab)) return 'DUNGEON';
    if (LOCATION_WHITELIST.TARPIT.has(prefab)) return 'TARPIT';
    if (LOCATION_WHITELIST.RUNESTONE.has(prefab) || prefab.startsWith('Runestone_')) return 'RUNESTONE';
    return 'HIDDEN';
  }

  const LOCATION_FRIENDLY = {
    Eikthyrnir: 'Eikthyr',
    GDKing: 'The Elder',
    Bonemass: 'Bonemass',
    Dragonqueen: 'Moder',
    GoblinKing: 'Yagluth',
    FaderLocation: 'Fader',
    Vendor_BlackForest: 'Haldor (Merchant)',
    Hildir_camp: 'Hildir (Camp)',
    Hildir_cave: 'Hildir (Cave)',
    Hildir_crypt: 'Hildir (Crypt)',
    Hildir_plainsfortress: 'Hildir (Plains Fortress)',
    BogWitch_Camp: 'Bog Witch (Camp)',
    Crypt2: 'Burial Chamber',
    Crypt3: 'Burial Chamber',
    Crypt4: 'Burial Chamber',
    SunkenCrypt4: 'Sunken Crypt',
    TrollCave02: 'Troll Cave',
    MountainCave02: 'Frost Cave',
    MorgenHole1: 'Infested Mine',
    MorgenHole2: 'Infested Mine',
    MorgenHole3: 'Infested Mine',
    TarPit1: 'Tar Pit',
    TarPit2: 'Tar Pit',
    TarPit3: 'Tar Pit',
    Mistlands_DvergrBossEntrance1: 'The Queen (Entrance)',
    CharredFortress: 'Charred Fortress',
    FortressRuins: 'Fortress Ruins',
    CharredStone_Spawner: 'Charred Spawner',
    CharredRuins1: 'Charred Ruins',
    CharredRuins2: 'Charred Ruins',
    CharredRuins3: 'Charred Ruins',
    CharredRuins4: 'Charred Ruins',
    CharredTowerRuins1: 'Charred Tower Ruins',
    CharredTowerRuins2: 'Charred Tower Ruins',
    CharredTowerRuins3: 'Charred Tower Ruins',
    Runestone_Ashlands: 'Runestone (Ashlands)',
    Runestone_Mistlands: 'Runestone (Mistlands)',
    Runestone_Mountains: 'Runestone (Mountains)',
    Runestone_Plains: 'Runestone (Plains)',
    Runestone_Swamps: 'Runestone (Swamps)',
    Runestone_BlackForest: 'Runestone (Black Forest)',
    Runestone_Meadows: 'Runestone (Meadows)',
    Runestone_Boars: 'Runestone (Boars)',
    Runestone_Draugr: 'Runestone (Draugr)',
    Runestone_Greydwarfs: 'Runestone (Greydwarfs)',
  };

  function prettifyPrefab(prefab) {
    if (!prefab) return 'Unknown';
    let s = String(prefab);
    s = s.replace(/_/g, ' ');
    s = s.replace(/\bnew\b/gi, '');
    s = s.replace(/\bruined\b/gi, '(Ruined)');
    s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
    s = s.replace(/([A-Za-z])(\d{1,3})\b/g, '$1 $2');
    s = s.replace(/\s+/g, ' ').trim();
    const keep = new Set(['Mistlands', 'Ashlands', 'Black', 'Forest']);
    const words = s.split(' ').map((w) => {
      if (keep.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
    return words.join(' ').replace('Black Forest', 'Black Forest');
  }

  function getLocationLabel(prefabName) {
    return LOCATION_FRIENDLY[prefabName] ?? prettifyPrefab(prefabName);
  }

  function buildLocationsSummary(locs) {
    const counts = new Map();
    let visibleCount = 0;
    let hiddenCount = 0;
    for (const l of locs) {
      const key = l.prefab || 'Unknown';
      counts.set(key, (counts.get(key) || 0) + 1);
      const cat = classifyLocation(l.prefab);
      if (cat === 'HIDDEN') hiddenCount += 1;
      else visibleCount += 1;
    }
    const rows = Array.from(counts.entries())
      .map(([prefab, count]) => ({ prefab, count, category: classifyLocation(prefab) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);
    return { rows, visibleCount, hiddenCount };
  }

  async function ensureLocationsLoaded() {
    if (!state.locationsEnabled) return;
    if (state.locationsLoaded || state.locationsLoading || state.locationsLoadError) return;
    state.locationsLoading = true;
    try {
      const locUrl = resolveAssetUrl('map/data/locations.json');
      console.info(`Fetching locations from: ${locUrl}`);
      const locs = await loadLocations(locUrl);
      state.locations = locs;
      state.locationsLoaded = true;
      state.locationsLoadError = null;
      state.locationsSummary = buildLocationsSummary(state.locations);
    } catch (e) {
      state.locationsLoadError = 'not found';
    } finally {
      state.locationsLoading = false;
    }
  }

  async function decodeGzip(buf) {
    if (!('DecompressionStream' in window)) return null;
    try {
      const ds = new DecompressionStream('gzip');
      const stream = new Response(buf).body.pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    } catch (e) {
      return null;
    }
  }

  function runTileJob(fn) {
    return new Promise((resolve, reject) => {
      tileJobQueue.push({ fn, resolve, reject });
      pumpTileJobs();
    });
  }

  function pumpTileJobs() {
    while (tileJobsRunning < MAX_TILE_JOBS && tileJobQueue.length > 0) {
      const job = tileJobQueue.shift();
      tileJobsRunning += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          tileJobsRunning -= 1;
          pumpTileJobs();
        });
    }
  }

  function ensureTileWorker() {
    if (tileWorker) return;
    tileWorker = new Worker('viewer.tile.worker.js');
    tileWorker.onmessage = (ev) => {
      const msg = ev.data || {};
      const key = msg.key;
      if (!key || !tileWorkerPending.has(key)) return;
      const pending = tileWorkerPending.get(key);
      tileWorkerPending.delete(key);
      if (msg.error) {
        pending.reject(new Error(msg.error));
        return;
      }
      pending.resolve(msg);
    };
    tileWorker.onerror = (err) => {
      for (const [key, pending] of tileWorkerPending.entries()) {
        pending.reject(err);
        tileWorkerPending.delete(key);
      }
      // Reset worker so the next request can reinitialize cleanly after a crash.
      tileWorker = null;
    };
  }

  function decodeTileInWorker(key, gzBuf) {
    ensureTileWorker();
    return new Promise((resolve, reject) => {
      tileWorkerPending.set(key, { resolve, reject });
      try {
        tileWorker.postMessage({ key, gzBytes: gzBuf }, [gzBuf]);
      } catch (e) {
        tileWorkerPending.delete(key);
        reject(e);
      }
    });
  }

  function getTileCacheStats() {
    return {
      size: tileCache.map.size,
      cap: tileCache.limit,
      inflightCount: inflightTileLoads.size,
      queuedCount: tileJobQueue.length,
      workerPending: tileWorkerPending.size,
      lastTileKey,
      lastTileMs,
    };
  }

  async function loadTileBuffer(tx, ty) {
    const key = tileKeyFor(tx, ty);
    const cached = tileCache.get(key);
    if (cached) {
      state.tileCacheLast = 'hit';
      lastTileKey = key;
      lastTileMs = 0;
      return cached;
    }
    if (inflightTileLoads.has(key)) {
      return await inflightTileLoads.get(key);
    }

    const path = `map/data/${tileFileFor(tx, ty)}`;
    const p = runTileJob(async () => {
      const t0 = performance.now();
      try {
        const res = await fetch(resolveAssetUrl(path), { cache: 'no-store' });
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        const msg = await decodeTileInWorker(key, buf);
        if (!msg || !msg.biomeBuf || !msg.heightBuf || !msg.forestBuf) return null;
        const tile = {
          biome: new Uint16Array(msg.biomeBuf),
          height: new Float32Array(msg.heightBuf),
          forest: new Float32Array(msg.forestBuf),
          count: msg.count || 0,
        };
        tileCache.set(key, tile);
        state.tileCacheLast = 'miss';
        lastTileKey = key;
        lastTileMs = Math.round(msg.decodeMs ?? (performance.now() - t0));
        return tile;
      } catch (e) {
        return null;
      }
    });
    inflightTileLoads.set(key, p);
    try {
      return await p;
    } finally {
      inflightTileLoads.delete(key);
    }
  }

  function worldToUV(x, z, meta) {
    let u = (x + meta.worldHalf) / meta.worldWidth;
    u = 1.0 - u; // mirror east/west in biome sampling only
    const v = ((LOCKED_BIOME_UV.zSign * z) + meta.worldHalf) / meta.worldWidth;
    return { u, v };
  }

  function uvToGlobalSample(u, v, meta) {
    let gx = Math.floor(u * meta.worldSamples);
    let gy = Math.floor(v * meta.worldSamples);
    gx = clamp(gx, 0, meta.worldSamples - 1);
    gy = clamp(gy, 0, meta.worldSamples - 1);
    return { gx, gy };
  }

  function globalSampleToTileXY(gx, gy, meta) {
    const tx = Math.floor(gx / meta.tileRowCount);
    const ty = Math.floor(gy / meta.tileRowCount);
    const ix = gx % meta.tileRowCount;
    const iy = gy % meta.tileRowCount;
    return { tx, ty, ix, iy };
  }

  function tileXYTransform(tx, ty, ix, iy, meta) {
    if (LOCKED_TILE_MAPPING.tileRowOrder === 'bottom-up') {
      ty = (meta.tileSideCount - 1) - ty;
    }
    if (LOCKED_TILE_MAPPING.swapXY) {
      const ttx = tx; tx = ty; ty = ttx;
      const tix = ix; ix = iy; iy = tix;
    }
    if (LOCKED_TILE_MAPPING.flipTileX) {
      tx = (meta.tileSideCount - 1) - tx;
    }
    if (LOCKED_TILE_MAPPING.flipTileY) {
      ty = (meta.tileSideCount - 1) - ty;
    }
    if (LOCKED_TILE_MAPPING.pixelFlipX) {
      ix = (meta.tileRowCount - 1) - ix;
    }
    if (LOCKED_TILE_MAPPING.pixelFlipY) {
      iy = (meta.tileRowCount - 1) - iy;
    }
    return { tx, ty, ix, iy };
  }

  function tileIndexToTileXY(index, meta) {
    if (!Number.isFinite(index)) return { ix: 0, iy: 0 };
    if (LOCKED_TILE_MAPPING.tileIndexMode === 'col') {
      const ix = Math.floor(index / meta.tileRowCount);
      const iy = index % meta.tileRowCount;
      return { ix, iy };
    }
    const iy = Math.floor(index / meta.tileRowCount);
    const ix = index % meta.tileRowCount;
    return { ix, iy };
  }

  function tileXYToTileIndex(ix, iy, meta) {
    if (LOCKED_TILE_MAPPING.tileIndexMode === 'col') {
      return (ix * meta.tileRowCount + iy);
    }
    return (iy * meta.tileRowCount + ix);
  }

  function tileUV(ix, iy, meta) {
    const u = meta.tileRowCount > 1 ? ix / (meta.tileRowCount - 1) : 0;
    const v = meta.tileRowCount > 1 ? iy / (meta.tileRowCount - 1) : 0;
    return { u, v };
  }

  async function sampleBiomeAtWorld(x, z) {
    if (!state.tileMeta) return null;
    const uv = worldToUV(x, z, state.tileMeta);
    const gs = uvToGlobalSample(uv.u, uv.v, state.tileMeta);
    const base = globalSampleToTileXY(gs.gx, gs.gy, state.tileMeta);
    const addr = tileXYTransform(base.tx, base.ty, base.ix, base.iy, state.tileMeta);
    const key = tileKeyFor(addr.tx, addr.ty);
    if (!tileCache.has(key)) {
      loadTileBuffer(addr.tx, addr.ty);
      return { ...addr, tileFile: tileFileFor(addr.tx, addr.ty), tileKey: key, status: 'loading' };
    }
    const buf = tileCache.get(key);
    const tileFile = tileFileFor(addr.tx, addr.ty);
    const tileKey = tileKeyFor(addr.tx, addr.ty);
    if (!buf) {
      return { ...addr, tileFile, tileKey, biomeId: null, biomeName: 'N/A', height: null, forestFactor: null };
    }
    const ix = addr.ix;
    const iy = addr.iy;
    const index = tileXYToTileIndex(ix, iy, state.tileMeta);
    const offset = index * 10;
    if (offset + 10 > buf.length) {
      return { ...addr, tileFile, tileKey, biomeId: null, biomeName: 'N/A', height: null, forestFactor: null };
    }
    if (!buf.biome || !buf.height || !buf.forest) {
      return { ...addr, tileFile, tileKey, biomeId: null, biomeName: 'N/A', height: null, forestFactor: null };
    }
    const raw16 = buf.biome[index];
    const height = buf.height[index];
    const forestFactor = buf.forest[index];
    const uvIn = tileUV(ix, iy, state.tileMeta);
    const decoded = decodeBiomeMask(raw16);
    return {
      ...addr,
      gx: gs.gx,
      gy: gs.gy,
      u: uvIn.u,
      v: uvIn.v,
      ix,
      iy,
      raw16,
      tileFile,
      tileKey,
      biomeId: raw16,
      biomeName: decoded.name,
      biomeColorKey: decoded.colorKey,
      biomeIdHex: decoded.idHex,
      height,
      forestFactor,
    };
  }

  function screenToWorld(mx, my) {
    if (!state.mapReady || !el.canvas) return null;
    const rect = el.canvas.getBoundingClientRect();
    const cx = mx - rect.left;
    const cy = my - rect.top;
    const mapX = (cx - state.view.panX) / state.view.zoom;
    const mapY = (cy - state.view.panY) / state.view.zoom;
    const px = mapX;
    const py = mapY;
    const c = state.mapCal;
    const x = ((px - c.mapCxPx - c.offsetXPx) / c.mapRadiusPx) * c.worldRadius;
    const z = -((py - c.mapCyPx - c.offsetYPx) / c.mapRadiusPx) * c.worldRadius;
    return { x, z, px, py };
  }

  function screenToMapPx(mx, my) {
    if (!state.mapReady || !el.canvas) return null;
    const rect = el.canvas.getBoundingClientRect();
    const cx = mx - rect.left;
    const cy = my - rect.top;
    const mapX = (cx - state.view.panX) / state.view.zoom;
    const mapY = (cy - state.view.panY) / state.view.zoom;
    return { px: mapX, py: mapY };
  }

  function hotspotCountAtZone(zx, zy) {
    if (!state.worldZdosAvailable) return { available: false, count: null };
    const key = zoneKey(zx, zy);
    if (state.worldZdosByZone.has(key)) {
      return { available: true, count: state.worldZdosByZone.get(key) };
    }
    return { available: true, count: null };
  }

  async function updateDebugOverlay() {
    try {
      if (!el.debugOverlay) return;

    if (!state.cursor || !state.mapReady) {
      el.debugOverlay.textContent = state.mapReady ? 'Cursor: off' : 'Cursor: loading';
      return;
    }

    const cursorToken = state.cursorSeq;
    const world = screenToWorld(state.cursor.x, state.cursor.y);
    const valid = world && Number.isFinite(world.x) && Number.isFinite(world.z);
    if (valid) {
      state.lastValidWorld = world;
      state.lastValidZone = worldToZone(world.x, world.z);
    }

    const useWorld = valid ? world : state.lastValidWorld;
    const useZone = valid ? state.lastValidZone : state.lastValidZone;
    if (!useWorld || !useZone) {
      el.debugOverlay.textContent = state.mapReady ? 'Cursor: off' : 'Cursor: loading';
      return;
    }

    const zx = useZone.zx;
    const zy = useZone.zy;
    const hotspot = hotspotCountAtZone(zx, zy);
    const wzTh = getWorldZdoThresholds(state.frame);
    let hotspotStr = 'N/A';
    if (hotspot.available) {
      hotspotStr = hotspot.count != null ? String(hotspot.count) : 'not in TopN';
    }

    let locLine = 'Location: off';
    if (state.locationsEnabled && state.locationsLoading) {
      locLine = 'Location: loading...';
    } else if (state.locationsEnabled && state.locationsLoadError) {
      locLine = 'Location: not found';
    } else if (state.locationsEnabled && state.locationsLoaded) {
      if (Array.isArray(state.locations) && state.locations.length > 0) {
        let best = null;
        let bestD2 = Infinity;
        for (const loc of state.locations) {
          const dx = loc.x - useWorld.x;
          const dz = loc.z - useWorld.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = loc;
          }
        }
        if (best) {
          // Debug overlay shows friendly names for locations.
          const dist = Math.sqrt(bestD2);
          locLine = `Location: ${getLocationLabel(best.prefab)} (${dist.toFixed(1)}m)`;
        } else {
          locLine = 'Location: none';
        }
      } else {
        locLine = 'Location: none';
      }
    }

    const tile = valid ? await sampleBiomeAtWorld(useWorld.x, useWorld.z) : null;
    if (cursorToken !== state.cursorSeq) return;

    const tileLoading = tile?.status === 'loading';
    const biomeName = tileLoading ? 'loading' : (tile?.biomeName ?? 'N/A');
    const raw16Hex = tile?.raw16 != null ? `0x${tile.raw16.toString(16).padStart(4, '0')}` : 'N/A';
    let lines =
      `${tileLoading ? 'Cursor: loading\n' : ''}` +
      `Biome: ${biomeName} (${raw16Hex})\n` +
      `Hotspot: ${hotspotStr}\n` +
      `${locLine}\n` +
      `world_zdos count=${hotspotStr} p90=${wzTh.p90 ?? 'N/A'} p99=${wzTh.p99 ?? 'N/A'} ` +
      `yellow_th=${wzTh.yellowTh} red_th=${wzTh.redTh} meta_valid=${wzTh.metaValid}`;

    if (DIAG_MODE) {
      const frameTs = state.frame?.meta?.t ?? '-';
      const frameEpoch = state.frame?.hotspots_meta?.world_zdos?.epoch;
      const zonesTotal = state.worldZdosZones.length;
      let renderedCount = 0;
      for (const z of state.worldZdosZones) {
        if ((Number(z?.count) || 0) >= 1) renderedCount += 1;
      }
      lines += `\nframe.ts=${frameTs} frame.epoch=${Number.isFinite(frameEpoch) ? frameEpoch : 'N/A'} meta_valid=${wzTh.metaValid}`;
      lines += `\nzones_total_in_frame=${zonesTotal} rendered_zones_count=${renderedCount}`;
      const d = state.diag || {};
      lines += `\nMode: ${state.mode}`;
      lines += `\nModeLock: ${state.modeLock ?? 'none'}`;
      if (state.mode === 'ARCHIVE' && d.archive) {
        lines += `\nArchive idx: ${d.archive.idx}`;
        lines += `\nWindow: [${d.archive.windowStart}..${d.archive.windowEnd}] (buf=${d.archive.bufferSize})`;
        lines += `\nCache: ${d.archive.cacheSize}/${d.archive.bufferSize} (missing=${d.archive.missingInWindow})`;
        lines += `\nInflight: ${d.archive.inflightCount}`;
        lines += `\nPrefetch: requested=${d.archive.missingInWindow} cap=${d.archive.prefetchCap} used=${d.archive.prefetchedThisCall}`;
        lines += `\nPump: ${d.archive.pumpActive ? 'ON' : 'OFF'}${d.archive.lastPumpReason ? ` (${d.archive.lastPumpReason})` : ''}`;
        if (Array.isArray(d.archive.cachedKeysSample) && d.archive.cachedKeysSample.length > 0) {
          lines += `\nCached keys: [${d.archive.cachedKeysSample.join(',')}]`;
        }
      }
      if (state.modeLast) {
        const ageMs = Date.now() - state.modeLast.atMs;
        lines += `\nModeLast: from=${state.modeLast.from} to=${state.modeLast.to} source=${state.modeLast.source} age=${Math.max(0, ageMs)}ms`;
      }
      if (state.mode === 'LIVE' && d.live) {
        lines += `\nLive ring: ${d.live.ringSize}/${d.live.ringCap}`;
        lines += `\nLive lastT: ${d.live.lastT ?? 'N/A'} polls=${d.live.polls ?? 0} pushed=${d.live.pushed ?? 0} dup=${d.live.skippedDuplicate ? 'y' : 'n'}`;
        lines += `\nLive incomingT: ${d.live.incomingT ?? 'N/A'} lastTBefore=${d.live.lastTBefore ?? 'N/A'} lastTAfter=${d.live.lastTAfter ?? 'N/A'}`;
        lines += `\nLive sameT=${d.live.sameT ? 'y' : 'n'} pushedThisPoll=${d.live.pushedThisPoll ? 'y' : 'n'}`;
      }
      if (d.union) {
        lines += `\nUnion: ${d.union.enabled ? 'ON' : 'OFF'} N=${d.union.n} loaded=${d.union.loaded}/${d.union.wanted}`;
      }
      const t = state.transport;
      lines += `\nTransport: playing=${t.playing ? 'y' : 'n'} dir=${t.direction} speed=${t.speed} fps=${t.framesPerSec ?? 'N/A'} tickMs=${t.tickMs ?? 'N/A'} idx=${state.selectedFrameIdx ?? 'N/A'}`;
      if (state.diag.seek) {
        const s = state.diag.seek;
        lines += `\nSeek: input="${s.input ?? ''}" targetMs=${s.targetMs ?? 'N/A'} idx=${s.nearestIdx ?? 'N/A'} sec=${s.nearestSec ?? 'N/A'} delta=${s.deltaSec ?? 'N/A'}`;
      }
      if (Number.isFinite(state.deltaAnchorSec)) {
        lines += `\nAnchor: ${epochSToIso(state.deltaAnchorSec)}`;
      }
    }

      if (qp.get('dev') === '1') {
        const anchorC = await sampleBiomeAtWorld(0, 0);
        const anchorN = await sampleBiomeAtWorld(0, 9000);
        const anchorS = await sampleBiomeAtWorld(0, -9000);
        const symL = await sampleBiomeAtWorld(-5000, 0);
        const symR = await sampleBiomeAtWorld(5000, 0);
        if (cursorToken !== state.cursorSeq) return;
        const fmt = (r) => {
          const name = r?.biomeName ?? 'N/A';
          const hex = r?.raw16 != null ? `0x${r.raw16.toString(16).padStart(4, '0')}` : 'N/A';
          return `${name} ${hex}`;
        };
        lines += `\nAnchors: (0,0)=${fmt(anchorC)} | (0,+9000)=${fmt(anchorN)} | (0,-9000)=${fmt(anchorS)}`;
        lines += `\nSymmetry: (-5000,0)=${fmt(symL)} | (+5000,0)=${fmt(symR)}`;
      }

      el.debugOverlay.textContent = lines;
    } catch (e) {
      const now = Date.now();
      if (now - state.debugErrTs > 5000) {
        state.debugErrTs = now;
        console.warn('Debug overlay update failed:', e);
      }
    }
  }

  function updateCoordHud() {
    if (!el.coordHud) return;
    if (!state.mapReady) {
      el.coordHud.textContent = 'Cursor: loading';
      return;
    }
    if (!state.cursor) {
      el.coordHud.textContent = 'Cursor: off';
      return;
    }
    const world = screenToWorld(state.cursor.x, state.cursor.y);
    const valid = world && Number.isFinite(world.x) && Number.isFinite(world.z);
    const useWorld = valid ? world : state.lastValidWorld;
    if (!useWorld) {
      el.coordHud.textContent = 'Cursor: off';
      return;
    }
      const zc = worldToZone(useWorld.x, useWorld.z);
      const zx = zc.zx;
      const zy = zc.zy;
    const status = valid ? '' : ' (outside globe)';
    el.coordHud.textContent =
      `World: x=${useWorld.x.toFixed(1)} z=${useWorld.z.toFixed(1)}${status}  ` +
      `Zone: zx=${zx} zy=${zy}`;
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

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

  function maybeUpdateDebug(force = false) {
    const now = performance.now();
    if (!force && now - state.debugLastTs < 50) return; // ~20Hz max
    state.debugLastTs = now;
    updateDebugOverlay();
    updateCoordHud();
  }

  let statusTimer = null;
  let statusNote = '';
  function updateStatusLine(note = '', timeoutMs = 3000) {
    if (note) {
      statusNote = note;
      if (statusTimer) clearTimeout(statusTimer);
      if (timeoutMs > 0) {
        statusTimer = setTimeout(() => {
          statusNote = '';
          updateStatusLine();
        }, timeoutMs);
      }
    }
    if (!el.frameStatus) return;
    const manifestUrl = state.manifestUrlResolved || resolveManifestUrl();
    const total = state.frames.length;
    const idx = state.selectedFrameIdx;
    const frame = (idx != null && total > 0) ? state.frames[idx] : null;
    const idxLabel = (idx != null && total > 0) ? `${idx + 1}/${total}` : '-';
    const tsLabel = frame?.sec != null ? epochSToIso(frame.sec) : '-';
    const urlLabel = frame?.url || '-';
    const base = `Manifest: ${manifestUrl} | Frame: ${idxLabel} | Time: ${tsLabel} | URL: ${urlLabel}`;
    if (DIAG_MODE) {
      el.frameStatus.textContent = statusNote ? `${base} | Note: ${statusNote}` : base;
      el.frameStatus.style.display = '';
    } else {
      el.frameStatus.textContent = statusNote || '';
      el.frameStatus.style.display = 'none';
    }
  }

  function getCadenceMs() {
    const s = Number(state.manifest?.time?.cadence_s || 30);
    const ms = Number.isFinite(s) ? s * 1000 : 30000;
    return Math.max(100, ms);
  }

  function parseTimeInputLocalOrUTC(input, context) {
    const raw = (input || '').trim();
    if (!raw) return null;
    const timeOnly = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
    const mTime = raw.match(timeOnly);
    if (mTime) {
      const hh = Number(mTime[1]);
      const mm = Number(mTime[2]);
      const ss = Number(mTime[3] || 0);
      if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null;
      const baseSec = context?.currentSec;
      if (!Number.isFinite(baseSec)) return null;
      const d = new Date(baseSec * 1000);
      const local = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, ss, 0);
      return local.getTime();
    }
    if (raw.endsWith('Z')) {
      const norm = raw.includes('T') ? raw : raw.replace(' ', 'T');
      const t = Date.parse(norm);
      return Number.isFinite(t) ? t : null;
    }
    const re = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
    const m = raw.match(re);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const da = Number(m[3]);
    const hh = Number(m[4]);
    const mm = Number(m[5]);
    const ss = Number(m[6] || 0);
    if (![y, mo, da, hh, mm, ss].every(Number.isFinite)) return null;
    const local = new Date(y, mo - 1, da, hh, mm, ss, 0);
    return local.getTime();
  }

  function findNearestFrameIndexByEpochMs(targetMs, frames) {
    if (!Array.isArray(frames) || frames.length === 0 || !Number.isFinite(targetMs)) return null;
    const targetSec = targetMs / 1000;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const sec = frames[mid].sec;
      if (sec === targetSec) return mid;
      if (sec < targetSec) lo = mid + 1;
      else hi = mid - 1;
    }
    const left = Math.max(0, Math.min(frames.length - 1, hi));
    const right = Math.max(0, Math.min(frames.length - 1, lo));
    if (left === right) return left;
    const dl = Math.abs(frames[left].sec - targetSec);
    const dr = Math.abs(frames[right].sec - targetSec);
    return dl <= dr ? left : right;
  }

  function updateSelectedLabel(sec, idx) {
    if (!el.selectedTime) return;
    const total = state.frames.length;
    if (!Number.isFinite(sec) || total <= 0 || idx == null) {
      el.selectedTime.textContent = '-';
      return;
    }
    const pos = Math.min(total, Math.max(1, idx + 1));
    el.selectedTime.textContent = `${epochSToIso(sec)} (${pos}/${total})`;
  }

  function setScrubControlsEnabled(enabled) {
    if (el.timeSlider) el.timeSlider.disabled = !enabled;
    if (el.btnStepBack) el.btnStepBack.disabled = !enabled;
    if (el.btnStepFwd) el.btnStepFwd.disabled = !enabled;
  }

  function resolveManifestUrl() {
    return new URL(cfg.manifestUrl, location.href).toString();
  }

  function resolveAgainstManifest(path) {
    const base = state.manifestBaseUrl || new URL('.', resolveManifestUrl()).toString();
    return new URL(path, base).toString();
  }

  function joinPath(dir, file) {
    if (!dir || dir === '.' || dir === './') return file;
    return dir.endsWith('/') ? `${dir}${file}` : `${dir}/${file}`;
  }

  function getFrameTemplate() {
    let template = state.manifest?.paths?.web?.frame_template;
    if (!template) template = joinPath(cfg.framesDir, 'frame_{compact}.json');
    if (!template.includes('{compact}')) template = joinPath(template, 'frame_{compact}.json');
    return template;
  }

  function getFrameLivePath() {
    return state.manifest?.paths?.web?.frame_live || cfg.frameLiveUrl;
  }

  function parseCompactToEpochS(compact) {
    if (!compact || typeof compact !== 'string') return null;
    const m = compact.match(/(\d{8}T\d{6})/);
    if (!m) return null;
    const core = m[1];
    const yyyy = Number(core.slice(0, 4));
    const mm = Number(core.slice(4, 6));
    const dd = Number(core.slice(6, 8));
    const hh = Number(core.slice(9, 11));
    const mi = Number(core.slice(11, 13));
    const ss = Number(core.slice(13, 15));
    if (![yyyy, mm, dd, hh, mi, ss].every(Number.isFinite)) return null;
    const d = Date.UTC(yyyy, mm - 1, dd, hh, mi, ss);
    return Number.isFinite(d) ? Math.floor(d / 1000) : null;
  }

  function parseFrameEntry(entry) {
    let path = null;
    let sec = null;
    if (typeof entry === 'string') {
      path = entry;
    } else if (entry && typeof entry === 'object') {
      path = entry.url || entry.path || entry.file || entry.href || null;
      const t = entry.t || entry.time || entry.ts || entry.epoch || entry.sec || null;
      if (typeof t === 'string') sec = isoToEpochS(t);
      else if (typeof t === 'number') sec = t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
    }
    if (!sec && path) sec = parseCompactToEpochS(path);
    if (!path || sec == null) return null;
    return { sec, url: resolveAgainstManifest(path) };
  }

  function buildFramesFromManifest(m) {
    const explicit = m?.frames || m?.time?.frames || null;
    if (!Array.isArray(explicit)) return { frames: [], explicit: false };
    const out = [];
    for (const entry of explicit) {
      const parsed = parseFrameEntry(entry);
      if (parsed) out.push(parsed);
    }
    return { frames: out, explicit: true };
  }

  // ---------- map ----------
  function loadMap() {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        state.mapImg = img;
        state.mapReady = true;
        resolve();
      };
      img.onerror = (e) => reject(e);
      img.src = 'map.png';
    });
  }

  function fitMap() {
    if (!state.mapReady) return;
    const cw = el.canvas.clientWidth;
    const ch = el.canvas.clientHeight;
    if (cw <= 0 || ch <= 0) return;

    const imgW = state.mapImg.width;
    const imgH = state.mapImg.height;

    const minSide = Math.min(imgW, imgH);
    state.mapCal.mapCxPx = imgW / 2;
    state.mapCal.mapCyPx = imgH / 2;
    state.mapCal.mapRadiusPx = minSide * 0.5 * state.mapCal.discRadiusScale;

    const scale = Math.min(cw / imgW, ch / imgH);
    state.view.zoom = clamp(scale, 0.05, 30);
    state.view.panX = (cw - imgW * state.view.zoom) / 2;
    state.view.panY = (ch - imgH * state.view.zoom) / 2;
  }

  // ---------- frame loading ----------
  function getManifestSignature(m) {
    const earliest = m?.time?.earliest ?? '';
    const latest = m?.time?.latest ?? '';
    const cadence = m?.time?.cadence_s ?? '';
    return `${earliest}|${latest}|${cadence}`;
  }

  function findNearestIndexBySec(sec) {
    if (!Number.isFinite(sec) || state.frames.length === 0) return null;
    let bestIdx = 0;
    let bestDist = Math.abs(state.frames[0].sec - sec);
    for (let i = 1; i < state.frames.length; i++) {
      const d = Math.abs(state.frames[i].sec - sec);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function findNearestOlderIndexBySec(sec) {
    if (!Number.isFinite(sec) || state.frames.length === 0) return null;
    for (let i = state.frames.length - 1; i >= 0; i--) {
      if (state.frames[i].sec <= sec) return i;
    }
    return null;
  }

  function applyFramesList(frames, explicit, preserveSec = null) {
    const sorted = frames
      .filter((f) => f && Number.isFinite(f.sec) && typeof f.url === 'string')
      .sort((a, b) => a.sec - b.sec);
    state.frames = sorted;
    state.frameCache.clear();
    state.archiveWindow = { start: 0, end: -1 };
    state.flowAggDirty = true;
    const total = sorted.length;

    if (el.timeSlider) {
      el.timeSlider.min = '0';
      el.timeSlider.max = total > 0 ? String(total - 1) : '0';
      el.timeSlider.step = '1';
    }
    setScrubControlsEnabled(total > 0);

      if (total === 0) {
        state.selectedFrameIdx = null;
        updateSelectedLabel(null, null);
        if (!explicit) {
          updateStatusLine('No historical frames available; Live only');
        } else {
        updateStatusLine('No historical frames available');
      }
      scheduleFlowRebuild();
      return;
    }

    state.latestEpochS = sorted[total - 1].sec;
    if (state.mode === 'ARCHIVE') {
      const targetSec = Number.isFinite(preserveSec) ? preserveSec : state.selectedEpochS;
      let finalIdx = findNearestOlderIndexBySec(targetSec);
      if (finalIdx == null) finalIdx = 0;
      state.selectedFrameIdx = finalIdx;
      state.selectedEpochS = sorted[finalIdx].sec;
      if (el.timeSlider) el.timeSlider.value = String(finalIdx);
      updateSelectedLabel(sorted[finalIdx].sec, finalIdx);
      updateStatusLine();
      ensureArchiveBuffer(finalIdx);
      scheduleScrubLoad(finalIdx);
      scheduleFlowRebuild();
      const now = Date.now();
      if (now - state.modeLogTs > 5000) {
        state.modeLogTs = now;
        console.info(`ARCHIVE pinned: selected=${finalIdx} latest=${total - 1} frames=${total}`);
      }
      return;
    }

    const finalIdx = total - 1;
    state.selectedFrameIdx = finalIdx;
    state.selectedEpochS = sorted[finalIdx].sec;
    if (el.timeSlider) el.timeSlider.value = String(finalIdx);
    updateSelectedLabel(sorted[finalIdx].sec, finalIdx);
    updateStatusLine();
    scheduleFlowRebuild();
    const now = Date.now();
    if (now - state.modeLogTs > 5000) {
      state.modeLogTs = now;
      console.info(`LIVE follow: latest=${finalIdx} frames=${total}`);
    }
  }

  async function refreshManifestAndFrames(force = false) {
    const m = await fetchJson(state.manifestUrlResolved || cfg.manifestUrl, true);
    const sig = getManifestSignature(m);
    const changed = sig !== state.manifestSig;
    state.manifestSig = sig;
    state.manifest = m;
    if (el.manifestPath) el.manifestPath.textContent = state.manifestUrlResolved || cfg.manifestUrl;
    if (force || changed) {
      const { frames, explicit } = buildFramesFromManifest(m);
      applyFramesList(frames, explicit, state.selectedEpochS);
    }
  }

  async function loadManifestLoop() {
    setPill(el.connPill, 'INIT', true);
    while (!state.manifest) {
      try {
        state.manifestUrlResolved = resolveManifestUrl();
        state.manifestBaseUrl = new URL('.', state.manifestUrlResolved).toString();
        await refreshManifestAndFrames(true);
        setPill(el.connPill, 'OK', true);
        updateVisualLabels();
        return;
      } catch (e) {
        setPill(el.connPill, 'ERROR', false);
        if (el.overlayTopRight) el.overlayTopRight.textContent = 'ERROR: manifest missing';
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  async function loadLiveFrame() {
    const liveUrl = resolveAgainstManifest(getFrameLivePath());
    const fr = await fetchJson(liveUrl, true);
    return fr;
  }

  async function loadArchivedFrameAtIndex(idx) {
    if (!Number.isFinite(idx)) return null;
    if (state.frameCache.has(idx)) {
      return state.frameCache.get(idx);
    }
    if (state.archiveInflight.has(idx)) {
      return null;
    }
    const entry = state.frames[idx];
    if (!entry || !Number.isFinite(entry.sec) || !entry.url) return null;
    const sec = entry.sec;
    const url = entry.url;
    state.archiveInflight.add(idx);
    try {
      const fr = await fetchJson(url, true);
      const res = { fr, resolvedSec: sec, url, idx, loadedAtMs: Date.now() };
      const win = state.archiveWindow;
      if (win && Number.isFinite(win.start) && Number.isFinite(win.end)) {
        if (idx < win.start || idx > win.end) {
          return res;
        }
      }
      state.frameCache.set(idx, res);
      return res;
    } finally {
      state.archiveInflight.delete(idx);
    }
  }

  async function loadArchivedFrameWithFallback(targetIdx) {
    if (!Array.isArray(state.frames) || state.frames.length === 0) return null;

    // try target index first
    try {
      return await loadArchivedFrameAtIndex(targetIdx);
    } catch (e) {
      // continue to fallback
    }

    // fallback: previous index once
    if (targetIdx > 0) {
      try {
        const res = await loadArchivedFrameAtIndex(targetIdx - 1);
        if (res) {
          updateStatusLine(`Frame missing, snapped to ${epochSToIso(res.resolvedSec)}`);
          return res;
        }
      } catch (e) {
        // ignore
      }
    }

    // fallback: next index once
    if (targetIdx < state.frames.length - 1) {
      try {
        const res = await loadArchivedFrameAtIndex(targetIdx + 1);
        if (res) {
          updateStatusLine(`Frame missing, snapped to ${epochSToIso(res.resolvedSec)}`);
          return res;
        }
      } catch (e) {
        // ignore
      }
    }

    return null;
  }

  
