// Exports: ranked list as CSV or GeoJSON, and a one-page printable report for a single piece.
import { CLASS_LABEL } from './score.js';

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : '');

export function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const COLS = [
  ['stop', (s) => s.stop ?? ''], ['rank', (s) => s.rank ?? ''], ['verdict', (s) => CLASS_LABEL[s.cls]], ['name', (s) => s.name], ['also_known_as', (s) => (s.aka || []).join(' / ')],
  ['type', (s) => s.kind], ['piece', (s) => s.piece], ['length_m', (s) => Math.round(s.len)], ['mid_lon', (s) => s.mid[0].toFixed(5)], ['mid_lat', (s) => s.mid[1].toFixed(5)],
  ['unevenness_mm_yr_per_km', (s) => r1(s.uneven)], ['unevenness_percentile', (s) => r1(s.pct)], ['sinking_rate_mm_yr', (s) => r1(s.rate)],
  ['good_data_share', (s) => s.valid.toFixed(2)], ['nearest_mapped_fissure_m', (s) => (Number.isFinite(s.fisDist) ? Math.round(s.fisDist) : '')],
];
const q = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v);

export function toCSV(segs, site) {
  const head = `# StrainWatch ranked list. Site: ${site.name}. Radar: ${site.sensor}, ${site.layers.rate ? site.layers.rate.period : ''}. Rates are ${site.rate_kind}; negative = sinking.\n# Screening index for prioritising inspection. Not a damage assessment and not a forecast. "No data" means not observed, not stable.\n`;
  return head + COLS.map((c) => c[0]).join(',') + '\n' + segs.map((s) => COLS.map((c) => q(c[1](s))).join(',')).join('\n') + '\n';
}

export function toGeoJSON(segs, site) {
  return JSON.stringify({
    type: 'FeatureCollection',
    name: `StrainWatch ${site.name}`,
    description: 'Screening index for prioritising inspection. Not a damage assessment and not a forecast. Negative rate = sinking. No data = not observed.',
    features: segs.map((s) => ({ type: 'Feature', properties: Object.fromEntries(COLS.map((c) => [c[0], c[1](s)])), geometry: { type: 'LineString', coordinates: s.coords.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]) } })),
  });
}

export function printReport(s, { c, map, fmtRate, fmtUn }) {
  const site = c.site, rep = document.getElementById('report');
  let img = '';
  try { img = map.getCanvas().toDataURL('image/jpeg', 0.85); } catch (e) { img = ''; }
  const ts = document.querySelector('#ts svg'), why = document.getElementById('why'), kv = document.getElementById('tskv');
  const esc = (t) => String(t).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  rep.innerHTML = `<div class="rk">StrainWatch inspection sheet · ${esc(site.name)} · printed ${new Date().toISOString().slice(0, 10)}</div>
    <h1>${esc(s.name)}</h1>
    <div>${esc(s.kind)}${s.aka && s.aka.length ? ' · also ' + esc(s.aka.join(', ')) : ''} · piece ${s.piece} of ${s.of} · ${Math.round(s.len)} m · centre ${s.mid[1].toFixed(5)}, ${s.mid[0].toFixed(5)}</div>
    <div class="verdict"><b>${CLASS_LABEL[s.cls]}</b>${s.rank ? ` · rank ${s.rank}` : ''}${s.cls !== 'nodata' ? ` · unevenness ${fmtUn(s.uneven)} · ${fmtRate(s.rate)}` : ''}</div>
    <div class="two"><div>${img ? `<img src="${img}" alt="Map of the piece">` : ''}</div><div>
      <table>
        <tr><td>Unevenness (worst point under the piece)</td><td>${fmtUn(s.uneven)}</td></tr>
        <tr><td>Percentile among measured ground in this frame</td><td>${Number.isFinite(s.pct) ? s.pct.toFixed(1) : 'n/a'}</td></tr>
        <tr><td>Sinking rate (middle value, ${esc(site.rate_kind)})</td><td>${Number.isFinite(s.rate) ? s.rate.toFixed(1) + ' mm/yr' : 'n/a'}</td></tr>
        <tr><td>Good radar data under the piece</td><td>${Math.round(s.valid * 100)}%</td></tr>
        <tr><td>Nearest mapped fissure</td><td>${Number.isFinite(s.fisDist) ? Math.round(s.fisDist) + ' m' : 'none within about 2 km, or not mapped here'}</td></tr>
        <tr><td>Data confidence (the radar reading, not the rank)</td><td>${s._conf ? esc(s._conf[0]) : 'n/a'}</td></tr>
      </table>
      ${kv ? '<h3>Sinking history</h3><table>' + kv.innerHTML + '</table>' : ''}
    </div></div>
    ${ts ? '<h3>Cumulative movement under the piece (mm)</h3><div style="max-width:420px">' + ts.outerHTML + '</div>' : ''}
    ${why ? '<h3>Why it ranks here</h3><ul>' + why.innerHTML + '</ul>' : ''}
    <h3>For the inspector</h3>
    <ul><li>Look for: open or hairline cracks crossing the line, offsets, potholes in a row, ponding, tilted poles or fence posts, fresh patching.</li>
    <li>Record what you find, including "nothing". Negative results are what make the next ranking better.</li></ul>
    <div class="fine">Source: ${esc(site.sensor)}, ${site.layers.rate ? esc(site.layers.rate.period) : ''}, referenced to: ${esc(site.reference)}. Unevenness = change in sinking rate per kilometre on a 270 m grid, ranked within the frame.
    This is a relative screening index for deciding where to look first. It is not a damage assessment, not an engineering finding and not a forecast. Fissures are narrower than a radar pixel. "Not observed" does not mean stable.
    Rates assume vertical motion${site.rate_kind === 'line of sight' ? ' (this site is reported along the radar line of sight)' : ''}.</div>`;
  setTimeout(() => window.print(), 60);
}

