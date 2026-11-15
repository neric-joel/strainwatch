// D3 charts. `d3` is a global loaded from the CDN in index.html.
/* global d3 */

const INK = '#1c1b19', MUTED = '#6f6b62', TEAL = '#147d6c', GRID = '#efece3', RED = '#b5452f', BLUE = '#2f62b7', AMBER = '#b7791f';
let tipEl;

function tip(html, ev) {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tt'; document.body.appendChild(tipEl); }
  if (!html) { tipEl.style.display = 'none'; return; }
  tipEl.innerHTML = html;
  tipEl.style.display = 'block';
  const x = Math.min(window.innerWidth - tipEl.offsetWidth - 8, ev.clientX + 12);
  tipEl.style.left = x + 'px';
  tipEl.style.top = ev.clientY + 14 + 'px';
}
const hover = (sel, fn) => sel.on('mousemove', (ev, d) => tip(fn(d), ev)).on('mouseleave', () => tip(null));

function frame(el, W, H, m) {
  el.innerHTML = '';
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img');
  const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
  return { svg, g, w: W - m.l - m.r, h: H - m.t - m.b };
}

function axes(g, x, y, w, h, { xl, yl, xt = 5, yt = 5, xf, yf } = {}) {
  g.append('g').attr('class', 'grid').call(d3.axisLeft(y).ticks(yt).tickSize(-w).tickFormat('')).call((s) => s.select('.domain').remove());
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).ticks(xt).tickSizeOuter(0).tickFormat(xf));
  g.append('g').attr('class', 'axis').call(d3.axisLeft(y).ticks(yt).tickSizeOuter(0).tickFormat(yf)).call((s) => s.select('.domain').remove());
  if (xl) g.append('text').attr('x', w).attr('y', h + 30).attr('text-anchor', 'end').text(xl);
  if (yl) g.append('text').attr('x', -34).attr('y', -9).text(yl);
}

/** Cumulative displacement with a fitted line. t = decimal years, y = mm. */
export function tsChart(el, t, y, fit, { unit = 'mm', height = 170 } = {}) {
  const { g, w, h } = frame(el, 380, height, { l: 40, r: 10, t: 16, b: 26 });
  const pts = t.map((v, i) => [v, y[i]]).filter((p) => Number.isFinite(p[1]));
  if (pts.length < 3) { el.innerHTML = '<p class="fine">No usable radar history at this spot.</p>'; return; }
  const x = d3.scaleLinear().domain(d3.extent(t)).range([0, w]);
  const ext = d3.extent(pts, (p) => p[1]);
  const pad = Math.max(4, (ext[1] - ext[0]) * 0.08);
  const ys = d3.scaleLinear().domain([Math.min(ext[0], 0) - pad, Math.max(ext[1], 0) + pad]).range([h, 0]);
  axes(g, x, ys, w, h, { xf: d3.format('d'), yl: unit, yt: 4, xt: 6 });
  g.append('line').attr('x1', 0).attr('x2', w).attr('y1', ys(0)).attr('y2', ys(0)).attr('stroke', '#c9c4b6');
  if (fit && Number.isFinite(fit.slope)) {
    const d = x.domain();
    g.append('line').attr('x1', x(d[0])).attr('x2', x(d[1])).attr('y1', ys(fit.intercept + fit.slope * d[0])).attr('y2', ys(fit.intercept + fit.slope * d[1]))
      .attr('stroke', TEAL).attr('stroke-width', 1.5).attr('stroke-dasharray', '5 3');
  }
  g.append('path').attr('d', d3.line().x((p) => x(p[0])).y((p) => ys(p[1]))(pts)).attr('fill', 'none').attr('stroke', INK).attr('stroke-width', 1.3);
  hover(g.selectAll('circle').data(pts).join('circle').attr('cx', (p) => x(p[0])).attr('cy', (p) => ys(p[1])).attr('r', 2.6).attr('fill', INK),
    (p) => `${p[0].toFixed(2)}: <b>${p[1].toFixed(0)} mm</b>`);
}

