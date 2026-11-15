"""Add an OPERA DISP-S1 site: find the frame over a lon/lat box, read the ministack-end ("bridge") files by HTTP range
requests, chain them into a cumulative series and fit a rate map.

    .venv/Scripts/python strainwatch/build/add_site.py                # all sites in SITES that are not done yet
    .venv/Scripts/python strainwatch/build/add_site.py pinal houston  # only these

Outputs in data/<site>/:
    cmr.json           granules found over the box, by frame
    raw/<ref>_<sec>.npz  displacement (m, line of sight, + toward satellite), recommended_mask, temporal_coherence, x, y, epsg
    maps.npz           rate_mm_yr (line of sight), valid_epoch_frac, x, y, epsg
    series.npz         cum_mm[t, r, c], dates
    meta.json          frame, pass direction, dates, reference note

These sites are MEASURED BUT NOT GROUND-CHECKED. There are no survey benchmarks, GPS or fissure tests behind them here.
Reference: each date is tied to the steadiest ground in the window (pixels whose first-pass rate lies between the 60th
and 90th percentile), not to bedrock chosen by hand. The unevenness score does not depend on the reference.
"""
import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor

import h5py
import numpy as np
import pyproj
import requests
from shapely.geometry import Polygon, box as sbox

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from httprange import HttpRangeFile, session  # noqa: E402

CMR = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"
# id: (name, region, lon0, lon1, lat0, lat1), from places.json
SITES = {k: (v["name"], v["region"], *v["box"]) for k, v in json.load(open(os.path.join(HERE, "places.json"))).items() if not k.startswith("_")}


def cmr(bbox):
    out, headers = [], {}
    while True:
        for attempt in range(6):
            try:
                r = requests.get(CMR, params=dict(short_name="OPERA_L3_DISP-S1_V1", bounding_box=",".join(map(str, bbox)), page_size=2000),
                                 headers=headers, timeout=300)
                if r.status_code < 500:
                    break
            except requests.RequestException:
                pass
            time.sleep(3 * (attempt + 1))
        r.raise_for_status()
        items = r.json()["items"]
        for it in items:
            u = it["umm"]
            urls = [x["URL"] for x in u.get("RelatedUrls", []) if x.get("Type") == "GET DATA" and x["URL"].startswith("https") and x["URL"].endswith(".nc")]
            try:
                pts = u["SpatialExtent"]["HorizontalSpatialDomain"]["Geometry"]["GPolygons"][0]["Boundary"]["Points"]
                poly = [(p["Longitude"], p["Latitude"]) for p in pts]
            except Exception:
                poly = None
            if urls:
                out.append(dict(name=u["GranuleUR"], url=urls[0], poly=poly))
        sa = r.headers.get("CMR-Search-After")
        if not items or not sa:
            break
        headers = {"CMR-Search-After": sa}
    return out


def choose_frame(grans, bb):
    target = sbox(bb[0], bb[1], bb[2], bb[3])
    frames = {}
    for g in grans:
        p = g["name"].split("_")
        g["frame"], g["ref"], g["sec"], g["prod"] = p[4], p[6][:8], p[7][:8], p[9]
        frames.setdefault(g["frame"], []).append(g)
    best = None
    for f, gs in frames.items():
        poly = next((Polygon(g["poly"]) for g in gs if g["poly"]), None)
        cover = poly.intersection(target).area / target.area if poly is not None and poly.is_valid else 0
        refs = len({g["ref"] for g in gs})
        print(f"   frame {f}: {len(gs)} files, {refs} ministacks, covers {cover:.0%} of the box")
        nb = len(bridges(gs))  # what counts is how many dates actually chain, not how many ministacks are listed
        key = (round(cover, 2) >= 0.9, nb >= 12, round(cover, 2) >= 0.6, nb, cover)
        if best is None or key > best[0]:
            best = (key, f, cover)
    return best[1], frames[best[1]], best[2]