/** Printable package for an inspection plan: one summary table and one block per stop. */
export function printPlan(plan, { c, map, fmtRate, fmtUn }) {
  const site = c.site, rep = document.getElementById('report');
  const esc = (t) => String(t).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  let img = '';
  try { img = map.getCanvas().toDataURL('image/jpeg', 0.85); } catch (e) { img = ''; }
  const fis = (s) => (Number.isFinite(s.fisDist) ? Math.round(s.fisDist) + ' m' : c.fis ? 'none within 2 km' : 'not mapped here');
  rep.innerHTML = `<div class="rk">StrainWatch inspection candidates · ${esc(site.name)} · printed ${new Date().toISOString().slice(0, 10)}</div>
    <h1>${plan.stops.length} stops to look at first</h1>
    <div>${esc(site.region)} · ${plan.inspectKm.toFixed(1)} km of line to check · about ${plan.travelKm.toFixed(0)} km between stops in straight lines (not by road)</div>
    ${img ? `<div style="max-width:520px;margin-top:8px"><img src="${img}" alt="Map of the stops"></div>` : ''}
    <h3>Summary</h3>
    <table><tr><td><b>Stop</b></td><td style="text-align:left;font-weight:400"><b>Where</b></td><td><b>Unevenness · sinking · nearest mapped fissure</b></td></tr>
    ${plan.stops.map((st) => `<tr><td>${st.order}</td><td style="text-align:left;font-weight:400">${esc(st.names.slice(0, 2).join(', '))} · ${st.top.mid[1].toFixed(4)}, ${st.top.mid[0].toFixed(4)}</td><td>${fmtUn(st.top.uneven)} · ${fmtRate(st.top.rate)} · ${fis(st.top)}</td></tr>`).join('')}</table>
    ${plan.stops.map((st) => `<h3>Stop ${st.order}: ${esc(st.names.slice(0, 3).join(', '))}</h3>
      <table>${st.segs.map((s) => `<tr><td>${esc(s.name)} (${esc(s.kind)}), ${Math.round(s.len)} m at ${s.mid[1].toFixed(5)}, ${s.mid[0].toFixed(5)}</td><td>${fmtUn(s.uneven)} · ${fmtRate(s.rate)} · ${Math.round(s.valid * 100)}% good data</td></tr>`).join('')}</table>
      <div>Found on site: ____________________________________________ &nbsp; Nothing found: [ ]</div>`).join('')}
    <div class="fine">Source: ${esc(site.sensor)}, ${site.layers.rate ? esc(site.layers.rate.period) : ''}, referenced to: ${esc(site.reference)}.
    These are candidates for inspection, ranked by how unevenly the ground is sinking on a 270 m grid. They are not findings of damage and not a forecast. The stop order is nearest-neighbour in straight lines.
    In our one forward test, distance to already-mapped fissures ranked ground slightly better than this score; use both. "Not observed" ground is not on this list and is not known to be stable.</div>`;
  setTimeout(() => window.print(), 60);
}