/** Profile along a drawn or selected line: unevenness bars by piece, sinking rate as a line. */
export function profileChart(el, pieces, onPick) {
  const { g, w, h } = frame(el, 380, 170, { l: 40, r: 40, t: 16, b: 28 });
  let acc = 0;
  const rows = pieces.map((s) => { const r = { s, d0: acc, d1: acc + s.len / 1000 }; acc = r.d1; return r; });
  const x = d3.scaleLinear().domain([0, acc]).range([0, w]);
  const yu = d3.scaleLinear().domain([0, d3.max(rows, (r) => r.s.uneven) || 1]).nice().range([h, 0]);
  const rmin = d3.min(rows, (r) => r.s.rate);
  const yr = d3.scaleLinear().domain([Math.min(rmin ?? -1, -1), Math.max(d3.max(rows, (r) => r.s.rate) ?? 0, 0)]).nice().range([h, 0]);
  axes(g, x, yu, w, h, { xl: 'km along the line', yl: 'mm/yr per km', yt: 4 });
  g.append('g').attr('class', 'axis').attr('transform', `translate(${w},0)`).call(d3.axisRight(yr).ticks(4).tickSizeOuter(0)).call((s) => s.select('.domain').remove());
  g.append('text').attr('x', w + 34).attr('y', -9).attr('text-anchor', 'end').text('mm/yr');
  const fill = { first: '#0e6a5c', watch: '#d9a441', routine: '#c4c0b4', nodata: 'url(#hatch)' };
  g.append('defs').html('<pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#ecebe6"/><rect width="2" height="5" fill="#a9a59b"/></pattern>');
  const bars = g.selectAll('rect.b').data(rows).join('rect').attr('class', 'b').attr('x', (r) => x(r.d0)).attr('width', (r) => Math.max(1, x(r.d1) - x(r.d0) - 0.5))
    .attr('y', (r) => (r.s.cls === 'nodata' ? 0 : yu(r.s.uneven))).attr('height', (r) => (r.s.cls === 'nodata' ? h : h - yu(r.s.uneven)))
    .attr('fill', (r) => fill[r.s.cls]).attr('opacity', (r) => (r.s.cls === 'nodata' ? 0.6 : 1)).style('cursor', 'pointer');
  hover(bars, (r) => (r.s.cls === 'nodata' ? `km ${r.d0.toFixed(1)}: <b>not observed</b>` : `km ${r.d0.toFixed(1)}: unevenness <b>${r.s.uneven.toFixed(0)}</b>, rate <b>${r.s.rate.toFixed(0)} mm/yr</b>`));
  if (onPick) bars.on('click', (ev, r) => onPick(r.s));
  const ok = rows.filter((r) => Number.isFinite(r.s.rate));
  g.append('path').attr('d', d3.line().x((r) => x((r.d0 + r.d1) / 2)).y((r) => yr(r.s.rate))(ok)).attr('fill', 'none').attr('stroke', RED).attr('stroke-width', 1.4);
}

/** Scatter of radar against ground truth with a 1:1 line. rows: {x, y, name, hollow, flag} */
export function scatterChart(el, rows, { xl, yl, lo, hi, one = true, label = [], height = 300 } = {}) {
  const { g, w, h } = frame(el, 520, height, { l: 46, r: 14, t: 18, b: 36 });
  const all = rows.flatMap((r) => [r.x, r.y]);
  lo = lo ?? Math.min(d3.min(all), 0); hi = hi ?? Math.max(d3.max(all), 0);
  const x = d3.scaleLinear().domain([lo, hi]).nice().range([0, w]);
  const y = d3.scaleLinear().domain(one ? x.domain() : d3.extent(rows, (r) => r.y)).nice().range([h, 0]);
  axes(g, x, y, w, h, { xl, yl });
  if (one) g.append('line').attr('x1', x(x.domain()[0])).attr('y1', y(x.domain()[0])).attr('x2', x(x.domain()[1])).attr('y2', y(x.domain()[1])).attr('stroke', '#b9b4a6').attr('stroke-dasharray', '4 3');
  if (one) g.append('text').attr('x', w - 4).attr('y', y(x.domain()[1]) + 12).attr('text-anchor', 'end').text('perfect match');
  hover(g.selectAll('circle').data(rows).join('circle').attr('cx', (r) => x(r.x)).attr('cy', (r) => y(r.y)).attr('r', 4.2)
    .attr('fill', (r) => (r.flag ? AMBER : r.hollow ? '#fff' : TEAL)).attr('stroke', (r) => (r.flag ? AMBER : TEAL)).attr('stroke-width', 1.5),
  (r) => `<b>${r.name}</b><br>${r.tip || ''}`);
  g.selectAll('text.lb').data(rows.filter((r) => label.includes(r.name))).join('text').attr('class', 'lb').attr('x', (r) => x(r.x) + 7).attr('y', (r) => y(r.y) + 4)
    .text((r) => r.name).style('fill', INK).style('font-weight', 600);
}

