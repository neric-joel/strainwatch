import fs from 'node:fs';
import * as geo from '../site/js/geo.js';
import { Raster } from '../site/js/raster.js';
import * as score from '../site/js/score.js';
const D = 'site/data/';
const sites = JSON.parse(fs.readFileSync(D + 'sites.json')).sites;
const bin = (f) => { const b = fs.readFileSync(D + f); return new Int16Array(b.buffer, b.byteOffset, b.length / 2); };
for (const s of sites) {
  if (!s.layers.rate) continue;
  const L = { rate: new Raster(s.layers.rate, bin(s.layers.rate.file)), uneven: new Raster(s.layers.uneven, bin(s.layers.uneven.file)), valid: new Raster(s.layers.valid, bin(s.layers.valid.file)) };
  // peak location
  let best = 0, bi = 0; const r = L.rate;
  for (let i = 0; i < r.data.length; i++) if (r.data[i] !== r.nodata && r.data[i] < best) { best = r.data[i]; bi = i; }
  const pk = geo.mercToLonLat(r.x0 + (bi % r.w + 0.5) * r.px, r.y0 - (Math.floor(bi / r.w) + 0.5) * r.px);
  console.log('\n==', s.id, 'peak', best / 10, pk.map((v) => v.toFixed(4)), 'P80', s.uneven_q[160], 'P95', s.uneven_q[190], 'P99', s.uneven_q[198]);
  const groups = JSON.parse(fs.readFileSync(D + s.lines)).groups;
  for (const g of groups) {
    let segs = [];
    for (const f of g.f) for (const sc of score.scoreLine(geo.decodeLine(f[2]), L, s.uneven_q)) { sc.name = g.names[f[0]]; sc.sub = f[1]; segs.push(sc); }
    segs = score.rankSegments(segs);
    const sm = score.summarize(segs);
    console.log(' ', g.id, 'lines', g.f.length, 'pieces', segs.length, 'km', sm.km.toFixed(0), 'first', sm.first.n, sm.first.km.toFixed(1) + 'km', 'watch', sm.watch.n, 'nodata', sm.nodata.n);
    console.log('    top:', segs.slice(0, 6).map((x) => `${x.name}[${x.sub}] u=${x.uneven.toFixed(0)} r=${x.rate.toFixed(0)} p=${x.pct.toFixed(1)} @${x.mid.map((v) => v.toFixed(3))}`).join(' | '));
    if (g.id === 'metro') { const c = {}; segs.slice(0, 30).forEach((x) => c[x.name] = (c[x.name] || 0) + 1); console.log('    top30 by line', c); }
  }
}
