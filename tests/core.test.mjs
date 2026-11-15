// Run:  node --test strainwatch/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as geo from '../site/js/geo.js';
import { Raster, Cube, percentileOf } from '../site/js/raster.js';
import * as score from '../site/js/score.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'data');
const sites = JSON.parse(fs.readFileSync(path.join(DATA, 'sites.json'), 'utf8')).sites;
const val = JSON.parse(fs.readFileSync(path.join(DATA, 'validation.json'), 'utf8'));
const bin = (f) => { const b = fs.readFileSync(path.join(DATA, f)); return new Int16Array(b.buffer, b.byteOffset, b.length / 2); };
const site = (id) => sites.find((s) => s.id === id);
const layersOf = (s) => ({ rate: new Raster(s.layers.rate, bin(s.layers.rate.file)), uneven: new Raster(s.layers.uneven, bin(s.layers.uneven.file)), valid: new Raster(s.layers.valid, bin(s.layers.valid.file)) });

test('mercator round trip', () => {
  const [x, y] = geo.lonLatToMerc(-109.93, 32.45);
  const [lon, lat] = geo.mercToLonLat(x, y);
  assert.ok(Math.abs(lon + 109.93) < 1e-9 && Math.abs(lat - 32.45) < 1e-9);
});

test('haversine: one degree of latitude is about 111.2 km', () => {
  assert.ok(Math.abs(geo.haversine([0, 0], [0, 1]) - 111195) < 200);
});

test('decodeLine reverses the delta encoding', () => {
  assert.deepEqual(geo.decodeLine([-10993000, 3245000, 10, -5]), [[-109.93, 32.45], [-109.9299, 32.44995]]);
});

test('cutLine: equal pieces near 300 m that cover the whole line', () => {
  const line = [[-109.9, 32.2], [-109.9, 32.209]]; // about 1,000 m
  const parts = geo.cutLine(line, 300);
  assert.equal(parts.length, 3);
  const lens = parts.map(geo.lineLength);
  assert.ok(lens.every((l) => Math.abs(l - lens[0]) < 0.5));
  assert.ok(Math.abs(lens.reduce((a, b) => a + b, 0) - geo.lineLength(line)) < 0.5);
  assert.deepEqual(parts[0][0], line[0]);
  assert.ok(Math.abs(parts[2].at(-1)[1] - 32.209) < 1e-9);
});

test('cutLine keeps interior vertices and never returns an empty piece', () => {
  const line = [[0, 0], [0.001, 0], [0.001, 0.001], [0.002, 0.001]];
  const parts = geo.cutLine(line, 100);
  assert.ok(parts.length >= 3 && parts.every((p) => p.length >= 2 && geo.lineLength(p) > 0));
  assert.equal(geo.cutLine([[0, 0], [0, 0]], 300).length, 0);
});

test('samplePoints includes both ends', () => {
  const pts = geo.samplePoints([[0, 0], [0, 0.003]], 30);
  assert.deepEqual(pts[0], [0, 0]);
  assert.ok(Math.abs(pts.at(-1)[1] - 0.003) < 1e-12 && pts.length >= 11);
});

test('distToLine', () => {
  const d = geo.distToLine([0, 0.001], [[-0.01, 0], [0.01, 0]]);
  assert.ok(Math.abs(d - 111.3) < 1);
});

test('linesFromGeoJSON handles features, multi-lines and rejects bad coordinates', () => {
  const gj = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'A' }, geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[500000, 3500000], [500100, 3500100]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } }] };
  const l = geo.linesFromGeoJSON(gj);
  assert.equal(l.length, 3);
  assert.equal(l[0].name, 'A');
});

test('percentileOf', () => {
  const q = Array.from({ length: 201 }, (_, i) => i / 2); // value == percentile
  assert.equal(percentileOf(q, -1), 0);
  assert.equal(percentileOf(q, 1000), 100);
  assert.ok(Math.abs(percentileOf(q, 95.25) - 95.25) < 1e-9);
  assert.ok(Number.isNaN(percentileOf(q, NaN)));
  const flat = new Array(201).fill(0); flat[200] = 1;
  assert.ok(percentileOf(flat, 0.5) > 99);
});

