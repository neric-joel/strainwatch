// Exports, the planner's options and awkward inputs. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../site/js/geo.js';
import * as score from '../site/js/score.js';
import { toCSV, toGeoJSON } from '../site/js/report.js';

const site = { name: 'Test place', sensor: 'radar', rate_kind: 'line of sight', layers: { rate: { period: '2016 to 2026' } } };
const seg = (i, o = {}) => ({ coords: [[-110 + i * 0.01, 32], [-110 + i * 0.01, 32.003]], len: 333, mid: [-110 + i * 0.01, 32.0015], rate: -10 - i, uneven: 50 - i, valid: 1, pct: 99 - i,
  cls: 'first', rank: i + 1, name: `Road "${i}", north`, aka: [], kind: 'road', piece: 1, of: 1, fisDist: 100 * i, g: 'roads', ...o });

test('CSV: header comment, one row per piece, quotes and commas escaped', () => {
  const csv = toCSV([seg(0), seg(1, { cls: 'nodata', rank: null, uneven: NaN, rate: NaN, pct: NaN, fisDist: Infinity })], site);
  const lines = csv.trim().split('\n');
  assert.ok(lines[0].startsWith('# StrainWatch') && lines[1].startsWith('#'));
  const head = lines[2].split(',');
  assert.ok(head.includes('unevenness_mm_yr_per_km') && head.includes('verdict'));
  assert.equal(lines.length, 5);
  assert.ok(lines[3].includes('"Road ""0"", north"'), lines[3]);
  assert.ok(lines[4].includes('No data'));
  assert.ok(!/NaN|Infinity|undefined/.test(csv), 'no NaN, Infinity or undefined may leak into the file');
});

test('GeoJSON: valid features with the same fields, readable back by linesFromGeoJSON', () => {
  const gj = JSON.parse(toGeoJSON([seg(0), seg(1)], site));
  assert.equal(gj.type, 'FeatureCollection');
  assert.equal(gj.features.length, 2);
  assert.equal(gj.features[0].geometry.type, 'LineString');
  assert.equal(gj.features[0].properties.verdict, 'Inspect first');
  const back = geo.linesFromGeoJSON(gj);
  assert.equal(back.length, 2);
  assert.equal(back[0].name, 'Road "0", north');
});

test('linesFromGeoJSON survives junk without throwing', () => {
  for (const junk of [null, 42, 'text', [], {}, { type: 'FeatureCollection', features: [] }, { type: 'Feature', geometry: null, properties: null },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[1, 2]] } }, { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [['a', 'b'], [1, 2]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }]) {
    let out;
    assert.doesNotThrow(() => { out = geo.linesFromGeoJSON(junk); });
    assert.deepEqual(out, []);
  }
});

test('planner: respects the stop count, the per-stop cap, the top-5% floor and "new ground only"', () => {
  const segs = [];
  for (let i = 0; i < 60; i++) segs.push(seg(i, { mid: [-110 + Math.floor(i / 10) * 0.05, 32 + (i % 10) * 0.0005], pct: i < 40 ? 99 : 85, cls: i < 40 ? 'first' : 'watch', fisDist: i % 2 ? 50 : 5000 }));
  const p = score.planStops(segs, { stops: 3, perStop: 4 });
  assert.equal(p.stops.length, 3);
  assert.ok(p.stops.every((s) => s.segs.length <= 4 && s.segs.every((x) => x.pct >= score.FIRST_PCT)));
  const fresh = score.planStops(segs, { stops: 3, perStop: 4, skipKnown: 250 });
  assert.ok(fresh.stops.every((s) => s.segs.every((x) => !(x.fisDist <= 250))));
  assert.ok(fresh.log.some((l) => l.step === 'Filter'));
  const none = score.planStops(segs.map((s) => ({ ...s, cls: 'nodata' })), { stops: 3 });
  assert.equal(none.stops.length, 0);
  assert.equal(score.planStops([], { stops: 5 }).stops.length, 0);
});

test('scoring: a piece half outside the data is "not observed"; summaries add up', () => {
  const flat = (v) => ({ valueAt: (lon) => (lon < 0 ? v : NaN) });
  const L = { rate: flat(-20), uneven: flat(30), valid: flat(1) };
  const q = Array.from({ length: 201 }, (_, i) => i / 2);
  const inside = score.scoreSegment([[-0.01, 0], [-0.007, 0]], L, q);
  assert.equal(inside.cls, 'routine');
  assert.ok(Math.abs(inside.pct - 30) < 1e-9 && inside.valid === 1);
  const straddle = score.scoreSegment([[-0.0005, 0], [0.0025, 0]], L, q);
  assert.ok(straddle.valid < 0.5 && straddle.cls === 'nodata');
  const sum = score.summarize([inside, straddle]);
  assert.equal(sum.n, 2);
  assert.ok(Math.abs(sum.km - (inside.len + straddle.len) / 1000) < 1e-9);
  const ranked = score.rankSegments([straddle, inside]);
  assert.equal(ranked[0], inside);
  assert.equal(ranked[1].rank, null);
});

test('cutLine and sampling on awkward lines: repeated points, very long lines, a single point', () => {
  assert.equal(geo.cutLine([[0, 0]], 300).length, 0);
  const dup = geo.cutLine([[0, 0], [0, 0], [0, 0.01], [0, 0.01]], 300);
  assert.ok(dup.length >= 3 && dup.every((p) => geo.lineLength(p) > 0));
  const long = geo.cutLine([[0, 0], [0, 1]], 300);
  assert.ok(long.length > 360 && long.length < 380);
  assert.ok(Number.isFinite(geo.distToLine([0, 0], [[1, 1]])));
});
