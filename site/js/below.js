// Everything below the map: the side-by-side table, the track-record charts, the test list and the method notes.
import * as charts from './charts.js';
import { CLASS_LABEL } from './score.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f0 = (v) => Math.round(v).toLocaleString();
const f1 = (v) => (Math.abs(v) < 20 ? v.toFixed(1) : v.toFixed(0));
let once = false;

const reading = (s) => (s.cls === 'nodata' ? ['not observed', 'bad'] : s.cls === 'first' && s.ratePct < 80 ? ['uneven, not fast', ''] : s.cls === 'first' ? ['uneven and fast', 'ok'] : s.cls === 'routine' && s.ratePct >= 95 ? ['fast but even', ''] : ['', '']);

const COLS = [
  ['rank', 'Rank', (s) => s.rank ?? 1e9], ['name', 'Line', (s) => s.name], ['kind', 'Type', (s) => s.kind], ['uneven', 'Unevenness', (s) => (Number.isFinite(s.uneven) ? -s.uneven : 1e9)],
  ['pct', 'Percentile', (s) => (Number.isFinite(s.pct) ? -s.pct : 1e9)], ['rate', 'Sinking rate', (s) => (Number.isFinite(s.rate) ? s.rate : 1e9)], ['fis', 'Nearest mapped fissure', (s) => (Number.isFinite(s.fisDist) ? s.fisDist : 1e9)],
  ['valid', 'Good data', (s) => -s.valid], ['cls', 'Verdict', (s) => ({ first: 0, watch: 1, routine: 2, nodata: 3 }[s.cls])], ['read', 'Reading', (s) => reading(s)[0] || 'zz'],
];