test('classify', () => {
  assert.equal(score.classify(99, 1), 'first');
  assert.equal(score.classify(95, 0.5), 'first');
  assert.equal(score.classify(85, 1), 'watch');
  assert.equal(score.classify(10, 1), 'routine');
  assert.equal(score.classify(99, 0.4), 'nodata');
  assert.equal(score.classify(NaN, 1), 'nodata');
});

test('linfit recovers a known slope and its interval covers it', () => {
  const t = Array.from({ length: 20 }, (_, i) => 2016 + i / 2);
  const y = t.map((v, i) => -50 * (v - 2016) + (i % 2 ? 3 : -3));
  const f = score.linfit(t, y);
  assert.ok(Math.abs(f.slope + 50) < 1 && f.lo < -50 && f.hi > -50 && f.n === 20);
  assert.ok(Number.isNaN(score.linfit([1, 2], [1, NaN]).slope));
});

test('Mann-Kendall (Hamed-Rao): monotonic series is significant, noise is not', () => {
  const t = Array.from({ length: 24 }, (_, i) => i);
  const down = score.mannKendallHR(t, t.map((v) => -3 * v + Math.sin(v)));
  assert.ok(down.p < 0.01 && down.z < 0 && Math.abs(down.sen + 3) < 0.3);
  const noise = [3, -1, 2, -4, 1, 0, -2, 4, -3, 2, 1, -1, 0, 3, -2, 1, -3, 2, 0, -1, 2, -2, 1, 0];
  assert.ok(score.mannKendallHR(t, noise).p > 0.05);
  assert.ok(Number.isNaN(score.mannKendallHR([1, 2, 3], [1, 2, 3]).p));
});

test('Willcox rasters: grid sizes, the fastest spot, bedrock reference near zero', () => {
  const s = site('willcox');
  const L = layersOf(s);
  const peak = L.rate.valueAt(-109.93, 32.45); // fastest-sinking area named in the brief
  assert.ok(peak < -90, `rate at the bowl centre should be strongly negative, got ${peak}`);
  const ref = L.rate.valueAt(-109.965, 31.925);
  assert.ok(Math.abs(ref) < 5, `bedrock reference should be near zero, got ${ref}`);
  assert.ok(Number.isNaN(L.rate.valueAt(-111, 33)));
  assert.equal(s.uneven_q.length, 201);
  assert.equal(s.uneven_q_n, 31990); // same basin-floor domain as the forward test
});

test('benchmark locations sampled in the browser grid match the research table', () => {
  const s = site('willcox');
  const L = layersOf(s);
  let n = 0, close = 0;
  for (const b of val.willcox_benchmarks.rows) {
    const v = L.rate.valueAt(b.lon, b.lat);
    if (!Number.isFinite(v)) continue;
    n++;
    if (Math.abs(v - b.radar) < Math.max(6, Math.abs(b.radar) * 0.15)) close++;
  }
  assert.ok(n >= 35 && close / n > 0.85, `only ${close} of ${n} benchmarks agree with the research table`);
});

test('validation numbers match the brief', () => {
  assert.equal(val.willcox_benchmarks.n, 38);
  assert.ok(Math.abs(val.willcox_benchmarks.spearman - 0.85) < 0.01);
  assert.equal(val.willcox_benchmarks.n_recent, 16);
  assert.ok(Math.abs(val.willcox_benchmarks.spearman_recent - 0.95) < 0.01);
  const g = val.willcox_forward.all.find((r) => r.score === 'gradient');
  const f = val.willcox_forward.all.find((r) => r.score === 'baseline_dist_fis2023');
  const r = val.willcox_forward.all.find((r) => r.score === 'baseline_rate');
  assert.ok(Math.abs(g.auc - 0.9) < 0.005 && Math.abs(f.auc - 0.918) < 0.005 && Math.abs(r.auc - 0.746) < 0.005);
  assert.ok(f.auc > g.auc, 'the app must not claim the score beats distance to known fissures');
  assert.equal(val.mexico_gps.n, 9);
  assert.ok(Math.abs(val.mexico_gps.r - 0.981) < 0.002 && Math.abs(val.mexico_gps.rmse - 17.3) < 0.2);
  assert.ok(Math.abs(val.mexico_nisar.r - 0.94) < 0.01);
  assert.equal(val.phoenix_benchmarks.n, 26);
  assert.ok(Math.abs(val.phoenix_benchmarks.spearman - 0.9) < 0.01);
  assert.ok(val.chennai.noise.every((n) => n.mdr_now > 35 && n.mdr_now < 45));
});

