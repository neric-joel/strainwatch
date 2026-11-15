// National exposure summary: score every place's preloaded lines with the same code the browser runs, and add up
// how much line was screened, how much sits on the most uneven 5 % of its window, and how much could not be observed.
//
//   node strainwatch/build/exposure.mjs        (after build_data.py)
//
// Writes site/data/exposure.json. "Flagged" counts only places whose unevenness signal is strong enough to mean
// something (top 5 % starting at 5 mm/yr per km or more); at weaker places a top 5 % is close to radar noise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as geo from '../site/js/geo.js';
import { Raster } from '../site/js/raster.js';
import * as score from '../site/js/score.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'data');
const sites = JSON.parse(fs.readFileSync(path.join(DATA, 'sites.json'), 'utf8')).sites;
const bin = (f) => { const b = fs.readFileSync(path.join(DATA, f)); return new Int16Array(b.buffer, b.byteOffset, b.length / 2); };
const STRONG = 5; // mm/yr per km

const kinds = {}, per = [];
const total = { km: 0, first_km: 0, first_n: 0, nodata_km: 0, n: 0, places: 0, strong_places: 0, strong_first_km: 0, strong_first_n: 0 };
for (const s of sites) {
  if (!s.layers.rate) continue;
  const L = { rate: new Raster(s.layers.rate, bin(s.layers.rate.file)), uneven: new Raster(s.layers.uneven, bin(s.layers.uneven.file)), valid: s.layers.valid ? new Raster(s.layers.valid, bin(s.layers.valid.file)) : null };
  const groups = JSON.parse(fs.readFileSync(path.join(DATA, s.lines), 'utf8')).groups;
  const strong = s.uneven_q[190] >= STRONG;
  const row = { id: s.id, km: 0, first_km: 0, first_n: 0, nodata_km: 0, n: 0, strong };
  for (const g of groups) {
    const seen = new Set();
    for (const f of g.f) {
      for (const p of score.scoreLine(geo.decodeLine(f[2]), L, s.uneven_q)) {
        if (p.len < 60) continue;
        const key = p.mid[0].toFixed(4) + ',' + p.mid[1].toFixed(4);
        if (seen.has(key)) continue; // the same carriageway under two names
        seen.add(key);
        const km = p.len / 1000;
        const k = (kinds[g.kind] ||= { km: 0, first_km: 0, nodata_km: 0 });
        row.km += km; row.n++; k.km += km;
        if (p.cls === 'nodata') { row.nodata_km += km; k.nodata_km += km; }
        if (p.cls === 'first') { row.first_km += km; row.first_n++; if (strong) k.first_km += km; }
      }
    }
  }
  per.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v])));
  total.km += row.km; total.n += row.n; total.nodata_km += row.nodata_km; total.first_km += row.first_km; total.first_n += row.first_n; total.places++;
  if (strong) { total.strong_places++; total.strong_first_km += row.first_km; total.strong_first_n += row.first_n; }
}
const r0 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
const out = { strong_threshold: STRONG, total: r0(total), kinds: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, r0(v)])), places: per };
fs.writeFileSync(path.join(DATA, 'exposure.json'), JSON.stringify(out));
console.log(JSON.stringify({ total: out.total, kinds: out.kinds }, null, 1));
