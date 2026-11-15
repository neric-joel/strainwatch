"""Check every place against independent ground measurements.

    python build/ground_truth.py            # all places
    python build/ground_truth.py houston    # some places

Two sources, both independent of the radar:
  1. GPS: daily station positions from the Nevada Geodetic Laboratory (IGS20 tenv3 series). For every station inside a
     place's window with at least 2.5 years of data inside the radar period, the vertical rate is a robust (Theil-Sen)
     slope over that period. The radar rate is the median of the 5 x 5 pixels (150 m) around the station.
  2. Arizona only: Arizona Department of Water Resources survey benchmarks (long-term averages, so ranking only).

Radar here is line of sight; it is divided by cos(39 deg) to compare with GPS vertical. The true incidence angle varies
from about 31 to 46 deg across a swath, so that conversion is good to roughly 12 %. Radar rates are relative to the
steadiest ground in the window while GPS is absolute, so with three or more stations the median difference is removed
before the misfit is measured; with one or two it cannot be, and the raw difference is reported.

Verdicts written to data/<place>/truth.json:
  agree  : typical misfit <= 3 mm/yr, or <= 25 % of the fastest GPS rate
  weak   : stations exist but the misfit is larger
  none   : no station with enough data inside the window
"""
import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pyproj
import requests
from scipy import stats

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(ROOT, "data")
GPS = os.path.join(DATA, "_gps")
os.makedirs(GPS, exist_ok=True)
PLACES = {k: v for k, v in json.load(open(os.path.join(HERE, "places.json"))).items() if not k.startswith("_")}
HOLD = "https://geodesy.unr.edu/NGLStationPages/DataHoldings.txt"
TENV = "https://geodesy.unr.edu/gps_timeseries/IGS20/tenv3/IGS20/{}.tenv3"
ADWR = "https://services.arcgis.com/C34zQ7veRS0V1t04/arcgis/rest/services/ADWR_GNSS_Data/FeatureServer/0/query"
UA = {"User-Agent": "strainwatch-build/1.0"}
COS = np.cos(np.radians(39.0))
MAX_STATIONS = 12


def dec(s):
    y, m, d = int(s[:4]), int(s[4:6]), int(s[6:8])
    return y + (m - 1) / 12 + (d - 1) / 365.25


def holdings():
    p = os.path.join(GPS, "DataHoldings.txt")
    if not os.path.exists(p):
        r = requests.get(HOLD, headers=UA, timeout=300); r.raise_for_status()
        open(p, "w").write(r.text)
    out = []
    for line in open(p):
        f = line.split()
        if len(f) < 11 or f[0] == "Sta":
            continue
        try:
            lon = float(f[2]); lon = lon - 360 if lon > 180 else lon
            out.append((f[0], float(f[1]), lon, f[7], f[8], int(f[10])))
        except ValueError:
            continue
    return out


def series(sta):
    p = os.path.join(GPS, f"{sta}.tenv3")
    if not os.path.exists(p):
        for attempt in range(3):
            try:
                r = requests.get(TENV.format(sta), headers=UA, timeout=120)
                if r.status_code == 200:
                    open(p, "w").write(r.text); break
                if r.status_code == 404:
                    open(p, "w").write(""); break
            except requests.RequestException:
                pass
            time.sleep(2 * (attempt + 1))
    t, u = [], []
    if os.path.exists(p):
        for line in open(p):
            f = line.split()
            if len(f) < 13 or f[0] == "site":
                continue
            try:
                t.append(float(f[2])); u.append(float(f[11]) + float(f[12]))
            except ValueError:
                continue
    return np.array(t), np.array(u) * 1000.0  # mm


def gps_rate(sta, t0, t1):
    t, u = series(sta)
    k = (t >= t0) & (t <= t1)
    if k.sum() < 200 or (t[k].max() - t[k].min()) < 2.5:
        return None
    t, u = t[k], u[k]
    # weekly medians keep Theil-Sen fast and shed daily noise
    wk = np.floor((t - t.min()) * 52).astype(int)
    tw = np.array([t[wk == w].mean() for w in np.unique(wk)])
    uw = np.array([np.median(u[wk == w]) for w in np.unique(wk)])
    sl = stats.theilslopes(uw, tw)
    return dict(up=round(float(sl[0]), 2), lo=round(float(sl[2]), 2), hi=round(float(sl[3]), 2), years=round(float(tw.max() - tw.min()), 1), n=int(k.sum()))


def maps_for(pid):
    if pid in ("phoenix_east", "phoenix_west"):
        return os.path.join(DATA, "phoenix", "opera_7091", f"{pid.split('_')[1]}_maps.npz"), os.path.join(DATA, "phoenix", f"truth_{pid.split('_')[1]}.json")
    return os.path.join(DATA, pid, "maps.npz"), os.path.join(DATA, pid, "truth.json")