test('scoring a real road network: classes, ranking, top-5 % share is plausible', () => {
  const s = site('willcox');
  const L = layersOf(s);
  const lines = JSON.parse(fs.readFileSync(path.join(DATA, s.lines), 'utf8'));
  const roads = lines.groups.find((g) => g.id === 'roads');
  assert.ok(roads.f.length > 13000);
  let segs = [];
  for (const f of roads.f) for (const sc of score.scoreLine(geo.decodeLine(f[2]), L, s.uneven_q)) segs.push(sc);
  segs = score.rankSegments(segs);
  const sum = score.summarize(segs);
  assert.ok(segs.length >= roads.f.length);
  assert.ok(sum.first.n > 50 && sum.first.n < segs.length * 0.4, `inspect-first count ${sum.first.n}`);
  assert.ok(segs[0].uneven >= segs[1].uneven && segs[0].rank === 1 && segs[0].cls === 'first');
  assert.ok(sum.nodata.n < segs.length * 0.3);
  const plan = score.planStops(segs.map((x, i) => ({ ...x, name: 'r' + (i % 50) })), { stops: 8 });
  assert.equal(plan.stops.length, 8);
  assert.deepEqual(plan.stops.map((p) => p.order), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(plan.stops.every((p) => p.segs.length <= 8) && plan.inspectKm < 8 * 8 * 0.35, `plan too long: ${plan.inspectKm} km`);
  // stops are separate places
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) assert.ok(geo.haversine(plan.stops[i].anchor, plan.stops[j].anchor) > 1200);
});

test('a line outside every raster is reported as no data, never as safe', () => {
  const s = site('willcox');
  const L = layersOf(s);
  const out = score.scoreLine([[-100, 40], [-100, 40.01]], L, s.uneven_q);
  assert.ok(out.length > 0 && out.every((x) => x.cls === 'nodata' && x.valid === 0));
});

test('time-series cube: bowl centre sinks over the record, in step with the rate map', () => {
  const s = site('willcox');
  const c = new Cube(s.ts, bin(s.ts.file));
  const y = c.seriesAt(-109.93, 32.45);
  assert.equal(y.length, s.ts.dates.length);
  const f = score.linfit(s.ts.decyear, y);
  const L = layersOf(s);
  const rate = L.rate.valueAt(-109.93, 32.45);
  assert.ok(f.slope < -60 && Math.abs(f.slope - rate) < 35, `cube slope ${f.slope} vs rate map ${rate}`);
  assert.equal(c.seriesAt(0, 0), null);
});

test('every site file listed in sites.json exists and has the stated size', () => {
  for (const s of sites) {
    for (const l of Object.values(s.layers)) assert.equal(fs.statSync(path.join(DATA, l.file)).size, l.w * l.h * 2, l.file);
    if (s.ts) assert.equal(fs.statSync(path.join(DATA, s.ts.file)).size, s.ts.n * s.ts.w * s.ts.h * 2);
    assert.ok(fs.existsSync(path.join(DATA, s.lines)) && fs.existsSync(path.join(DATA, s.overlays)));
  }
});

test('every place carries a trust tier and a robust fastest-ground figure; unchecked places never claim a check', () => {
  assert.ok(sites.length >= 5);
  for (const s of sites) {
    assert.ok(['checked', 'measured', 'frontier'].includes(s.tier), `${s.id} tier`);
    if (s.tier === 'frontier') { assert.equal(s.layers.rate, undefined); continue; }
    assert.ok(Number.isFinite(s.summary.fast_mmyr) && s.summary.fast_mmyr < 0 && s.summary.fast_mmyr > -600, `${s.id} fast ${s.summary.fast_mmyr}`);
    assert.ok(s.bbox[0] < s.center[0] && s.center[0] < s.bbox[2] && s.bbox[1] < s.center[1] && s.center[1] < s.bbox[3], `${s.id} centre inside its box`);
    if (s.tier === 'measured') assert.equal(s.check, null);
    else assert.ok(s.check && s.check.length > 5);
  }
  assert.deepEqual(sites.filter((s) => s.tier === 'checked').map((s) => s.id).sort(), ['mexico', 'phoenix_east', 'willcox']);
});

