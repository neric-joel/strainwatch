"""US state outlines for the national map, from the US Census Bureau cartographic boundary file (public domain).

    .venv/Scripts/python strainwatch/build/fetch_states.py

Writes site/data/us_states.json: simplified outlines with the postal code, name and a label point for each state.
"""
import io, json, os, zipfile

import geopandas as gpd
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_state_20m.zip"
ZIP = os.path.join(HERE, "cache", "cb_2023_us_state_20m.zip")
OUT = os.path.join(os.path.dirname(HERE), "site", "data", "us_states.json")

if not os.path.exists(ZIP):
    r = requests.get(URL, headers={"User-Agent": "strainwatch-build/1.0"}, timeout=120)
    r.raise_for_status()
    open(ZIP, "wb").write(r.content)
g = gpd.read_file(f"zip://{ZIP}").to_crs(4326)
g = g[~g["STUSPS"].isin(["AK", "HI", "PR", "VI", "GU", "MP", "AS"])]
feats = []
for _, row in g.iterrows():
    geom = row.geometry.simplify(0.02, preserve_topology=True)
    p = max(geom.geoms, key=lambda q: q.area).representative_point() if geom.geom_type == "MultiPolygon" else geom.representative_point()
    gj = json.loads(gpd.GeoSeries([geom]).to_json())["features"][0]["geometry"]

    def rnd(c):
        return [rnd(x) for x in c] if isinstance(c[0], (list, tuple)) else [round(c[0], 3), round(c[1], 3)]
    gj["coordinates"] = rnd(gj["coordinates"])
    feats.append(dict(type="Feature", properties=dict(st=row["STUSPS"], name=row["NAME"], lon=round(p.x, 3), lat=round(p.y, 3)), geometry=gj))
json.dump(dict(type="FeatureCollection", features=feats), open(OUT, "w"), separators=(",", ":"))
print(len(feats), "states,", os.path.getsize(OUT) // 1024, "KB")