def radar_at(M, tr, lon, lat, hw=2):
    x, y = tr.transform(lon, lat)
    c = int(round((x - M["x"][0]) / (M["x"][1] - M["x"][0]))); r = int(round((y - M["y"][0]) / (M["y"][1] - M["y"][0])))
    R = M["rate_mm_yr"]
    if r - hw < 0 or c - hw < 0 or r + hw >= R.shape[0] or c + hw >= R.shape[1]:
        return None
    w = R[r - hw:r + hw + 1, c - hw:c + hw + 1]
    return float(np.nanmedian(w)) if np.isfinite(w).sum() >= 5 else None


def adwr(bb):
    try:
        r = requests.get(ADWR, params=dict(where="1=1", geometry=f"{bb[0]},{bb[1]},{bb[2]},{bb[3]}", geometryType="esriGeometryEnvelope", inSR=4326, spatialRel="esriSpatialRelIntersects",
                                           outFields="Station,Subsidence,First_Date,Last_Date", outSR=4326, f="geojson"), headers=UA, timeout=120)
        r.raise_for_status()
        return r.json().get("features", [])
    except Exception as e:
        print("   ADWR query failed:", e)
        return []


def run(pid, H):
    mp, out = maps_for(pid)
    if not os.path.exists(mp):
        return None
    M = np.load(mp)
    if pid in PLACES:
        b = PLACES[pid]["box"]; bb = (b[0], b[2], b[1], b[3]); st = PLACES[pid].get("st")
        meta = json.load(open(os.path.join(DATA, pid, "meta.json"))); t0, t1 = dec(meta["first"]), dec(meta["last"])
    else:
        bb = {"phoenix_east": (-111.80, 33.15, -111.45, 33.50), "phoenix_west": (-112.55, 33.45, -112.25, 33.70)}[pid]; st = "AZ"; t0, t1 = 2016.54, 2026.1
    tr = pyproj.Transformer.from_crs(4326, int(M["epsg"]), always_xy=True)
    cand = [h for h in H if bb[0] <= h[2] <= bb[2] and bb[1] <= h[1] <= bb[3] and h[4] >= "2019" and h[3] <= "2023" and h[5] > 300]
    cand.sort(key=lambda h: -h[5])
    with ThreadPoolExecutor(6) as ex:
        rates = list(ex.map(lambda h: gps_rate(h[0], t0, t1), cand[:MAX_STATIONS + 6]))
    rows = []
    for h, g in zip(cand, rates):
        if g is None:
            continue
        los = radar_at(M, tr, h[2], h[1])
        rows.append(dict(id=h[0], lon=round(h[2], 4), lat=round(h[1], 4), gps_up=g["up"], gps_lo=g["lo"], gps_hi=g["hi"], years=g["years"],
                         radar=None if los is None else round(los / COS, 2)))
    rows = rows[:MAX_STATIONS]
    used = [r for r in rows if r["radar"] is not None]
    res = dict(source="GPS, Nevada Geodetic Laboratory", stations=rows, n_found=len(rows), n=len(used), period=[round(t0, 1), round(t1, 1)])
    if used:
        g = np.array([r["gps_up"] for r in used]); a = np.array([r["radar"] for r in used])
        d = a - g
        off = float(np.median(d)) if len(used) >= 3 else 0.0
        mis = float(np.median(np.abs(d - off)))
        fastest = float(np.max(np.abs(g)))
        res.update(offset=round(off, 2), misfit=round(mis, 2), gps_fastest=round(fastest, 1), offset_removed=len(used) >= 3,
                   verdict="agree" if mis <= max(3.0, 0.25 * fastest) else "weak")
        if len(used) >= 5 and np.std(g) > 1.5:
            res["r"] = round(float(np.corrcoef(g, a)[0, 1]), 2)
    else:
        res["verdict"] = "none"
    if st == "AZ":  # survey benchmarks, long-term averages: ranking only
        bms = []
        for f in adwr(bb):
            p = f["properties"]
            try:
                yrs = float(p["Last_Date"]) - float(p["First_Date"])
                if yrs < 5:
                    continue
                lon, lat = f["geometry"]["coordinates"][:2]
                los = radar_at(M, tr, lon, lat)
                if los is not None:
                    bms.append((float(p["Subsidence"]) * 1000 / yrs, los / COS))
            except (TypeError, ValueError, KeyError):
                continue
        if len(bms) >= 6:
            rho = stats.spearmanr([b_[0] for b_ in bms], [b_[1] for b_ in bms])[0]
            res["survey"] = dict(source="Arizona Department of Water Resources benchmarks", n=len(bms), spearman=round(float(rho), 2))
        else:
            res["survey"] = dict(source="Arizona Department of Water Resources benchmarks", n=len(bms))
    json.dump(res, open(out, "w"), indent=1)
    print(f"{pid:16s} stations {res['n_found']:2d} used {res['n']:2d}  verdict {res['verdict']:5s}", {k: res.get(k) for k in ("misfit", "offset", "gps_fastest", "r")}, res.get("survey", ""), flush=True)
    return res


if __name__ == "__main__":
    H = holdings()
    ids = sys.argv[1:] or (["phoenix_east", "phoenix_west"] + list(PLACES))
    for pid in ids:
        try:
            run(pid, H)
        except Exception as e:
            print(pid, "FAILED:", type(e).__name__, e, flush=True)
