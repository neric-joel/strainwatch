"""Fetch linear infrastructure (rail, pipelines, power lines, canals) from OpenStreetMap via the Overpass API.

Cached as raw JSON in build/cache/osm_<site>.json. (c) OpenStreetMap contributors, ODbL.
Run:  .venv\Scripts\python strainwatch\build\fetch_osm.py
"""
import json, os, sys, time
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
# south, west, north, east
BOXES = {
    "willcox": (31.77, -110.07, 32.68, -109.63),
    "phoenix_east": (33.15, -111.80, 33.50, -111.45),
    "phoenix_west": (33.45, -112.55, 33.70, -112.25),
}
# sites added with add_site.py: these also take their main roads from OpenStreetMap
PLACES = {k: v for k, v in json.load(open(os.path.join(HERE, "places.json"))).items() if not k.startswith("_")}
ROADS = {k: (v["box"][2], v["box"][0], v["box"][3], v["box"][1]) for k, v in PLACES.items()}  # south, west, north, east
BOXES.update(ROADS)
AZ_FISSURES = "https://services1.arcgis.com/Ezk9fcjSUkeadg6u/arcgis/rest/services/AZGS_Mapped_Earth_Fissures/FeatureServer/12/query"
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
Q = """[out:json][timeout:120];
(way["railway"="rail"]({b});way["man_made"="pipeline"]({b});way["power"="line"]({b});way["waterway"="canal"]({b});{roads});
out geom tags;"""
QROADS = 'way["highway"~"^(motorway|trunk|primary)$"]({b});'


def main():
    for site, box in BOXES.items():
        out = os.path.join(CACHE, f"osm_{site}.json")
        if os.path.exists(out) and "--force" not in sys.argv:
            print(site, "cached"); continue
        b = ",".join(str(v) for v in box)
        q = Q.format(b=b, roads=QROADS.format(b=b) if site in ROADS else "")
        for ep in ENDPOINTS * 2:
            try:
                r = requests.post(ep, data={"data": q}, headers={"User-Agent": "strainwatch-build/1.0"}, timeout=180)
                if r.status_code == 200 and r.text.lstrip().startswith("{"):
                    js = r.json()
                    json.dump(js, open(out, "w"))
                    kinds = {}
                    for e in js["elements"]:
                        t = e.get("tags", {})
                        k = "rail" if "railway" in t else "pipeline" if "man_made" in t else "power" if "power" in t else "road" if "highway" in t else "canal"
                        kinds[k] = kinds.get(k, 0) + 1
                    print(site, len(js["elements"]), "ways", kinds); break
                print(site, ep, "HTTP", r.status_code)
            except Exception as exc:
                print(site, ep, type(exc).__name__, exc)
            time.sleep(5)
        else:
            print(site, "FAILED on all endpoints")


def fissures(site, box):
    """Arizona Geological Survey mapped earth fissures inside a box (public ArcGIS service), as GeoJSON."""
    out = os.path.join(CACHE, f"fissures_{site}.geojson")
    if os.path.exists(out) and "--force" not in sys.argv:
        print(site, "fissures cached"); return
    feats, off = [], 0
    while True:
        r = requests.get(AZ_FISSURES, params=dict(where="1=1", geometry=f"{box[1]},{box[0]},{box[3]},{box[2]}", geometryType="esriGeometryEnvelope", inSR=4326,
                                                  spatialRel="esriSpatialRelIntersects", outFields="Symbol", outSR=4326, f="geojson", resultOffset=off, resultRecordCount=1000),
                         headers={"User-Agent": "strainwatch-build/1.0"}, timeout=120)
        r.raise_for_status()
        fs = r.json().get("features", [])
        feats += fs
        if len(fs) < 1000:
            break
        off += len(fs)
    json.dump(dict(type="FeatureCollection", features=feats), open(out, "w"))
    print(site, "fissures:", len(feats))


if __name__ == "__main__":
    main()
    for k, v in PLACES.items():
        if v.get("az"):
            try:
                fissures(k, ROADS[k])
            except Exception as exc:
                print(k, "fissures failed:", exc)