/** Horizontal AUC bars with a shaded "could be luck" band. rows: {label, auc, kind} */
export function aucChart(el, rows, { null95, title } = {}) {
  const { g, w, h } = frame(el, 520, 44 + rows.length * 34, { l: 190, r: 46, t: 24, b: 30 });
  const x = d3.scaleLinear().domain([0.5, 1]).range([0, w]);
  const y = d3.scaleBand().domain(rows.map((r) => r.label)).range([0, h]).padding(0.32);
  if (null95) {
    g.append('rect').attr('x', 0).attr('width', x(null95)).attr('y', -6).attr('height', h + 6).attr('fill', '#f1eee5');
    g.append('text').attr('x', x(null95) - 4).attr('y', -10).attr('text-anchor', 'end').text(`could be luck (below ${null95.toFixed(2)})`);
  }
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).ticks(5).tickSizeOuter(0));
  g.append('text').attr('x', w).attr('y', h + 28).attr('text-anchor', 'end').text(title || 'AUC: 0.5 = coin flip, 1.0 = perfect');
  const col = { ours: TEAL, base: '#8d887b', win: INK };
  hover(g.selectAll('rect.b').data(rows).join('rect').attr('class', 'b').attr('x', 0).attr('y', (r) => y(r.label)).attr('height', y.bandwidth()).attr('width', (r) => x(r.auc)).attr('fill', (r) => col[r.kind] || col.base),
    (r) => `<b>${r.label}</b><br>AUC ${r.auc.toFixed(3)}${r.lift != null ? `<br>top 5% of ground: ${r.lift}x chance` : ''}`);
  g.selectAll('text.v').data(rows).join('text').attr('class', 'v').attr('x', (r) => x(r.auc) + 5).attr('y', (r) => y(r.label) + y.bandwidth() / 2 + 4).text((r) => r.auc.toFixed(2)).style('fill', INK).style('font-weight', 700);
  g.selectAll('text.l').data(rows).join('text').attr('class', 'l').attr('x', -8).attr('y', (r) => y(r.label) + y.bandwidth() / 2 + 4).attr('text-anchor', 'end').text((r) => r.label).style('fill', (r) => (r.kind === 'ours' ? TEAL : INK)).style('font-weight', (r) => (r.kind === 'base' ? 400 : 700));
}

/** 2-D density (counts on a square grid) for NISAR against Sentinel-1. */
export function densityChart(el, d, { xl, yl } = {}) {
  const { g, w, h } = frame(el, 520, 300, { l: 46, r: 14, t: 18, b: 36 });
  const x = d3.scaleLinear().domain([d.lo, d.hi]).range([0, w]);
  const y = d3.scaleLinear().domain([d.lo, d.hi]).range([h, 0]);
  axes(g, x, y, w, h, { xl, yl });
  const cells = [];
  const step = (d.hi - d.lo) / d.bins;
  d.counts.forEach((row, i) => row.forEach((c, j) => { if (c > 0) cells.push({ i, j, c }); }));
  const col = d3.scaleSequentialLog(d3.interpolateRgb('#dbe6f4', '#14306b')).domain([1, d3.max(cells, (c) => c.c)]);
  g.selectAll('rect.c').data(cells).join('rect').attr('class', 'c').attr('x', (c) => x(d.lo + c.i * step)).attr('y', (c) => y(d.lo + (c.j + 1) * step))
    .attr('width', w / d.bins + 0.4).attr('height', h / d.bins + 0.4).attr('fill', (c) => col(c.c));
  g.append('line').attr('x1', x(d.lo)).attr('y1', y(d.lo)).attr('x2', x(d.hi)).attr('y2', y(d.hi)).attr('stroke', INK).attr('stroke-dasharray', '4 3');
  g.append('text').attr('x', w - 4).attr('y', 12).attr('text-anchor', 'end').text('darker = more pixels');
}