test('unevenness is blank next to data gaps, so gap rims cannot top the ranking', () => {
  for (const id of ['phoenix_west', 'phoenix_east', 'mexico']) {
    const s = site(id);
    const L = layersOf(s);
    const u = L.uneven, v = L.valid;
    let checked = 0, leaks = 0;
    for (let r = 2; r < u.h - 2; r += 3) for (let c = 2; c < u.w - 2; c += 3) {
      if (u.data[r * u.w + c] === u.nodata) continue;
      const x = u.x0 + (c + 0.5) * u.px, y = u.y0 - (r + 0.5) * u.px; // centre of the 270 m cell
      const vc = Math.floor((x - v.x0) / v.px), vr = Math.floor((v.y0 - y) / v.px);
      if (vc < 0 || vr < 0 || vc >= v.w || vr >= v.h) continue;
      checked++;
      const val = v.data[vr * v.w + vc];
      if (val !== v.nodata && val / v.scale < 0.2) leaks++;
    }
    assert.ok(checked > 500 && leaks / checked < 0.01, `${id}: ${leaks} of ${checked} scored cells sit on unobserved ground`);
  }
});

test('NISAR is reported at every place with one of the allowed verdicts, and agreement is never claimed without a number', () => {
  const allowed = ['strong', 'moderate', 'weak', 'quiet', 'frontier', 'none'];
  for (const s of sites) {
    const v = (s.nisar && s.nisar.verdict) || 'none';
    assert.ok(allowed.includes(v), `${s.id}: ${v}`);
    if (v === 'strong') assert.ok(s.nisar.r >= 0.75, `${s.id} strong with r ${s.nisar.r}`);
    if (v === 'moderate') assert.ok(s.nisar.r >= 0.4 && s.nisar.r < 0.75, `${s.id} moderate with r ${s.nisar.r}`);
    if (v !== 'none' && v !== 'frontier') assert.ok(s.layers.nisar, `${s.id} has a verdict but no NISAR layer`);
  }
  assert.equal(site('mexico').nisar.verdict, 'strong');
  assert.equal(site('willcox').nisar.verdict, 'moderate');
  assert.equal(site('chennai').nisar.verdict, 'frontier');
});

test('coverage is stated from the boxes, not rounded up', () => {
  const cov = JSON.parse(fs.readFileSync(path.join(DATA, 'sites.json'), 'utf8')).coverage;
  const us = sites.filter((s) => !['MX', 'IND', undefined, null].includes(s.st));
  assert.equal(cov.us_places, us.length);
  assert.equal(cov.us_states, new Set(us.map((s) => s.st).filter((x) => x !== 'DC')).size);
  assert.ok(!us.some((s) => s.id === 'chennai'), 'Chennai must not be counted as a US place');
  assert.ok(cov.us_share > 0 && cov.us_share < 0.2, `share ${cov.us_share}`);
});

test('every place carries a ground-truth verdict, and a map is tied to GPS only where three or more stations agree', () => {
  const allowed = ['validated', 'agree', 'weak', 'none'];
  for (const s of sites) {
    assert.ok(s.truth && allowed.includes(s.truth.verdict), `${s.id}: ground-truth verdict ${s.truth && s.truth.verdict}`);
    if (s.truth.verdict === 'validated') assert.equal(s.tier, 'checked', `${s.id} validated but not in the checked tier`);
    if (s.tier === 'checked') assert.equal(s.truth.verdict, 'validated');
    if (s.truth.tied) assert.ok(s.truth.n >= 3 && s.truth.verdict === 'agree', `${s.id} tied on ${s.truth.n} stations`);
    if (s.truth.verdict === 'agree' || s.truth.verdict === 'weak') assert.ok(s.truth.n >= 1 && Number.isFinite(s.truth.misfit), `${s.id} has a verdict without numbers`);
    if (s.truth.verdict === 'none' && s.tier === 'measured') assert.equal(s.truth.n, 0);
  }
  const c = val.truth.counts;
  assert.equal(c.validated + c.agree + c.weak + c.none, sites.length);
});
