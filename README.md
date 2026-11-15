# StrainWatch

**Where should the field crew go first?** StrainWatch takes any road, rail line, pipeline or canal inside a processed radar
window and ranks every 300 m of it by how unevenly the ground beneath is sinking.

NASA Space Apps Challenge 2026, "Dancing with the SARs".

It is built for three people: a county road engineer, a pipeline / canal / rail / power-line operator, and a state
geological survey. What they take away is a ranked work list, a short list of inspection stops, a printable sheet per stop,
and CSV or GeoJSON for the GIS they already run.

The app is a static site: no server, no API keys. Everything it shows is computed in the browser from the files in `site/data/`.

## Run it

```bash
python serve.py
```

Then open http://localhost:8765. It opens as a scroll story over a live map. "Skip to the map" (or `#explore` in the address)
goes to the national view, where every processed place is a square marker. Zoom into one, click it, click a state name, or use
"Jump to a place". `#site=willcox`, `#site=mexico`, `#site=sansimon` and so on open a place directly.

## What is on the map

| Tier | Places | What stands behind it |
|---|---|---|
| Checked against ground truth | Willcox Basin (AZ), Mexico City, Phoenix East Valley (AZ) | Survey benchmarks, GPS, and a forward test against newly mapped earth fissures at Willcox |
| Measured, compared with GPS | Places in most lower-48 states, plus Aguascalientes and Celaya | Real OPERA DISP-S1 radar, same code. Each is compared with GPS stations inside its window (Nevada Geodetic Laboratory): 105 agree, 7 agree only weakly, 4 have no station. No survey or fissure test |
| NISAR only | Chennai, India | A noise analysis; nothing is ranked |

Each place is a window of roughly 35 km. Together the windows cover a small share of the country's land area (the app states
the figure). Everywhere else is **not processed yet**, and the app says so when you click or draw there. It never shows
unmeasured ground as stable.

Map views: sinking rate, unevenness, NISAR, data quality, a Sentinel-1 | NISAR compare slider, Light / Satellite / Terrain
base maps, and five national views (trust level, sinking speed, unevenness, ground observed, NISAR agreement).

## The score

1. **Rate.** A straight-line fit through the radar dates at every pixel, relative to bedrock, a stable GPS station or the
   steadiest ground in the window.
2. **Smooth.** 90 m cells, then the median of each 3 x 3 block: a 270 m grid.
3. **Unevenness.** The size of the gradient of that rate, in mm/yr per km. Cells touching a data gap are blanked.
4. **Rank.** Each cell against the rest of its window. The top 5 % is the threshold the forward test scored.
5. **Line.** Any line is cut into pieces of about 300 m. A piece takes the highest unevenness under it and the median sinking
   rate. Less than half good data means "not observed".

## What was tested, including what failed

- Willcox: radar against 38 survey benchmarks, rank correlation 0.85 (0.95 for the 16 surveyed since 2005).
- Willcox forward test (radar before 2023 only, scored on fissures field-surveyed afterwards): unevenness AUC 0.90, sinking
  rate alone 0.75. **It did not beat "look near fissures already mapped" (0.92).** It ranks ground for inspection; it does
  not predict where a fissure will open.
- Mexico City: radar against 9 GPS stations, r 0.98, error 17 mm/yr. One station is off by about 50 mm/yr, cause unknown.
- Mexico City: one year of stacked NISAR against ten years of Sentinel-1, r 0.94. At Willcox the two agree only loosely.
- Every place added by script against GPS (Nevada Geodetic Laboratory vertical rates over the radar period): 105 agree,
  7 agree only weakly, 4 have no station in the window. At the 60 places with three or more stations (308 stations), radar
  against GPS gives r 0.89 and a typical difference of 0.7 mm/yr, after removing one constant per place, because the radar
  is relative and GPS is absolute. 51 places rest on one or two stations, where that constant cannot be removed. This is
  a consistency check on the sinking rate; it does not test the ranking.
- NISAR at every other place: the app reports the agreement, strong or weak, place by place.
- Chennai: not detectable yet; the app shows how long a record is needed.

The full list is in the app under "Radar against the ground, and the track record".

## Test it

```bash
node --test tests/
```

Geometry, percentile and trend maths, scoring of the real Willcox road network, exports, the planner, awkward inputs, and
checks that the packed numbers still match the research tables.

## Rebuild the data

The build reads cached radar products from `../data/` (not in this repository; the scripts below fetch them from NASA's
archive with an Earthdata login). These scripts rebuild every place, its NISAR stack and its GPS comparison. The in-depth
research tables for Willcox, Mexico City, Phoenix and Chennai (survey benchmarks against radar, the forward fissure
test, the Chennai noise figures) come from separate analysis scripts that are not in this repository: `build_data.py`
reads their output tables and packs them into `site/data/validation.json`, so those headline results cannot be rerun
from this repository alone.

```bash
python build/add_site.py        # fetch OPERA DISP-S1 for the places in build/places.json
python build/nisar_site.py fetch && python build/nisar_site.py process    # stack NISAR at every place
python build/ground_truth.py    # compare every place with GPS stations (and Arizona survey benchmarks)
python build/fetch_osm.py       # roads, rail, pipelines, power lines, canals (OpenStreetMap)
python build/fetch_states.py    # state outlines (US Census)
python build/build_data.py      # pack rasters, time series, lines and validation tables into site/data
node build/exposure.mjs         # national totals, scored with the same code the browser runs
```

To add a place, add one entry to `build/places.json` (a name and a lon/lat box inside North or Central America) and rerun.

## Publish it

Upload the `site/` folder to any static host. It loads MapLibre GL, D3, fonts and base-map tiles from public CDNs; if the
base map cannot load, the app falls back to a plain background and still works.

## Layout

| Path | What |
|---|---|
| `site/index.html`, `site/css/style.css` | Page and styles |
| `site/js/geo.js`, `raster.js`, `score.js` | Cutting lines, sampling rasters, scoring, ranking, trend tests, the planner |
| `site/js/app.js` | Map, panels, draw and upload, compare slider, national views |
| `site/js/rasterlayer.js` | WebGL layer that draws the radar maps |
| `site/js/story.js`, `below.js`, `charts.js`, `report.js` | Story chapters, tables and track record, charts, CSV / GeoJSON / printable sheets |
| `site/data/` | Packed rasters, lines and tables |
| `build/` | Data scripts |
| `tests/` | Node tests |

## Data credits

NASA OPERA DISP-S1 and NISAR GUNW (ASF DAAC / Earthdata); Arizona Department of Water Resources benchmarks; Arizona Geological
Survey earth-fissure maps; Nevada Geodetic Laboratory GPS; US Census TIGER/Line and cartographic boundaries; OpenStreetMap
contributors (ODbL); Copernicus GLO-30 DEM; OpenFreeMap / OpenMapTiles; Sentinel-2 cloudless by EOX; Mapzen terrain tiles.

## Limits

A relative screening index. Not a damage assessment, not an engineering finding, not a forecast. Fissures are narrower than
a radar pixel. Rates assume vertical motion. Places added by script are compared with GPS only, often at one or two stations; they have no survey or fissure test behind
them here.
