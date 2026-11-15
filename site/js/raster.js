// Rasters written by build_data.py: Int16, Web Mercator, north-up. Pure code, no DOM needed for sampling.
import { lonLatToMerc, mercToLonLat } from './geo.js';

export class Raster {
  constructor(meta, data) {
    Object.assign(this, meta);
    this.data = data; // Int16Array, row-major, row 0 = north
    if (data.length !== meta.w * meta.h) throw new Error(`raster ${meta.file}: expected ${meta.w * meta.h} cells, got ${data.length}`);
  }

  /** Value at a lon/lat (nearest cell). NaN outside the grid or where there is no data. */
  valueAt(lon, lat) {
    const [x, y] = lonLatToMerc(lon, lat);
    const c = Math.floor((x - this.x0) / this.px), r = Math.floor((this.y0 - y) / this.px);
    if (c < 0 || r < 0 || c >= this.w || r >= this.h) return NaN;
    const v = this.data[r * this.w + c];
    return v === this.nodata ? NaN : v / this.scale;
  }

  inside(lon, lat) {
    const [x, y] = lonLatToMerc(lon, lat);
    return x >= this.x0 && x < this.x0 + this.w * this.px && y <= this.y0 && y > this.y0 - this.h * this.px;
  }

  /** Corners for a MapLibre image/canvas source: NW, NE, SE, SW as [lon, lat]. */
  corners() {
    const xe = this.x0 + this.w * this.px, ys = this.y0 - this.h * this.px;
    return [mercToLonLat(this.x0, this.y0), mercToLonLat(xe, this.y0), mercToLonLat(xe, ys), mercToLonLat(this.x0, ys)];
  }

  /** Column index (may be fractional, may fall outside 0..w) of a longitude. */
  colOfLon(lon) {
    return (lonLatToMerc(lon, 0)[0] - this.x0) / this.px;
  }

  /** Fill an RGBA Uint8ClampedArray using colorFn(value) -> [r, g, b, a] or null for transparent. */
  paint(rgba, colorFn) {
    const d = this.data, nd = this.nodata, s = this.scale;
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      const c = v === nd ? null : colorFn(v / s);
      const o = i * 4;
      if (c) { rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3]; }
      else rgba[o + 3] = 0;
    }
    return rgba;
  }
}

/** A (dates, rows, cols) Int16 cube of cumulative displacement. */
export class Cube {
  constructor(meta, data) {
    Object.assign(this, meta);
    this.data = data;
    if (data.length !== meta.n * meta.w * meta.h) throw new Error(`cube ${meta.file}: wrong size`);
  }

  /** Series at a lon/lat: array of values (NaN where missing), or null outside the grid. */
  seriesAt(lon, lat) {
    const [x, y] = lonLatToMerc(lon, lat);
    const c = Math.floor((x - this.x0) / this.px), r = Math.floor((this.y0 - y) / this.px);
    if (c < 0 || r < 0 || c >= this.w || r >= this.h) return null;
    const out = new Array(this.n), plane = this.w * this.h, at = r * this.w + c;
    for (let t = 0; t < this.n; t++) {
      const v = this.data[t * plane + at];
      out[t] = v === this.nodata ? NaN : v / this.scale;
    }
    return out;
  }
}

/**
 * Percentile (0-100) of value v in a 201-point quantile table (0 %, 0.5 %, ... 100 %).
 * Ties at the bottom of the table (many zeros) resolve to the highest matching step.
 */
export function percentileOf(q, v) {
  if (!Number.isFinite(v) || !q) return NaN;
  if (v <= q[0]) return 0;
  const n = q.length - 1;
  if (v >= q[n]) return 100;
  let lo = 0, hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (q[mid] <= v) lo = mid; else hi = mid;
  }
  const span = q[hi] - q[lo];
  return ((lo + (span > 0 ? (v - q[lo]) / span : 0)) / n) * 100;
}

export async function loadRaster(meta, base = 'data/') {
  const buf = await (await fetch(base + meta.file)).arrayBuffer();
  return new Raster(meta, new Int16Array(buf));
}

export async function loadCube(meta, base = 'data/') {
  const buf = await (await fetch(base + meta.file)).arrayBuffer();
  return new Cube(meta, new Int16Array(buf));
}