function renderTable(S, api) {
  const c = S.cur, t = $('#bigtable');
  if (!c || !c.segs.length) { $('#sec-table').style.display = 'none'; return; }
  const all = api.visible() || [];
  $('#sec-table').style.display = '';
  const odd = c.segs.filter((s) => s.cls === 'first' && s.ratePct < 80).length, first = c.segs.filter((s) => s.cls === 'first').length;
  $('#tableSub').innerHTML = `${esc(c.site.name)}: ${f0(all.length)} pieces in the current filter. Across the site, <b>${f0(first)}</b> pieces sit on the most uneven 5% of ground, and <b>${f0(odd)}</b> of those are outside the fastest-sinking 20% of pieces: a ranking by sinking speed alone would have left them in the routine pile. Click a column to sort, a row to open the piece.`;
  const col = COLS.find((x) => x[0] === S.tableSort.k) || COLS[0];
  const rows = all.slice().sort((a, b) => { const x = col[2](a), y = col[2](b); return (x < y ? -1 : x > y ? 1 : 0) * S.tableSort.dir; });
  const umax = Math.max(1, ...all.slice(0, 400).map((s) => (Number.isFinite(s.uneven) ? s.uneven : 0)));
  t.className = 'big';
  t.innerHTML = `<thead><tr>${COLS.map((x) => `<th data-k="${x[0]}" class="${x[0] === S.tableSort.k ? 'sorted' : ''}">${x[1]}${x[0] === S.tableSort.k ? (S.tableSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead><tbody>` +
    rows.slice(0, S.tableShown).map((s, i) => {
      const rd = reading(s);
      return `<tr data-i="${i}"><td class="n">${s.rank ?? '–'}</td><td><b>${esc(s.name)}</b>${s.of > 1 ? ` <span style="color:var(--muted)">piece ${s.piece}</span>` : ''}</td><td>${esc(s.g === 'mine' ? 'your line' : s.kind)}</td>
      <td class="n">${Number.isFinite(s.uneven) && s.cls !== 'nodata' ? f1(s.uneven) + `<span class="bar" style="width:${Math.round((s.uneven / umax) * 60)}px"></span>` : '–'}</td>
      <td class="n">${s.cls !== 'nodata' ? s.pct.toFixed(1) : '–'}</td><td class="n">${s.cls !== 'nodata' ? f1(s.rate) + ' mm/yr' : '–'}</td>
      <td class="n">${Number.isFinite(s.fisDist) ? f0(s.fisDist) + ' m' : c.fis ? '> 2 km' : 'not mapped'}</td><td class="n">${Math.round(s.valid * 100)}%</td>
      <td><b class="c-${s.cls}">${CLASS_LABEL[s.cls]}</b></td><td>${rd[0] ? `<span class="tag ${rd[1]}" style="margin:0">${rd[0]}</span>` : ''}</td></tr>`;
    }).join('') + '</tbody>';
  t.querySelectorAll('th').forEach((th) => (th.onclick = () => { const k = th.dataset.k; S.tableSort = { k, dir: S.tableSort.k === k ? -S.tableSort.dir : 1 }; renderTable(S, api); }));
  t.querySelectorAll('tbody tr').forEach((tr) => (tr.onclick = () => api.select(rows[+tr.dataset.i])));
  const more = $('#moreRows');
  more.hidden = rows.length <= S.tableShown;
  more.onclick = () => { S.tableShown += 100; renderTable(S, api); };
}

function card(parent, cls, title, cap, stat) {
  const d = document.createElement('div');
  d.className = 'card ' + cls;
  d.innerHTML = `<h3>${title}</h3><p class="cap">${cap}</p>${stat ? `<p class="stat">${stat}</p>` : ''}<div class="chart"></div>`;
  parent.appendChild(d);
  return d.querySelector('.chart');
}

function renderCharts(V) {
  const root = $('#charts');
  root.innerHTML = '';
  const bm = V.willcox_benchmarks;
  charts.scatterChart(card(root, '', 'Willcox: radar against surveyors', `${bm.n} state survey benchmarks. Filled dots were first surveyed since 2005, so their averages cover roughly the radar years. Hollow dots average older, slower decades, so radar reads faster there.`, `Rank correlation ${bm.spearman.toFixed(2)} (all ${bm.n}) · ${bm.spearman_recent.toFixed(2)} (the ${bm.n_recent} since 2005)`),
    bm.rows.map((r) => ({ x: r.bm, y: r.radar, name: r.name, hollow: r.first < 2005, tip: `survey ${r.first} to ${r.last}: ${r.bm.toFixed(0)} mm/yr<br>radar: ${r.radar.toFixed(0)} mm/yr` })), { xl: 'survey rate, mm/yr', yl: 'radar rate, mm/yr', label: ['Apple', '850H', 'Drury RM1'] });

  const names = { gradient: 'Unevenness score (ours)', curvature_abs_laplacian: 'Curvature (ours, weaker)', baseline_rate: 'Sinking rate alone', baseline_dist_fis2023: 'Distance to fissures known in 2023' };
  const contour = V.willcox_forward.all.filter((r) => r.score.startsWith('baseline_dist_contour')).sort((a, b) => b.auc - a.auc)[0];
  const rows = V.willcox_forward.all.filter((r) => names[r.score]).map((r) => ({ label: names[r.score], auc: r.auc, lift: r.lift5, kind: r.score === 'gradient' ? 'ours' : r.score === 'baseline_dist_fis2023' ? 'win' : 'base' }));
  if (contour) rows.push({ label: 'Distance to the bowl margin', auc: contour.auc, lift: contour.lift5, kind: 'base' });
  rows.sort((a, b) => b.auc - a.auc);
  const g = V.willcox_forward.all.find((r) => r.score === 'gradient');
  charts.aucChart(card(root, '', 'The forward test: it beat sinking rate, not the known-fissure map', `Radar before 2023 only, scored on ${g.n_pos} cells with fissures field-surveyed after January 2023, among ${f0(g.n_dom)} basin-floor cells. Precision is low in absolute terms: about ${(g.prec5 * 100).toFixed(0)}% of top-5% cells hold a newly mapped fissure.`, `Unevenness ${g.auc.toFixed(2)} · sinking rate ${V.willcox_forward.all.find((r) => r.score === 'baseline_rate').auc.toFixed(2)} · known fissures ${V.willcox_forward.all.find((r) => r.score === 'baseline_dist_fis2023').auc.toFixed(2)}`), rows, { null95: g.null95 });

  const gp = V.mexico_gps;
  charts.scatterChart(card(root, '', 'Mexico City: radar against GPS', `${gp.n} stations, both measured along the radar's line of sight, December 2017 to March 2019. The amber dot is MXTM, about 50 mm/yr off; the cause is not diagnosed.`, `r = ${gp.r.toFixed(3)} · slope ${gp.slope.toFixed(2)} · error ${gp.rmse.toFixed(1)} mm/yr · bias ${gp.bias > 0 ? '+' : ''}${gp.bias.toFixed(1)}`),
    gp.rows.filter((r) => r.gps != null).map((r) => ({ x: r.gps, y: r.radar, name: r.name, flag: r.name === 'MXTM', tip: `GPS ${r.gps.toFixed(1)} mm/yr<br>radar ${r.radar.toFixed(1)} mm/yr` })), { xl: 'GPS rate, mm/yr', yl: 'radar rate, mm/yr', label: ['MMX1', 'MXTM', 'UFXN'] });

  const ni = V.mexico_nisar;
  charts.densityChart(card(root, '', 'Mexico City: one year of NISAR against ten of Sentinel-1', `${f0(ni.n)} pixels of 80 m. ${ni.note}`, `r = ${ni.r.toFixed(2)} · slope ${ni.slope.toFixed(2)} · spread ${ni.rmsd.toFixed(0)} mm/yr`), ni, { xl: 'Sentinel-1 rate 2016 to 2026, mm/yr', yl: 'NISAR rate 2025 to 2026, mm/yr' });

  const tr = V.truth;
  if (tr && tr.stations && tr.stations.length > 10) {
    const st3 = tr.stations.filter((r) => r.n >= 3);
    charts.scatterChart(card(root, 'full', `Every place against GPS: ${st3.length} stations at ${tr.stats.places} places`, `${tr.note} Places with one or two stations are left off this chart because their offset cannot be separated. Of ${tr.counts.agree + tr.counts.weak} places with a station: ${tr.counts.agree} agree, ${tr.counts.weak} agree only weakly (${tr.thin} of them rest on one or two stations). ${tr.counts.none} places have nothing to check against.`, tr.stats.r != null ? `r = ${tr.stats.r.toFixed(2)} · typical difference ${tr.stats.median_abs} mm/yr · ${tr.tied} maps tied to GPS` : ''),
      st3.map((r) => ({ x: r.gps, y: r.radar, name: `${r.name}, ${r.place}`, tip: `GPS ${r.gps.toFixed(1)} mm/yr<br>radar ${r.radar.toFixed(1)} mm/yr` })), { xl: 'GPS vertical rate, mm/yr', yl: 'radar rate, mm/yr', height: 320 });
  }
  const ns = V.nisar_sites || [];
  if (ns.length > 3) {
    const cnt = (k) => ns.filter((r) => r.verdict === k).length;
    charts.nisarChart(card(root, 'full', `NISAR at ${ns.length} places: of the ${cnt('strong') + cnt('moderate') + cnt('weak')} that move enough to compare, it agrees at ${cnt('strong')} and loosely at ${cnt('moderate')}`, `One dot per place with NISAR pairs from the past year stacked (6 to 28 pairs). Left to right: how much the Sentinel-1 rate varies across the place. Bottom to top: how well NISAR's map matches it. Where the ground barely moves there is nothing to match, and the correlation falls into noise. Big dots are the ground-checked places.`, `Agrees at ${cnt('strong')} · loosely at ${cnt('moderate')} · not yet at ${cnt('weak')} · too quiet to compare at ${cnt('quiet')}`), ns);
  }
  const pb = V.phoenix_benchmarks;
  charts.scatterChart(card(root, '', 'Phoenix East Valley: ranking agrees, sizes do not', `${pb.n} state benchmarks. ${pb.note}`, `Rank correlation ${pb.spearman.toFixed(2)}`),
    pb.rows.map((r) => ({ x: r.bm, y: r.radar, name: r.name, tip: `survey ${r.first} to ${r.last}: ${r.bm.toFixed(1)} mm/yr<br>radar: ${r.radar.toFixed(1)} mm/yr` })), { xl: 'survey rate, mm/yr (decades)', yl: 'radar rate, mm/yr', label: ['SGC-17', 'SUEL'] });

  charts.mdrChart(card(root, '', 'Chennai: it did not detect anything, yet', `With ${V.chennai.noise[0].months.toFixed(1)} months of NISAR the slowest detectable sinking is about ${V.chennai.noise[0].mdr_now.toFixed(0)} mm/yr. Published rates are below that. The curves show when that changes.`, 'Verdict: noise, shown as noise'), V.chennai.noise, V.chennai.published);
}

function renderTests(V) {
  const fw = Object.fromEntries(V.willcox_forward.all.map((r) => [r.score, r]));
  const ng = Object.fromEntries(V.willcox_forward.new_ground.map((r) => [r.score, r]));
  const bm = V.willcox_benchmarks, gp = V.mexico_gps, mx = gp.rows.find((r) => r.name === 'MXTM');
  const T = [
    ['Willcox: radar against survey benchmarks', `rank correlation ${bm.spearman.toFixed(2)} on ${bm.n}; ${bm.spearman_recent.toFixed(2)} on the ${bm.n_recent} surveyed since 2005`, 'ok', 'held up'],
    ['Willcox forward test: does unevenness, from pre-2023 radar, find fissures surveyed later?', `AUC ${fw.gradient.auc.toFixed(2)}; luck gives up to ${fw.gradient.null95.toFixed(2)}; top 5% of ground is ${fw.gradient.lift5} times chance`, 'ok', 'held up'],
    ['...and does it beat sinking rate alone?', `yes: ${fw.gradient.auc.toFixed(2)} against ${fw.baseline_rate.auc.toFixed(2)}`, 'ok', 'held up'],
    ['...and does it beat "look near fissures already mapped"?', `no: ${fw.gradient.auc.toFixed(2)} against ${fw.baseline_dist_fis2023.auc.toFixed(2)}`, 'bad', 'did not'],
    ['...on ground more than 500 m from any known fissure?', `highest score of the four (${ng.gradient ? ng.gradient.auc.toFixed(2) : '0.89'}), but on only ${ng.gradient ? ng.gradient.n_pos : 13} cells: suggestive, not shown`, '', 'inconclusive'],
    ['...at a finer 90 m grid?', 'weaker (0.81); distance to known fissures is clearly better (0.93)', 'bad', 'did not'],
    ['Absolute precision of the top 5%', `about ${(fw.gradient.prec5 * 100).toFixed(0)} in 100 flagged cells holds a newly mapped fissure. It ranks ground; it does not predict a fissure`, '', 'limit'],
    ['Mexico City: radar against GPS', `r = ${gp.r.toFixed(2)}, error ${gp.rmse.toFixed(0)} mm/yr on ${gp.n} stations; station MXTM is off by ${Math.abs(mx.radar - mx.gps).toFixed(0)} mm/yr, cause unknown`, 'ok', 'held up, one miss'],
    ['Mexico City: stacked NISAR against Sentinel-1', `r = ${V.mexico_nisar.r.toFixed(2)} over ${f0(V.mexico_nisar.n)} pixels`, 'ok', 'held up'],
    ['Willcox: NISAR against Sentinel-1', 'loose: r = 0.51 between rate maps, 3 to 19 mm of noise per pair, often no data at the fastest spot', 'bad', 'weak'],
    ...((V.nisar_sites || []).length > 3 ? [[`NISAR against Sentinel-1 at ${V.nisar_sites.length} places`, (() => { const c = (k) => V.nisar_sites.filter((r) => r.verdict === k).length; return `agrees (r 0.75 or more) at ${c('strong')}, loosely at ${c('moderate')}, not yet at ${c('weak')}; at ${c('quiet')} the ground moves too little for a comparison to mean anything`; })(), '', 'mixed, as expected']] : []),
    ['"NISAR sees farm fields where Sentinel-1 is blind"', 'dropped: 92% of Sentinel-1 pixels pass the quality mask at Willcox', 'bad', 'dropped'],
    ...(V.truth ? [[`Every other place against GPS stations inside its window`, `${V.truth.counts.agree} agree, ${V.truth.counts.weak} agree only weakly, ${V.truth.counts.none} have no station to check against; ${V.truth.thin} of the checks rest on one or two stations${V.truth.stats.r != null ? `; across ${V.truth.stats.n} stations at places with three or more, r = ${V.truth.stats.r.toFixed(2)}` : ''}`, V.truth.counts.weak ? '' : 'ok', 'mixed, shown per place']] : []),
    ['Phoenix: radar against survey benchmarks', `rank correlation ${V.phoenix_benchmarks.spearman.toFixed(2)} on ${V.phoenix_benchmarks.n}; radar sizes are 30 to 60% of the multi-decade survey averages`, 'ok', 'ranking only'],
    ['Chennai: can NISAR see the published sinking?', `not yet: detectable from about ${V.chennai.noise[0].mdr_now.toFixed(0)} mm/yr, published rates are 15 to 32`, 'bad', 'not detectable'],
    ['A fixed damage threshold (the 1/500 building limit)', 'dropped: at pixel scale it would take decades to reach, so it flags nothing or noise. The score is relative only', 'bad', 'dropped'],
  ];
  const t = $('#tests');
  t.className = 'big plain';
  t.innerHTML = '<thead><tr><th>Test</th><th>Result</th><th></th></tr></thead><tbody>' + T.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td><span class="tag ${r[2]}" style="margin:0;white-space:nowrap">${r[3]}</span></td></tr>`).join('') + '</tbody>';
}

function renderMethod() {
  $('#method').innerHTML = `
  <div class="card"><h3>The score, in five steps</h3><ul>
    <li><b>Rate.</b> A straight-line fit through the radar dates at every pixel, measured against bedrock, a stable GPS station or, at the places added by script, the steadiest ground in the window.</li>
    <li><b>Smooth.</b> 90 m cells, then the middle value of each 3 by 3 block: a 270 m grid that sheds single-pixel noise.</li>
    <li><b>Unevenness.</b> How much the rate changes per kilometre between neighbouring cells (the size of the gradient).</li>
    <li><b>Rank.</b> Each cell against the rest of the frame. The top 5% is the threshold the forward test scored.</li>
    <li><b>Line.</b> Any line is cut into pieces of about 300 m. A piece takes the highest unevenness under it and the middle sinking rate. Less than half good data means "not observed".</li></ul>
    <p class="fine">The same code scores the preloaded networks and anything you draw or upload. It runs in your browser; nothing is sent anywhere.</p></div>
  <div class="card"><h3>Data</h3><ul>
    <li><b>NASA OPERA DISP-S1</b> (Sentinel-1 displacement, 30 m), 2016 to 2026: frames 34478 (Willcox), 20688 (Mexico City), 7091 (Phoenix and Pinal County), and one frame for each other place, named on its panel.</li>
    <li><b>NISAR L2 GUNW</b> (L-band, 80 m, provisional): a year of pairs stacked at every place where the archive has them, noise analysis for Chennai. Wavelength read from each file; ionosphere screen and a plane removed; sign convention confirmed against Sentinel-1 at two sites.</li>
    <li><b>Ground truth:</b> Arizona Department of Water Resources survey benchmarks; Arizona Geological Survey earth-fissure maps (January 2023 and May 2026); GPS series from the Nevada Geodetic Laboratory.</li>
    <li><b>Lines:</b> US Census TIGER/Line 2024 roads; rail, pipelines, power lines, canals and the Metro from OpenStreetMap contributors (ODbL).</li>
    <li>Copernicus GLO-30 elevation for the basin-floor mask. Base map: OpenFreeMap, OpenMapTiles, OpenStreetMap.</li></ul></div>
  <div class="card"><h3>What StrainWatch does not know</h3><ul>
    <li>Whether anything is damaged. It reads the ground, not the asphalt, the weld or the lining.</li>
    <li>Anything narrower than a pixel. A fissure is a crack a few metres wide; we flag the strain field around it.</li>
    <li>Sideways motion. Rates assume the ground moves straight down. Phoenix is reported along the radar's line of sight.</li>
    <li>Ground with no good radar signal: irrigated fields, water, steep slopes. Those pieces are listed as not observed.</li>
    <li>Whether the bedrock reference points, chosen by hand, are truly still. At the places added by script there is no bedrock point at all. Where three or more GPS stations agree the map is tied to them; elsewhere rates are relative to the steadiest ground in the window, so a window that is sinking as a whole reads too slow.</li>
    <li>Why GPS station MXTM disagrees by about 50 mm a year.</li>
    <li>Extreme unevenness values in built-up cells can be noise. Use them to rank, not as measurements.</li></ul></div>
  <div class="card"><h3>What it does not claim</h3><ul>
    <li>That it predicts where a new fissure will open.</li>
    <li>That it beats looking near fissures that are already mapped.</li>
    <li>That Chennai is sinking at any measured rate.</li>
    <li>That a single 12-day NISAR pair is a measurement.</li>
    <li>Anything about any past incident on any road, canal or Metro line.</li></ul></div>
  <div class="card"><h3>Before acting on it</h3>
    <p><b>Ask a local expert:</b> in Arizona, the county engineer's office and the Arizona Geological Survey's earth-fissure program. They know which fissures have been filled, which roads were rebuilt, and what the radar cannot see.</p>
    <p class="fine">Scale: about 1.2 billion people live where land subsidence is likely by modelled potential (Herrera-García and others, Science, 2021). That figure is modelled potential, not measured sinking.</p></div>
  <div class="card"><h3>Who would keep it running</h3>
    <p><b>Status: nobody outside the team has used this yet.</b> The first field test is ready: print the ten Willcox stop sheets, drive them, and tick "found" or "nothing found" on each.</p>
    <p>StrainWatch is a folder of static files: no server, no database, no licence fee. A county or state GIS office reruns one script when NASA publishes new radar, and re-uploads the folder.</p>
    <p>Adding a place is one line in a list and a few minutes of reading NASA's archive. Open data in, open files out: every ranked list exports as CSV or GeoJSON for the GIS an agency already runs.</p>
    <p class="fine">Related work this builds on: Fernández-Torres and others 2020 and Cigna and Tapete 2021 (differential subsidence, Mexico City); Holzer, USGS (fissures and differential compaction); Carlson, Shirzaei and others 2020 (strain and fissure potential, San Joaquin Valley).</p></div>`;
}


function renderWho(S, api) {
  const root = $('#who');
  if (!root) return;
  const w = S.cache.get('willcox');
  let ex = '';
  if (w) {
    const roads = w.segs.filter((s) => s.g === 'roads'), first = roads.filter((s) => s.cls === 'first');
    const km = (a) => a.reduce((t, s) => t + s.len, 0) / 1000;
    const known = first.filter((s) => s.fisDist <= 500).length, fresh = first.filter((s) => !(s.fisDist <= 2000)).length;
    const lines = w.segs.filter((s) => ['pipeline', 'rail'].includes(s.g) && s.cls === 'first');
    ex = `<div class="card full"><h3>A worked example: the Willcox Basin, Cochise County, Arizona</h3>
      <div class="steps4">
        <div><b class="big">${f0(km(roads))} km</b>of public road cross this radar frame. One crew cannot drive all of it before the monsoon.</div>
        <div><b class="big">${f0(km(first))} km</b>sit on the most uneven 5% of ground. That is the list: ${f0(first.length)} pieces of about 300 m, each with a rate, a rank and a confidence.</div>
        <div><b class="big">${f0(known)} / ${f0(fresh)}</b>${f0(known)} of those pieces are within 500 m of a fissure the state has already mapped, which is the list agreeing with geologists. ${f0(fresh)} have no mapped fissure within 2 km: new places to look.</div>
        <div><b class="big">10 stops</b>is the short list the planner makes of it, ordered stop to nearest stop in straight lines (it does not know roads or driving time). Each stop prints as a one-page sheet; the whole list exports as CSV or GeoJSON. ${f0(lines.length)} pieces of the gas and fuel pipelines and the Union Pacific main line are on the same list.</div>
      </div>
      <p class="fine">Numbers computed live from the radar and the public road, rail and pipeline maps. They rank ground for inspection. They do not say anything is damaged.</p></div>`;
  }
  root.innerHTML = api.roles.map((r) => `<div class="card rolecard"><div class="kicker teal" style="margin-top:0">${r.who}</div><h3>${r.q}</h3>
      <p><b>What they get.</b> ${r.gets}</p>
      <p><b>What they do with it.</b> ${r.id === 'roads' ? 'Treat the top stops as inspection candidates alongside the known-fissure map, record what the crew finds, and keep the sheet with the road file.' : r.id === 'lines' ? 'Walk or fly the flagged pieces first, and overlay the file on their own integrity or maintenance map.' : 'Point field mapping at uneven ground away from known fissures, where a new fissure is least expected and least watched.'}</p>
      <button class="btn teal" data-role="${r.id}">Open the map as this person</button></div>`).join('') + ex;
  root.querySelectorAll('[data-role]').forEach((b) => (b.onclick = () => api.pickRole(b.dataset.role)));
}

export function renderBelow(S, api) {
  renderTable(S, api);
  renderWho(S, api);
  if (once) return;
  once = true;
  renderCharts(S.val);
  renderTests(S.val);
  renderMethod();
}