def bridges(gs):
    latest = {}
    for g in sorted(gs, key=lambda g: g["prod"]):
        latest[(g["ref"], g["sec"])] = g
    refs = sorted({k[0] for k in latest})
    out = []
    for i, R in enumerate(refs):
        secs = sorted(k[1] for k in latest if k[0] == R)
        nxt = refs[i + 1] if i + 1 < len(refs) else secs[-1]
        if (R, nxt) in latest:
            out.append(latest[(R, nxt)])
        else:
            break
    return out


def read_window(url, s, bb):
    raw = HttpRangeFile(s, url, block=2 * 1024 * 1024, max_blocks=256)
    with h5py.File(raw, "r") as h:
        x, y = h["x"][:], h["y"][:]
        wkt = h["spatial_ref"].attrs.get("crs_wkt", b"")
        epsg = pyproj.CRS.from_wkt(wkt.decode() if isinstance(wkt, bytes) else wkt).to_epsg()
        tr = pyproj.Transformer.from_crs(4326, epsg, always_xy=True)
        xs, ys = tr.transform([bb[0], bb[2], bb[0], bb[2]], [bb[1], bb[1], bb[3], bb[3]])
        c0, c1 = np.searchsorted(x, min(xs)), np.searchsorted(x, max(xs))
        r0, r1 = np.searchsorted(-y, -max(ys)), np.searchsorted(-y, -min(ys))
        sl = np.s_[r0:r1, c0:c1]
        d = dict(x=x[c0:c1], y=y[r0:r1], epsg=epsg, displacement=h["displacement"][sl].astype("float32"),
                 recommended_mask=h["recommended_mask"][sl].astype("uint8"), temporal_coherence=h["temporal_coherence"][sl].astype("float16"))
        try:
            d["direction"] = h["identification/orbit_pass_direction"][()].decode()
        except Exception:
            d["direction"] = ""
    return d


def fit(cum, t, nmin):
    w = np.isfinite(cum)
    y = np.where(w, cum, 0).astype("float64")
    tt = t - t.mean()
    T = tt[:, None, None] * w
    n = w.sum(0)
    st, sy = T.sum(0), y.sum(0)
    stt, sty = (T * tt[:, None, None]).sum(0), (T * y).sum(0)
    with np.errstate(all="ignore"):
        b = (sty - st * sy / n) / (stt - st ** 2 / n)
    return np.where(n >= nmin, b, np.nan).astype("float32")


