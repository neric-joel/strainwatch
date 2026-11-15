"""NISAR at every place: fetch a year of NISAR L2 GUNW pairs over each place's box, stack them into a rate map,
and measure how well that map agrees with the Sentinel-1 (OPERA DISP-S1) rate map of the same place.

    .venv/Scripts/python strainwatch/build/nisar_site.py fetch [place ...] [--worker=k/n]   # windowed HTTP range reads
    .venv/Scripts/python strainwatch/build/nisar_site.py process [place ...]                # stack + compare

Per pair (same recipe as research_scripts/mexico/p5b_nisar_rate.py, which matched Sentinel-1 at r = 0.94):
    d = -(unwrappedPhase - ionospherePhaseScreen) * wavelength / (4 pi)     line of sight, + toward the satellite
    wavelength is read from each file (centerFrequency); keep coherence >= 0.3 and the dominant connected component;
    remove a best-fit plane on ground the Sentinel-1 map calls steady; tie to the median of that ground.
Stack: rate = sum(d) / sum(days) over the pairs a pixel is valid in, needing 60 % of the time span.

Outputs in data/<place>/nisar/ (Phoenix: data/phoenix/nisar_<box>/):
    cmr.json, <ref>_<sec>.npz (raw windows), rate.npz (los_rate_mmyr, mean_coh, x, y, epsg), nisar.json (statistics)

NISAR looks left and Sentinel-1 looks right, so the two lines of sight differ; for vertical motion they have the same
sign. Agreement is reported as a correlation, which does not depend on that scale. Products are provisional.
"""
import datetime as dt
import glob, json, os, sys, time

import h5py
import numpy as np
import pyproj
import requests
from scipy import stats
from shapely.geometry import Polygon, box as sbox

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from httprange import HttpRangeFile, session  # noqa: E402

CMR = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"
COLLECTIONS = ["NISAR_L2_GUNW_BETA_V1", "NISAR_L2_GUNW_PROVISIONAL_V1", "NISAR_L2_GUNW_V1"]  # later ones override earlier
G = "/science/LSAR/GUNW/grids/frequencyA/unwrappedInterferogram"
PLACES = {k: v for k, v in json.load(open(os.path.join(HERE, "places.json"))).items() if not k.startswith("_")}
MAX_PAIRS = 32


def place(pid):
    """-> (bbox lon0, lat0, lon1, lat1), OPERA maps path, output dir"""
    if pid in ("phoenix_east", "phoenix_west"):
        bx = pid.split("_")[1]
        b = {"east": (-111.80, 33.15, -111.45, 33.50), "west": (-112.55, 33.45, -112.25, 33.70)}[bx]
        return b, os.path.join(ROOT, "data", "phoenix", "opera_7091", f"{bx}_maps.npz"), os.path.join(ROOT, "data", "phoenix", f"nisar_{bx}")
    v = PLACES[pid]["box"]
    return (v[0], v[2], v[1], v[3]), os.path.join(ROOT, "data", pid, "maps.npz"), os.path.join(ROOT, "data", pid, "nisar")


def all_places():
    return [p for p in ["phoenix_east", "phoenix_west"] + list(PLACES) if os.path.exists(place(p)[1])]


def days(a, b):
    return (dt.datetime.strptime(b, "%Y%m%d") - dt.datetime.strptime(a, "%Y%m%d")).days