/** NISAR against Sentinel-1, one dot per place: agreement (r) against how much the ground there actually moves. */
export function nisarChart(el, rows) {
  const { g, w, h } = frame(el, 1060, 300, { l: 46, r: 150, t: 18, b: 38 });
  const ok = rows.filter((r) => r.r != null && r.s1_spread > 0);
  const x = d3.scaleLog().domain([0.2, Math.max(120, d3.max(ok, (r) => r.s1_spread) * 1.2)]).range([0, w]);
  const y = d3.scaleLinear().domain([-0.4, 1]).range([h, 0]);
  axes(g, x, y, w, h, { xl: 'how much the Sentinel-1 rate varies across the place, mm/yr (log scale)', yl: 'NISAR against Sentinel-1, r', xt: 6, xf: (v) => (Math.log10(v) % 1 < 0.01 || [0.5, 2, 5, 20, 50].includes(v) ? d3.format('~g')(v) : '') });
  [[0.75, 'agrees'], [0.4, 'loosely']].forEach(([v, t]) => {
    g.append('line').attr('x1', 0).attr('x2', w).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', '#b9b4a6').attr('stroke-dasharray', '4 3');
    g.append('text').attr('x', w + 6).attr('y', y(v) + 4).text(`${v}: ${t}`);
  });
  g.append('line').attr('x1', 0).attr('x2', w).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', '#c9c4b6');
  const col = { strong: TEAL, moderate: '#d9a441', weak: RED, quiet: '#9aa0a6' };
  hover(g.selectAll('circle').data(ok).join('circle').attr('cx', (r) => x(Math.max(0.2, r.s1_spread))).attr('cy', (r) => y(Math.max(-0.4, r.r))).attr('r', (r) => (r.tier === 'checked' ? 6 : 4.2))
    .attr('fill', (r) => col[r.verdict] || '#9aa0a6').attr('stroke', '#fff').attr('stroke-width', 1),
  (r) => `<b>${r.name}${r.st && r.st !== 'MX' ? ', ' + r.st : ''}</b><br>r = ${r.r.toFixed(2)} · ${r.pairs} pairs<br>Sentinel-1 varies by ±${r.s1_spread.toFixed(1)} mm/yr here${r.noise_mmyr != null ? `<br>NISAR scatter on steady ground ±${r.noise_mmyr} mm/yr` : ''}`);
  const lab = ok.slice().sort((a, b) => b.s1_spread - a.s1_spread).slice(0, 9);
  g.selectAll('text.lb').data(lab).join('text').attr('class', 'lb').attr('x', (r) => x(r.s1_spread) + 7).attr('y', (r) => y(Math.max(-0.4, r.r)) + 4).text((r) => r.name).style('fill', INK).style('font-weight', 600);
  const leg = g.append('g').attr('transform', `translate(${w + 6}, ${h - 62})`);
  [['strong', 'agrees'], ['moderate', 'agrees loosely'], ['weak', 'does not agree yet'], ['quiet', 'too quiet to compare']].forEach(([k, t], i) => {
    leg.append('circle').attr('cx', 5).attr('cy', i * 16).attr('r', 4.2).attr('fill', col[k]);
    leg.append('text').attr('x', 15).attr('y', i * 16 + 4).text(t);
  });
}

/** Smallest detectable rate against months of record, two noise models, with published rates marked. */
export function mdrChart(el, noise, published, { W = 520, H = 300 } = {}) {
  const { g, w, h } = frame(el, W, H, { l: 40, r: 92, t: 18, b: 36 });
  const n = noise[0];
  const months = d3.range(2, 37, 0.5);
  const fixed = months.map((m) => [m, (2 * n.sigma_cum) / (m / 12)]);
  const walk = months.map((m) => [m, (2 * n.sigma_pair * Math.sqrt((m * 30.44) / 12)) / (m / 12)]);
  const x = d3.scaleLinear().domain([0, 36]).range([0, w]);
  const y = d3.scaleLog().domain([3, 120]).range([h, 0]);
  axes(g, x, y, w, h, { xl: 'months of NISAR record', yl: 'smallest detectable rate, mm/yr', xt: 6 });
  g.selectAll('.axis').filter((d, i) => i === 1).call(d3.axisLeft(y).tickValues([3, 5, 10, 20, 40, 80]).tickFormat(d3.format('d')).tickSizeOuter(0)).call((s) => s.select('.domain').remove());
  g.selectAll('.grid line').attr('stroke', GRID);
  const line = d3.line().x((p) => x(p[0])).y((p) => y(Math.max(3, Math.min(120, p[1]))));
  g.append('path').attr('d', line(fixed)).attr('fill', 'none').attr('stroke', TEAL).attr('stroke-width', 2);
  g.append('path').attr('d', line(walk)).attr('fill', 'none').attr('stroke', INK).attr('stroke-width', 2).attr('stroke-dasharray', '5 3');
  g.append('text').attr('x', w + 5).attr('y', y(Math.max(3, fixed.at(-1)[1])) + 4).text('if noise stays flat').style('fill', TEAL).style('font-weight', 600);
  g.append('text').attr('x', w + 5).attr('y', y(walk.at(-1)[1]) + 4).text('if noise adds up').style('fill', INK).style('font-weight', 600);
  published.forEach((p) => {
    g.append('line').attr('x1', 0).attr('x2', w).attr('y1', y(p)).attr('y2', y(p)).attr('stroke', RED).attr('stroke-dasharray', '2 3');
    g.append('text').attr('x', w - 4).attr('y', y(p) - 4).attr('text-anchor', 'end').text(`published: ${p} mm/yr`).style('fill', RED);
  });
  g.append('circle').attr('cx', x(n.months)).attr('cy', y(n.mdr_now)).attr('r', 5).attr('fill', '#fff').attr('stroke', INK).attr('stroke-width', 2);
  g.append('text').attr('x', x(n.months) + 9).attr('y', y(n.mdr_now) - 12).text(`today: ${n.months.toFixed(1)} months, ${n.mdr_now.toFixed(0)} mm/yr`).style('fill', INK).style('font-weight', 700);
}