def run(site):
    name, region, lo0, lo1, la0, la1 = SITES[site]
    bb = (lo0, la0, lo1, la1)
    out = os.path.join(ROOT, "data", site)
    raw = os.path.join(out, "raw")
    os.makedirs(raw, exist_ok=True)
    print(f"== {site}: {name}", flush=True)
    cj = os.path.join(out, "cmr.json")
    grans = json.load(open(cj)) if os.path.exists(cj) else cmr(bb)
    json.dump(grans, open(cj, "w"))
    if not grans:
        print("   no OPERA DISP-S1 granules over this box"); return False
    frame, gs, cover = choose_frame(grans, bb)
    files = bridges(gs)
    print(f"   using frame {frame}: {len(files)} bridge files {files[0]['ref']}..{files[-1]['sec']}", flush=True)
    s = session()

    def job(g):
        fn = os.path.join(raw, f"{g['ref']}_{g['sec']}.npz")
        if os.path.exists(fn):
            return g["ref"], "cached"
        t0, err = time.time(), None
        for _ in range(3):
            try:
                d = read_window(g["url"], s, bb)
                tmp = fn + f".{os.getpid()}.tmp.npz"  # unique per process, so helpers can share a site
                np.savez_compressed(tmp, **d)
                os.replace(tmp, fn)
                return g["ref"], f"{time.time() - t0:.0f}s"
            except Exception as e:  # report and retry
                err = e
                time.sleep(5)
        return g["ref"], f"FAILED {type(err).__name__}: {err}"

    with ThreadPoolExecutor(6) as ex:
        res = list(ex.map(job, files))
    bad = [r for r in res if r[1].startswith("FAILED")]
    print("   read:", sum(1 for r in res if not r[1].startswith("FAILED")), "ok,", len(bad), "failed", bad[:2], flush=True)
    # chain (stop at the first missing link)
    dates, cum, z0, direction = [files[0]["ref"]], None, None, ""
    valid_n = None
    for g in files:
        fn = os.path.join(raw, f"{g['ref']}_{g['sec']}.npz")
        if not os.path.exists(fn) or g["ref"] != dates[-1]:
            print("   chain stops at", g["ref"]); break
        z = np.load(fn)
        z0 = z0 or dict(x=z["x"], y=z["y"], epsg=int(z["epsg"]))
        direction = str(z["direction"]) or direction
        ok = np.isfinite(z["displacement"]) & (z["recommended_mask"] == 1)
        d = np.where(ok, z["displacement"].astype("float64") * 1000.0, np.nan)
        if cum is None:
            cum = [np.zeros_like(d)]; valid_n = np.zeros(d.shape, "int32")
        cum.append(cum[-1] + d)
        valid_n += ok
        dates.append(g["sec"])
    if cum is None or len(cum) < 8:
        print("   too few epochs; skipping"); return False
    cum = np.array(cum, "float32")
    t = np.array([(np.datetime64(f"{d[:4]}-{d[4:6]}-{d[6:]}") - np.datetime64("2016-01-01")) / np.timedelta64(1, "D") / 365.25 for d in dates])
    nmin = int(np.ceil(0.8 * len(t)))
    # pass 1: tie each date to the window median, fit, then find the steadiest ground
    with np.errstate(all="ignore"):
        cum -= np.nanmedian(cum.reshape(len(t), -1), axis=1)[:, None, None]
        r1 = fit(cum, t, nmin)
        q60, q90 = np.nanpercentile(r1, [60, 90])
        stable = (r1 >= q60) & (r1 <= q90)
        cum -= np.nanmedian(cum[:, stable], axis=1)[:, None, None]
    rate = fit(cum, t, nmin)
    vf = (valid_n / (len(t) - 1)).astype("float32")
    np.savez_compressed(os.path.join(out, "maps.npz"), rate_mm_yr=rate, valid_epoch_frac=vf, **z0)
    np.savez_compressed(os.path.join(out, "series.npz"), cum_mm=cum, dates=np.array(dates), **z0)
    fin = rate[np.isfinite(rate)]
    meta = dict(id=site, name=name, region=region, bbox=[lo0, la0, lo1, la1], frame=frame, direction=direction, epochs=len(dates), first=dates[0], last=dates[-1],
                cover=round(float(cover), 3), with_rate=round(float(np.isfinite(rate).mean()), 3), p01_rate=round(float(np.percentile(fin, 1)), 1), p50_rate=round(float(np.percentile(fin, 50)), 2),
                reference="steadiest ground in the window (first-pass rate between the 60th and 90th percentile)")
    json.dump(meta, open(os.path.join(out, "meta.json"), "w"), indent=1)
    print("   done:", meta, flush=True)
    return True


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    todo = args or [s for s in SITES if not os.path.exists(os.path.join(ROOT, "data", s, "meta.json"))]
    w = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--worker=")), None)  # --worker=k/n: every n-th place, offset k
    if w:
        k, n = map(int, w.split("/"))
        todo = todo[k::n]
    if "--reverse" in sys.argv:  # a helper that starts from the other end of the same list
        todo = todo[::-1]
    for s in todo:
        if os.path.exists(os.path.join(ROOT, "data", s, "meta.json")) and not args:
            continue
        try:
            run(s)
        except Exception as e:  # keep going with the other sites
            print(f"   {s} FAILED: {type(e).__name__}: {e}", flush=True)