def cmr(bbox):
    out = []
    for sn in COLLECTIONS:
        headers = {}
        while True:
            for attempt in range(6):
                try:
                    r = requests.get(CMR, params=dict(short_name=sn, bounding_box=",".join(map(str, bbox)), page_size=2000), headers=headers, timeout=300)
                    if r.status_code < 500:
                        break
                except requests.RequestException:
                    pass
                time.sleep(3 * (attempt + 1))
            r.raise_for_status()
            items = r.json()["items"]
            for it in items:
                u = it["umm"]
                urls = [x["URL"] for x in u.get("RelatedUrls", []) if x.get("Type") == "GET DATA" and x["URL"].startswith("https") and x["URL"].endswith(".h5")]
                try:
                    pts = u["SpatialExtent"]["HorizontalSpatialDomain"]["Geometry"]["GPolygons"][0]["Boundary"]["Points"]
                    poly = [(p["Longitude"], p["Latitude"]) for p in pts]
                except Exception:
                    poly = None
                if urls:
                    out.append(dict(name=u["GranuleUR"], url=urls[0], poly=poly, collection=sn))
            sa = r.headers.get("CMR-Search-After")
            if not items or not sa:
                break
            headers = {"CMR-Search-After": sa}
    return out


def choose(grans, bb):
    """Pick the track/frame that covers the box best and has the most pairs; return its non-overlapping chain of pairs."""
    target = sbox(*bb)
    groups = {}
    for g in grans:
        p = g["name"].split("_")
        if len(p) < 15 or p[3] != "GUNW":
            continue
        g["track"], g["dir"], g["frame"], g["ref"], g["sec"] = p[5], p[6], p[7], p[11][:8], p[13][:8]
        groups.setdefault((g["track"], g["dir"], g["frame"]), {})[(g["ref"], g["sec"])] = g  # later collection wins
    best = None
    for key, pairs in groups.items():
        poly = next((Polygon(g["poly"]) for g in pairs.values() if g["poly"]), None)
        try:
            cover = poly.intersection(target).area / target.area if poly is not None else 0
        except Exception:
            cover = 0
        chain, cur = [], "0"
        for (r, s) in sorted(pairs, key=lambda k: (k[0], days(*k))):
            if r >= cur:
                chain.append(pairs[(r, s)]); cur = s
        score = (cover >= 0.9, sum(days(g["ref"], g["sec"]) for g in chain), cover)
        if best is None or score > best[0]:
            best = (score, key, chain, cover)
    if best is None:
        return None
    return dict(track=best[1][0], dir=best[1][1], frame=best[1][2], cover=round(float(best[3]), 3), chain=best[2][-MAX_PAIRS:])


def plan(pid):
    bb, _, out = place(pid)
    os.makedirs(out, exist_ok=True)
    cj = os.path.join(out, "cmr.json")
    if os.path.exists(cj):
        return json.load(open(cj))
    sel = choose(cmr(bb), bb)
    sel = sel or dict(chain=[])
    json.dump(sel, open(cj, "w"))
    return sel


def read_pair(g, bb, out, sess, block=1024 * 1024):
    fn = os.path.join(out, f"{g['ref']}_{g['sec']}.npz")
    if os.path.exists(fn):
        return "cached", 0, 0
    t0 = time.time()
    f = HttpRangeFile(sess, g["url"], block=block, max_blocks=128)
    with h5py.File(f, "r") as h:
        pol = [k for k in h[G].keys() if isinstance(h[G][k], h5py.Group) and "unwrappedPhase" in h[G][k]][0]
        grp = h[G + "/" + pol]
        x, y = h[G + "/xCoordinates"][:], h[G + "/yCoordinates"][:]
        epsg = int(h[G + "/projection"][()])
        fc = float(h["/science/LSAR/GUNW/grids/frequencyA/centerFrequency"][()])
        tr = pyproj.Transformer.from_crs(4326, epsg, always_xy=True)
        xs, ys = tr.transform([bb[0], bb[2], bb[0], bb[2]], [bb[1], bb[1], bb[3], bb[3]])
        dx, dy = x[1] - x[0], y[1] - y[0]
        c0 = max(0, int(np.floor((min(xs) - x[0]) / dx))); c1 = min(len(x), int(np.ceil((max(xs) - x[0]) / dx)) + 1)
        rr = sorted([(max(ys) - y[0]) / dy, (min(ys) - y[0]) / dy])
        r0 = max(0, int(np.floor(rr[0]))); r1 = min(len(y), int(np.ceil(rr[1])) + 1)
        if c1 - c0 < 20 or r1 - r0 < 20:
            raise ValueError("box outside this granule")
        res = dict(x=x[c0:c1], y=y[r0:r1], epsg=epsg, wavelength=299792458.0 / fc)
        for k, short in [("unwrappedPhase", "unw"), ("coherenceMagnitude", "coh"), ("connectedComponents", "cc"), ("ionospherePhaseScreen", "iono")]:
            ds = grp[k]
            a = ds[r0:r1, c0:c1]
            fill = ds.attrs.get("_FillValue")
            if a.dtype.kind == "f":
                a = a.astype("float32")
                if fill is not None:
                    a[a == fill] = np.nan
            res[short] = a
    tmp = fn + f".{os.getpid()}.tmp.npz"
    np.savez_compressed(tmp, **res)
    os.replace(tmp, fn)
    return "ok", time.time() - t0, f.bytes_fetched / 1e6


