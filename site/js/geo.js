// Geometry helpers. Pure functions, no DOM, so they run in the browser and under `node --test`.

export const EARTH_R = 6378137;
const D2R = Math.PI / 180;

export function lonLatToMerc(lon, lat) {
  return [EARTH_R * lon * D2R, EARTH_R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2))];
}

export function mercToLonLat(x, y) {
  return [x / EARTH_R / D2R, (2 * Math.atan(Math.exp(y / EARTH_R)) - Math.PI / 2) / D2R];
}

/** Great-circle distance in metres between [lon, lat] points. */
export function haversine(a, b) {
  const dLat = (b[1] - a[1]) * D2R, dLon = (b[0] - a[0]) * D2R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function lineLength(coords) {
  let L = 0;
  for (let i = 1; i < coords.length; i++) L += haversine(coords[i - 1], coords[i]);
  return L;
}

/** Decode the delta-encoded integer lines written by build_data.py (1e-5 degrees). */
export function decodeLine(arr) {
  const out = [];
  let x = 0, y = 0;
  for (let i = 0; i < arr.length; i += 2) {
    x += arr[i]; y += arr[i + 1];
    out.push([x / 1e5, y / 1e5]);
  }
  return out;
}

/** Point at distance d (metres) along a line. */
export function pointAlong(coords, d) {
  if (d <= 0) return coords[0].slice();
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = haversine(coords[i - 1], coords[i]);
    if (acc + seg >= d && seg > 0) {
      const t = (d - acc) / seg;
      return [coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]), coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1])];
    }
    acc += seg;
  }
  return coords[coords.length - 1].slice();
}

/** Part of a line between distances d0 and d1 (metres), keeping the original vertices in between. */
export function sliceLine(coords, d0, d1) {
  const out = [pointAlong(coords, d0)];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += haversine(coords[i - 1], coords[i]);
    if (acc > d0 + 1e-6 && acc < d1 - 1e-6) out.push(coords[i].slice());
  }
  out.push(pointAlong(coords, d1));
  return out;
}

/**
 * Cut a line into pieces of about `target` metres. The pieces are equal in length, so a 1,000 m line gives
 * three pieces of 333 m, not three of 300 m and a 100 m stub.
 */
export function cutLine(coords, target = 300) {
  const L = lineLength(coords);
  if (!(L > 0)) return [];
  const n = Math.max(1, Math.round(L / target));
  const out = [];
  for (let k = 0; k < n; k++) out.push(sliceLine(coords, (L * k) / n, (L * (k + 1)) / n));
  return out;
}

/** Points every `step` metres along a line, always including both ends and at least three points. */
export function samplePoints(coords, step = 30) {
  const L = lineLength(coords);
  const n = Math.max(2, Math.ceil(L / step));
  const pts = [];
  for (let k = 0; k <= n; k++) pts.push(pointAlong(coords, (L * k) / n));
  return pts;
}

export function midpoint(coords) {
  return pointAlong(coords, lineLength(coords) / 2);
}

/** Shortest distance in metres from point p to a polyline (flat-earth approximation, fine below ~50 km). */
export function distToLine(p, coords) {
  const kx = Math.cos(p[1] * D2R) * EARTH_R * D2R, ky = EARTH_R * D2R;
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const ax = (coords[i - 1][0] - p[0]) * kx, ay = (coords[i - 1][1] - p[1]) * ky;
    const bx = (coords[i][0] - p[0]) * kx, by = (coords[i][1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) best = d;
  }
  if (coords.length === 1) best = haversine(p, coords[0]);
  return best;
}

/** Pull LineString coordinate arrays out of any GeoJSON object (Feature, FeatureCollection, geometry). */
export function linesFromGeoJSON(gj) {
  const out = [];
  const walk = (o, name) => {
    if (!o) return;
    if (o.type === 'FeatureCollection') o.features.forEach((f) => walk(f));
    else if (o.type === 'Feature') walk(o.geometry, (o.properties && (o.properties.name || o.properties.NAME || o.properties.FULLNAME)) || name);
    else if (o.type === 'GeometryCollection') o.geometries.forEach((g) => walk(g, name));
    else if (o.type === 'LineString') out.push({ name, coords: o.coordinates.map((c) => [+c[0], +c[1]]) });
    else if (o.type === 'MultiLineString') o.coordinates.forEach((c) => out.push({ name, coords: c.map((q) => [+q[0], +q[1]]) }));
  };
  walk(gj);
  return out.filter((l) => l.coords.length >= 2 && l.coords.every((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90));
}
