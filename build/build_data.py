"""Pack the cached radar products into small files a static web page can read.

Run from the project root:
    .venv\\Scripts\\python strainwatch\\build\\build_data.py

Inputs : data/<site>/...            (see each data/<site>/README.md)
Outputs: strainwatch/site/data/
    sites.json                site list, raster layer descriptors, percentile tables, time-series descriptors
    <site>_<layer>.bin        Int16 little-endian rasters in Web Mercator (EPSG:3857); value = int / scale; -32768 = no data
    <site>_ts.bin             Int16 cube (dates, rows, cols), cumulative displacement in 0.2 mm steps
    <site>_lines.json         preloaded line networks (roads, rail, pipelines, power lines, canals, Metro)
    <site>_overlays.json      fissures, survey benchmarks, GPS stations, reference points
    validation.json           every number behind the "track record" charts, recomputed here from the cached tables

ONE definition of the unevenness score at every site (the one the Willcox forward test scored):
    rate90  = rate on a 90 m grid
    v270    = 3x3 nan-median of rate90 (270 m)
    uneven  = |grad(v270)| in mm/yr per km
"""
import csv, json, os, sys, warnings
from datetime import datetime

import numpy as np
import pyproj
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import Resampling, calculate_default_transform, reproject
from scipy import stats
from shapely.geometry import LineString, box as sbox

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "strainwatch", "site", "data")
os.makedirs(OUT, exist_ok=True)
NODATA = -32768
to_ll = {}


def decyear(s):
    d = datetime.strptime(str(s), "%Y%m%d")
    return d.year + (d.timetuple().tm_yday - 0.5) / 365.25


