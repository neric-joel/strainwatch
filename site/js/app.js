/* global maplibregl, d3 */
import { decodeLine, haversine, lineLength, linesFromGeoJSON, distToLine, mercToLonLat } from './geo.js';
import { loadRaster, loadCube, percentileOf } from './raster.js';
import { scoreLine, rankSegments, summarize, linfit, mannKendallHR, planStops, CLASS_LABEL, FIRST_PCT, WATCH_PCT } from './score.js';
import * as charts from './charts.js';
import { RasterGL, mercBox } from './rasterlayer.js';
import { buildSteps } from './story.js';
import { renderBelow } from './below.js';
import { printReport, printPlan, download, toCSV, toGeoJSON } from './report.js';

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => (k === 'class' ? (e.className = v) : e.setAttribute(k, v))); e.innerHTML = html; return e; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f0 = (v) => Math.round(v).toLocaleString();
const f1 = (v) => (Math.abs(v) < 20 ? v.toFixed(1) : v.toFixed(0));
export const fmtRate = (v) => (!Number.isFinite(v) ? 'no rate' : v <= -0.5 ? `sinking ${f1(-v)} mm/yr` : v >= 0.5 ? `rising ${f1(v)} mm/yr` : 'steady');
export const fmtUn = (v) => (Number.isFinite(v) ? `${f1(v)} mm/yr per km` : 'no data');
const KIND_WORD = { road: 'Road', rail: 'Rail', pipeline: 'Pipeline', power: 'Power line', canal: 'Canal', mine: 'Your line' };

// ------------------------------------------------------------------ colours
const UN_COLS = ['#dfe8f5', '#b3c9ea', '#7ba2db', '#3368bd', '#14306b'];
const UN_STEPS = [50, 80, 90, 95, 99]; // percentiles
const RATE_COLS = ['#f7e6d3', '#f3c9a4', '#e9a174', '#d9714a', '#bf4330', '#8c1f1c'];
// colour steps follow how fast the place sinks, so slow places are not washed out and fast ones do not saturate
const rateBreaks = (site) => { const f = Math.abs(site.summary.fast_mmyr ?? 50); return f > 150 ? [10, 25, 50, 100, 200, 300] : f > 30 ? [5, 10, 25, 50, 75, 100] : f > 12 ? [2, 5, 10, 15, 20, 30] : [2, 4, 6, 8, 10, 12]; };
const NOISE_COLS = ['#8f7fb0', '#b8aecb', '#dcd7e4', null, '#d5dccb', '#aebd9c', '#7f9568'];
const NOISE_BREAKS = [-30, -20, -10, 10, 20, 30];
const CLS_COL = { first: '#0e6a5c', watch: '#b7791f', routine: '#7b8089', nodata: '#a9a59b' };
const hex = (h, a = 225) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

function painter(site, key) {
  const m = site.layers[key];
  if (m.kind === 'uneven') {
    const q = site.uneven_q, t = UN_STEPS.map((p) => q[p * 2]), c = UN_COLS.map((h) => hex(h));
    return (v) => (v < t[0] ? null : v < t[1] ? c[0] : v < t[2] ? c[1] : v < t[3] ? c[2] : v < t[4] ? c[3] : c[4]);
  }
  if (m.kind === 'rate') {
    const b = rateBreaks(site), c = RATE_COLS.map((h) => hex(h)), up = hex('#c9dcef', 200);
    return (v) => { const s = -v; return s < -b[0] ? up : s < b[0] ? null : s < b[1] ? c[0] : s < b[2] ? c[1] : s < b[3] ? c[2] : s < b[4] ? c[3] : s < b[5] ? c[4] : c[5]; };
  }
  if (m.kind === 'noise') {
    const c = NOISE_COLS.map((h) => (h ? hex(h, 215) : null));
    return (v) => { let i = 0; while (i < NOISE_BREAKS.length && v >= NOISE_BREAKS[i]) i++; return c[i]; };
  }
  if (m.kind === 'valid') {
    const lo = hex('#5f6670', 205), mid = hex('#b9bec4', 190), hi = hex('#a6d8cc', 170);
    return (v) => (v < 0.5 ? lo : v < 0.8 ? mid : hi);
  }
  return () => null;
}

// ------------------------------------------------------------------ state
const S = {
  sites: [], val: null, cache: new Map(), cur: null, layer: 'uneven', compare: null, split: 0.5,
  mode: 'story', view: 'list', sel: null, plan: null, shown: 40, tableShown: 100, tableSort: { k: 'rank', dir: 1 },
  filter: { groups: new Set(), cls: 'all', q: '', odd: false }, show: { lines: true, fissures: 'both', points: null },
  draw: null, role: null, dotBy: 'tier', base: 'light', placeQ: '', markers: [], callouts: [], planOpts: { groups: null, stops: 10, skipKnown: false, start: 'best' },
};
let map, glA, glB, glM, storySteps = [], activeStep = -1, drawN = 0, siteTok = 0, planRun = 0;
const painted = new Map(), rasters = new Map(), ov = new Map(), siteMarks = [];
const getRaster = (meta) => rasters.get(meta.file) || rasters.set(meta.file, loadRaster(meta)).get(meta.file);
const inBox = (b, p) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
const OV_BREAKS = [5, 10, 25, 50, 100, 200];

async function getJSON(f) { return (await fetch('data/' + f)).json(); }

// ------------------------------------------------------------------ site loading and scoring
const loading = new Map();
function loadSite(id) {
  if (S.cache.has(id)) return Promise.resolve(S.cache.get(id));
  if (!loading.has(id)) loading.set(id, loadSiteNow(id));
  return loading.get(id);
}
async function loadSiteNow(id) {
  const site = S.sites.find((s) => s.id === id);
  const c = { site, R: {}, segs: [], groups: [], overlays: null, cube: null, mine: [] };
  const want = ['rate', 'uneven', 'valid'].filter((k) => site.layers[k]);
  const [lines, overlays] = await Promise.all([getJSON(site.lines), getJSON(site.overlays), ...want.map(async (k) => { c.R[k] = await getRaster(site.layers[k]); })]);
  c.overlays = overlays;
  c.groups = lines.groups.map((g) => ({ id: g.id, label: g.label, kind: g.kind, source: g.source }));
  c.fis = buildFisIndex(overlays);
  if (c.R.rate) {
    const all = [];
    for (const g of lines.groups) scoreGroup(c, g.id, g.kind, g.f.map((f, i) => ({ id: i, name: g.names[f[0]], sub: f[1], coords: decodeLine(f[2]) })), all);
    c.segs = rankSegments(all);
  }
  S.cache.set(id, c);
  return c;
}

function scoreGroup(c, gid, kind, lines, out) {
  const seen = new Map();
  for (const ln of lines) {
    const pieces = scoreLine(ln.coords, c.R, c.site.uneven_q);
    pieces.forEach((p, k) => {
      if (gid !== 'mine' && p.len < 60) return; // map fragments too short to mean anything on a 270 m grid
      const key = p.mid[0].toFixed(4) + ',' + p.mid[1].toFixed(4);
      const dup = seen.get(key);
      if (dup) { if (ln.name && dup.name !== ln.name && !dup.aka.includes(ln.name) && dup.aka.length < 2) dup.aka.push(ln.name); return; }
      p.g = gid; p.kind = kind; p.name = ln.name || KIND_WORD[kind]; p.sub = ln.sub; p.aka = []; p.piece = k + 1; p.of = pieces.length; p.line = ln.id ?? null;
      p.fisDist = fisDist(c.fis, p.mid);
      seen.set(key, p);
      out.push(p);
    });
  }
}

// nearest mapped fissure, through a coarse grid so 15,000 pieces stay fast
function buildFisIndex(ov) {
  const lines = [];
  for (const k of ['fissures_known', 'fissures_new']) if (ov[k]) ov[k].f.forEach((f) => lines.push(f._c || (f._c = decodeLine(f.p))));
  if (!lines.length) return null;
  const grid = new Map(), cell = 0.02;
  lines.forEach((ln) => { const seenCells = new Set(); ln.forEach((p) => { const k = Math.floor(p[0] / cell) + ':' + Math.floor(p[1] / cell); if (!seenCells.has(k)) { seenCells.add(k); (grid.get(k) || grid.set(k, []).get(k)).push(ln); } }); });
  return { grid, cell };
}
function fisDist(ix, p) {
  if (!ix) return NaN;
  const cx = Math.floor(p[0] / ix.cell), cy = Math.floor(p[1] / ix.cell);
  let best = Infinity;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const a = ix.grid.get((cx + dx) + ':' + (cy + dy)); if (a) for (const ln of a) { const d = distToLine(p, ln); if (d < best) best = d; } }
  return best; // Infinity = none within about 2 km
}

async function ensureLayer(c, key) {
  if (!c.R[key] && c.site.layers[key]) c.R[key] = await getRaster(c.site.layers[key]);
  return c.R[key];
}

function paintedRGBA(c, key) {
  const id = c.site.id + ':' + key;
  if (painted.has(id)) return painted.get(id);
  const r = c.R[key];
  const rgba = r.paint(new Uint8ClampedArray(r.w * r.h * 4), painter(c.site, key));
  painted.set(id, rgba);
  return rgba;
}

// ground with no usable radar data, drawn as a grey hatch so that "unobserved" never looks like "stable"
function maskRGBA(c) {
  const id = c.site.id + ':mask';
  if (painted.has(id)) return painted.get(id);
  const r = c.R.rate, v = c.R.valid, d = new Uint8ClampedArray(r.w * r.h * 4);
  const same = v && v.w === r.w && v.h === r.h;
  // lookup from rate columns/rows into the good-data grid, which is coarser at the places added by script
  const vc = v && !same ? Int32Array.from({ length: r.w }, (_, col) => Math.floor((r.x0 + (col + 0.5) * r.px - v.x0) / v.px)) : null;
  const vr = v && !same ? Int32Array.from({ length: r.h }, (_, row) => Math.floor((v.y0 - (r.y0 - (row + 0.5) * r.px)) / v.px)) : null;
  for (let i = 0; i < r.data.length; i++) {
    const row = Math.floor(i / r.w), col = i % r.w;
    let vv = null;
    if (v) { if (same) vv = v.data[i]; else { const a = vr[row], b = vc[col]; vv = a < 0 || b < 0 || a >= v.h || b >= v.w ? v.nodata : v.data[a * v.w + b]; } }
    const inFrame = !v || vv !== v.nodata; // outside the radar window is not hatched: it was never looked at
    const bad = inFrame && (r.data[i] === r.nodata || (v && vv / v.scale < 0.5));
    if (!bad) continue;
    const on = (row + col) % 4 < 1;
    d[i * 4] = 120; d[i * 4 + 1] = 124; d[i * 4 + 2] = 130; d[i * 4 + 3] = on ? 150 : 34;
  }
  painted.set(id, d);
  return d;
}

