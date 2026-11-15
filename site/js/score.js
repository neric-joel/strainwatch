// Scoring, ranking, trend tests and the inspection planner. Pure functions.
import { cutLine, samplePoints, lineLength, midpoint, haversine } from './geo.js';
import { percentileOf } from './raster.js';

export const FIRST_PCT = 95; // top 5 % of measured ground: the threshold scored in the Willcox forward test
export const WATCH_PCT = 80;
export const MIN_VALID = 0.5;
export const CLASS_LABEL = { first: 'Inspect first', watch: 'Watch', routine: 'Routine', nodata: 'No data' };

const median = (a) => {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function classify(pct, valid) {
  if (!(valid >= MIN_VALID) || !Number.isFinite(pct)) return 'nodata';
  if (pct >= FIRST_PCT) return 'first';
  if (pct >= WATCH_PCT) return 'watch';
  return 'routine';
}

/**
 * Score one piece of line against a site's rasters.
 *   rate   = median sinking rate under the piece (mm/yr, negative = sinking)
 *   uneven = highest unevenness under the piece (mm/yr per km)
 *   valid  = share of sample points with a rate and good-data share >= 0.5
 *   pct    = percentile of `uneven` among the frame's measured cells
 */
export function scoreSegment(coords, layers, q, step = 30) {
  const pts = samplePoints(coords, step);
  const rates = [], un = [];
  let good = 0;
  for (const p of pts) {
    const r = layers.rate.valueAt(p[0], p[1]);
    const u = layers.uneven.valueAt(p[0], p[1]);
    const v = layers.valid ? layers.valid.valueAt(p[0], p[1]) : 1;
    if (Number.isFinite(r) && Number.isFinite(u) && v >= MIN_VALID) { good++; rates.push(r); un.push(u); }
  }
  const valid = good / pts.length;
  const uneven = un.length ? Math.max(...un) : NaN;
  const rate = median(rates);
  const pct = percentileOf(q, uneven);
  return { coords, len: lineLength(coords), mid: midpoint(coords), rate, uneven, valid, pct, cls: classify(pct, valid) };
}

/** Cut a line into ~300 m pieces and score each. */
export function scoreLine(coords, layers, q, target = 300) {
  return cutLine(coords, target).map((c) => scoreSegment(c, layers, q));
}

/**
 * Rank scored pieces: most uneven first, pieces without data last. Adds `rank` (1-based, among pieces with data)
 * and `ratePct` (share of pieces with data that sink more slowly).
 */
export function rankSegments(segs) {
  const withData = segs.filter((s) => s.cls !== 'nodata').sort((a, b) => b.uneven - a.uneven || a.rate - b.rate);
  withData.forEach((s, i) => { s.rank = i + 1; });
  const byRate = withData.slice().sort((a, b) => b.rate - a.rate); // slowest sinking first
  byRate.forEach((s, i) => { s.ratePct = withData.length > 1 ? (i / (withData.length - 1)) * 100 : 100; });
  const none = segs.filter((s) => s.cls === 'nodata');
  none.forEach((s) => { s.rank = null; s.ratePct = NaN; });
  return withData.concat(none);
}

export function summarize(segs) {
  const out = { first: { n: 0, km: 0 }, watch: { n: 0, km: 0 }, routine: { n: 0, km: 0 }, nodata: { n: 0, km: 0 }, n: segs.length, km: 0 };
  for (const s of segs) { out[s.cls].n++; out[s.cls].km += s.len / 1000; out.km += s.len / 1000; }
  return out;
}

// ---------------------------------------------------------------- trend statistics
/** Ordinary least squares y = a + b t, ignoring NaN. Returns slope, its standard error and a 95 % interval. */
export function linfit(t, y) {
  const tt = [], yy = [];
  for (let i = 0; i < t.length; i++) if (Number.isFinite(y[i]) && Number.isFinite(t[i])) { tt.push(t[i]); yy.push(y[i]); }
  const n = tt.length;
  if (n < 3) return { n, slope: NaN, intercept: NaN, se: NaN, lo: NaN, hi: NaN };
  const mt = tt.reduce((a, b) => a + b, 0) / n, my = yy.reduce((a, b) => a + b, 0) / n;
  let stt = 0, sty = 0;
  for (let i = 0; i < n; i++) { stt += (tt[i] - mt) ** 2; sty += (tt[i] - mt) * (yy[i] - my); }
  const slope = sty / stt, intercept = my - slope * mt;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (yy[i] - intercept - slope * tt[i]) ** 2;
  const se = Math.sqrt(sse / (n - 2) / stt);
  const tcrit = tCrit95(n - 2);
  return { n, slope, intercept, se, lo: slope - tcrit * se, hi: slope + tcrit * se, resid: Math.sqrt(sse / (n - 2)) };
}

function tCrit95(df) {
  const tab = [12.71, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086];
  if (df <= 0) return NaN;
  if (df <= 20) return tab[df - 1];
  if (df <= 30) return 2.086 - ((df - 20) * (2.086 - 2.042)) / 10;
  if (df <= 60) return 2.042 - ((df - 30) * (2.042 - 2.0)) / 30;
  return 1.96 + 2.4 / df;
}

const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

/**
 * Mann-Kendall trend test with the Hamed & Rao (1998) variance correction for autocorrelation, plus Sen's slope.
 * t and y may contain NaN (dropped). Returns { n, S, z, p, sen, correction }.
 */
export function mannKendallHR(t, y) {
  const tt = [], yy = [];
  for (let i = 0; i < t.length; i++) if (Number.isFinite(y[i]) && Number.isFinite(t[i])) { tt.push(t[i]); yy.push(y[i]); }
  const n = tt.length;
  if (n < 6) return { n, S: NaN, z: NaN, p: NaN, sen: NaN, correction: NaN };
  let S = 0;
  const slopes = [];
  for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
    S += Math.sign(yy[j] - yy[i]);
    if (tt[j] !== tt[i]) slopes.push((yy[j] - yy[i]) / (tt[j] - tt[i]));
  }
  const sen = median(slopes);
  let v0 = (n * (n - 1) * (2 * n + 5)) / 18;
  // ties
  const counts = new Map();
  yy.forEach((v) => counts.set(v, (counts.get(v) || 0) + 1));
  for (const c of counts.values()) if (c > 1) v0 -= (c * (c - 1) * (2 * c + 5)) / 18;
  // autocorrelation of the ranks of the detrended series
  const rk = ranks(yy.map((v, i) => v - sen * tt[i]));
  const mr = (n + 1) / 2;
  let den = 0;
  for (let i = 0; i < n; i++) den += (rk[i] - mr) ** 2;
  let corr = 0;
  const lim = 1.96 / Math.sqrt(n);
  for (let k = 1; k < n - 1 && den > 0; k++) {
    let num = 0;
    for (let i = 0; i < n - k; i++) num += (rk[i] - mr) * (rk[i + k] - mr);
    const r = num / den;
    if (Math.abs(r) > lim) corr += (n - k) * (n - k - 1) * (n - k - 2) * r;
  }
  let correction = 1 + (2 / (n * (n - 1) * (n - 2))) * corr;
  if (!(correction > 0.1)) correction = 0.1; // guard against a negative or tiny variance from strong negative lags
  const v = v0 * correction;
  const z = S > 0 ? (S - 1) / Math.sqrt(v) : S < 0 ? (S + 1) / Math.sqrt(v) : 0;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  return { n, S, z, p, sen, correction };
}