def block(a, f):
    r, c = a.shape[-2] // f * f, a.shape[-1] // f * f
    b = a[..., :r, :c]
    return b.reshape(b.shape[:-2] + (r // f, f, c // f, f))


def bmean(a, f):
    with np.errstate(all="ignore"):
        return np.nanmean(block(a, f), axis=(-3, -1))


def bmedian(a, f):
    with np.errstate(all="ignore"):
        return np.nanmedian(block(a, f), axis=(-3, -1))


def bcoord(v, f):
    return v[: len(v) // f * f].reshape(-1, f).mean(1)


def unevenness(rate90, pix_km=0.27):
    """|grad| of the 3x3 nan-median of the 90 m rate, mm/yr per km. Same as research_scripts/willcox/s12_derived.py."""
    v270 = bmedian(rate90, 3)
    gy, gx = np.gradient(v270, pix_km)
    return np.hypot(gx, gy).astype("float32"), v270


def mask_rims(un, valid270, v270):
    """Blank unevenness cells that touch ground without good data. The edge of a data gap is where unwrapping errors
    sit, and a gradient taken across it is not a measurement."""
    from scipy.ndimage import binary_dilation
    bad = ~np.isfinite(v270) | ~(valid270 >= 0.5)
    out = un.copy()
    out[binary_dilation(bad, structure=np.ones((3, 3), bool))] = np.nan
    return out


def fast(v90, valid90):
    """Rate of the fastest-sinking 0.5 % of well-observed ground: a peak figure that one bad pixel cannot set."""
    v = v90[np.isfinite(v90) & (valid90 >= 0.8)]
    return r3(float(np.percentile(v, 0.5)), 1)


def nisar_verdict(st):
    """Plain-word reading of how a place's NISAR stack compares with its Sentinel-1 map."""
    if not st or st.get("r") is None:
        return "none"
    noise = st.get("noise_mmyr") or 0
    if st.get("s1_spread", 0) < max(2.0, noise):
        return "quiet"  # the ground barely moves, so there is nothing for the two sensors to agree on
    return "strong" if st["r"] >= 0.75 else "moderate" if st["r"] >= 0.4 else "weak"


def nisar_layer(site, ndir, L):
    """Add the stacked NISAR rate layer and its agreement statistics, if the place has been processed."""
    rp, jp = os.path.join(ndir, "rate.npz"), os.path.join(ndir, "nisar.json")
    if not (os.path.exists(rp) and os.path.exists(jp)):
        return None
    st = json.load(open(jp))
    N = np.load(rp)
    nv = np.where(N["mean_coh"] >= 0.3, N["los_rate_mmyr"], np.nan).astype("float32")
    y = N["y"]
    if y[0] < y[-1]:
        nv, y = nv[::-1], y[::-1]
    f = lambda d: f"{d[:4]}-{d[4:6]}"
    L["nisar"] = layer(site, "nisar", Grid(N["x"], y, int(N["epsg"])), nv, 10, label=f"NISAR rate {f(st['first'])} to {f(st['last'])}", unit="mm/yr", kind="rate",
                       period=f"{f(st['first'])} to {f(st['last'])}", sensor="NISAR L-band (GUNW, provisional)",
                       caveat=f"{st['pairs']} pairs stacked, line of sight. Single 12-day pairs are too noisy to read alone.")
    st["verdict"] = nisar_verdict(st)
    return st


def fit_rate(cum, t, nmin):
    """nan-aware least-squares slope per pixel; cum (T, r, c) -> units of cum per year"""
    tt = (t - t.mean()).astype("float64")
    w = np.isfinite(cum)
    y = np.where(w, cum, 0).astype("float64")
    T = tt[:, None, None] * w
    n = w.sum(0)
    st, sy = T.sum(0), y.sum(0)
    stt, sty = (T * tt[:, None, None]).sum(0), (T * y).sum(0)
    with np.errstate(all="ignore"):
        b = (sty - st * sy / n) / (stt - st ** 2 / n)
    return np.where(n >= nmin, b, np.nan).astype("float32")


class Grid:
    """A north-up source grid given by pixel-centre coordinate vectors."""

    def __init__(self, x, y, epsg):
        self.x, self.y, self.epsg = np.asarray(x, float), np.asarray(y, float), int(epsg)
        assert self.y[0] > self.y[-1], "expected north-up (y decreasing)"
        self.dx, self.dy = self.x[1] - self.x[0], self.y[0] - self.y[1]
        self.transform = from_origin(self.x[0] - self.dx / 2, self.y[0] + self.dy / 2, self.dx, self.dy)
        self.bounds = (self.x[0] - self.dx / 2, self.y[-1] - self.dy / 2, self.x[-1] + self.dx / 2, self.y[0] + self.dy / 2)
        tr = pyproj.Transformer.from_crs(self.epsg, 4326, always_xy=True)
        self.lat0 = tr.transform((self.bounds[0] + self.bounds[2]) / 2, (self.bounds[1] + self.bounds[3]) / 2)[1]
        self.dst = None

    def target(self):
        if self.dst is None:
            res = self.dx / np.cos(np.radians(self.lat0))  # keep roughly the same ground size
            self.dst = calculate_default_transform(f"EPSG:{self.epsg}", "EPSG:3857", len(self.x), len(self.y), *self.bounds, resolution=res)
        return self.dst

    def warp(self, arr, resampling=Resampling.bilinear):
        tr, w, h = self.target()
        a = np.asarray(arr, "float32")
        out = np.full(a.shape[:-2] + (h, w), np.nan, "float32")
        reproject(a, out, src_transform=self.transform, src_crs=f"EPSG:{self.epsg}", dst_transform=tr, dst_crs="EPSG:3857",
                  src_nodata=np.nan, dst_nodata=np.nan, resampling=resampling)
        return out, tr

    def lonlat_box(self):
        tr = pyproj.Transformer.from_crs(self.epsg, 4326, always_xy=True)
        b = self.bounds
        xs, ys = tr.transform([b[0], b[2], b[0], b[2]], [b[1], b[1], b[3], b[3]])
        return [min(xs), min(ys), max(xs), max(ys)]


def write_bin(name, arr, scale):
    a = np.asarray(arr, "float64") * scale
    q = np.where(np.isfinite(a), np.clip(np.rint(a), -32767, 32767), NODATA).astype("<i2")
    q.tofile(os.path.join(OUT, name))
    return q


def layer(site, key, grid, arr, scale, resampling=Resampling.bilinear, **meta):
    w, tr = grid.warp(arr, resampling)
    fn = f"{site}_{key}.bin"
    write_bin(fn, w, scale)
    d = dict(file=fn, w=int(w.shape[-1]), h=int(w.shape[-2]), x0=tr.c, y0=tr.f, px=tr.a, scale=scale, nodata=NODATA)
    d.update(meta)
    fin = w[np.isfinite(w)]
    print(f"  {fn:34s} {w.shape}  valid {np.isfinite(w).mean():.0%}  range {fin.min():.1f}..{fin.max():.1f}" if fin.size else f"  {fn} EMPTY")
    return d


def cube(site, grid, arr, dates, scale=5):
    w, tr = grid.warp(arr, Resampling.bilinear)
    fn = f"{site}_ts.bin"
    write_bin(fn, w, scale)
    print(f"  {fn:34s} {w.shape}  {os.path.getsize(os.path.join(OUT, fn)) / 1e6:.1f} MB")
    return dict(file=fn, n=int(w.shape[0]), w=int(w.shape[2]), h=int(w.shape[1]), x0=tr.c, y0=tr.f, px=tr.a, scale=scale, nodata=NODATA,
                dates=[str(d) for d in dates], decyear=[round(decyear(d), 4) for d in dates])


def quantiles(a, mask=None):
    v = a[np.isfinite(a) & (mask if mask is not None else True)]
    q = np.quantile(v, np.linspace(0, 1, 201))
    return [round(float(x), 3) for x in q], int(v.size)


# ---------------------------------------------------------------- vectors
def enc_line(coords):
    """delta-encode lon/lat pairs as integers of 1e-5 degrees"""
    out, px, py = [], 0, 0
    for lon, lat in coords:
        x, y = int(round(lon * 1e5)), int(round(lat * 1e5))
        out += [x - px, y - py]
        px, py = x, y
    return out


def clip_lines(coords, bb):
    g = LineString(coords).intersection(sbox(*bb))
    if g.is_empty:
        return []
    geoms = [g] if g.geom_type == "LineString" else [p for p in getattr(g, "geoms", []) if p.geom_type == "LineString"]
    return [list(p.coords) for p in geoms if p.length > 0]


TIGER_CLASS = {"S1100": "Highway", "S1200": "Main road", "S1400": "Local road", "S1500": "4WD track", "S1630": "Ramp",
               "S1640": "Service road", "S1730": "Alley", "S1740": "Private road", "S1750": "Private road", "S1780": "Parking road",
               "S1820": "Path"}


def roads_group(path, keep=None, label="Roads"):
    j = json.load(open(path, encoding="utf-8"))
    names, feats, ix = [], [], {}
    for f in j["features"]:
        p = f["properties"]
        if keep and p["MTFCC"] not in keep:
            continue
        nm = p.get("FULLNAME") or "Unnamed road"
        if nm not in ix:
            ix[nm] = len(names); names.append(nm)
        feats.append([ix[nm], TIGER_CLASS.get(p["MTFCC"], "Road"), enc_line(f["geometry"]["coordinates"])])
    return dict(id="roads", label=label, kind="road", source="US Census TIGER/Line 2024", names=names, f=feats)


def osm_groups(site, bb):
    p = os.path.join(HERE, "cache", f"osm_{site}.json")
    if not os.path.exists(p):
        print("  (no OSM cache for", site, "- run fetch_osm.py)")
        return []
    els = json.load(open(p))["elements"]
    spec = [("road", "Highways and main roads", lambda t: t.get("highway") in ("motorway", "trunk", "primary")), ("rail", "Rail", lambda t: "railway" in t), ("pipeline", "Pipelines", lambda t: t.get("man_made") == "pipeline"),
            ("power", "Power lines", lambda t: t.get("power") == "line"), ("canal", "Canals", lambda t: t.get("waterway") == "canal")]
    groups = []
    for kind, label, test in spec:
        names, feats, ix = [], [], {}
        for e in els:
            t = e.get("tags", {})
            if not test(t) or "geometry" not in e:
                continue
            if kind == "rail" and t.get("service") in ("spur", "yard", "siding", "crossover"):
                continue
            if kind == "pipeline" and t.get("substance") in ("drain", "water", "sewage", "wastewater", "rainwater", "irrigation"):
                continue
            if kind == "pipeline":
                nm = t.get("name") or (t.get("operator", "Pipeline") + (" " + t["substance"] if t.get("substance") else ""))
            elif kind == "power":
                kv = t.get("voltage", "").split(";")[0]
                nm = t.get("name") or ((t.get("operator:short") or t.get("operator") or "Power line") + (f" {int(kv) // 1000} kV" if kv.isdigit() else ""))
            elif kind == "road":
                nm = t.get("name") or t.get("ref") or "Unnamed road"
            else:
                nm = t.get("name") or t.get("operator") or label[:-1]
            sub = {"road": {"motorway": "Highway", "trunk": "Highway", "primary": "Main road"}.get(t.get("highway"), "Road"), "rail": t.get("usage", "rail"), "pipeline": t.get("substance", "pipeline"), "power": "transmission", "canal": "canal"}[kind]
            for part in clip_lines([(g["lon"], g["lat"]) for g in e["geometry"]], bb):
                if nm not in ix:
                    ix[nm] = len(names); names.append(nm)
                feats.append([ix[nm], sub, enc_line(part)])
        if feats:
            groups.append(dict(id="roads" if kind == "road" else kind, label=label, kind=kind, source="OpenStreetMap contributors (ODbL)", names=names, f=feats))
            print(f"  osm {kind}: {len(feats)} lines")
    return groups


def line_features(path, bb, keep=lambda p: True, props=lambda p: {}, tol=3e-5):
    out = []
    for f in json.load(open(path, encoding="utf-8"))["features"]:
        p = f["properties"]
        if not keep(p):
            continue
        geom = f["geometry"]
        parts = geom["coordinates"] if geom["type"] == "MultiLineString" else [geom["coordinates"]]
        for coords in parts:
            if len(coords) < 2:
                continue
            g = LineString([c[:2] for c in coords]).simplify(tol)
            for part in clip_lines(list(g.coords), bb):
                out.append(dict(p=enc_line(part), **props(p)))
    return out


def dump(name, obj):
    p = os.path.join(OUT, name)
    json.dump(obj, open(p, "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
    print(f"  {name:34s} {os.path.getsize(p) / 1e6:.2f} MB")


def r3(x, n=3):
    return None if x is None or not np.isfinite(x) else round(float(x), n)


SITES, VAL = [], {}


# ================================================================ WILLCOX
def willcox():
    print("WILLCOX")
    W = os.path.join(DATA, "willcox")
    P = np.load(os.path.join(W, "derived", "derived_products.npz"))
    x90, y90 = P["x90"], P["y90"]
    g90 = Grid(x90, y90, 32612)
    g270 = Grid(bcoord(x90, 3), bcoord(y90, 3), 32612)
    v90, v90pre = P["rate_vert_2016_2026_90m"].astype("float32"), P["rate_vert_2016_2022_90m"].astype("float32")
    un, v270 = unevenness(v90)
    unpre, _ = unevenness(v90pre)
    # the build must reproduce the cached research product exactly
    ref = P["grad_rate_2016_2026_270m"]
    assert np.nanmax(np.abs(un - ref)) < 1e-3, "unevenness() differs from s12_derived.py"
    vf30 = np.load(os.path.join(W, "derived", "cum_los_30m_ministack_ends.npz"))["valid_frac"]
    valid90 = bmean(vf30, 3)
    dem = np.load(os.path.join(W, "inputs", "dem_90m.npz"))
    floor270 = (bmean(dem["slope_deg"], 3) < 2) & (bmean(dem["elev_m"], 3) < 1450) & np.isfinite(un) & np.isfinite(v270)
    q, n = quantiles(un, floor270)
    print("  basin-floor cells at 270 m:", n, "(forward test used 31,990)  P95 unevenness:", q[190])
    L = {}
    L["rate"] = layer("willcox", "rate", g90, v90, 10, label="Sinking rate 2016-2026", unit="mm/yr", kind="rate", period="2016-07 to 2026-04", sensor="Sentinel-1 (OPERA DISP-S1)")
    L["rate_pre"] = layer("willcox", "rate_pre", g90, v90pre, 10, label="Sinking rate 2016-2022", unit="mm/yr", kind="rate", period="2016-07 to 2022-10", sensor="Sentinel-1 (OPERA DISP-S1)")
    valid270 = bmean(valid90, 3)
    un_show, unpre_show = mask_rims(un, valid270, v270), mask_rims(unpre, valid270, v270)
    print("  rim mask blanks", int(np.isfinite(un).sum() - np.isfinite(un_show).sum()), "of", int(np.isfinite(un).sum()), "unevenness cells")
    L["uneven"] = layer("willcox", "uneven", g270, un_show, 10, Resampling.nearest, label="Unevenness 2016-2026", unit="mm/yr per km", kind="uneven", period="2016-07 to 2026-04", sensor="Sentinel-1 (OPERA DISP-S1)")
    L["uneven_pre"] = layer("willcox", "uneven_pre", g270, unpre_show, 10, Resampling.nearest, label="Unevenness 2016-2022", unit="mm/yr per km", kind="uneven", period="2016-07 to 2022-10", sensor="Sentinel-1 (OPERA DISP-S1)")
    L["valid"] = layer("willcox", "valid", g90, valid90, 100, label="Share of dates with good data", unit="fraction", kind="valid")
    # NISAR chained cumulative -> rate (provisional, noisy at this site)
    N = np.load(os.path.join(W, "nisar_gunw", "nisar_chain_cum_los_90m.npz"))
    tn = np.array([decyear(d) for d in N["dates"]])
    nrate = fit_rate(N["cum"] * 1000.0, tn, 18) / np.cos(np.radians(43.0))
    L["nisar"] = layer("willcox", "nisar", g90, nrate, 10, label="NISAR rate Nov 2025 - Oct 2026", unit="mm/yr", kind="rate", period="2025-11 to 2026-10",
                       sensor="NISAR L-band (GUNW, provisional)", caveat="Provisional and noisy here: agrees only loosely with Sentinel-1 (rate-map r = 0.51).")
    both = np.isfinite(nrate) & np.isfinite(v90)
    print("  NISAR rate valid:", f"{np.isfinite(nrate).mean():.0%}", " r vs S1 2016-26 rate:", round(float(np.corrcoef(nrate[both], v90[both])[0, 1]), 2))
    # time series: ~36 dates at 270 m, vertical-equivalent mm
    C = np.load(os.path.join(W, "derived", "cum_los_90m_all_dates.npz"))
    dates = [str(d) for d in C["dates"]]
    idx = sorted(set(np.rint(np.linspace(0, len(dates) - 1, 36)).astype(int).tolist()))
    cols90 = 4608 + 1.5 + 3 * np.arange(len(x90))
    cos90 = np.cos(np.radians(46.0 - 15.1 * cols90 / 9662))[None, :]
    cum = C["cum"]
    sub = np.stack([bmedian(cum[i] / cos90 * 1000.0, 3) for i in idx])
    del cum
    ts = cube("willcox", g270, sub, [dates[i] for i in idx])
    ts["unit"] = "mm, vertical-equivalent"
    bb = g90.lonlat_box()
    # ---- lines
    groups = [roads_group(os.path.join(W, "inputs", "roads_segments_300m.geojson"), label="Roads")] + osm_groups("willcox", bb)
    dump("willcox_lines.json", dict(groups=groups))
    # ---- overlays
    new = line_features(os.path.join(W, "inputs", "fissures_new_since_2023.geojson"), bb, props=lambda p: dict(s=1 if p.get("surveyed") else 0))
    old = line_features(os.path.join(W, "inputs", "fissures_azgs_2023.geojson"), bb)
    bmgeo = {f["properties"]["Station"]: f["geometry"]["coordinates"] for f in
             json.load(open(os.path.join(W, "inputs", "benchmarks_adwr_gnss.geojson")))["features"]}
    bms = []
    for r in csv.DictReader(open(os.path.join(ROOT, "research_scripts", "willcox", "out", "benchmarks_vs_insar.csv"))):
        lon, lat = bmgeo.get(r["station"], (float(r["lon"]), float(r["lat"])))[:2]
        bms.append(dict(name=r["station"], lon=round(lon, 5), lat=round(lat, 5), first=int(r["first"]), last=int(r["last"]),
                        total_m=float(r["bm_total_m"]), bm=float(r["bm_rate_mmyr"]), radar=float(r["insar_vert_mmyr"])))
    dump("willcox_overlays.json", dict(
        fissures_known=dict(label="Fissures mapped by Jan 2023", source="Arizona Geological Survey", f=old),
        fissures_new=dict(label="Fissures added Jan 2023 - May 2026", source="Arizona Geological Survey", f=new),
        benchmarks=bms,
        reference=[dict(name="Dragoon Mts bedrock reference", lon=lo, lat=la) for lo, la in [(-109.965, 31.925), (-109.99, 31.87), (-110.00, 31.99)]]))
    # ---- validation numbers (recomputed)
    b = np.array([m["bm"] for m in bms]); rr = np.array([m["radar"] for m in bms])
    rec = np.array([m["first"] >= 2005 for m in bms])
    sl = stats.linregress(b[rec], rr[rec])
    VAL["willcox_benchmarks"] = dict(
        rows=bms, n=len(bms), spearman=r3(stats.spearmanr(b, rr)[0]), pearson=r3(stats.pearsonr(b, rr)[0]),
        n_recent=int(rec.sum()), spearman_recent=r3(stats.spearmanr(b[rec], rr[rec])[0]), slope_recent=r3(sl.slope),
        note="Benchmark rate = total survey change / years between first and last survey (some since 1943-1991). Radar = 2016-2026 vertical-equivalent rate at the benchmark.")
    rows = list(csv.DictReader(open(os.path.join(W, "p1_forward_test", "results.csv"))))
    def pick(domain):
        out = []
        for r in rows:
            if r["grid"] == "270m" and r["positives"].startswith("A_") and r["domain"] == domain:
                out.append(dict(score=r["score"], auc=r3(float(r["auc"])), auc_matched=r3(float(r["auc_rate_matched"])) if r["auc_rate_matched"] else None,
                                null95=r3(float(r["null95_block2km"])) if r["null95_block2km"] else None, n_pos=int(float(r["n_pos"])), n_dom=int(float(r["n_dom"])),
                                lift5=r3(float(r["lift_top5"]), 1) if r["lift_top5"] else None, prec5=r3(float(r["prec_top5"]), 4) if r["prec_top5"] else None,
                                recall5=r3(float(r["recall_top5"]), 3) if r["recall_top5"] else None))
        return out
    domains = sorted({r["domain"] for r in rows})
    VAL["willcox_forward"] = dict(all=pick("all_basin_floor"), new_ground=pick([d for d in domains if d != "all_basin_floor"][0]),
                                  note="Rate map from 13 dates before 2023 only. Positives: field-surveyed fissures added to the state map between Jan 2023 and May 2026 (65 features, 32 cells of 270 m).")
    a90 = 0.09 * 0.09
    summary = dict(peak_mmyr=r3(np.nanmin(v270), 1), peak90_mmyr=r3(np.nanmin(v90), 1), fast_mmyr=fast(v90, valid90), area_gt50_km2=r3(float((v90 < -50).sum() * a90), 0),
                   valid_share=r3(float((valid90 >= 0.5).mean()), 3))
    print("  summary", summary)
    SITES.append(dict(
        id="willcox", name="Willcox Basin", region="Cochise County, Arizona", role="Validated core", tier="checked", check="38 survey benchmarks and a forward fissure test", bbox=[round(v, 5) for v in bb],
        center=[-109.86, 32.22], zoom=9.6, rate_kind="vertical-equivalent", layers=L, ts=ts, uneven_q=q, uneven_q_n=n,
        uneven_q_domain="basin-floor cells (slope < 2 deg, below 1450 m)", lines="willcox_lines.json", overlays="willcox_overlays.json",
        st="AZ", nisar=dict(track="128", frame="072", dir="D", pairs=24, first="20251107", last="20261021", r=0.51, verdict="moderate",
                            note="Rate-map correlation over the months both sensors cover; 3 to 19 mm of noise per pair; often no data at the fastest spot."),
        summary=summary, sensor="Sentinel-1 via OPERA DISP-S1, frame 34478", reference="Median of three Dragoon Mountains bedrock patches",
        default_groups=["roads", "rail", "pipeline", "power"]))


# ================================================================ MEXICO CITY
def mexico():
    print("MEXICO CITY")
    M = os.path.join(DATA, "mexico")
    D = np.load(os.path.join(M, "opera_derived.npz"))
    x, y = D["x"], D["y"]
    good = D["good_mask"]
    v30 = np.where(good, D["vert_equiv_full_mmyr"], np.nan).astype("float32")
    v90 = bmean(v30, 3)
    v90[bmean(good.astype("float32"), 3) < 0.45] = np.nan
    valid90 = bmean(good.astype("float32"), 3)
    g90 = Grid(bcoord(x, 3), bcoord(y, 3), 32614)
    g270 = Grid(bcoord(bcoord(x, 3), 3), bcoord(bcoord(y, 3), 3), 32614)
    un, v270 = unevenness(v90)
    un = mask_rims(un, bmean(valid90, 3), v270)
    q, n = quantiles(un)
    L = {}
    L["rate"] = layer("mexico", "rate", g90, v90, 10, label="Sinking rate 2016-2026", unit="mm/yr", kind="rate", period="2016-07 to 2026-02", sensor="Sentinel-1 (OPERA DISP-S1)")
    L["uneven"] = layer("mexico", "uneven", g270, un, 10, Resampling.nearest, label="Unevenness 2016-2026", unit="mm/yr per km", kind="uneven", period="2016-07 to 2026-02", sensor="Sentinel-1 (OPERA DISP-S1)")
    L["valid"] = layer("mexico", "valid", g90, valid90, 100, label="Share of pixels passing the quality mask", unit="fraction", kind="valid")
    N = np.load(os.path.join(M, "nisar_rate.npz"))
    nv = np.where(N["mean_coh"] >= 0.5, N["vert_equiv_mmyr"], np.nan).astype("float32")
    gN = Grid(N["x"], N["y"], int(N["epsg"]))
    L["nisar"] = layer("mexico", "nisar", gN, nv, 10, label="NISAR rate Oct 2025 - Oct 2026", unit="mm/yr", kind="rate", period="2025-10 to 2026-10",
                       sensor="NISAR L-band (GUNW, provisional)", caveat="28 pairs stacked. Single 12-day pairs are too noisy to read alone.")
    # NISAR vs Sentinel-1 density for the chart
    ov = N["opera_vert_on_nisar_grid"]
    ok = np.isfinite(nv) & np.isfinite(ov)
    sl = stats.linregress(ov[ok], nv[ok])
    H, xe, ye = np.histogram2d(ov[ok], nv[ok], bins=[60, 60], range=[[-400, 40], [-400, 40]])
    VAL["mexico_nisar"] = dict(n=int(ok.sum()), r=r3(sl.rvalue), slope=r3(sl.slope), rmsd=r3(float(np.sqrt(np.mean((nv[ok] - ov[ok]) ** 2))), 1),
                               lo=-400, hi=40, bins=60, counts=H.astype(int).tolist(),
                               note="Each cell counts 80 m pixels. Sentinel-1 covers 2016-2026, NISAR 2025-2026, so the spread mixes noise with real change.")
    # time series cube: ministack-end dates at 270 m, vertical-equivalent
    Cz = np.load(os.path.join(M, "opera_cumulative_los_refTNGF.npz"))
    alld = [str(d) for d in Cz["dates"]]
    full = [str(d) for d in D["full_dates"]]
    idx = [alld.index(d) for d in full if d in alld]
    los_up = D["los_enu"][2]
    cum = Cz["cum_los_mm"]
    good9 = bmean(good.astype("float32"), 9) >= 0.45
    sub = []
    for i in idx:
        s = bmean(np.where(good, cum[i] / los_up, np.nan), 9)
        s[~good9] = np.nan
        sub.append(s)
    del cum
    ts = cube("mexico", g270, np.stack(sub), [alld[i] for i in idx])
    ts["unit"] = "mm, vertical-equivalent"
    bb = g90.lonlat_box()
    # ---- lines: the 12 Metro lines, already cut along route geometry
    names, feats, ix = [], [], {}
    for f in json.load(open(os.path.join(M, "metro_segments.geojson"), encoding="utf-8"))["features"]:
        p = f["properties"]
        nm = f"Metro Line {p['line']}"
        if nm not in ix:
            ix[nm] = len(names); names.append(nm)
        feats.append([ix[nm], p["structure"], enc_line(f["geometry"]["coordinates"])])
    dump("mexico_lines.json", dict(groups=[dict(id="metro", label="Metro (12 lines)", kind="rail", source="OpenStreetMap contributors (ODbL)", names=names, f=feats)]))
    # ---- overlays + GPS validation
    gps = []
    for r in csv.DictReader(open(os.path.join(M, "validation_opera_vs_gps_2017-12_2019-03.csv"))):
        if not r["lat"]:
            continue
        gps.append(dict(name=r["sta"], lon=round(float(r["lon"]), 5), lat=round(float(r["lat"]), 5), radar=float(r["opera_los_mmyr"]),
                        gps=float(r["gps_los_mmyr"]) if r["gps_los_mmyr"] else None, gps_up=float(r["gps_u_mmyr"]) if r["gps_u_mmyr"] else None,
                        resid=float(r["opera_resid_mm"])))
    st = [dict(name=f["properties"]["name"], lon=round(f["geometry"]["coordinates"][0], 5), lat=round(f["geometry"]["coordinates"][1], 5))
          for f in json.load(open(os.path.join(M, "inputs", "metro_stations.geojson"), encoding="utf-8"))["features"] if f["properties"].get("name")]
    dump("mexico_overlays.json", dict(gps=gps, stations=st, reference=[dict(name="GPS station TNGF (reference)", lon=-99.1767, lat=19.3269)]))
    have = [g for g in gps if g["gps"] is not None]
    a, b = np.array([g["gps"] for g in have]), np.array([g["radar"] for g in have])
    sl = stats.linregress(a, b)
    keep = np.array([g["name"] not in ("MMX1", "MXTM") for g in have])
    VAL["mexico_gps"] = dict(rows=gps, n=len(have), r=r3(sl.rvalue), slope=r3(sl.slope, 2), rmse=r3(float(np.sqrt(np.mean((b - a) ** 2))), 1),
                             bias=r3(float(np.mean(b - a)), 1), rmse_without_fastest_two=r3(float(np.sqrt(np.mean((b[keep] - a[keep]) ** 2))), 1),
                             note="Radar and GPS both along the radar line of sight, both relative to station TNGF, Dec 2017 to Mar 2019 (71 radar dates).")
    summary = dict(peak_mmyr=r3(np.nanmin(v270), 1), fast_mmyr=fast(v90, valid90), valid_share=r3(float(good.mean()), 3))
    print("  summary", summary, " GPS:", {k: VAL['mexico_gps'][k] for k in ('n', 'r', 'slope', 'rmse', 'bias')}, " NISAR r:", VAL["mexico_nisar"]["r"])
    SITES.append(dict(
        id="mexico", name="Mexico City", region="Valley of Mexico", role="Proof it transfers", tier="checked", check="9 GPS stations", bbox=[round(v, 5) for v in bb],
        center=[-99.06, 19.40], zoom=10.6, rate_kind="vertical-equivalent", layers=L, ts=ts, uneven_q=q, uneven_q_n=n,
        uneven_q_domain="all cells passing the quality mask", lines="mexico_lines.json", overlays="mexico_overlays.json", summary=summary,
        st="MX", nisar=dict(track="019", frame="011", dir="A", pairs=28, first="20251030", last="20261013", r=VAL["mexico_nisar"]["r"], slope=VAL["mexico_nisar"]["slope"],
                            n=VAL["mexico_nisar"]["n"], rmsd=VAL["mexico_nisar"]["rmsd"], verdict="strong", note="At the fastest GPS station NISAR reads -279 mm/yr; GPS says -262 to -268."),
        sensor="Sentinel-1 via OPERA DISP-S1, frame 20688", reference="GPS station TNGF", default_groups=["metro"]))


# ================================================================ PHOENIX
def phoenix():
    print("PHOENIX")
    Ph = os.path.join(DATA, "phoenix")
    rows = list(csv.DictReader(open(os.path.join(Ph, "inputs", "adwr_vs_opera.csv"))))
    bms = [dict(name=r["Station"], lon=round(float(r["lon"]), 5), lat=round(float(r["lat"]), 5), first=int(float(r["First_Date"])), last=int(float(r["Last_Date"])),
                bm=round(float(r["adwr_rate_mm_yr"]), 2), radar=round(float(r["opera_rate_mm_yr"]), 2)) for r in rows]
    a, b = np.array([m["bm"] for m in bms]), np.array([m["radar"] for m in bms])
    VAL["phoenix_benchmarks"] = dict(rows=bms, n=len(bms), spearman=r3(stats.spearmanr(a, b)[0]),
                                     note="Survey rates are multi-decade vertical averages (mostly 1997 onward); radar is 2016-2026 along the line of sight. Rank agrees; sizes are not comparable.")
    for bx, nm, ctr, zoom, keepc in [("east", "Phoenix East Valley", [-111.62, 33.33], 10.6, None), ("west", "Phoenix West Valley", [-112.40, 33.57], 10.8, None)]:
        Mz = np.load(os.path.join(Ph, "opera_7091", f"{bx}_maps.npz"))
        x, y = Mz["x"], Mz["y"]
        v90 = bmean(Mz["rate_mm_yr"], 3)
        valid90 = bmean(Mz["valid_epoch_frac"], 3)
        v90[bmean(np.isfinite(Mz["rate_mm_yr"]).astype("float32"), 3) < 0.45] = np.nan
        g90 = Grid(bcoord(x, 3), bcoord(y, 3), 32612)
        g270 = Grid(bcoord(bcoord(x, 3), 3), bcoord(bcoord(y, 3), 3), 32612)
        un, v270 = unevenness(v90)
        un = mask_rims(un, bmean(bmean(np.isfinite(Mz["rate_mm_yr"]).astype("float32"), 3), 3), v270)
        q, n = quantiles(un)
        site = f"phoenix_{bx}"
        L = {}
        L["rate"] = layer(site, "rate", g90, v90, 10, label="Sinking rate 2016-2026", unit="mm/yr", kind="rate", period="2016-07 to 2026-02", sensor="Sentinel-1 (OPERA DISP-S1)")
        L["uneven"] = layer(site, "uneven", g270, un, 10, Resampling.nearest, label="Unevenness 2016-2026", unit="mm/yr per km", kind="uneven", period="2016-07 to 2026-02", sensor="Sentinel-1 (OPERA DISP-S1)")
        L["valid"] = layer(site, "valid", g90, valid90, 100, label="Share of dates with good data", unit="fraction", kind="valid")
        nis = nisar_layer(site, os.path.join(Ph, f"nisar_{bx}"), L)
        S = np.load(os.path.join(Ph, "opera_7091", f"{bx}_series.npz"))
        ts = cube(site, g270, bmean(S["cum_mm"], 9), [str(d) for d in S["dates"]])
        ts["unit"] = "mm, line of sight"
        bb = g90.lonlat_box()
        groups = [roads_group(os.path.join(Ph, "inputs", f"road_segments_{bx}.geojson"), keep={"S1100", "S1200"}, label="Highways and main roads")] + osm_groups(site, bb)
        dump(f"{site}_lines.json", dict(groups=groups))
        fis = line_features(os.path.join(Ph, "inputs", f"azgs_fissures_{bx}.geojson"), bb)
        refs = dict(east=[("Usery Mtn", -111.620, 33.470), ("Goldfield Mtns SW", -111.520, 33.455), ("San Tan Mtns", -111.640, 33.165)],
                    west=[("White Tank foothills", -112.500, 33.580), ("White Tank E", -112.480, 33.600)])[bx]
        dump(f"{site}_overlays.json", dict(fissures_known=dict(label="Mapped earth fissures (May 2026)", source="Arizona Geological Survey", f=fis),
                                           benchmarks=bms if bx == "east" else [],
                                           reference=[dict(name=f"{a_} (bedrock reference)", lon=lo, lat=la) for a_, lo, la in refs]))
        # peak on a 5x5 median, as in the research script
        from scipy.ndimage import median_filter
        pk = float(np.nanmin(median_filter(np.nan_to_num(Mz["rate_mm_yr"], nan=0.0), 5)))
        summary = dict(peak_mmyr=r3(pk, 1), fast_mmyr=fast(v90, valid90), valid_share=r3(float(np.isfinite(Mz["rate_mm_yr"]).mean()), 3))
        print("  ", bx, "summary", summary)
        SITES.append(dict(
            id=site, name=nm, region="Maricopa and Pinal counties, Arizona", role="Home site" if bx == "east" else "Measured, not ground-checked",
            tier="checked" if bx == "east" else "measured", check="26 survey benchmarks, ranking only" if bx == "east" else None, bbox=[round(v, 5) for v in bb], center=ctr, zoom=zoom,
            rate_kind="line of sight", layers=L, ts=ts, uneven_q=q, uneven_q_n=n, uneven_q_domain="all cells with a rate", st="AZ", nisar=nis,
            lines=f"{site}_lines.json", overlays=f"{site}_overlays.json", summary=summary, sensor="Sentinel-1 via OPERA DISP-S1, frame 7091",
            reference="Median of bedrock windows (" + ", ".join(r_[0] for r_ in refs) + ")", default_groups=["roads", "canal", "rail", "pipeline"]))


# ================================================================ SITES ADDED WITH add_site.py (measured, not ground-checked)
PLACES = {k: v for k, v in json.load(open(os.path.join(HERE, "places.json"))).items() if not k.startswith("_")}
EXTRA = {k: (v["center"], v["zoom"]) for k, v in PLACES.items()}


def extra():
    from scipy.ndimage import median_filter
    for site, (ctr, zoom) in EXTRA.items():
        d = os.path.join(DATA, site)
        if not os.path.exists(os.path.join(d, "meta.json")):
            print("EXTRA", site, "- not fetched, skipped"); continue
        print("EXTRA", site)
        meta = json.load(open(os.path.join(d, "meta.json")))
        if meta["epochs"] < 9 or meta["with_rate"] < 0.03:
            print("   rejected by the quality gate:", {k: meta[k] for k in ("epochs", "with_rate")}); continue
        Mz = np.load(os.path.join(d, "maps.npz"))
        x, y, epsg = Mz["x"], Mz["y"], int(Mz["epsg"])
        r30 = Mz["rate_mm_yr"]
        has = np.isfinite(r30).astype("float32")
        v90 = bmean(r30, 3)
        v90[bmean(has, 3) < 0.45] = np.nan
        valid90 = bmean(Mz["valid_epoch_frac"], 3)
        g90 = Grid(bcoord(x, 3), bcoord(y, 3), epsg)
        g270 = Grid(bcoord(bcoord(x, 3), 3), bcoord(bcoord(y, 3), 3), epsg)
        un, v270 = unevenness(v90)
        un = mask_rims(un, bmean(bmean(has, 3), 3), v270)
        q, n = quantiles(un)
        per = f"{meta['first'][:4]}-{meta['first'][4:6]} to {meta['last'][:4]}-{meta['last'][4:6]}"
        yrs = f"{meta['first'][:4]}-{meta['last'][:4]}"
        L = {}
        L["rate"] = layer(site, "rate", g90, v90, 10, label=f"Sinking rate {yrs}", unit="mm/yr", kind="rate", period=per, sensor="Sentinel-1 (OPERA DISP-S1)")
        L["uneven"] = layer(site, "uneven", g270, un, 10, Resampling.nearest, label=f"Unevenness {yrs}", unit="mm/yr per km", kind="uneven", period=per, sensor="Sentinel-1 (OPERA DISP-S1)")
        L["valid"] = layer(site, "valid", g270, bmean(valid90, 3), 100, label="Share of dates with good data", unit="fraction", kind="valid")
        nis = nisar_layer(site, os.path.join(d, "nisar"), L)
        S = np.load(os.path.join(d, "series.npz"))
        ts = cube(site, g270, bmean(S["cum_mm"], 9), [str(t) for t in S["dates"]])
        ts["unit"] = "mm, line of sight"
        bb = g90.lonlat_box()
        dump(f"{site}_lines.json", dict(groups=osm_groups(site, bb)))
        ov = dict(reference=[])
        fp = os.path.join(HERE, "cache", f"fissures_{site}.geojson")
        if os.path.exists(fp):
            ov["fissures_known"] = dict(label="Mapped earth fissures (May 2026)", source="Arizona Geological Survey", f=line_features(fp, bb))
        dump(f"{site}_overlays.json", ov)
        pk = float(np.nanmin(np.where(np.isfinite(r30), median_filter(np.nan_to_num(r30, nan=0.0), 5), np.nan)))
        fin = v90[np.isfinite(v90)]
        summary = dict(peak_mmyr=r3(pk, 1), fast_mmyr=fast(v90, valid90), p01_mmyr=r3(float(np.percentile(fin, 1)), 1), valid_share=r3(float(np.isfinite(r30).mean()), 3))
        print("   summary", summary, "P95 unevenness", q[190])
        SITES.append(dict(
            id=site, name=meta["name"], region=meta["region"], st=PLACES[site].get("st"), nisar=nis, role="Measured, not ground-checked", tier="measured", check=None, bbox=[round(v, 5) for v in bb], center=ctr, zoom=zoom,
            rate_kind="line of sight", layers=L, ts=ts, uneven_q=q, uneven_q_n=n, uneven_q_domain="all cells with a rate", lines=f"{site}_lines.json", overlays=f"{site}_overlays.json",
            summary=summary, sensor=f"Sentinel-1 via OPERA DISP-S1, frame {int(meta['frame'].lstrip('F'))}", reference="The steadiest ground in the window (not bedrock chosen by hand)",
            default_groups=["roads", "canal", "rail", "pipeline"]))


# ================================================================ CHENNAI
def chennai():
    print("CHENNAI")
    Cn = os.path.join(DATA, "chennai", "analysis")
    L = {}
    bb = None
    for tr, nm in [("track149_frame82", "t149"), ("track156_frame8", "t156")]:
        with rasterio.open(os.path.join(Cn, f"cum_los_mm_NOISE_LEVEL_{tr}.tif")) as d:
            a = d.read(1).astype("float32")
            t = d.transform
            x = t.c + t.a * (np.arange(d.width) + 0.5)
            y = t.f + t.e * (np.arange(d.height) + 0.5)
        g = Grid(x, y, 32644)
        bb = g.lonlat_box()
        L[nm] = layer("chennai", nm, g, a, 10, label=f"NISAR cumulative, 3.5 months, track {tr[5:8]} (noise level)", unit="mm", kind="noise",
                      period="2026-06 to 2026-10", sensor="NISAR L-band (GUNW, provisional)", caveat="Noise level. Not a detection.")
    pts = []
    for tr in ["track149_frame82", "track156_frame8"]:
        for r in csv.DictReader(open(os.path.join(Cn, f"points_{tr}.csv"))):
            pts.append(dict(track=tr[5:8], name=r["point"].replace("_", " "), kind=r["kind"], lon=float(r["lon"]), lat=float(r["lat"]),
                            cum=r3(float(r["cum_los_mm_toward"]), 1), sigma=r3(float(r["sigma_cum_mm"]), 1), snr=r3(float(r["snr"]), 1), coh=r3(float(r["coh_median"]), 2)))
    noise = [dict(track=r["track"][5:8], months=r3(float(r["months"]), 2), sigma_pair=r3(float(r["sigma_pair_mm"]), 2), sigma_cum=r3(float(r["sigma_cum_mm"]), 2),
                  mdr_now=r3(float(r["mdr_2sigma_now_mm_yr"]), 1), n_pairs=int(r["n_pairs"])) for r in csv.DictReader(open(os.path.join(Cn, "noise_floor.csv")))]
    mtd = [dict(track=r["track"][5:8], rate=float(r["rate_mm_yr"]), random_walk=float(r["months_random_walk"]), fixed=float(r["months_fixed_floor"]))
           for r in csv.DictReader(open(os.path.join(Cn, "months_to_detect.csv")))]
    VAL["chennai"] = dict(points=pts, noise=noise, months_to_detect=mtd, published=[15, 31.7],
                          note="Smallest detectable rate = 2 sigma / record length. Fixed floor: noise stays at today's level. Random walk: independent pair noise adds up.")
    dump("chennai_overlays.json", dict(points=[p for p in pts if p["track"] == "149"]))
    dump("chennai_lines.json", dict(groups=[]))
    SITES.append(dict(
        id="chennai", name="Chennai", region="Tamil Nadu, India", role="The frontier: NISAR only", tier="frontier", check=None, st="IND",
        nisar=dict(pairs=8, first="20260624", last="20261010", verdict="frontier"), bbox=[round(v, 5) for v in bb], center=[80.22, 13.07], zoom=11.2,
        rate_kind="none", layers=L, ts=None, uneven_q=None, lines="chennai_lines.json", overlays="chennai_overlays.json",
        summary=dict(mdr_now=noise[0]["mdr_now"], months=noise[0]["months"]), sensor="NISAR GUNW, tracks 149 and 156", reference="Median of 8 presumed-stable points",
        default_groups=[], frontier=True))


if __name__ == "__main__":
    only = set(sys.argv[1:])
    for fn in (willcox, mexico, phoenix, extra, chennai):
        if not only or fn.__name__ in only:
            fn()
    if not only:
        us = [s for s in SITES if s.get("st") not in ("MX", "IND", None)]
        def km2(b):
            la = np.radians((b[1] + b[3]) / 2)
            return (b[2] - b[0]) * 111.32 * np.cos(la) * (b[3] - b[1]) * 110.57
        area = sum(km2(s["bbox"]) for s in us)
        cov = dict(places=len(SITES), us_places=len(us), us_states=len({s["st"] for s in us} - {"DC"}), dc=any(s["st"] == "DC" for s in us), us_area_km2=round(area), conus_km2=8081000, us_share=round(area / 8081000, 4),
                   nisar_places=sum(1 for s in SITES if s.get("nisar") and s["nisar"].get("verdict") not in (None, "none")))
        print("COVERAGE", cov)
        VAL["nisar_sites"] = [dict(id=s["id"], name=s["name"], st=s.get("st"), tier=s["tier"], **{k: s["nisar"].get(k) for k in ("r", "n", "pairs", "verdict", "s1_spread", "noise_mmyr", "cover_nisar", "cover_s1")})
                              for s in SITES if s.get("nisar") and s["nisar"].get("r") is not None]
        dump("sites.json", dict(built=datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"), coverage=cov, sites=SITES))
        dump("validation.json", VAL)
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f"TOTAL site/data: {total / 1e6:.1f} MB")