// ------------------------------------------------------------------ map
function initMap() {
  map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/positron', center: [-109.86, 32.22], zoom: 9.2, dragRotate: false, pitchWithRotate: false, preserveDrawingBuffer: true, attributionControl: { compact: true } });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  window.__map = map;
  // 'style.load' does not wait for tiles, so the app starts even on a slow connection. If the base map never arrives
  // (offline, tile host down), fall back to a plain background: the radar layers and lines are all local.
  let started = false;
  const blank = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9ebed' } }] };
  setTimeout(() => { if (!started) { console.warn('Base map did not load; using a plain background.'); map.setStyle(blank); } }, 7000);
  return new Promise((res) => map.on('style.load', () => {
    if (started) return;
    started = true;
    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    // other base views, switched by visibility so the data layers above them are never rebuilt
    map.addSource('sat', { type: 'raster', tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg'], tileSize: 256, maxzoom: 14,
      attribution: 'Sentinel-2 cloudless by EOX (contains modified Copernicus Sentinel data 2016)' });
    map.addLayer({ id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' }, paint: { 'raster-saturation': -0.25, 'raster-fade-duration': 0 } }, before);
    map.addSource('dem', { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 13, encoding: 'terrarium',
      attribution: 'Terrain: Mapzen / AWS Terrain Tiles' });
    map.addLayer({ id: 'hill', type: 'hillshade', source: 'dem', layout: { visibility: 'none' }, paint: { 'hillshade-exaggeration': 0.6, 'hillshade-shadow-color': '#4f483e', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#7d7568' } }, before);
    map.addSource('states', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'state-fill', type: 'fill', source: 'states', maxzoom: 7.5, paint: { 'fill-color': ['case', ['>', ['get', 'n'], 0], '#147d6c', '#8a8578'], 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 3, ['case', ['>', ['get', 'n'], 0], 0.1, 0.03], 7.5, 0] } }, before);
    map.addLayer({ id: 'state-line', type: 'line', source: 'states', paint: { 'line-color': '#3d3b36', 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.9, 7, 1.6], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.75, 9, 0.35] } }, before);
    map.addSource('boxes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'boxes', type: 'line', source: 'boxes', minzoom: 4.6, maxzoom: 9.4, paint: { 'line-color': ['match', ['get', 'tier'], 'checked', '#147d6c', 'frontier', '#8f7fb0', '#1c1b19'], 'line-width': 1.2, 'line-dasharray': [3, 2], 'line-opacity': 0.75 } }, before);
    glA = new RasterGL('rasA', 0.86); glB = new RasterGL('rasB', 0.86); glM = new RasterGL('rasM', 0.9);
    [glA, glB, glM].forEach((l) => map.addLayer(l, before));
    const empty = { type: 'FeatureCollection', features: [] };
    ['fisK', 'fisN', 'segs', 'sel', 'route', 'draw'].forEach((id) => map.addSource(id, { type: 'geojson', data: empty }));
    const line = (id, source, paint, filter, layout = {}) => map.addLayer({ id, type: 'line', source, paint, layout: { 'line-cap': 'round', 'line-join': 'round', ...layout }, ...(filter ? { filter } : {}) }, before);
    line('fisK', 'fisK', { 'line-color': '#1c1b19', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.9, 13, 2.2], 'line-opacity': 0.85 });
    line('fisN', 'fisN', { 'line-color': '#e8590c', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 13, 3.6] });
    const zw = (a, b) => ['interpolate', ['linear'], ['zoom'], 8, a, 13, b];
    line('seg-mine', 'segs', { 'line-color': '#1c1b19', 'line-width': zw(4.5, 9), 'line-opacity': 0.28 }, ['==', ['get', 'mine'], 1]);
    line('seg-routine', 'segs', { 'line-color': CLS_COL.routine, 'line-width': zw(0.5, 1.6), 'line-opacity': 0.55 }, ['==', ['get', 'cls'], 'routine']);
    line('seg-nodata', 'segs', { 'line-color': CLS_COL.nodata, 'line-width': zw(0.7, 1.8), 'line-dasharray': [1.2, 1.8] }, ['==', ['get', 'cls'], 'nodata'], { 'line-cap': 'butt' });
    line('seg-watch', 'segs', { 'line-color': '#d9a441', 'line-width': zw(1.2, 3.2) }, ['==', ['get', 'cls'], 'watch']);
    line('seg-first-case', 'segs', { 'line-color': '#fff', 'line-width': zw(3.4, 8) }, ['==', ['get', 'cls'], 'first']);
    line('seg-first', 'segs', { 'line-color': CLS_COL.first, 'line-width': zw(2, 5) }, ['==', ['get', 'cls'], 'first']);
    line('seg-hit', 'segs', { 'line-color': '#000', 'line-width': 14, 'line-opacity': 0 });
    line('route', 'route', { 'line-color': '#147d6c', 'line-width': 2, 'line-dasharray': [2, 2] });
    line('sel-case', 'sel', { 'line-color': '#fff', 'line-width': 12 });
    line('sel', 'sel', { 'line-color': '#1c1b19', 'line-width': 6 });
    line('draw', 'draw', { 'line-color': '#147d6c', 'line-width': 3, 'line-dasharray': [1.5, 1.5] });
    map.addLayer({ id: 'draw-pts', type: 'circle', source: 'draw', paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#147d6c', 'circle-stroke-width': 2 } });
    wireMap();
    res();
  }));
}

function showRaster(gl, c, key, from = 0, to = 1) {
  const r = key && c.R[key];
  if (!r) { gl.hide(); return; }
  gl.setImage(c.site.id + ':' + key, paintedRGBA(c, key), r.w, r.h, mercBox(r));
  gl.setClip(from, to);
}

function drawRasters() {
  const c = S.cur; if (!map) return;
  syncOverview();
  if (!c) { glA.hide(); glB.hide(); glM.hide(); return; }
  if (S.compare) {
    const lon = map.unproject([S.split * map.getContainer().clientWidth, 0]).lng;
    const [a, b] = S.compare;
    showRaster(glA, c, a, 0, c.R[a].colOfLon(lon) / c.R[a].w);
    showRaster(glB, c, b, c.R[b].colOfLon(lon) / c.R[b].w, 1);
  } else {
    showRaster(glA, c, c.site.layers[S.layer] ? S.layer : null);
    glB.hide();
  }
  const s1 = (k) => k && !['nisar', 't149', 't156', 'none', 'valid'].includes(k);
  const maskOn = c.R.rate && (S.compare ? s1(S.compare[0]) || s1(S.compare[1]) : s1(S.layer) || S.layer === 'none');
  if (maskOn) {
    const r = c.R.rate;
    glM.setImage(c.site.id + ':mask', maskRGBA(c), r.w, r.h, mercBox(r));
    if (S.compare) { const lon = map.unproject([S.split * map.getContainer().clientWidth, 0]).lng, u = r.colOfLon(lon) / r.w; glM.setClip(s1(S.compare[0]) ? 0 : u, s1(S.compare[1]) ? 1 : u); } else glM.setClip(0, 1);
  } else glM.hide();
}

const fcLines = (arr, props = () => ({})) => ({ type: 'FeatureCollection', features: arr.map((a, i) => ({ type: 'Feature', properties: props(a, i), geometry: { type: 'LineString', coordinates: a.coords || a } })) });

function visibleSegs() {
  const c = S.cur; if (!c) return [];
  const f = S.filter, q = f.q.trim().toLowerCase();
  return c.segs.filter((s) => f.groups.has(s.g) && (f.cls === 'all' || s.cls === f.cls) && (!q || s.name.toLowerCase().includes(q) || s.aka.some((a) => a.toLowerCase().includes(q))) && (!f.odd || (s.cls === 'first' && s.ratePct < 80)));
}

function drawVectors() {
  const c = S.cur; if (!map) return;
  if (!c) { ['segs', 'fisK', 'fisN', 'sel'].forEach((id) => map.getSource(id).setData(fcLines([]))); S.vis = []; clearMarkers(S.markers); return; }
  const show = S.mode === 'story' ? S.show : { lines: true, fissures: 'both', points: S.show.points };
  const segs = show.lines ? visibleSegs() : [];
  S.vis = segs;
  const wk = isWeak(c.site);
  map.getSource('segs').setData(fcLines(segs, (s, i) => ({ i, cls: wk && s.cls === 'first' ? 'watch' : s.cls, mine: s.g === 'mine' ? 1 : 0 })));
  const ov = c.overlays;
  const fl = (k) => (ov[k] ? fcLines(ov[k].f.map((f) => f._c || (f._c = decodeLine(f.p)))) : fcLines([]));
  map.getSource('fisK').setData(show.fissures ? fl('fissures_known') : fcLines([]));
  map.getSource('fisN').setData(show.fissures === 'both' ? fl('fissures_new') : fcLines([]));
  map.getSource('sel').setData(S.sel ? fcLines([S.sel]) : fcLines([]));
  drawPoints(show.points);
}

function clearMarkers(list) { list.forEach((m) => m.remove()); list.length = 0; }

function drawPoints(kind) {
  clearMarkers(S.markers);
  const c = S.cur, ov = c.overlays;
  const add = (lon, lat, color, html) => {
    const d = el('div', { class: 'ptmark', style: `color:${color}` });
    const m = new maplibregl.Marker({ element: d }).setLngLat([lon, lat]).setPopup(new maplibregl.Popup({ offset: 10, closeButton: false }).setHTML(html)).addTo(map);
    S.markers.push(m);
  };
  if (kind === 'benchmarks') (ov.benchmarks || []).forEach((b) => add(b.lon, b.lat, Math.abs(b.radar - b.bm) < Math.max(8, Math.abs(b.bm) * 0.3) ? '#147d6c' : '#d9a441',
    `<b>Benchmark ${esc(b.name)}</b><br>Survey ${b.first} to ${b.last}: <b>${b.bm.toFixed(1)} mm/yr</b><br>Radar 2016 to 2026: <b>${b.radar.toFixed(1)} mm/yr</b><br><span class="m">Green: within 30%. Amber: survey average covers older, slower decades or the two differ.</span>`));
  if (kind === 'gps') (ov.gps || []).forEach((g) => add(g.lon, g.lat, g.gps == null || g.radar == null ? '#9a958a' : Math.abs(g.radar - g.gps) < (g.note ? Math.max(3, 0.25 * Math.abs(g.gps)) : 20) ? '#147d6c' : '#d9a441',
    `<b>GPS ${esc(g.name)}</b><br>${g.gps == null ? 'No GPS rate in the test window' : `GPS: <b>${g.gps.toFixed(1)} mm/yr</b>`}<br>Radar: <b>${g.radar == null ? 'no data here' : g.radar.toFixed(1) + ' mm/yr'}</b><br><span class="m">${esc(g.note || 'Both along the radar line of sight, Dec 2017 to Mar 2019.')}</span>`));
  if (kind === 'chennai') (ov.points || []).forEach((p) => add(p.lon, p.lat, p.kind === 'stable' ? '#8a8578' : '#8f7fb0',
    `<b>${esc(p.name)}</b><br>${p.kind === 'stable' ? 'Presumed-stable reference point' : 'Published hotspot'}<br>3.5-month change: <b>${p.cum} mm</b> (noise ±${p.sigma} mm)<br><span class="m">${Math.abs(p.snr) < 2 ? 'Inside the noise.' : 'Above 2 sigma on this track, but not specific to this spot.'}</span>`));
}

function setCallouts(list) {
  clearMarkers(S.callouts);
  (list || []).forEach((c) => {
    if (!c || !c.at) return;
    const d = el('div', { class: 'callout' + (c.side === 'left' ? ' left' : '') + (c.down ? ' down' : '') }, `<div class="dot"></div><div class="box"><b>${esc(c.title)}</b>${c.sub ? `<span>${esc(c.sub)}</span>` : ''}</div>`);
    S.callouts.push(new maplibregl.Marker({ element: d, anchor: 'center' }).setLngLat(c.at).addTo(map));
  });
}

function wireMap() {
  const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
  map.on('mousemove', 'seg-hit', (e) => {
    if (S.draw || S.mode === 'story') return;
    const s = S.vis[e.features[0].properties.i]; if (!s) return;
    map.getCanvas().style.cursor = 'pointer';
    pop.setLngLat(e.lngLat).setHTML(`<b>${esc(s.name)}</b><br><span class="c-${s.cls}" style="font-weight:700">${CLASS_LABEL[s.cls]}</span>${s.cls === 'nodata' ? '<br><span class="m">Not observed: too little good radar data.</span>' : `<br>Unevenness ${fmtUn(s.uneven)}<br>${fmtRate(s.rate)}`}`).addTo(map);
  });
  map.on('mouseleave', 'seg-hit', () => { map.getCanvas().style.cursor = ''; pop.remove(); });
  map.on('click', (e) => {
    if (S.mode === 'story') return;
    if (S.draw) { S.draw.pts.push([e.lngLat.lng, e.lngLat.lat]); renderDraw(); return; }
    const hit = map.queryRenderedFeatures(e.point, { layers: ['seg-hit'] })[0];
    if (hit) { select(S.vis[hit.properties.i]); return; }
    pointReadout(e.lngLat);
  });
  map.on('dblclick', (e) => { if (S.draw) { e.preventDefault(); S.draw.pts.pop(); finishDraw(); } });
  map.on('move', () => { if (S.compare) { drawRasters(); placeSplitter(); } });
  map.on('resize', () => { if (S.compare) { drawRasters(); placeSplitter(); } });
}

function pointReadout({ lng, lat }) {
  const c = S.cur, box = $('#readout');
  const close = () => { box.querySelector('.x').onclick = () => { box.hidden = true; }; };
  if (c && c.site.frontier) { box.hidden = true; return; }
  if (!c || !c.R.rate.inside(lng, lat)) {
    const near = S.sites.find((s) => inBox(s.bbox, [lng, lat]));
    if (near && (!c || near.id !== c.site.id)) { setSite(near.id, { keepView: true }); box.hidden = true; return; }
    box.innerHTML = `<button class="x" aria-label="Close">×</button><b>${lat.toFixed(3)}, ${lng.toFixed(3)}</b><br>${noFrameMsg([lng, lat])}`;
    box.hidden = false; close(); return;
  }
  const r = c.R.rate.valueAt(lng, lat), u = c.R.uneven.valueAt(lng, lat), v = c.R.valid.valueAt(lng, lat);
  const ok = Number.isFinite(r) && Number.isFinite(u) && v >= 0.5;
  const p = percentileOf(c.site.uneven_q, u);
  box.innerHTML = `<button class="x" aria-label="Close">×</button><b>${lat.toFixed(4)}, ${lng.toFixed(4)}</b><br>` + (ok
    ? `${fmtRate(r)} · unevenness ${fmtUn(u)}<br><span class="m" style="color:var(--muted)">More uneven than ${p.toFixed(0)}% of measured ground in this frame. Click a line for the full reading, or draw your own.</span>`
    : '<b>Not observed.</b> The radar has too little good data here. That is not the same as stable.');
  box.hidden = false;
  box.querySelector('.x').onclick = () => { box.hidden = true; };
}

// ------------------------------------------------------------------ site switching, layers, compare
async function setSite(id, opts = {}) {
  const tok = ++siteTok;
  const c = await loadSite(id);
  if (tok !== siteTok) return c; // a later click won
  const changed = S.cur !== c;
  S.cur = c;
  if (changed) {
    S.sel = null; S.plan = null; S.shown = 40; S.tableShown = 100; S.compare = null; S.view = c.site.frontier ? 'frontier' : 'list';
    S.filter = { groups: new Set(c.groups.map((g) => g.id).concat(c.mine.length ? ['mine'] : [])), cls: 'all', q: '', odd: false };
    S.planOpts.groups = null;
    $('#search').value = '';
    setRoute(null);
    S.layer = c.site.frontier ? 't149' : opts.layer || 'uneven';
  }
  if (opts.layer && c.site.layers[opts.layer]) S.layer = opts.layer;
  await ensureLayer(c, S.layer);
  if (tok !== siteTok) return c;
  if (S.mode !== 'story') {
    if (changed && !opts.keepView) { S.flyUntil = Date.now() + 2400; const far = haversine(map.getCenter().toArray(), c.site.center) > 3e6; map[far ? 'jumpTo' : 'flyTo']({ center: c.site.center, zoom: c.site.zoom, duration: 1600 }); }
    if (changed) S.show.points = c.site.frontier ? 'chennai' : null;
    renderAll();
  }
  return c;
}

function layerOptions(c) {
  const L = c.site.layers, out = [];
  if (L.uneven) out.push(['uneven', 'Unevenness']);
  if (L.rate) out.push(['rate', 'Sinking rate']);
  if (L.nisar) out.push(['nisar', 'NISAR']);
  if (L.t149) out.push(['t149', 'NISAR track 149'], ['t156', 'NISAR track 156']);
  if (L.valid) out.push(['valid', 'Data quality']);
  out.push(['none', 'Lines only']);
  return out;
}
function compareOptions(c) {
  const L = c.site.layers, out = [];
  if (L.rate && L.uneven) out.push([['rate', 'uneven'], 'Rate | Unevenness']);
  if (L.rate_pre) out.push([['rate_pre', 'rate'], 'To 2022 | To 2026']);
  if (L.nisar) out.push([['rate', 'nisar'], 'Sentinel-1 | NISAR']);
  if (L.t149) out.push([['t149', 't156'], 'Track 149 | Track 156']);
  return out;
}
const SHORT = { rate: 'Sinking rate, Sentinel-1', rate_pre: 'Sinking rate to 2022', uneven: 'Unevenness', uneven_pre: 'Unevenness to 2022', nisar: 'Sinking rate, NISAR', t149: 'Track 149', t156: 'Track 156' };

function renderMapbar() {
  const c = S.cur, seg = $('#layerSeg');
  seg.innerHTML = '';
  if (S.compare) compareOptions(c).forEach(([pair, label]) => { const b = el('button', { 'aria-pressed': String(S.compare.join() === pair.join()) }, label); b.onclick = () => setCompare(pair); seg.appendChild(b); });
  else layerOptions(c).forEach(([k, label]) => { const b = el('button', { 'aria-pressed': String(S.layer === k) }, label); b.onclick = () => setLayer(k); seg.appendChild(b); });
  $('#compareBtn').setAttribute('aria-pressed', String(!!S.compare));
  $('#compareBtn').hidden = !compareOptions(c).length;
  $('#drawBtn').hidden = !!c.site.frontier;
  document.querySelector('label[for=fileIn]').hidden = !!c.site.frontier;
  $('#search').hidden = !!c.site.frontier;
  const tk = truthKind(c), tb = $('#truthBtn');
  tb.hidden = !tk || !!c.site.frontier;
  tb.textContent = tk === 'gps' ? 'GPS stations' : 'Survey benchmarks';
  tb.setAttribute('aria-pressed', String(!!S.show.points && !c.site.frontier));
}
const truthKind = (c) => (c.overlays.gps && c.overlays.gps.length ? 'gps' : c.overlays.benchmarks && c.overlays.benchmarks.length ? 'benchmarks' : c.overlays.points ? 'chennai' : null);

async function setLayer(k) { S.layer = k; S.compare = null; if (k !== 'none') await ensureLayer(S.cur, k); renderMapbar(); drawRasters(); renderLegend(); placeSplitter(); }
async function setCompare(pair) {
  if (pair) await Promise.all(pair.map((k) => ensureLayer(S.cur, k)));
  S.compare = pair;
  renderMapbar(); drawRasters(); renderLegend(); placeSplitter();
}
function placeSplitter() {
  const sp = $('#splitter');
  sp.hidden = !S.compare;
  if (!S.compare) return;
  sp.style.left = S.split * 100 + '%';
  $('#splitL').textContent = SHORT[S.compare[0]]; $('#splitR').textContent = SHORT[S.compare[1]];
}
function wireSplitter() {
  const h = $('#splitter .handle');
  h.addEventListener('pointerdown', (e) => {
    h.setPointerCapture(e.pointerId);
    const move = (ev) => { const r = $('#mapwrap').getBoundingClientRect(); S.split = Math.max(0.05, Math.min(0.95, (ev.clientX - r.left) / r.width)); placeSplitter(); drawRasters(); };
    const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
  });
}

function renderLegend() {
  const c = S.cur, lg = $('#legend');
  if (!c) { lg.hidden = false; lg.innerHTML = worldLegend(); return; }
  const one = (key) => {
    const m = c.site.layers[key]; if (!m) return '';
    if (m.kind === 'uneven') return `<b>${m.label}</b><div class="note" style="margin:0 0 5px">How much the sinking rate changes from one end of a kilometre to the other (${m.unit}).</div><div class="ramp">${UN_COLS.map((x) => `<i style="background:${x}"></i>`).join('')}</div><div class="ticks"><span>top half</span><span>top 20%</span><span>10%</span><span>5%</span><span>1%</span></div><div class="note">Compared with the rest of this window (${f0(c.site.uneven_q_n)} cells). The top 5% starts at ${f1(c.site.uneven_q[190])}.</div>`;
    if (m.kind === 'rate') { const b = rateBreaks(c.site); return `<b>${m.label} · ${m.unit}${c.site.rate_kind === 'line of sight' ? ', line of sight' : ''}</b><div class="ramp">${RATE_COLS.map((x) => `<i style="background:${x}"></i>`).join('')}</div><div class="ticks">${b.map((v) => `<span>${v}</span>`).join('')}<span>+</span></div>${m.caveat ? `<div class="note">${m.caveat}</div>` : ''}`; }
    if (m.kind === 'noise') return `<b>${m.label}</b><div class="ramp">${NOISE_COLS.map((x) => `<i style="background:${x || '#f1efe9'}"></i>`).join('')}</div><div class="ticks"><span>−30 mm</span><span>0</span><span>+30 mm</span></div><div class="note"><b style="display:inline;color:#a8321f">Noise level. Not a detection.</b> Smallest detectable rate today: about ${c.site.summary.mdr_now.toFixed(0)} mm/yr.</div>`;
    if (m.kind === 'valid') return `<b>Data quality · share of radar dates with a usable signal</b><div class="ramp"><i style="background:#5f6670"></i><i style="background:#b9bec4"></i><i style="background:#a6d8cc"></i></div><div class="ticks"><span>under half: not observed</span><span>half to 80%</span><span>80% +</span></div><div class="note">Sentinel-1 loses its signal over irrigated fields, water and steep slopes. Lines over dark ground are listed as not observed.</div>`;
    return '';
  };
  let h = S.compare ? one(S.compare[0]) + '<div style="height:8px"></div>' + one(S.compare[1]) : one(S.layer);
  const showLines = S.mode !== 'story' || S.show.lines;
  if (c.R.rate) {
    h += '<div class="keys">';
    if (showLines) h += `<span><i class="sw" style="border-color:${CLS_COL.first}"></i>Inspect first (top 5%)</span><span><i class="sw" style="border-color:#d9a441"></i>Watch (top 20%)</span><span><i class="sw dash" style="border-color:${CLS_COL.nodata}"></i>Not observed</span>`;
    if (c.fis && (S.mode !== 'story' || S.show.fissures)) h += `<span><i class="sw" style="border-color:#1c1b19"></i>Mapped fissure</span>${c.overlays.fissures_new && (S.mode !== 'story' || S.show.fissures === 'both') ? '<span><i class="sw" style="border-color:#e8590c"></i>Added since 2023</span>' : ''}`;
    h += '<span><i class="hatch"></i>No good radar data</span></div>';
  }
  lg.innerHTML = h;
  lg.hidden = !h;
}

// ------------------------------------------------------------------ header
const TIERS = [['checked', 'Checked in depth against ground truth'], ['measured', 'Added by script: checked against GPS where stations exist'], ['frontier', 'NISAR only: the clock has just started']];
function renderTabs() {
  const t = $('#siteTabs'); t.innerHTML = '';
  const all = el('button', { 'aria-pressed': String(!S.cur) }, 'All places'); all.onclick = () => goWorld(); t.appendChild(all);
  const cur = S.cur ? S.cur.site.id : '';
  const opt = (s, label) => `<option value="${s.id}"${s.id === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const measured = S.sites.filter((s) => s.tier === 'measured').sort((a, b) => (a.st || '').localeCompare(b.st || '') || a.name.localeCompare(b.name));
  const sel = el('select', { id: 'siteSel', 'aria-label': 'Jump to a place', class: cur ? 'on' : '' }, '<option value="">Jump to a place…</option>'
    + `<optgroup label="${TIERS[0][1]}">${S.sites.filter((s) => s.tier === 'checked').map((s) => opt(s, s.name)).join('')}</optgroup>`
    + `<optgroup label="${TIERS[1][1]}, by state">${measured.map((s) => opt(s, `${s.st || ''} · ${s.name}`)).join('')}</optgroup>`
    + `<optgroup label="${TIERS[2][1]}">${S.sites.filter((s) => s.tier === 'frontier').map((s) => opt(s, s.name)).join('')}</optgroup>`);
  sel.onchange = () => (sel.value ? setSite(sel.value) : goWorld());
  t.appendChild(sel);
}
function renderTally() {
  const c = S.cur, t = $('#tally');
  if (!c) {
    const w = (k) => (truthCount(k) / S.sites.length) * 100;
    t.innerHTML = `<div class="bar">${['validated', 'agree', 'weak', 'none', 'frontier'].map((k) => `<i style="width:${w(k)}%;background:${TRUTH_COL[k]}"></i>`).join('')}</div><div class="cap"><span><b>${truthCount('validated') + truthCount('agree')}</b> places agree with ground truth</span><span><b>${truthCount('weak')}</b> weak</span><span><b>${truthCount('none')}</b> nothing to check against</span></div>`;
    return;
  }
  if (!c.segs.length) { t.innerHTML = `<div class="cap"><span><b>${c.site.name}</b> · ${roleLabel(c.site)}</span><span>No ranking: record too short</span></div>`; return; }
  const s = summarize(c.segs.filter((x) => S.filter.groups.has(x.g)));
  const w = (k) => (s.km ? (s[k].km / s.km) * 100 : 0);
  t.innerHTML = `<div class="bar" title="Share of line length by class"><i style="width:${w('first')}%;background:${CLS_COL.first}"></i><i style="width:${w('watch')}%;background:#d9a441"></i><i style="width:${w('routine')}%;background:#cfcabd"></i><i style="width:${w('nodata')}%;background:repeating-linear-gradient(45deg,#a9a59b 0 2px,#e9e5da 2px 5px)"></i></div>
    <div class="cap"><span><b>${isWeak(c.site) ? 0 : f0(s.first.km)} km</b> inspect first</span><span><b>${f0(s.watch.km)} km</b> watch</span><span>${f0(s.km)} km of line ranked</span><span><b>${f0(s.nodata.km)} km</b> not observed</span></div>`;
}

// ------------------------------------------------------------------ panel: list
function rowHTML(s, pos) {
  const kind = s.g === 'mine' ? 'Your line' : `${KIND_WORD[s.kind] || ''}${s.sub && !['rail', 'pipeline', 'canal', 'transmission'].includes(s.sub) ? ' · ' + esc(s.sub) : ''}`;
  return `<span class="rk">${s.rank ? '#' + (pos ?? s.rank) : '–'}</span><span><span class="nm">${esc(s.name)}${s.aka.length ? ` <span style="font-weight:400;color:var(--muted)">/ ${esc(s.aka.join(' / '))}</span>` : ''}</span><span class="sb">${kind} · ${f0(s.len)} m at ${s.mid[1].toFixed(3)}, ${s.mid[0].toFixed(3)}${s.of > 1 ? ` · piece ${s.piece} of ${s.of}` : ''}${Number.isFinite(s.fisDist) && s.fisDist < 300 ? ' <span class="tag">fissure within ' + f0(Math.max(10, s.fisDist)) + ' m</span>' : ''}</span></span>
    <span class="vd c-${s.cls}">${s.cls === 'nodata' ? 'Not observed' : f1(s.uneven) + ' <small>mm/yr per km</small>'}<small>${s.cls === 'nodata' ? `${Math.round(s.valid * 100)}% good data` : fmtRate(s.rate)}</small></span>`;
}

function renderList() {
  const c = S.cur, p = $('#panel');
  const vis = S.vis || visibleSegs();
  const counts = {}; c.segs.forEach((s) => { counts[s.g] = (counts[s.g] || 0) + 1; });
  const groups = c.groups.filter((g) => counts[g.id]).concat(c.mine.length ? [{ id: 'mine', label: 'Your lines' }] : []);
  const fsum = summarize(c.segs.filter((s) => S.filter.groups.has(s.g)));
  const weak = isWeak(c.site);
  p.innerHTML = `<h2>${weak ? 'Nothing stands out here' : `${f0(fsum.n)} pieces of line, ranked`}</h2>
    <p class="lede">${esc(c.site.name)}: ${esc(roleLabel(c.site).replace(/^M/, 'm'))}. ${weak ? `The ground here sinks slowly and evenly as far as the radar can tell, so the ${f0(fsum.n)} pieces below are in order but <b>none is flagged</b>. Treat it as a clean bill for now, not a work list.` : `Each piece is about 300 m, in order of how unevenly the ground beneath it is sinking (not how fast). <b>${S.role ? ROLES.find((r) => r.id === S.role).who + ': ' : ''}${f0(fsum.first.km)} km to look at first, out of ${f0(fsum.km)} km${S.filter.groups.size < groups.length ? ' of your lines' : ''}.</b>`}</p>
    ${siteCaveat(c)}
    <div class="kicker" style="margin-top:4px">I look after</div>
    <div class="chips" id="rchips">${ROLES.map((r) => `<button data-role="${r.id}" aria-pressed="${S.role === r.id}" title="${r.q}">${r.id === 'roads' ? 'Roads' : r.id === 'lines' ? 'Pipelines, canals, rail, power' : 'Fissure mapping'}</button>`).join('')}</div>
    <div class="takeaway"><button class="btn teal" id="taPlan">Plan inspection stops</button><button class="btn ghost" id="taGis">File for my GIS</button><button class="btn ghost" id="taCsv">CSV</button></div>
    <div class="chips" id="gchips">${groups.map((g) => `<button data-g="${g.id}" aria-pressed="${S.filter.groups.has(g.id)}">${esc(g.label)}<span class="n">${f0(counts[g.id] || 0)}</span></button>`).join('')}</div>
    <div class="chips" id="cchips">${[['all', 'All'], ['first', weak ? 'Highest here' : 'Inspect first'], ['watch', 'Watch'], ['nodata', 'Not observed']].map(([k, l]) => `<button data-c="${k}" aria-pressed="${S.filter.cls === k && !S.filter.odd}">${l}</button>`).join('')}<button data-odd="1" aria-pressed="${S.filter.odd}" title="Top 5% for unevenness, but outside the fastest-sinking 20% of pieces. A ranking by sinking speed alone would leave these in the routine pile.">Uneven, not fast</button></div>
    <div id="rows"></div>
    <div style="height:14px"></div>
    ${truthCard(c)}
    ${nisarCard(c)}
    <div class="meta">Data behind this place: ${c.site.sensor} · radar ${c.site.layers.rate.period} · rates are ${c.site.rate_kind} · <a href="#sec-method">How it works</a></div>`;
  wireRoles(p);
  if ($('#gpsShow')) $('#gpsShow').onclick = () => { S.show.points = 'gps'; renderMapbar(); drawVectors(); p.scrollTop = 0; toast('GPS stations are on the map. Click a dot to compare GPS with the radar there.'); };
  if ($('#nisCmp')) { $('#nisCmp').onclick = () => setCompare(['rate', 'nisar']); $('#nisOnly').onclick = () => setLayer('nisar'); }
  $('#taPlan').onclick = () => { S.view = 'planner'; S.planOpts.groups = new Set(S.filter.groups); renderAll(); runPlan(); };
  $('#taGis').onclick = () => download(`strainwatch_${c.site.id}_ranked.geojson`, toGeoJSON(vis, c.site), 'application/geo+json');
  $('#taCsv').onclick = () => download(`strainwatch_${c.site.id}_ranked.csv`, toCSV(vis, c.site), 'text/csv');
  const rows = $('#rows');
  if (!vis.length) rows.innerHTML = `<div class="empty">Nothing matches. ${c.segs.length ? 'Clear the search or turn a line type back on.' : ''}</div>`;
  let last = null;
  vis.slice(0, S.shown).forEach((s, i) => {
    if (s.cls !== last) { last = s.cls; const n = vis.filter((x) => x.cls === s.cls).length; rows.appendChild(el('div', { class: 'kicker' + (s.cls === 'first' && !weak ? ' teal' : '') }, `${clsLabel(s.cls)} · ${f0(n)} ${s.cls === 'first' ? (weak ? '· still close to radar noise' : '· ground in the most uneven 5%') : s.cls === 'watch' ? '· most uneven 5 to 20%' : s.cls === 'nodata' ? '· too little good radar data' : ''}`)); }
    const b = el('button', { class: 'row' }, rowHTML(s, i + 1));
    b.onclick = () => select(s); b.onmouseenter = () => hoverSeg(s); b.onmouseleave = () => hoverSeg(null);
    rows.appendChild(b);
  });
  if (vis.length > S.shown) { const m = el('button', { class: 'more' }, `Show 40 more of ${f0(vis.length - S.shown)}`); m.onclick = () => { S.shown += 40; renderList(); }; rows.appendChild(m); }
  p.querySelectorAll('#gchips button').forEach((b) => (b.onclick = () => { const g = b.dataset.g; S.filter.groups.has(g) ? S.filter.groups.delete(g) : S.filter.groups.add(g); S.shown = 40; renderAll(); }));
  p.querySelectorAll('#cchips button').forEach((b) => (b.onclick = () => { if (b.dataset.odd) { S.filter.odd = !S.filter.odd; S.filter.cls = 'all'; } else { S.filter.cls = b.dataset.c; S.filter.odd = false; } S.shown = 40; renderAll(); }));
}

function hoverSeg(s) { if (S.sel) return; map.getSource('sel').setData(s ? fcLines([s]) : fcLines([])); }

// ------------------------------------------------------------------ panel: detail
function confidence(s, fit, mk) {
  if (s.cls === 'nodata') return ['none', 'Too little good radar data under this piece.'];
  if (s.valid >= 0.9 && fit && fit.n >= 12 && mk && mk.p < 0.05) return ['high', `Good data under ${Math.round(s.valid * 100)}% of the piece, ${fit.n} dates, and a trend that is unlikely to be chance.`];
  if (s.valid >= 0.7 && fit && fit.n >= 8) return ['medium', mk && !(mk.p < 0.05) ? 'Good coverage, but the sinking trend here is not statistically clear.' : `Good data under ${Math.round(s.valid * 100)}% of the piece.`];
  return ['low', `Good data under only ${Math.round(s.valid * 100)}% of the piece, or too few dates.`];
}

async function select(s, { fly = true } = {}) {
  if (!s) return;
  S.sel = s; S.view = 'detail';
  map.getSource('sel').setData(fcLines([s]));
  if (fly) map.easeTo({ center: s.mid, zoom: Math.max(map.getZoom(), 12.4), duration: 700 });
  const c = S.cur, p = $('#panel');
  p.scrollTop = 0;
  const un = c.site.uneven_q, kindWord = s.g === 'mine' ? 'Your line' : KIND_WORD[s.kind];
  // pieces of the same named line, ordered along its longer axis, for the profile
  const generic = /^(Unnamed road|Power line|Pipeline|Rail|Canal|Road)\b/.test(s.name) && !/\d{3,}|[A-Z]{2,}-?\d/.test(s.name.replace(/\d+ kV/, ''));
  let siblings = c.segs.filter((x) => x.g === s.g && (s.g === 'mine' || generic ? x.line === s.line : x.name === s.name));
  if (siblings.length > 400) siblings = siblings.filter((x) => haversine(x.mid, s.mid) < 30000);
  const ex = (k) => Math.max(...siblings.map((x) => x.mid[k])) - Math.min(...siblings.map((x) => x.mid[k]));
  const axis = ex(0) * Math.cos((s.mid[1] * Math.PI) / 180) >= ex(1) ? 0 : 1;
  p.innerHTML = `<button class="back" id="back">← All pieces</button>
    <h2>${esc(s.name)}</h2>
    <p class="lede">${kindWord}${s.aka.length ? ' · also ' + esc(s.aka.join(', ')) : ''} · ${f0(s.len)} m piece at ${s.mid[1].toFixed(4)}, ${s.mid[0].toFixed(4)}</p>
    <div class="card"><div class="verdict c-${s.cls}">${s.cls === 'nodata' ? 'Not observed' : `${clsLabel(s.cls)} · rank ${f0(s.rank)} of ${f0(c.segs.filter((x) => x.rank).length)} pieces with data`}</div>
      ${s.cls === 'nodata' ? `<p>The radar has good data under only <b>${Math.round(s.valid * 100)}%</b> of this piece, so it gets no score. <b>That is not the same as stable.</b> Irrigated fields, water and steep slopes lose the signal.</p>`
    : `<p><b>Radar reads a change in sinking rate of up to ${fmtUn(s.uneven)} under this piece</b> (its worst 270 m cell). That is more uneven than ${s.pct >= 99.5 ? 'over 99' : s.pct.toFixed(0)}% of the measured ground in this frame. Use the number to rank, not as a measurement of strain. The piece itself is ${fmtRate(s.rate)}${c.site.rate_kind === 'line of sight' ? ' along the radar line of sight' : ''}.</p>
      <div class="gauge"><div class="zone" style="left:${WATCH_PCT}%;right:${100 - FIRST_PCT}%;background:#ecd9ae"></div><div class="zone" style="left:${FIRST_PCT}%;right:0;background:#b5d8cf"></div><div class="mark hollow" style="left:${s.ratePct}%" title="Sinking-rate rank"></div><div class="mark" style="left:${s.pct}%" title="Unevenness percentile"></div></div>
      <div class="gscale"><span>least</span><span>median</span><span>most</span></div>
      <div class="gkey"><span><i></i>Unevenness: ${s.pct >= 99.5 ? 'top 0.5%' : 'more uneven than ' + s.pct.toFixed(0) + '% of ground'}</span><span><i class="h"></i>Sinking speed: faster than ${s.ratePct.toFixed(0)}% of pieces</span></div>`}
      <p class="fine">A to-do order for deciding where to look first. Not a damage report and not a forecast.</p></div>
    <div class="card"><h3>Why it ranks here</h3><ul class="why" id="why"></ul></div>
    <div class="card"><h3>Sinking history under this piece <span class="src">${c.site.ts ? 'Sentinel-1' : ''}</span></h3><div class="chart" id="ts"><p class="fine">Loading the radar history…</p></div><table class="kv" id="tskv"></table></div>
    ${siblings.length > 2 ? `<div class="card"><h3>Profile along ${esc(s.name)}</h3><p class="fine">Bars: unevenness of each piece. Red line: sinking rate. Hatched: not observed. Click a bar to open that piece.</p><div class="chart" id="prof"></div></div>` : ''}
    <div class="card"><h3>What this does not tell you</h3><p class="fine" style="font-size:12.5px;color:var(--ink2)">Whether the ${s.g === 'mine' ? 'line' : kindWord.toLowerCase()} is damaged. Whether a fissure will open here. Anything narrower than a radar pixel (30 to 270 m). Sideways ground motion. For that, a person has to look: the county engineer, or ${c.site.st === 'AZ' ? "the Arizona Geological Survey's fissure mappers" : 'your state geological survey'}.</p></div>
    <div class="btnrow"><button class="btn teal" id="repBtn">One-page report</button><button class="btn ghost" id="zoomBtn">Zoom to piece</button></div>`;
  $('#back').onclick = () => { S.sel = null; S.view = S.plan ? 'planner' : 'list'; renderAll(); };
  $('#zoomBtn').onclick = () => map.easeTo({ center: s.mid, zoom: 14 });
  // profile
  if (siblings.length > 2) {
    const ordered = s.g === 'mine' ? siblings.slice().sort((a, b) => a.piece - b.piece) : siblings.slice().sort((a, b) => a.mid[axis] - b.mid[axis]);
    charts.profileChart($('#prof'), ordered, (x) => select(x));
  }
  // history
  let fit = null, mk = null, y = null;
  if (c.site.ts) {
    if (!c.cube) c.cube = await loadCube(c.site.ts);
    if (S.sel !== s) return;
    y = c.cube.seriesAt(s.mid[0], s.mid[1]);
    if (y) { fit = linfit(c.site.ts.decyear, y); mk = mannKendallHR(c.site.ts.decyear, y); charts.tsChart($('#ts'), c.site.ts.decyear, y, fit, { unit: 'mm' }); }
    else $('#ts').innerHTML = '<p class="fine">Outside the stored history grid.</p>';
    if (fit && Number.isFinite(fit.slope)) {
      $('#tskv').innerHTML = `<tr><td>Fitted rate, ${c.site.ts.dates[0].slice(0, 4)} to ${c.site.ts.dates.at(-1).slice(0, 4)}</td><td>${f1(fit.slope)} mm/yr</td></tr>
        <tr><td>95% range of that rate</td><td>${f1(fit.lo)} to ${f1(fit.hi)}</td></tr>
        <tr><td>Is the sinking trend real? (statistical test)</td><td>${mk.p < 0.05 ? 'yes' : 'not clear'}, ${mk.p < 0.001 ? 'p < 0.001' : 'p = ' + mk.p.toFixed(3)}</td></tr>
        <tr><td>Dates used</td><td>${fit.n} of ${c.site.ts.n}</td></tr>`;
    }
  } else $('#ts').innerHTML = '<p class="fine">No history cube for this site.</p>';
  let stable = null;
  if (c.site.layers.uneven_pre && s.cls !== 'nodata') {
    const pre = await ensureLayer(c, 'uneven_pre');
    if (S.sel !== s) return;
    const vals = s.coords.map((p) => pre.valueAt(p[0], p[1])).concat([pre.valueAt(s.mid[0], s.mid[1])]).filter(Number.isFinite);
    if (vals.length) stable = percentileOf(c.site.uneven_q, Math.max(...vals));
  }
  const [conf, why] = confidence(s, fit, mk);
  s._fit = fit; s._mk = mk; s._conf = [conf, why];
  const li = [];
  if (s.cls !== 'nodata') {
    li.push(['', `<b>Unevenness ${fmtUn(s.uneven)}</b> at the worst point under the piece. The top 5% of this frame starts at ${f1(un[190])}; the top 20% at ${f1(un[160])}.`]);
    const rt = fmtRate(s.rate);
    li.push([s.ratePct >= 80 ? '' : 'q', `<b>${rt[0].toUpperCase() + rt.slice(1)}</b> (middle value under the piece), faster than ${s.ratePct.toFixed(0)}% of ranked pieces.${s.ratePct < 80 && s.cls === 'first' ? ' Not among the fastest 20%: a ranking by sinking speed alone would have left it in the routine pile.' : ''}`]);
  }
  if (c.fis) li.push([Number.isFinite(s.fisDist) && s.fisDist < 500 ? '' : 'q', Number.isFinite(s.fisDist) ? `<b>Nearest mapped fissure: ${f0(s.fisDist)} m.</b> In our test, being near a known fissure was the single best guide, slightly ahead of this score.` : '<b>No mapped fissure within about 2 km.</b> This is the kind of ground where the score adds most, and where our test had the fewest cases.']);
  if (stable != null) li.push([stable >= FIRST_PCT === (s.cls === 'first') ? '' : 'q', stable >= FIRST_PCT ? `<b>Stable ranking.</b> With radar up to 2022 only, this ground was already in the most uneven 5% (percentile ${stable.toFixed(0)}).` : `<b>${s.cls === 'first' ? 'Newer signal.' : 'Earlier reading.'}</b> With radar up to 2022 only, this ground sat at percentile ${stable.toFixed(0)}${s.cls === 'first' ? ', outside the top 5%. The unevenness has grown since, or the earlier map was noisier here.' : '.'}`]);
  li.push([s.valid >= 0.9 ? '' : 'minus', `<b>Good radar data under ${Math.round(s.valid * 100)}% of the piece.</b>${s.valid < 1 ? ' The rest is not observed.' : ''}`]);
  li.push([conf === 'high' ? '' : conf === 'medium' ? 'q' : 'minus', `<b>Data confidence: ${conf}.</b> ${why} This is about the radar reading under the piece, not about whether the rank is right.`]);
  $('#why').innerHTML = li.map(([k, h]) => `<li class="${k}">${h}</li>`).join('');
  $('#repBtn').onclick = () => printReport(s, { c, map, fmtRate, fmtUn, y });
}

// ------------------------------------------------------------------ panel: frontier (Chennai)
function renderFrontier() {
  const c = S.cur, ch = S.val.chennai, n = ch.noise, p = $('#panel');
  p.innerHTML = `<h2>Chennai: not detectable yet</h2>
    <p class="lede">The frontier case. NASA's ready-made OPERA displacement history covers North and Central America only. Here StrainWatch has only NISAR, and only ${n[0].months.toFixed(1)} months of it. It does not rank lines on this site, because it would be ranking noise.</p>
    <div class="card"><div class="verdict" style="color:var(--bad)">Smallest detectable rate today: about ${n[0].mdr_now.toFixed(0)} mm a year</div>
      <p>Published sinking rates for Chennai are <b>15 to 32 mm a year</b>, from other teams' multi-year Sentinel-1 studies. The NISAR noise floor after ${n[0].n_pairs} pairs is about <b>${n[0].sigma_cum.toFixed(1)} mm</b>, so nothing on this map is a measurement of sinking.</p>
      <table class="kv">${ch.months_to_detect.map((m) => `<tr><td>Track ${m.track}: months of record to detect ${m.rate} mm/yr</td><td>${m.fixed} (noise flat) · ${m.random_walk} (noise adds up)</td></tr>`).join('')}</table></div>
    <div class="card"><h3>When will it be detectable?</h3><div class="chart" id="mdr"></div><p class="fine">Smallest detectable rate = twice the noise, divided by the length of the record. The two curves bracket what longer records usually deliver.</p></div>
    <div class="card"><h3>Kodungaiyur: a candidate, not a finding</h3><p>Both tracks read negative at the published hotspot (${ch.points.filter((x) => x.name === 'Kodungaiyur').map((x) => `track ${x.track}: ${x.cum} mm`).join(', ')}). The sign holds across 22 processing variants. But the ring 1 to 3 km around it reads much the same, so the signal is not specific to that point, and the strongest cell sits on a waste yard where the surface is being dug away.</p></div>
    <div class="card"><h3>Published hotspots and stable points, track 149</h3><table class="kv">${ch.points.filter((x) => x.track === '149').map((x) => `<tr><td>${esc(x.name)} <span style="color:var(--muted)">${x.kind}</span></td><td>${x.cum} mm ${Math.abs(x.snr) < 2 ? '<span class="tag">noise</span>' : '<span class="tag bad">2σ+</span>'}</td></tr>`).join('')}</table></div>`;
  charts.mdrChart($('#mdr'), n, ch.published, { W: 380, H: 250 });
}

// ------------------------------------------------------------------ panel: planner
function setRoute(plan) {
  clearMarkers(S.planMarks || (S.planMarks = []));
  if (!map || !map.getSource('route')) return;
  map.getSource('route').setData(plan ? fcLines([plan.stops.map((s) => s.center)]) : fcLines([]));
  (plan ? plan.stops : []).forEach((st) => {
    const d = el('div', { class: 'stopmark', title: st.names.slice(0, 2).join(', ') }, String(st.order));
    d.onclick = (e) => { e.stopPropagation(); select(st.top); };
    S.planMarks.push(new maplibregl.Marker({ element: d }).setLngLat(st.center).addTo(map));
  });
}

function renderPlanner() {
  const c = S.cur, p = $('#panel'), o = S.planOpts;
  if (!o.groups) o.groups = new Set(c.groups.map((g) => g.id).concat(c.mine.length ? ['mine'] : []));
  const groups = c.groups.concat(c.mine.length ? [{ id: 'mine', label: 'Your lines' }] : []);
  p.innerHTML = `<button class="back" id="back">← All pieces</button><h2>Inspection Planner</h2>
    <p class="lede">Turns the ranking into a short list of inspection candidates: the most uneven pieces (top 5% only), up to eight per stop, ordered from each stop to the nearest next one in straight lines. It does not know roads or driving time. A plain algorithm, shown step by step.</p>
    <div class="pl-step"><span class="stepno">1</span>What are you responsible for?</div><div class="opts" id="pg">${groups.map((g) => `<button data-g="${g.id}" aria-pressed="${o.groups.has(g.id)}">${esc(g.label)}</button>`).join('')}</div>
    <div class="pl-step"><span class="stepno">2</span>How many stops can the crew make?</div><div class="opts" id="ps">${[5, 10, 15, 25].map((n) => `<button data-n="${n}" aria-pressed="${o.stops === n}">${n} stops</button>`).join('')}</div>
    <div class="pl-step"><span class="stepno">3</span>Strategy</div><div class="opts" id="pk"><button data-k="0" aria-pressed="${!o.skipKnown}">Most uneven first</button><button data-k="1" aria-pressed="${o.skipKnown}" ${c.fis ? '' : 'disabled'} title="Leave out pieces within 250 m of a fissure that is already on the state map">New ground only</button></div>
    <div style="height:14px"></div><button class="btn teal wide" id="go">Plan the inspection</button>
    <div class="log" id="plog"></div><div id="pout"></div>`;
  $('#back').onclick = () => { S.view = 'list'; renderAll(); };
  p.querySelectorAll('#pg button').forEach((b) => (b.onclick = () => { o.groups.has(b.dataset.g) ? o.groups.delete(b.dataset.g) : o.groups.add(b.dataset.g); renderPlanner(); }));
  p.querySelectorAll('#ps button').forEach((b) => (b.onclick = () => { o.stops = +b.dataset.n; renderPlanner(); }));
  p.querySelectorAll('#pk button').forEach((b) => (b.onclick = () => { o.skipKnown = b.dataset.k === '1'; renderPlanner(); }));
  $('#go').onclick = runPlan;
  if (S.plan) showPlan(false); else $('#pout').innerHTML = '<div class="tip"><b style="color:#fff">Start here.</b> Press <b style="color:#fff">Plan the inspection</b>, then change the line types or the number of stops and run it again.</div>';
}

function runPlan() {
  const c = S.cur, o = S.planOpts;
  const pool = c.segs.filter((s) => o.groups.has(s.g));
  S.plan = planStops(pool, { stops: o.stops, skipKnown: o.skipKnown ? 250 : 0 });
  planRun++;
  showPlan(true);
}

function showPlan(animate) {
  const plan = S.plan, log = $('#plog'), out = $('#pout'), run = planRun, site = S.cur;
  if (!log || !out) return;
  log.innerHTML = ''; out.innerHTML = '';
  const live = () => S.view === 'planner' && S.plan === plan && run === planRun && S.cur === site && log.isConnected;
  const finish = () => {
    if (!live()) return;
    if (!plan.stops.length) { out.innerHTML = '<div class="empty">No pieces qualify with these choices.</div>'; setRoute(null); return; }
    setRoute(plan);
    out.innerHTML = `<div class="kicker teal">The route · ${plan.stops.length} stops</div>` + plan.stops.map((st) => `<button class="row" data-o="${st.order}"><span class="rk">${st.order}</span><span><span class="nm">${esc(st.names.slice(0, 2).join(', '))}</span><span class="sb">${st.segs.length} piece${st.segs.length > 1 ? 's' : ''} · ${st.km.toFixed(1)} km to check</span></span><span class="vd c-${st.top.cls}">${f1(st.top.uneven)} <small>mm/yr per km</small><small>${fmtRate(st.top.rate)}</small></span></button>`).join('')
      + (S.cur.fis ? (() => { const k = plan.stops.filter((st) => st.top.fisDist <= 500).length, m = plan.stops.filter((st) => !(st.top.fisDist <= 2000)).length; return `<div class="meta" style="margin-top:8px"><b style="color:var(--ink)">Beside the known-fissure map:</b> ${k} of these ${plan.stops.length} stops lie within 500 m of a fissure the state has already mapped; ${m} have none within 2 km. Known fissures were the best single guide in our test. What the radar adds is the stops that map would not send anyone to.</div>`; })() : '')
      + '<div class="btnrow"><button class="btn teal" id="ppkg">Print the stop sheets</button><button class="btn ghost" id="pcsv">CSV</button><button class="btn ghost" id="pgeo">GeoJSON</button></div><p class="fine" style="font-size:11.5px;color:var(--muted);margin-top:8px">Distances are straight lines between stops. Check the list against local knowledge before sending a crew.</p>';
    out.querySelectorAll('.row').forEach((b) => (b.onclick = () => select(plan.stops[+b.dataset.o - 1].top)));
    const flat = plan.stops.flatMap((st) => st.segs.map((s) => ({ ...s, stop: st.order })));
    $('#ppkg').onclick = () => printPlan(plan, { c: S.cur, map, fmtRate, fmtUn });
    $('#pcsv').onclick = () => download(`strainwatch_${S.cur.site.id}_inspection_plan.csv`, toCSV(flat, S.cur.site), 'text/csv');
    $('#pgeo').onclick = () => download(`strainwatch_${S.cur.site.id}_inspection_plan.geojson`, toGeoJSON(flat, S.cur.site), 'application/geo+json');
    const b = new maplibregl.LngLatBounds(); plan.stops.forEach((st) => b.extend(st.center));
    map.fitBounds(b, { padding: 70, maxZoom: 12.5, duration: 800 });
  };
  plan.log.forEach((l, i) => setTimeout(() => { if (!live()) return; log.appendChild(el('div', {}, `<b>${l.step}</b>${l.text}`)); if (i === plan.log.length - 1) finish(); }, animate ? 320 * i : 0));
}

// ------------------------------------------------------------------ draw and upload
function startDraw() {
  S.draw = { pts: [] };
  $('#drawBtn').setAttribute('aria-pressed', 'true');
  map.doubleClickZoom.disable(); map.getCanvas().style.cursor = 'crosshair';
  renderDraw();
}
function renderDraw() {
  const h = $('#drawhint'), d = S.draw;
  if (!d) { h.hidden = true; map.getSource('draw').setData(fcLines([])); return; }
  const km = d.pts.length > 1 ? lineLength(d.pts) / 1000 : 0;
  h.hidden = false;
  h.innerHTML = d.pts.length < 2 ? `Click along your road, pipeline or canal. ${d.pts.length ? 'One more point at least.' : ''} <button id="dc">Cancel</button>` : `${d.pts.length} points · ${km.toFixed(1)} km <button id="df">Finish and rank</button><button id="du">Undo</button><button id="dc">Cancel</button>`;
  $('#dc').onclick = cancelDraw;
  if ($('#df')) $('#df').onclick = finishDraw;
  if ($('#du')) $('#du').onclick = () => { d.pts.pop(); renderDraw(); };
  const fc = d.pts.length > 1 ? fcLines([d.pts]) : fcLines([]);
  d.pts.forEach((p) => fc.features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
  map.getSource('draw').setData(fc);
}
function cancelDraw() { S.draw = null; $('#drawBtn').setAttribute('aria-pressed', 'false'); map.doubleClickZoom.enable(); map.getCanvas().style.cursor = ''; renderDraw(); }
function finishDraw() {
  const pts = S.draw ? S.draw.pts.slice() : [];
  cancelDraw();
  if (pts.length < 2 || lineLength(pts) < 30) { toast('That line is too short to rank. Click at least two points.'); return; }
  addMine([{ name: `Your line ${++drawN}`, coords: pts }]);
}

export async function addMine(lines) {
  lines = lines.filter((l) => l.coords.length >= 2 && lineLength(l.coords) >= 30);
  if (!lines.length) { toast('That line is too short to rank.'); return 0; }
  let c = S.cur;
  const touches = (cc) => cc && cc.R.rate && lines.some((l) => l.coords.some((p) => cc.R.rate.inside(p[0], p[1])));
  if (!touches(c)) {
    const hit = S.sites.find((s) => !s.frontier && lines.some((l) => l.coords.some((p) => inBox(s.bbox, p))));
    if (!hit) { toast(noFrameMsg(lines[0].coords[0]).replace(/<[^>]+>/g, '')); return 0; }
    c = await setSite(hit.id, { keepView: true });
    if (!touches(c)) { toast(`None of that falls inside the ${hit.name} radar frame.`); return 0; }
  }
  const inFrame = lines.filter((l) => l.coords.some((p) => c.R.rate.inside(p[0], p[1])));
  const out = [];
  inFrame.forEach((l, i) => { l.id = c.mine.length + i; l.name = l.name || `Your line ${++drawN}`; });
  scoreGroup(c, 'mine', 'mine', inFrame, out);
  if (!out.length) { toast('Nothing to rank on that line.'); return 0; }
  c.mine.push(...inFrame);
  c.segs = rankSegments(c.segs.concat(out));
  S.filter.groups = new Set(['mine']); S.filter.cls = 'all'; S.filter.odd = false; S.filter.q = ''; $('#search').value = '';
  S.view = 'list'; S.sel = null; S.shown = 40;
  renderAll();
  const b = new maplibregl.LngLatBounds(); out.forEach((s) => s.coords.forEach((p) => b.extend(p)));
  map.fitBounds(b, { padding: 80, maxZoom: 13.5, duration: 700 });
  const sm = summarize(out);
  toast(`${out.length} pieces ranked: ${sm.first.n} inspect first, ${sm.watch.n} watch, ${sm.nodata.n} not observed.`);
  if (out.length > 1) select(out.slice().sort((a, b2) => (a.rank ?? 1e9) - (b2.rank ?? 1e9))[0], { fly: false });
  return out.length;
}

function onFile(ev) {
  const f = ev.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const lines = linesFromGeoJSON(JSON.parse(rd.result));
      if (!lines.length) throw new Error('no lines');
      if (lines.length > 3000) { toast('That file has more than 3,000 lines. Upload a smaller selection.'); return; }
      lines.forEach((l, i) => { l.name = l.name || `${f.name.replace(/\.[^.]+$/, '')} ${i + 1}`; });
      addMine(lines);
    } catch (e) { toast('Could not read that file. It needs to be GeoJSON with LineString features in longitude and latitude.'); }
    ev.target.value = '';
  };
  rd.readAsText(f);
}

let toastT;
function toast(msg, ms = 5200, big = false) { const t = $('#toast'); t.textContent = msg; t.classList.toggle('big', big); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }


// ------------------------------------------------------------------ who uses it: three people, three questions
export const ROLES = [
  { id: 'roads', who: 'County road engineer', q: 'Which roads does the crew check first?', gets: 'A ranked list of road pieces, a short list of inspection stops and a one-page sheet for each.', groups: ['roads'], noun: 'road' },
  { id: 'lines', who: 'Pipeline, canal, rail or power-line operator', q: 'Where along my line is the ground bending it?', gets: 'The pieces of your own line in order, a profile along it, and a file for your GIS.', groups: ['pipeline', 'canal', 'rail', 'power', 'metro'], noun: 'line' },
  { id: 'survey', who: 'State geological survey', q: 'Where do we map fissures next?', gets: 'The most uneven ground that has no mapped fissure nearby, grouped into field stops.', groups: null, noun: 'line', plan: true },
];

function roleNational(id) {
  const k = S.exposure && S.exposure.kinds; if (!k) return '';
  const v = (x) => k[x] || { km: 0, first_km: 0 };
  if (id === 'roads') return `Across all places: ${f0(v('road').km)} km of road scored, ${f0(v('road').first_km)} km flagged.`;
  if (id === 'lines') return `Across all places: ${f0(v('pipeline').km)} km of pipeline, ${f0(v('rail').km)} km of rail, ${f0(v('canal').km)} km of canal and ${f0(v('power').km)} km of power line scored; ${f0(v('pipeline').first_km + v('rail').first_km + v('canal').first_km + v('power').first_km)} km flagged.`;
  return '';
}
function roleCards(cls = '') {
  return `<div class="roles ${cls}">${ROLES.map((r) => `<button class="role${S.role === r.id ? ' on' : ''}" data-role="${r.id}"><b>${r.who}</b><span class="q">${r.q}</span><span class="g">${r.gets} ${roleNational(r.id)}</span></button>`).join('')}</div>`;
}
function wireRoles(root) { root.querySelectorAll('[data-role]').forEach((b) => (b.onclick = () => pickRole(b.dataset.role))); }

async function pickRole(id) {
  const r = ROLES.find((x) => x.id === id); if (!r) return;
  S.role = id;
  if (S.mode === 'story') { await enterExplore('willcox'); }
  let c = S.cur;
  if (!c || c.site.frontier) c = await setSite('willcox');
  const have = c.groups.map((g) => g.id);
  const want = r.groups ? r.groups.filter((g) => have.includes(g)) : have;
  S.filter.groups = new Set((want.length ? want : have).concat(c.mine.length ? ['mine'] : []));
  S.filter.cls = 'all'; S.filter.odd = false; S.sel = null; S.shown = 40;
  if (r.plan) { S.planOpts.groups = new Set(have); S.planOpts.skipKnown = !!c.fis; S.view = 'planner'; renderAll(); runPlan(); }
  else { S.view = 'list'; renderAll(); }
  if (r.groups && !want.length) toast(`${c.site.name} has no ${r.noun === 'road' ? 'roads' : 'lines of that kind'} loaded, so everything is shown.`);
}

// ------------------------------------------------------------------ world view: every place on one map
function noFrameMsg(p) {
  const americas = p[0] > -170 && p[0] < -50 && p[1] > 5 && p[1] < 72;
  return americas
    ? '<b>No data here yet. That does not mean it is safe.</b> NASA publishes the radar history for North and Central America, so this ground can be added the same way as the others. Until then it is simply not measured.'
    : '<b>No data here yet. That does not mean it is safe.</b> Outside North and Central America there is no ready-made radar history; StrainWatch has only the newer NISAR satellite, whose record is about a year old. The Chennai panel shows what that allows today.';
}

// ---- ground truth, per place: validated in depth / GPS agrees / GPS weak / nothing to check against
const TRUTH_COL = { validated: '#147d6c', agree: '#2f9c86', weak: '#c9701f', none: '#8a8578', frontier: '#8f7fb0' };
const ROLE_WORD = { agree: 'Measured, agrees with GPS', weak: 'Measured, agrees only weakly with GPS', none: 'Measured, nothing on the ground to check against' };
const roleLabel = (s) => (s.tier === 'measured' ? ROLE_WORD[truthV(s)] || s.role : s.role);
const TRUTH_WORD = { validated: 'checked in depth', agree: 'GPS agrees', weak: 'GPS: weak agreement', none: 'not checked against ground truth', frontier: 'NISAR only' };
const truthV = (s) => (s.frontier ? 'frontier' : (s.truth && s.truth.verdict) || 'none');
const truthCount = (k) => S.sites.filter((s) => truthV(s) === k).length;

function truthLine(s) {
  const t = s.truth || {}, v = truthV(s);
  if (v === 'validated') return `<b>Checked in depth against ground truth.</b> ${esc(t.note || '')}.`;
  if (v === 'frontier') return '';
  if (v === 'none') return '<b>Not checked against ground truth.</b> No GPS station with enough data lies inside this window, so this place is satellite only. Rates are relative to the steadiest ground in the window and may understate sinking where the whole window is going down. The unevenness score does not depend on that.';
  const thin = t.n < 3 ? ` Only ${t.n} station${t.n === 1 ? '' : 's'}, so this is a thin check.` : '';
  const tied = t.tied ? ` The map is tied to those stations: before the tie the radar's relative rates read ${f1(Math.abs(t.offset))} mm/yr ${t.offset > 0 ? 'slower' : 'faster'} than GPS.` : '';
  if (v === 'agree') return `<b>Checked against GPS: agrees.</b> ${t.n} station${t.n === 1 ? '' : 's'} inside this window; typical difference ${f1(t.misfit)} mm/yr${t.r != null ? `, r = ${t.r.toFixed(2)}` : ''}.${tied}${thin}`;
  return `<b>Checked against GPS: weak agreement.</b> ${t.n} station${t.n === 1 ? '' : 's'} inside this window; typical difference ${f1(t.misfit)} mm/yr against a fastest GPS rate of ${f1(t.gps_fastest)}. Treat the rates here with caution.${t.n < 3 ? ` With only ${t.n} station${t.n === 1 ? '' : 's'} the gap may be the radar's relative reference (it measures against the steadiest ground in the window) and not an error, but that cannot be told apart here.` : ''}`;
}

function truthCard(c) {
  const t = c.site.truth || {}, v = truthV(c.site);
  if (v === 'validated' || v === 'frontier') return '';
  const sv = t.survey && t.survey.spearman != null ? `<p><b>Arizona survey benchmarks:</b> ${t.survey.n} benchmarks, rank correlation ${t.survey.spearman.toFixed(2)} (${t.survey.spearman >= 0.7 ? 'agrees' : t.survey.spearman >= 0.4 ? 'agrees loosely' : 'weak'}). They average decades, so only the ranking is compared.</p>` : '';
  if (v === 'none') return `<div class="card truth"><h3>Ground truth here <span class="src">nothing to check against</span></h3><p>No GPS station with at least 2.5 years of data inside the radar period lies in this window${t.n_found ? ' on ground the radar could read' : ''}. Nothing on the ground has confirmed these numbers.</p>${sv}</div>`;
  const rows = (t.stations || []).map((g) => `<tr><td>${esc(g.name)} <span style="color:var(--muted)">${g.years} yr</span></td><td>GPS ${f1(g.gps)} · radar ${g.radar == null ? 'no data' : f1(g.radar)}</td></tr>`).join('');
  return `<div class="card truth"><h3>Ground truth here <span class="src">${t.n} GPS station${t.n === 1 ? '' : 's'} · ${v === 'agree' ? 'agrees' : 'weak agreement'}</span></h3>
    <p>${truthLine(c.site)}</p><table class="kv">${rows}</table>
    ${sv}<div class="btnrow"><button class="btn ghost" id="gpsShow">Show the GPS stations on the map</button></div>
    <p class="fine">Vertical rates in mm/yr over the radar period. GPS: Nevada Geodetic Laboratory. Radar is converted from line of sight with one angle, good to about 12%.</p></div>`;
}

const DOT_VIEWS = [['tier', 'Trust level'], ['speed', 'Sinking speed'], ['uneven', 'Unevenness'], ['observed', 'Ground observed'], ['nisar', 'NISAR agreement']];
const NISAR_COL = { strong: '#147d6c', moderate: '#d9a441', weak: '#b5452f', quiet: '#9aa0a6', frontier: '#8f7fb0', none: '#ffffff' };
const NISAR_WORD = { strong: 'NISAR agrees with Sentinel-1', moderate: 'NISAR agrees loosely', weak: 'NISAR does not agree yet', quiet: 'too quiet to compare', frontier: 'NISAR only: not detectable yet', none: 'NISAR not processed yet' };
const UN_BREAKS = [2, 5, 10, 20, 40], OBS_BREAKS = [0.25, 0.5, 0.75, 0.9], OBS_COLS = ['#5f6670', '#9aa0a6', '#cfd3d6', '#9fd3c7', '#147d6c'];
const nisV = (s) => (s.nisar && s.nisar.verdict) || 'none';
const stepCol = (v, breaks, cols) => { let i = 0; while (i < breaks.length && v >= breaks[i]) i++; return cols[i]; };

function dotColor(s) {
  const by = S.dotBy;
  if (by === 'nisar') return NISAR_COL[nisV(s)];
  if (s.frontier) return '#8f7fb0';
  if (by === 'speed') return stepCol(-s.summary.fast_mmyr, OV_BREAKS, ['#fbf3e8', ...RATE_COLS]);
  if (by === 'uneven') return stepCol(s.uneven_q[190], UN_BREAKS, ['#f1f4f9', ...UN_COLS]);
  if (by === 'observed') return stepCol(s.summary.valid_share, OBS_BREAKS, OBS_COLS);
  return TRUTH_COL[truthV(s)];
}

function siteStat(s) {
  if (S.dotBy === 'nisar') return NISAR_WORD[nisV(s)] + (s.nisar && s.nisar.r != null && nisV(s) !== 'quiet' ? ` (r = ${s.nisar.r.toFixed(2)})` : '');
  if (s.frontier) return 'not detectable yet';
  if (S.dotBy === 'uneven') return `top 5% starts at ${f1(s.uneven_q[190])} mm/yr per km`;
  if (S.dotBy === 'observed') return `${Math.round(s.summary.valid_share * 100)}% of the ground observed`;
  return `about ${f0(-s.summary.fast_mmyr)} mm/yr at its fastest`;
}

function worldLegend() {
  const ramp = (cols, ticks) => `<div class="ramp">${cols.map((x) => `<i style="background:${x}"></i>`).join('')}</div><div class="ticks">${ticks.map((v) => `<span>${v}</span>`).join('')}</div>`;
  const key = (col, text) => `<span><i class="dotkey" style="background:${col}"></i>${text}</span>`;
  const tkey = (v, text) => `<span><i class="dotkey" style="background:${v === 'validated' ? TRUTH_COL[v] : '#fff'};border:2px ${v === 'none' ? 'dashed' : 'solid'} ${TRUTH_COL[v]}"></i>${text}</span>`;
  let h;
  if (S.dotBy === 'speed') h = `<b>Markers: fastest ground at each place · mm/yr</b>${ramp(['#fbf3e8', ...RATE_COLS], ['0', ...OV_BREAKS])}`;
  else if (S.dotBy === 'uneven') h = `<b>Markers: where the top 5% of unevenness starts · mm/yr per km</b>${ramp(['#f1f4f9', ...UN_COLS], ['0', ...UN_BREAKS])}<div class="note">Low values mean nothing stands out there.</div>`;
  else if (S.dotBy === 'observed') h = `<b>Markers: share of the ground the radar could read</b>${ramp(OBS_COLS, ['0', '25%', '50%', '75%', '90%'])}<div class="note">Grey places are mostly farm fields, forest or water for Sentinel-1.</div>`;
  else if (S.dotBy === 'nisar') h = `<b>Markers: does a year of NISAR match Sentinel-1?</b><div class="keys" style="grid-template-columns:1fr">${key(NISAR_COL.strong, 'Agrees (r 0.75 or more)')}${key(NISAR_COL.moderate, 'Agrees loosely')}${key(NISAR_COL.weak, 'Does not agree yet')}${key(NISAR_COL.quiet, 'Ground too quiet to compare')}${key(NISAR_COL.frontier, 'NISAR is the only source')}${key(NISAR_COL.none, 'Not processed yet')}</div>`;
  else h = `<b>Markers: how far each place is proven</b><div class="keys" style="grid-template-columns:1fr">${tkey('validated', `Checked in depth (${truthCount('validated')})`)}${tkey('agree', `Checked against GPS: agrees (${truthCount('agree')})`)}${tkey('weak', `Checked against GPS: weak (${truthCount('weak')})`)}${tkey('none', `Nothing to check against (${truthCount('none')})`)}${tkey('frontier', 'NISAR only: not detectable yet')}</div>`;
  return h + '<div class="note">Bigger square = faster sinking. Tinted states have at least one processed place; click a state name to list them. Dashed boxes are the processed windows. Everywhere else is <b style="display:inline">not processed yet</b>, which is not the same as stable.</div>';
}

const isWeak = (s) => !!(s.uneven_q && s.uneven_q[190] < 5);
const clsLabel = (cls) => (cls === 'first' && S.cur && isWeak(S.cur.site) ? 'Highest here (weak signal)' : CLASS_LABEL[cls]);

function siteCaveat(c) {
  const s = c.site, out = [];
  if (s.tier === 'measured') out.push(truthLine(s));
  if (s.summary.valid_share < 0.5) out.push(`<b>Mostly unobserved.</b> Only ${Math.round(s.summary.valid_share * 100)}% of this window kept a usable Sentinel-1 signal; farm fields, forest and water lose it. Most lines here are listed as not observed.`);
  if (s.uneven_q && s.uneven_q[190] < 5) out.push(`<b>Very weak signal.</b> The top 5% starts at only ${f1(s.uneven_q[190])} mm/yr per km here (44 at Willcox). At this level the order is close to radar noise: read this place as "nothing stands out", not as a work list.`);
  else if (s.uneven_q && s.uneven_q[190] < 10) out.push(`<b>Weak signal.</b> The top 5% starts at only ${f1(s.uneven_q[190])} mm/yr per km here (44 at Willcox). Read the order as a relative rank; it has not been tested against fissures at this place.`);
  return out.length ? `<div class="meta warn">${out.join('<br>')}</div>` : '';
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ym = (d) => `${MON[+d.slice(4, 6) - 1]} ${d.slice(0, 4)}`;

// what NISAR adds at this place, in plain words, whether the news is good or not
function nisarCard(c) {
  const n = c.site.nisar, v = nisV(c.site);
  if (v === 'none') return '<div class="card nisar"><h3>NISAR here <span class="src">not processed yet</span></h3><p class="fine">The Sentinel-1 history is loaded for this place; its NISAR pairs have not been stacked yet.</p></div>';
  const r = n.r != null ? `r = ${n.r.toFixed(2)}${n.n ? ` over ${f0(n.n)} pixels` : ''}` : '';
  const body = {
    strong: `<b>NISAR agrees with Sentinel-1 here</b> (${r}). One year of NISAR reproduces the ten-year map, which suggests the watch could carry on with NISAR once the Sentinel-1 record ends.`,
    moderate: `<b>NISAR agrees loosely here</b> (${r}). The broad pattern is there; the detail is not, yet.`,
    weak: `<b>NISAR does not match Sentinel-1 here yet</b> (${r}). At this place read the NISAR layer as noise.`,
    quiet: `<b>Too little motion to compare.</b> Sentinel-1 rates differ by only about ±${f1(n.s1_spread ?? 0)} mm/yr across this window, no more than NISAR's own one-year noise, so a correlation would mean nothing${n.r != null ? ` (it comes out at ${n.r.toFixed(2)})` : ''}.`,
  }[v] || '';
  const cover = n.cover_nisar != null ? `<tr><td>Ground with a usable signal</td><td>NISAR ${Math.round(n.cover_nisar * 100)}% · Sentinel-1 ${Math.round(n.cover_s1 * 100)}%</td></tr>` : '';
  const noise = n.noise_mmyr != null ? `<tr><td>NISAR scatter on steady ground, one year</td><td>±${f1(n.noise_mmyr)} mm/yr</td></tr><tr><td>So NISAR can confirm sinking faster than about</td><td>${f0(Math.max(1, 2 * n.noise_mmyr))} mm/yr</td></tr>` : '';
  return `<div class="card nisar"><h3>NISAR, the newer radar satellite, here <span class="src">${n.pairs} pairs · ${ym(n.first)} to ${ym(n.last)}</span></h3><p>${body}${n.note ? ' ' + n.note : ''}</p>
    <table class="kv">${cover}${noise}</table>
    <div class="btnrow"><button class="btn ghost" id="nisCmp">Compare NISAR with Sentinel-1</button><button class="btn ghost" id="nisOnly">Show NISAR</button></div>
    <p class="fine">NISAR products are provisional. The two usable-signal figures use different masks, so read them as an indication.</p></div>`;
}

function buildSiteMarks() {
  S.sites.forEach((s, i) => {
    const pos = { phoenix_west: 'left up', phoenix_east: 'up', pinal: 'left down', willcox: 'down', mexico: 'left' }[s.id] ?? ['', 'left', 'up', 'left down'][i % 4];
    const dot = s.frontier ? 12 : Math.round(Math.max(9, Math.min(20, 6 + 1.4 * Math.sqrt(-s.summary.fast_mmyr)))); // bigger dot = faster sinking
    const d = el('div', { class: `sitemark t-${s.tier} ${pos}` }, `<i style="width:${dot}px;height:${dot}px"></i><span></span>`);
    d.onclick = (e) => { e.stopPropagation(); if (S.mode === 'story') enterExplore(s.id); else setSite(s.id); };
    siteMarks.push({ s, d, m: new maplibregl.Marker({ element: d, anchor: 'center' }).setLngLat(s.center).addTo(map) });
  });
  map.getSource('boxes').setData({ type: 'FeatureCollection', features: S.sites.map((s) => { const b = s.bbox; return { type: 'Feature', properties: { tier: s.tier }, geometry: { type: 'LineString', coordinates: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]] } }; }) });
  paintSiteMarks();
}
// State outlines, names and a count of processed places, so the national map reads state by state
async function buildStates() {
  let gj;
  try { gj = await getJSON('us_states.json'); } catch (e) { return; }
  const count = {};
  S.sites.forEach((s) => { if (s.st) count[s.st] = (count[s.st] || 0) + 1; });
  gj.features.forEach((f) => { f.properties.n = count[f.properties.st] || 0; });
  map.getSource('states').setData(gj);
  S.states = gj.features.map((f) => f.properties);
  gj.features.forEach((f) => {
    const p = f.properties;
    const d = el('div', { class: 'statemark' + (p.n ? ' has' : ''), title: `${p.name}: ${p.n ? p.n + (p.n === 1 ? ' place' : ' places') + ' processed' : 'not processed yet'}` }, `<b>${p.st}</b><span>${esc(p.name)}</span><i>${p.n || ''}</i>`);
    d.onclick = (e) => { e.stopPropagation(); if (S.mode === 'story') return; pickState(p, f); };
    new maplibregl.Marker({ element: d, anchor: 'center' }).setLngLat([p.lon, p.lat]).addTo(map);
  });
}
function pickState(p, f) {
  const b = new maplibregl.LngLatBounds();
  const walk = (c) => (typeof c[0] === 'number' ? b.extend(c) : c.forEach(walk));
  walk(f.geometry.coordinates);
  if (S.cur) goWorld({ keepView: true });
  S.placeQ = p.name;
  renderWorld();
  const pq = $('#placeQ'), pn2 = $('#panel'); if (pq && pn2) pn2.scrollTop = Math.max(0, pq.offsetTop - 60);
  map.fitBounds(b, { padding: 50, maxZoom: 7.2, duration: 900 });
  toast(p.n ? `${p.name}: ${p.n} ${p.n === 1 ? 'place' : 'places'} processed. The rest of the state is not processed yet.` : `${p.name}: no place processed yet. That is not the same as stable.`);
}

function paintSiteMarks() {
  siteMarks.forEach(({ s, d }) => {
    const i = d.querySelector('i'), col = dotColor(s), v = truthV(s);
    if (S.dotBy === 'tier') { i.style.background = v === 'validated' ? col : '#fff'; i.style.borderColor = col; i.style.borderStyle = v === 'none' ? 'dashed' : 'solid'; }
    else { i.style.background = col; i.style.borderColor = '#57534a'; i.style.borderStyle = 'solid'; }
    d.title = `${s.name}: ${siteStat(s)}`;
    d.querySelector('span').innerHTML = `<b>${esc(s.name)}</b>${esc(siteStat(s))}`;
  });
}

function zoomClasses() {
  const z = map.getZoom(), k = map.getContainer().classList;
  k.toggle('z-far', z < 7.3); k.toggle('z-mid', z >= 5.6 && z < 7.3); k.toggle('z-state', z >= 2.8 && z < 7.3); k.toggle('z-statename', z >= 4.6 && z < 7.3);
}

// One low-key rate layer per place, loaded only when that place is on screen and you are close enough to see it.
// With more than a hundred places, loading them all at the start would cost about 50 MB.
function syncOverview() {
  if (!map || !S.sites.length) return;
  const z = map.getZoom(), b = map.getBounds();
  const view = [b.getWest() - 0.3, b.getSouth() - 0.3, b.getEast() + 0.3, b.getNorth() + 0.3];
  for (const s of S.sites) {
    const active = S.cur && S.cur.site.id === s.id;
    const near = z >= 5.6 && !(s.bbox[2] < view[0] || s.bbox[0] > view[2] || s.bbox[3] < view[1] || s.bbox[1] > view[3]);
    let gl = ov.get(s.id);
    if (!near || active) { if (gl) gl.hide(); continue; }
    if (gl) { gl.show(); continue; }
    const key = s.layers.rate ? 'rate' : 't149';
    gl = new RasterGL('ov-' + s.id, 0.86);
    ov.set(s.id, gl);
    map.addLayer(gl, 'rasA');
    getRaster(s.layers[key]).then((r) => {
      const c = RATE_COLS.map((h) => hex(h)), bk = OV_BREAKS, up = hex('#c9dcef', 200);
      const fn = key === 'rate' ? (v) => { const q = -v; return q < -bk[0] ? up : q < bk[0] ? null : q < bk[1] ? c[0] : q < bk[2] ? c[1] : q < bk[3] ? c[2] : q < bk[4] ? c[3] : q < bk[5] ? c[4] : c[5]; } : painter(s, key);
      gl.setImage('ov:' + s.id, r.paint(new Uint8ClampedArray(r.w * r.h * 4), fn), r.w, r.h, mercBox(r));
      if (S.cur && S.cur.site.id === s.id) gl.hide();
    });
  }
}

function setBase(k) {
  S.base = k;
  map.setLayoutProperty('sat', 'visibility', k === 'satellite' ? 'visible' : 'none');
  map.setLayoutProperty('hill', 'visibility', k === 'terrain' ? 'visible' : 'none');
  document.querySelectorAll('#baseSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.base === k)));
}

function goWorld(opts = {}) {
  siteTok++;
  S.cur = null; S.view = 'world'; S.sel = null; S.compare = null; S.plan = null;
  if (S.draw) cancelDraw();
  renderAll();
  if (!opts.keepView) {
    const b = new maplibregl.LngLatBounds();
    S.sites.filter((s) => !s.frontier).forEach((s) => b.extend(s.center));
    map.fitBounds(b, { padding: { top: 90, bottom: 60, left: 60, right: 60 }, maxZoom: 5, duration: 1200 });
  }
  if (S.mode === 'explore') history.replaceState(null, '', '#explore');
}

// zooming into a place opens it; zooming far out returns to the list of places
function autoSite() {
  if (S.mode !== 'explore' || S.draw || Date.now() < (S.flyUntil || 0)) return; // not while the app itself is flying to a place
  const z = map.getZoom(), ctr = map.getCenter().toArray();
  if (z >= 8) {
    const hit = S.sites.find((s) => inBox(s.bbox, ctr));
    if (hit && (!S.cur || S.cur.site.id !== hit.id)) setSite(hit.id, { keepView: true });
    else if (!hit && S.cur && !S.sel) { const b = S.cur.site.bbox; if (!inBox([b[0] - 1, b[1] - 1, b[2] + 1, b[3] + 1], ctr)) goWorld({ keepView: true }); } // wandered far from the open place
  }
  else if (z < 5.2 && S.cur) goWorld({ keepView: true });
}

// what NISAR adds that Sentinel-1 cannot: ground it can still read
function nisarSummary() {
  const both = S.sites.filter((s) => s.nisar && s.nisar.cover_nisar != null && s.nisar.cover_s1 != null), low = both.filter((s) => s.nisar.cover_s1 < 0.5);
  if (low.length < 3) return 'NISAR coverage figures appear here once more places are stacked.';
  const mean = (a, k) => Math.round((a.reduce((t, s) => t + s.nisar[k], 0) / a.length) * 100);
  const e = S.exposure ? S.exposure.total : null;
  return `${e ? `Sentinel-1 could not read <b>${f0(e.nodata_km)} km (${Math.round((e.nodata_km / e.km) * 100)}%)</b> of the line scored here. ` : ''}At the ${low.length} places where it reads under half the ground, <b>NISAR keeps a usable signal on ${mean(low, 'cover_nisar')}% on average, against ${mean(low, 'cover_s1')}%</b>. The two masks are built differently, and NISAR has not ranked those lines yet: this is where it would add most.`;
}

function exposureCard() {
  const e = S.exposure; if (!e) return '';
  const t = e.total, k = e.kinds, km = (x) => f0((k[x] || {}).km || 0);
  return `<div class="card expo"><div class="big3"><div><b>${f0(t.km)} km</b>of line scored</div><div><b>${f0(t.strong_first_km)} km</b>flagged to look at first</div><div><b>${f0(t.nodata_km)} km</b>not observed</div></div>
    <p class="fine">${km('road')} km of highway and main road, ${km('rail')} km of rail, ${km('pipeline')} km of pipeline, ${km('canal')} km of canal and ${km('power')} km of power line across the ${t.places} places that have rankings (Chennai has none), scored by the same code that runs on this page. "Flagged" counts the ${t.strong_places} places where the unevenness signal is strong enough to mean something; elsewhere nothing stands out.</p></div>`;
}

// A hands-off walk through the whole loop on the validated case, for a first look or a screen recording
let demoRun = 0;
async function runDemo() {
  const run = ++demoRun, wait = (ms) => new Promise((r) => setTimeout(r, ms)), live = () => run === demoRun;
  const say = (t, ms) => toast(t, ms, true);
  if (S.mode === 'story') await enterExplore('willcox'); else await setSite('willcox');
  if (!live()) return;
  say('1 of 4 · A county road engineer opens the Willcox Basin, Arizona.', 9000);
  await pickRole('roads'); await wait(6000); if (!live()) return;
  const top = (S.vis || [])[0];
  if (top) { say('2 of 4 · The top-ranked piece of road: why it ranks here, and how the ground under it has sunk.', 10000); await select(top); await wait(9000); if (!live()) return; }
  say('3 of 4 · The planner turns the list into ten places to send the crew.', 10000);
  S.view = 'planner'; S.sel = null; S.planOpts.groups = new Set(S.filter.groups); S.planOpts.stops = 10; S.planOpts.skipKnown = false; renderAll(); runPlan(); await wait(9000); if (!live()) return;
  const pk = document.getElementById('ppkg'), pn = $('#panel'); if (pk && pn) pn.scrollTo({ top: Math.max(0, pk.offsetTop - pn.clientHeight + 120), behavior: 'smooth' }); // scroll the panel, never the page
  say('4 of 4 · Print the stop sheets, or download the list for your GIS. That is the whole loop.', 12000);
}

function renderWorld() {
  const p = $('#panel'), cov = S.coverage || {};
  const nc = (k) => S.sites.filter((s) => nisV(s) === k).length;
  p.innerHTML = `<div class="kicker teal" style="margin-top:0">Who uses this</div><h2>For whoever decides where the field crew goes first</h2>
    <p class="lede">Pick the job that is closest to yours. It opens the validated Willcox Basin with your lines and your question.</p>${roleCards()}
    <h2 style="margin-top:20px">${S.sites.length} places, one method</h2>
    <p class="lede"><b>${cov.us_places ?? ''} US places in ${cov.us_states ?? ''} of the lower-48 states${cov.dc ? ' and Washington DC' : ''}</b>, plus Mexico and India. Zoom into any marker, or pick one below. The dashed boxes are the windows that have been processed: together about ${cov.us_share != null ? (cov.us_share * 100).toFixed(1) : '?'}% of the lower-48 land area. <b>Everywhere else is not processed yet</b>, which is not the same as stable.</p>
    <p class="lede"><b>Every place was checked against independent ground measurements where any exist:</b> ${truthCount('validated')} in depth, ${truthCount('agree')} agree with GPS stations inside the window, ${truthCount('weak')} agree only weakly, and ${truthCount('none')} have nothing to check against. Each place says which.</p>
    <div class="kicker">Different views of the map</div>
    <div class="chips" id="dotby">${DOT_VIEWS.map(([k, l]) => `<button data-k="${k}" aria-pressed="${S.dotBy === k}">${l}</button>`).join('')}</div>
    <input id="placeQ" type="search" placeholder="Find a place or a state" value="${esc(S.placeQ)}" autocomplete="off">
    <div id="wrows" class="scrollbox"></div>
    ${exposureCard()}
    <div class="card nisar" style="margin-top:6px"><h3>What NISAR does here</h3>
      <p>The ten-year history is Sentinel-1. <b>NISAR</b>, the NASA-ISRO L-band radar flying since 2025, has two jobs: it <b>can carry the watch forward</b> once the Sentinel-1 record ends (shown here on one year of data, not yet a live service), and it is <b>the only source in most of the world</b>. Its strongest result here: at Mexico City one year of NISAR matches ten years of Sentinel-1 at r = 0.94, and reads −279 mm/yr where GPS says −262 to −268.</p>
      <p>${nisarSummary()}</p><p>NISAR pairs from the past year are stacked at <b>${S.sites.length - nc('none') - nc('frontier')} places</b>, plus Chennai. Of the ${nc('strong') + nc('moderate') + nc('weak')} that move enough to compare, NISAR agrees with Sentinel-1 at ${nc('strong')}, loosely at ${nc('moderate')}, not yet at ${nc('weak')}; at ${nc('quiet')} the ground is too quiet to tell${nc('none') ? `, and ${nc('none')} are not processed yet` : ''}. <button class="linkbtn" id="seeNisar">Colour the markers by NISAR agreement</button></p></div>
    <div class="card" style="margin-top:14px"><h3>Everywhere else</h3>
      <p><b>North and Central America.</b> NASA's OPERA project publishes the Sentinel-1 displacement history used here. Any window can be packed with one script in a few minutes; every place outside the three checked in depth was added that way, then compared with GPS.</p>
      <p><b>The rest of the world.</b> There is no ready-made history. NISAR is the source, and its record is about a year old. StrainWatch reports how long until a given sinking rate becomes detectable: see Chennai.</p>
      <p class="fine">Click or draw anywhere without a packed window and the app says so. It never shows unmeasured ground as stable.</p></div>`;
  wireRoles(p);
  const setDot = (k) => { S.dotBy = k; paintSiteMarks(); renderLegend(); p.querySelectorAll('#dotby button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === k))); drawRows(); };
  p.querySelectorAll('#dotby button').forEach((b) => (b.onclick = () => setDot(b.dataset.k)));
  $('#seeNisar').onclick = () => setDot('nisar');
  const drawRows = () => {
    const rows = $('#wrows'), q = S.placeQ.trim().toLowerCase();
    rows.innerHTML = '';
    TIERS.forEach(([k, label]) => {
      let list = S.sites.filter((s) => s.tier === k && (!q || (s.name + ' ' + s.region + ' ' + (s.st || '') + ' ' + ((S.states || []).find((x) => x.st === s.st) || {}).name).toLowerCase().includes(q)));
      if (!list.length) return;
      if (k === 'measured') list = list.slice().sort((a, b) => a.summary.fast_mmyr - b.summary.fast_mmyr);
      rows.appendChild(el('div', { class: 'kicker' + (k === 'checked' ? ' teal' : '') }, `${label} · ${list.length}${k === 'measured' ? ' · fastest first' : ''}`));
      list.forEach((s) => {
        const big = s.frontier ? 'Not yet' : S.dotBy === 'uneven' ? f1(s.uneven_q[190]) : S.dotBy === 'observed' ? Math.round(s.summary.valid_share * 100) + '%' : S.dotBy === 'nisar' ? (s.nisar && s.nisar.r != null ? s.nisar.r.toFixed(2) : '–') : f0(-s.summary.fast_mmyr);
        const small = s.frontier ? 'detectable' : S.dotBy === 'uneven' ? 'mm/yr per km, top 5%' : S.dotBy === 'observed' ? 'of ground observed' : S.dotBy === 'nisar' ? NISAR_WORD[nisV(s)].replace('NISAR ', '') : 'mm/yr, fastest ground';
        const b = el('button', { class: 'row' }, `<span class="rk"><i class="dotkey" style="background:${dotColor(s)}"></i></span><span><span class="nm">${esc(s.name)}</span><span class="sb">${esc(s.region)}${s.check ? ' · ' + esc(s.check) : ''}${s.tier === 'measured' ? ` · <span style="color:${truthV(s) === 'weak' ? 'var(--bad)' : truthV(s) === 'agree' ? 'var(--teal-d)' : 'var(--muted)'};font-weight:600">${TRUTH_WORD[truthV(s)]}${s.truth && s.truth.n ? ` (${s.truth.n})` : ''}</span>` : ''}</span></span><span class="vd ${s.frontier ? 'c-nodata' : ''}">${big}<small>${small}</small></span>`);
        b.onclick = () => setSite(s.id);
        rows.appendChild(b);
      });
    });
    if (!rows.children.length) rows.innerHTML = '<div class="empty">No place matches. Clear the search.</div>';
  };
  $('#placeQ').oninput = (e) => { S.placeQ = e.target.value; drawRows(); };
  drawRows();
}

// ------------------------------------------------------------------ render
function renderPanel() {
  if (S.view === 'frontier') return renderFrontier();
  if (S.view === 'planner') return renderPlanner();
  if (S.view === 'detail' && S.sel) return; // detail renders itself
  renderList();
}
function renderAll() {
  document.body.classList.remove('loading');
  document.body.classList.toggle('world', !S.cur);
  if (!S.cur) { renderTabs(); drawRasters(); drawVectors(); renderLegend(); renderTally(); placeSplitter(); setRoute(null); renderWorld(); $('#plannerBtn').hidden = true; $('#readout').hidden = true; renderBelow(S, { select: () => {}, fmtRate, fmtUn, visible: () => [], roles: ROLES, pickRole: (id) => { window.scrollTo({ top: 0, behavior: 'smooth' }); pickRole(id); } }); return; }
  renderTabs(); renderMapbar(); drawRasters(); drawVectors(); renderLegend(); renderTally(); placeSplitter(); renderPanel();
  if (S.view !== 'planner' && S.view !== 'detail') setRoute(null);
  else if (S.plan) setRoute(S.plan);
  $('#plannerBtn').hidden = !!S.cur.site.frontier;
  renderBelow(S, { select: (s) => { window.scrollTo({ top: 0, behavior: 'smooth' }); select(s); }, fmtRate, fmtUn, visible: () => S.vis, roles: ROLES, pickRole: (id) => { window.scrollTo({ top: 0, behavior: 'smooth' }); pickRole(id); } });
}

// ------------------------------------------------------------------ story
function storyCtx() {
  const V = S.val;
  const bmRow = (n) => V.willcox_benchmarks.rows.find((r) => r.name === n);
  return {
    val: V, exposure: S.exposure, truthCount, nisarSummary, nisarPlaces: () => S.sites.filter((x) => !['none', 'frontier'].includes(nisV(x))).length, site: (id) => S.sites.find((s) => s.id === id), sites: S.sites, coverage: S.coverage || {}, nisarCount: (k) => S.sites.filter((x) => nisV(x) === k).length,
    groupSum: (id, g) => summarize(S.cache.get(id).segs.filter((s) => s.g === g)),
    roles: ROLES,
    missed: (id) => S.cache.get(id).segs.filter((s) => s.cls === 'first' && s.ratePct < 80).length,
    named: (id, name, title) => { const c = S.cache.get(id), s = c && c.segs.find((x) => x.name === name && x.cls !== 'nodata'); return s ? { at: s.mid, title: title || name, sub: `More uneven than ${s.pct >= 99.5 ? 'over 99' : s.pct.toFixed(0)}% of this frame's ground` } : null; },
    bm: (n) => [bmRow(n).lon, bmRow(n).lat], bmv: bmRow,
    gps: (n) => V.mexico_gps.rows.find((r) => r.name === n),
    summary: (id) => summarize(S.cache.get(id).segs),
    metroTop: () => {
      const top = S.cache.get('mexico').segs.slice(0, 30), cnt = {};
      top.forEach((s) => { cnt[s.name] = (cnt[s.name] || 0) + 1; });
      const o = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
      return `${o[0][1]} of the 30 most uneven are on ${o[0][0].replace('Metro ', '')}${o[1] ? `, then ${o[1][0].replace('Metro ', '')}` : ''}`;
    },
    topCallouts: (id, gids) => {
      const segs = S.cache.get(id).segs, out = [], used = [];
      gids.forEach((g, i) => {
        const s = segs.find((x) => x.g === g && x.cls !== 'nodata' && used.every((u) => haversine(u, x.mid) > 2500));
        if (!s) return;
        used.push(s.mid);
        out.push({ at: s.mid, title: s.name, sub: `${fmtUn(s.uneven)} · ${fmtRate(s.rate)}`, side: i % 2 ? 'left' : '', down: i === 2 });
      });
      return out;
    },
  };
}

async function buildStory() {
  await Promise.all([loadSite('willcox'), loadSite('mexico')]);
  const ctx = storyCtx();
  storySteps = buildSteps(ctx);
  const root = $('#story'); root.innerHTML = '';
  storySteps.forEach((st, i) => {
    const body = typeof st.body === 'function' ? st.body(ctx) : st.body;
    const sec = el('section', { class: 'step' + (st.hero ? ' hero' : ''), 'data-i': i }, `<div class="scard">${st.hero ? st.html : `<div class="k">${st.kicker}</div><h2>${st.title}</h2>${body}`}</div>`);
    root.appendChild(sec);
  });
  root.querySelectorAll('[data-act=open]').forEach((b) => (b.onclick = () => enterExplore()));
  root.querySelectorAll('[data-act=demo]').forEach((b) => (b.onclick = () => runDemo()));
  wireRoles(root);
  const io = new IntersectionObserver((ents) => ents.forEach((e) => { if (e.isIntersecting && S.mode === 'story') activateStep(+e.target.dataset.i); }), { rootMargin: '-45% 0px -45% 0px' });
  root.querySelectorAll('.step').forEach((s) => io.observe(s));
  window.addEventListener('scroll', () => { if (S.mode !== 'story') return; const h = document.documentElement; $('#progress i').style.width = (h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)) * 100 + '%'; }, { passive: true });
}

async function activateStep(i) {
  if (i === activeStep) return;
  activeStep = i;
  const v = storySteps[i].view, ctx = storyCtx();
  document.body.classList.toggle('hero-on', !!storySteps[i].hero);
  const c = v.site ? await loadSite(v.site) : null;
  if (activeStep !== i) return;
  const first = i === 0 && !map._swMoved;
  map._swMoved = true;
  S.cur = c; S.sel = null;
  if (c) S.filter = { groups: new Set(c.groups.map((g) => g.id)), cls: 'all', q: '', odd: false };
  S.show = { lines: !!v.lines, fissures: v.fissures || null, points: v.points || null };
  S.compare = null;
  if (!c) { /* world view: only the overview layers */ } else if (v.compare) { await Promise.all(v.compare.map((k) => ensureLayer(c, k))); S.compare = v.compare; S.split = v.split || 0.5; } else { S.layer = v.layer; await ensureLayer(c, v.layer); }
  if (activeStep !== i) return;
  const wide = window.innerWidth > 900;
  const pad = { left: wide ? Math.min(window.innerWidth * 0.42, 620) : 0, right: 0, top: 0, bottom: wide ? 0 : window.innerHeight * 0.4 };
  const cam = { center: v.center, zoom: v.zoom - (wide ? 0 : 0.8), padding: pad };
  if (first) map.jumpTo(cam); else map.flyTo({ ...cam, duration: 1400, essential: true });
  drawRasters(); drawVectors(); renderLegend(); placeSplitter();
  setCallouts(typeof v.callouts === 'function' ? v.callouts(ctx) : v.callouts);
}

function enterStory() {
  S.mode = 'story'; activeStep = -1;
  document.body.classList.add('story');
  window.scrollTo({ top: 0, behavior: 'instant' });
  map.scrollZoom.disable();
  $('#readout').hidden = true;
  if (S.draw) cancelDraw();
  setRoute(null);
  map.resize();
  activateStep(0);
}

async function enterExplore(siteId) {
  S.mode = 'explore'; activeStep = -1;
  document.body.classList.remove('story');
  setCallouts(null);
  window.scrollTo({ top: 0, behavior: 'instant' });
  map.scrollZoom.enable();
  document.body.classList.remove('hero-on');
  map.setPadding({ left: 0, right: 0, top: 0, bottom: 0 });
  S.show = { lines: true, fissures: 'both', points: null };
  S.cur = null;
  map.resize();
  if (siteId && S.sites.some((s) => s.id === siteId)) { map.jumpTo({ center: S.sites.find((s) => s.id === siteId).center, zoom: 8.5 }); await setSite(siteId); } else goWorld();
  map.resize();
  history.replaceState(null, '', '#explore');
}

// ------------------------------------------------------------------ boot
async function boot() {
  const [sites, val] = await Promise.all([getJSON('sites.json'), getJSON('validation.json')]);
  S.sites = sites.sites; S.val = val; S.coverage = sites.coverage;
  try { S.exposure = await getJSON('exposure.json'); } catch (e) { S.exposure = null; }
  $('#built').textContent = 'Data packed ' + sites.built;
  await initMap();
  wireSplitter();
  $('#skip').onclick = () => enterExplore();
  $('#homeBtn').onclick = enterStory;
  $('#demoBtn').onclick = runDemo;
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#demoBtn')) demoRun++; }, true);
  $('#plannerBtn').onclick = () => { S.view = 'planner'; S.sel = null; map.getSource('sel').setData(fcLines([])); renderAll(); };
  $('#compareBtn').onclick = () => S.cur && setCompare(S.compare ? null : compareOptions(S.cur)[0][0]);
  $('#drawBtn').onclick = () => (S.draw ? cancelDraw() : startDraw());
  $('#truthBtn').onclick = () => { S.show.points = S.show.points ? null : truthKind(S.cur); renderMapbar(); drawVectors(); if (S.show.points) toast('Click a dot to compare the radar with the ground measurement there.'); };
  $('#fileIn').onchange = onFile;
  $('#search').oninput = (e) => { if (!S.cur) return; S.filter.q = e.target.value; S.shown = 40; S.view = 'list'; S.sel = null; renderAll(); };
  $('#menuBtn').onclick = (e) => { e.stopPropagation(); const m = $('#menu'); m.hidden = !m.hidden; $('#menuBtn').setAttribute('aria-expanded', String(!m.hidden)); };
  document.addEventListener('click', () => { $('#menu').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (S.draw) cancelDraw(); $('#menu').hidden = true; } if (e.key === 'Enter' && S.draw && S.draw.pts.length > 1) finishDraw(); });
  $('#menu').addEventListener('click', (e) => {
    const a = e.target.closest('a'); if (!a) return;
    const act = a.dataset.act;
    if (act) e.preventDefault();
    if (act === 'story') enterStory();
    if ((act === 'csv' || act === 'geojson') && !S.cur) { toast('Pick a place first: the list is per place.'); return; }
    if (act === 'csv') download(`strainwatch_${S.cur.site.id}_ranked.csv`, toCSV(S.vis || [], S.cur.site), 'text/csv');
    if (act === 'geojson') download(`strainwatch_${S.cur.site.id}_ranked.geojson`, toGeoJSON(S.vis || [], S.cur.site), 'application/geo+json');
  });
  buildSiteMarks();
  buildStates();
  map.on('zoom', zoomClasses); zoomClasses();
  map.on('moveend', () => { syncOverview(); autoSite(); });
  document.querySelectorAll('#baseSeg button').forEach((b) => (b.onclick = () => setBase(b.dataset.base)));
  await buildStory();
  window.__sw = { S, setSite, select, addMine, enterExplore, enterStory, runPlan, setLayer, setCompare, goWorld, pickRole, setBase, runDemo };
  if (location.hash === '#explore' || location.hash.startsWith('#site=')) await enterExplore(location.hash.startsWith('#site=') ? location.hash.slice(6) : undefined);
  else { document.body.classList.remove('loading'); enterStory(); }
}

boot().catch((e) => { console.error(e); document.body.classList.remove('loading'); const p = document.createElement('pre'); p.style.cssText = 'position:fixed;inset:auto 10px 10px 10px;background:#fff;border:1px solid #c00;padding:10px;z-index:99;white-space:pre-wrap'; p.textContent = 'StrainWatch could not start: ' + e.message; document.body.appendChild(p); });