// ---------------------------------------------------------------- inspection planner
/**
 * Group the most uneven pieces into inspection stops and order the stops into a route.
 *   segs   : ranked pieces (rankSegments output)
 *   opts   : { stops, radius (m), perStop, skipKnown (m, 0 = off), minPct, start: [lon, lat] }
 * Greedy: walk down the ranking; a piece joins an existing stop if it lies within `radius` of that stop's first piece
 * and the stop is not full (`perStop` pieces, about 2.4 km by default), otherwise it opens a new stop, until `stops`
 * stops exist. Route: nearest neighbour from `start`.
 */
export function planStops(segs, opts = {}) {
  const { stops = 10, radius = 1200, perStop = 8, skipKnown = 0, minPct = FIRST_PCT, start = null } = opts;
  const log = [];
  const pool = segs.filter((s) => s.cls !== 'nodata');
  log.push({ step: 'Read', text: `Read ${segs.length.toLocaleString()} pieces; ${(segs.length - pool.length).toLocaleString()} have too little good data and are left out.` });
  let cand = pool.filter((s) => s.pct >= minPct);
  log.push({ step: 'Rank', text: `${cand.length.toLocaleString()} pieces sit on ground more uneven than ${minPct}% of the frame.` });
  if (skipKnown > 0) {
    const before = cand.length;
    cand = cand.filter((s) => !(s.fisDist <= skipKnown));
    log.push({ step: 'Filter', text: `Skipped ${(before - cand.length).toLocaleString()} pieces within ${skipKnown} m of an already-mapped fissure.` });
  }
  cand.sort((a, b) => b.uneven - a.uneven);
  const out = [];
  for (const s of cand) {
    let home = null;
    let near = false;
    for (const st of out) if (haversine(st.anchor, s.mid) <= radius) { near = true; if (st.segs.length < perStop) { home = st; break; } }
    if (home) home.segs.push(s);
    else if (!near && out.length < stops) out.push({ anchor: s.mid, segs: [s] });
  }
  for (const st of out) {
    st.km = st.segs.reduce((a, s) => a + s.len, 0) / 1000;
    st.top = st.segs[0];
    st.center = [st.segs.reduce((a, s) => a + s.mid[0], 0) / st.segs.length, st.segs.reduce((a, s) => a + s.mid[1], 0) / st.segs.length];
    const names = new Map();
    st.segs.forEach((s) => names.set(s.name, (names.get(s.name) || 0) + s.len));
    st.names = [...names.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  }
  log.push({ step: 'Group', text: `Grouped the top pieces into ${out.length} stops (up to ${perStop} pieces within ${(radius / 1000).toFixed(1)} km share a stop).` });
  // nearest-neighbour route
  const route = [];
  const left = out.slice();
  // without a given start, begin at the stop farthest from the middle of the set, so the route runs end to end
  let at = start;
  if (!at && left.length) {
    const cx = left.reduce((a, s) => a + s.center[0], 0) / left.length, cy = left.reduce((a, s) => a + s.center[1], 0) / left.length;
    at = left.slice().sort((a, b) => haversine([cx, cy], b.center) - haversine([cx, cy], a.center))[0].center;
  }
  let dist = 0;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((st, i) => { const d = haversine(at, st.center); if (d < bd) { bd = d; bi = i; } });
    const st = left.splice(bi, 1)[0];
    if (route.length || start) dist += bd;
    st.order = route.length + 1;
    route.push(st);
    at = st.center;
  }
  const km = route.reduce((a, s) => a + s.km, 0);
  log.push({ step: 'Route', text: `Ordered the stops by nearest neighbour: about ${(dist / 1000).toFixed(0)} km between stops in a straight line, ${km.toFixed(1)} km of line to walk or drive.` });
  return { stops: route, log, travelKm: dist / 1000, inspectKm: km };
}