def fetch(pids, worker=None):
    tasks = []
    for pid in pids:
        try:
            sel = plan(pid)
        except Exception as e:
            print(pid, "search failed:", type(e).__name__, e, flush=True); continue
        for g in sel["chain"]:
            tasks.append((pid, g))
    if worker:
        k, n = worker
        tasks = tasks[k::n]
    print(len(tasks), "pair windows to read", flush=True)
    sess = session()
    for i, (pid, g) in enumerate(tasks):
        bb, _, out = place(pid)
        for attempt in range(3):
            try:
                st, sec, mb = read_pair(g, bb, out, sess)
                if st != "cached":
                    print(f"[{i + 1}/{len(tasks)}] {pid} {g['ref']}_{g['sec']} {sec:.0f}s {mb:.0f}MB", flush=True)
                break
            except Exception as e:
                err = e
                time.sleep(4)
        else:
            print(f"[{i + 1}/{len(tasks)}] {pid} {g['ref']}_{g['sec']} FAILED {type(err).__name__}: {err}", flush=True)


def process(pid):
    bb, maps, out = place(pid)
    sel = plan(pid)
    pairs = [(g["ref"], g["sec"]) for g in sel["chain"] if os.path.exists(os.path.join(out, f"{g['ref']}_{g['sec']}.npz"))]
    if len(pairs) < 6:
        print(pid, "too few NISAR pairs cached:", len(pairs)); return None
    z0 = np.load(os.path.join(out, f"{pairs[0][0]}_{pairs[0][1]}.npz"))
    x, y, epsg, lam = z0["x"], z0["y"], int(z0["epsg"]), float(z0["wavelength"])
    XX, YY = np.meshgrid(x, y)
    # Sentinel-1 rate on the NISAR grid (3x3 median of the nearest 30 m pixels)
    M = np.load(maps)
    ox, oy, oe, orate = M["x"], M["y"], int(M["epsg"]), M["rate_mm_yr"]
    if oe != epsg:
        tx, ty = pyproj.Transformer.from_crs(epsg, oe, always_xy=True).transform(XX, YY)
    else:
        tx, ty = XX, YY
    oc = np.round((tx - ox[0]) / (ox[1] - ox[0])).astype(int)
    orow = np.round((ty - oy[0]) / (oy[1] - oy[0])).astype(int)
    inside = (oc >= 1) & (oc < len(ox) - 1) & (orow >= 1) & (orow < len(oy) - 1)
    oc, orow = np.clip(oc, 1, len(ox) - 2), np.clip(orow, 1, len(oy) - 2)
    with np.errstate(all="ignore"):
        s1 = np.nanmedian(np.stack([orate[orow + i, oc + j] for i in (-1, 0, 1) for j in (-1, 0, 1)]), axis=0)
    s1[~inside] = np.nan
    stable = np.abs(s1 - np.nanmedian(s1)) < 3.0
    A = np.c_[XX.ravel() - XX.mean(), YY.ravel() - YY.mean(), np.ones(XX.size)] / np.array([1e4, 1e4, 1])
    Ssum = np.zeros(XX.shape); Tsum = np.zeros(XX.shape); cohsum = np.zeros(XX.shape); span = 0; used = 0
    for p in pairs:
        z = np.load(os.path.join(out, f"{p[0]}_{p[1]}.npz"))
        if z["unw"].shape != XX.shape:
            continue
        d = -(z["unw"] - z["iono"]) * float(z["wavelength"]) / (4 * np.pi) * 1000.0
        cc = z["cc"].astype("int64")
        ok = np.isfinite(d) & (z["coh"] >= 0.3) & (cc != 0) & (cc < 60000)
        if ok.sum() < 2000:
            continue
        dom = np.bincount(cc[ok]).argmax()
        ok &= cc == dom
        d = np.where(ok, d, np.nan)
        fit = (np.isfinite(d) & stable).ravel()
        if fit.sum() > 500:
            coef, *_ = np.linalg.lstsq(A[fit], d.ravel()[fit], rcond=None)
            d = d - (A @ coef).reshape(d.shape)
            d -= np.nanmedian(d[stable & np.isfinite(d)])
        else:
            d -= np.nanmedian(d)
        v = np.isfinite(d)
        n = days(*p)
        Ssum += np.where(v, d, 0); Tsum += v * n; cohsum += np.nan_to_num(z["coh"]); span += n; used += 1
    if used < 6:
        print(pid, "too few usable pairs:", used); return None
    with np.errstate(all="ignore"):
        rate = Ssum / Tsum * 365.25
    rate[Tsum < 0.6 * span] = np.nan
    mcoh = cohsum / used
    both = np.isfinite(rate) & np.isfinite(s1) & (mcoh >= 0.4)
    st = dict(track=sel["track"], frame=sel["frame"], dir=sel["dir"], pairs=used, first=pairs[0][0], last=pairs[-1][1], span_days=int(span), wavelength_m=round(lam, 4),
              cover_nisar=round(float(np.isfinite(rate)[inside].mean()), 3) if inside.any() else 0.0, cover_s1=round(float(np.isfinite(s1)[inside].mean()), 3) if inside.any() else 0.0,
              mean_coh=round(float(np.nanmean(mcoh)), 3), n=int(both.sum()))
    if both.sum() > 500:
        a, b = s1[both], rate[both]
        lr = stats.linregress(a, b)
        st.update(r=round(float(lr.rvalue), 3), slope=round(float(lr.slope), 2), rmsd=round(float(np.sqrt(np.mean((b - a) ** 2))), 1), s1_spread=round(float(np.std(a)), 2))
    sb = stable & np.isfinite(rate)
    if sb.sum() > 500:
        st["noise_mmyr"] = round(float(1.4826 * np.median(np.abs(rate[sb] - np.median(rate[sb])))), 1)  # robust spread on steady ground
    np.savez_compressed(os.path.join(out, "rate.npz"), los_rate_mmyr=rate.astype("float32"), mean_coh=mcoh.astype("float32"), x=x, y=y, epsg=epsg)
    json.dump(st, open(os.path.join(out, "nisar.json"), "w"), indent=1)
    print(pid, st, flush=True)
    return st


if __name__ == "__main__":
    args = [a for a in sys.argv[2:] if not a.startswith("--")]
    w = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--worker=")), None)
    cmd = sys.argv[1] if len(sys.argv) > 1 else "process"
    pids = args or all_places()
    if cmd == "fetch":
        if not args:
            pids = [p for p in pids if not os.path.exists(os.path.join(place(p)[2], "nisar.json"))]
        fetch(pids, tuple(map(int, w.split("/"))) if w else None)
    else:
        for p in pids:
            try:
                process(p)
            except Exception as e:
                print(p, "FAILED:", type(e).__name__, e, flush=True)
