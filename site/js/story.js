// The opening story: one card per step, each with a map view. Numbers come from validation.json and from the live scoring,
// so the text cannot drift from what the app computes.

const f0 = (v) => Math.round(v).toLocaleString();
const sw = (c) => `<i class="sw-inline" style="background:${c}"></i>`;

export function buildSteps(ctx) {
  const V = ctx.val;
  const fw = Object.fromEntries(V.willcox_forward.all.map((r) => [r.score, r]));
  const g = fw.gradient, rate = fw.baseline_rate, fis = fw.baseline_dist_fis2023;
  const bm = V.willcox_benchmarks, gps = V.mexico_gps, nis = V.mexico_nisar, ch = V.chennai, pb = V.phoenix_benchmarks;
  const mtd = (r, k) => ch.months_to_detect.filter((m) => m.rate === r).map((m) => m[k]);
  const rng = (a) => (Math.min(...a) === Math.max(...a) ? `${a[0]}` : `${Math.min(...a)} to ${Math.max(...a)}`);

  const nT = (k) => ctx.sites.filter((s) => s.tier === k).length;
  const added = ctx.sites.filter((s) => s.tier === 'measured' && s.summary.p01_mmyr != null);
  // feature a well-observed US place first; fall back to whatever is fastest
  const pick = (f) => added.filter(f).sort((a, b) => a.summary.fast_mmyr - b.summary.fast_mmyr);
  const extra = [...new Set([...pick((s) => !/Mexico$/.test(s.region) && s.summary.valid_share >= 0.8), ...pick(() => true)])];
  const join = (a) => a.join(', ').replace(/, ([^,]*)$/, ' and $1');
  const states = (list) => join([...new Set(list.map((s) => s.region.split(', ').pop()))]);
  const nStates = (list) => new Set(list.map((s) => s.st)).size;
  const names = (list) => (list.length <= 4 ? join(list.map((s) => s.name)) : nStates(list) > 9 ? `in ${ctx.coverage.us_states} of the lower-48 states${ctx.coverage.dc ? ', Washington DC' : ''} and Mexico` : `across ${states(list)}`);

  return [
    {
      id: 'hero', hero: true,
      view: { site: null, center: [-99, 36], zoom: 3.9 },
      html: `<div class="k">NASA Space Apps 2026 · Dancing with the SARs</div>
        <h1>The Ground Is Sinking Unevenly. Here Is Where It Bends the Line.</h1>
        <p class="dek">Radar satellites measure how fast land sinks. The damage happens where it sinks <b>unevenly</b>. StrainWatch takes any road, rail line, pipeline or canal inside a processed radar window and tells you which stretches to check first, 300 metres at a time: ${ctx.exposure ? `so far ${f0(ctx.exposure.total.km)} km of road, rail, pipeline, canal and power line across the US and Mexico, with ${f0(ctx.exposure.total.strong_first_km)} km flagged to look at first` : `${ctx.sites.length} places so far`}. Ground-checked at three of those places, in two countries.</p>
        <p class="dek" style="margin-top:10px"><b>Which stretch should your crew check first?</b> Built for county road engineers, pipeline and canal operators, and state geologists.</p>
        <p><button class="btn teal" data-act="demo">Show me a county example</button></p>
        <div class="by">Data: NASA OPERA DISP-S1 (Sentinel-1) and NISAR · Arizona survey benchmarks and fissure maps · GPS · November 2026</div>
        <div class="scroll">SCROLL ↓ &nbsp;·&nbsp; the map is live: drag it, zoom it, click a dot</div>`,
    },
    {
      id: 'who', kicker: 'Who uses this',
      title: 'One crew, thousands of kilometres. Where do they go first?',
      view: { site: 'willcox', center: [-109.84, 32.1], zoom: 10.2, layer: 'uneven', lines: true },
      body: (c) => {
        const r = c.groupSum('willcox', 'roads');
        return `<p>The radar frame over the Willcox Basin alone holds <b>${f0(r.km)} km</b> of public road, and nobody can inspect all of it. StrainWatch says which <b>${f0(r.first.km)} km</b> to look at first, and why. Across every line type in this frame: ${f0(c.summary('willcox').km)} km, ${f0(c.summary('willcox').first.km)} km to look at first.</p>
        <p class="fine">Scale: about 1.2 billion people live where land subsidence is likely (modelled potential; Herrera-García and others, 2021). Counting residents says who is exposed. A crew needs to know which 300 metres to drive to.</p>
        <div class="roles story">${c.roles.map((x) => `<button class="role" data-role="${x.id}"><b>${x.who}</b><span class="q">${x.q}</span><span class="g">${x.gets}</span></button>`).join('')}</div>
        ${c.exposure ? `<p>Across every place so far: <b>${f0(c.exposure.total.km)} km</b> of road, rail, pipeline, canal and power line screened, <b>${f0(c.exposure.total.strong_first_km)} km</b> flagged to look at first, and ${f0(c.exposure.total.nodata_km)} km the radar could not observe.</p>` : ''}
        <p class="fine">Click a job to open the map as that person. What they take away: a ranked work list, a short list of inspection stops, a one-page sheet per stop, and a file that drops into the GIS they already run.</p>`;
      },
    },
    {
      id: 'world', kicker: 'One method, many places',
      title: `${ctx.sites.length} places, three levels of trust`,
      view: { site: null, center: [-98, 36.5], zoom: 3.9 },
      body: `<p>Every dot is real radar, processed by the same code. They are not equally proven, and the map keeps them apart.</p>
        <p>${sw('#147d6c')}<b>${nT('checked')} checked against the ground</b>: Willcox against surveyors and a fissure test, Mexico City against GPS, the Phoenix East Valley against surveyors.<br>${sw('#1c1b19')}<b>${nT('measured')} measured, not yet checked</b>, ${names(ctx.sites.filter((s) => s.tier === 'measured'))}${ctx.coverage.us_states >= 48 ? ': every lower-48 state has at least one' : ''}.<br>${sw('#8f7fb0')}<b>${nT('frontier')} NISAR only</b>: Chennai, where the honest answer is "not yet".</p>
        <p><b>NISAR's job:</b> the ten-year history is Sentinel-1; NISAR can carry the watch forward once that record ends, and it is the only source in most of the world. Pairs from its first year are stacked at ${ctx.nisarPlaces()} places: of the ${ctx.nisarCount('strong') + ctx.nisarCount('moderate') + ctx.nisarCount('weak')} that move enough to compare, it agrees with Sentinel-1 at ${ctx.nisarCount('strong')}, loosely at ${ctx.nisarCount('moderate')}, not yet at ${ctx.nisarCount('weak')}. ${ctx.nisarSummary()}</p>
        <p class="fine">The dashed boxes are the processed windows, about ${((ctx.coverage.us_share || 0) * 100).toFixed(1)}% of the lower-48 land area. Everywhere else is not processed yet, which is not the same as stable.</p>`,
    },
    {
      id: 'bowl', kicker: 'Willcox Basin, Arizona',
      title: 'A farm valley sinking up to six inches a year',
      view: { site: 'willcox', center: [-109.88, 32.2], zoom: 9.45, layer: 'rate',
        callouts: [
          { at: [-109.931, 32.45], title: `Fastest ground: ${f0(-ctx.site('willcox').summary.peak90_mmyr)} mm a year`, sub: 'Sentinel-1 radar, 2016 to 2026', side: 'left' },
          { at: [-109.965, 31.925], title: 'Dragoon Mountains', sub: 'Bedrock. Every rate is measured against it.', side: 'left', down: true },
          { at: [-109.832, 32.2528], title: 'Willcox' },
        ] },
      body: `<p>Under the fields of Cochise County, pumped groundwater is letting the land settle. Ten years of Sentinel-1 radar, processed by NASA's OPERA project, show the fastest spot dropping about <b>${f0(-ctx.site('willcox').summary.peak90_mmyr)} mm a year</b>.</p>
        <p>About <b>${f0(ctx.site('willcox').summary.area_gt50_km2 / 10) * 10} km²</b> of the basin is going down faster than 50 mm a year. ${sw('#8c1f1c')}Darker red means faster.</p>`,
    },
    {
      id: 'survey', kicker: 'Check one: surveyors',
      title: 'The radar ranks the ground the way surveyors do',
      view: { site: 'willcox', center: [-109.88, 32.22], zoom: 9.7, layer: 'rate', points: 'benchmarks',
        callouts: [
          { at: ctx.bm('Apple'), title: 'Benchmark "Apple"', sub: `Survey ${ctx.bmv('Apple').bm.toFixed(0)} · radar ${ctx.bmv('Apple').radar.toFixed(0)} mm/yr`, side: 'left' },
          { at: ctx.bm('Arabian'), title: 'Benchmark "Arabian"', sub: `Survey ${ctx.bmv('Arabian').bm.toFixed(0)} · radar ${ctx.bmv('Arabian').radar.toFixed(0)} mm/yr`, down: true },
        ] },
      body: `<p>Arizona's water agency has surveyed <b>${bm.n} benchmarks</b> in this basin, some of them for decades. Radar puts them in nearly the same order: rank correlation <b>${bm.spearman.toFixed(2)}</b>.</p>
        <p>For the ${bm.n_recent} benchmarks first surveyed since 2005, whose averages cover roughly the radar years, it is <b>${bm.spearman_recent.toFixed(2)}</b>, with a fitted slope of ${bm.slope_recent.toFixed(2)} (1.00 would be a perfect match).</p>
        <p class="fine">Older benchmarks average decades when sinking was slower, so their survey rates are lower than today's radar rates. That is expected.</p>`,
    },
    {
      id: 'uneven', kicker: 'The idea',
      title: 'Fast is not the same as uneven',
      view: { site: 'willcox', center: [-109.86, 32.08], zoom: 10.4, compare: ['rate', 'uneven'], split: 0.62 },
      body: `<p>A road that rides down evenly with the ground can survive. It breaks where one end sinks faster than the other, and that is also where earth fissures open.</p>
        <p>So StrainWatch maps the <b>change in sinking rate per kilometre</b>. Left of the line: how fast. Right: ${sw('#14306b')}how uneven. The steepest ground rings the bowls. It is not at their centres.</p>
        <p class="fine">The score is relative. Each 270 m cell is ranked against the rest of the basin floor; the darkest blue is the top 1%.</p>`,
    },
    {
      id: 'test', kicker: 'Check two: a forward test',
      title: 'We hid three years of fissures, then looked',
      view: { site: 'willcox', center: [-109.82, 32.06], zoom: 10.7, layer: 'uneven_pre', fissures: 'both',
        callouts: [{ at: [-109.9, 32.036], title: 'Dragoon Road area', sub: 'New fissure lines in orange, older ones in black', side: 'left' }] },
      body: `<p>The basin was ranked with radar from <b>before 2023 only</b>. Then it was scored against ${fw.gradient.n_pos} map cells holding fissures that state geologists field-surveyed and added <b>after</b> January 2023 ${sw('#e8590c')}.</p>
        <p>The unevenness score separated them from the rest of the basin floor with an AUC of <b>${g.auc.toFixed(2)}</b> (95% of shuffled trials score below ${g.null95.toFixed(2)}), well ahead of sinking rate alone at <b>${rate.auc.toFixed(2)}</b>. The top 5% of ground held ${Math.round(g.recall5 * 100)}% of those cells: ${g.lift5} times chance.</p>
        <p><b>What it did not do:</b> beat the simplest rule, "look near fissures you already know" (${fis.auc.toFixed(2)}). So this ranks ground for inspection. It does not predict where a fissure will open.</p>`,
    },
    {
      id: 'list', kicker: 'From map to work list',
      title: 'Every 300 metres gets one line: how fast, how uneven, how sure',
      view: { site: 'willcox', center: [-109.84, 32.05], zoom: 10.9, layer: 'uneven', lines: true, callouts: (c) => c.topCallouts('willcox', ['roads', 'pipeline', 'rail']) },
      body: (c) => {
        const s = c.summary('willcox'), rd = c.groupSum('willcox', 'roads');
        return `<p>Cochise County's roads, the Union Pacific main line, gas and fuel pipelines and the transmission grid were cut into <b>${f0(s.n)} pieces</b> and scored by the same code.</p>
        <p>${sw('#0e6a5c')}For a county road crew that means <b>${f0(rd.first.km)} km of road to look at first, out of ${f0(rd.km)} km</b>. Across all line types, ${f0(c.missed('willcox'))} of the top-ranked pieces are not among the fastest-sinking fifth: a ranking by speed alone would have left them in the routine pile.</p>
        <p>${f0(s.nodata.n)} pieces have too little good radar data and are marked <b>not observed</b>, never "safe". The planner turns the list into a short set of inspection stops and exports it for the maps an agency already runs.</p>`;
      },
    },
    {
      id: 'mexico', kicker: 'Check three: another country, GPS',
      title: 'The same code, unchanged, in Mexico City',
      view: { site: 'mexico', center: [-99.07, 19.4], zoom: 10.7, layer: 'rate', points: 'gps', lines: true,
        callouts: [
          { at: [-99.0684, 19.4317], title: 'GPS station MMX1', sub: `GPS ${ctx.gps('MMX1').gps.toFixed(0)} · radar ${ctx.gps('MMX1').radar.toFixed(0)} mm/yr`, side: 'left' },
          { at: [-98.9785, 19.4844], title: 'MXTM: the miss', sub: `GPS ${ctx.gps('MXTM').gps.toFixed(0)} · radar ${ctx.gps('MXTM').radar.toFixed(0)}. Cause not found.` },
          { at: [-99.011, 19.369], title: 'Metro Line A', sub: 'Highest readings on the network (upper bounds)', down: true },
        ] },
      body: (c) => `<p>Mexico City sinks faster than almost any city on Earth. Against <b>${gps.n} GPS stations</b> there, the radar scored r = <b>${gps.r.toFixed(2)}</b> with an error of <b>${gps.rmse.toFixed(0)} mm a year</b> on rates up to about 220 along the radar's line of sight.</p>
        <p>One station, MXTM, is off by about 50 mm a year and we have not found why. Without the two fastest stations the error is ${gps.rmse_without_fastest_two.toFixed(0)}.</p>
        <p>Across ${f0(c.summary('mexico').n)} pieces of the Metro's 12 lines, ${c.metroTop()}. No claim is made here about any Metro incident.</p>`,
    },
    {
      id: 'nisar', kicker: 'NISAR',
      title: 'One year of NISAR roughly matches ten years of Sentinel-1',
      view: { site: 'mexico', center: [-99.05, 19.4], zoom: 10.6, compare: ['rate', 'nisar'], split: 0.6 },
      body: `<p>The NASA-ISRO radar satellite began returning data in late 2025. Left: Sentinel-1, 2016 to 2026. Right: <b>28 NISAR pairs</b>, twelve months.</p>
        <p>The two maps agree at r = <b>${nis.r.toFixed(2)}</b> over ${f0(nis.n / 1000)},000 pixels. At the fastest GPS station NISAR reads −279 mm a year; GPS says −262 to −268.</p>
        <p>That could keep the watch going after the Sentinel-1 record ends. Two cautions: a single 12-day pair is too noisy to read alone, and over Willcox's farm fields the two sensors agree only loosely (r = 0.51).</p>`,
    },
    {
      id: 'phoenix', kicker: 'At home',
      title: 'Phoenix is slower, and still measurable',
      view: { site: 'phoenix_east', center: [-111.6, 33.36], zoom: 10.6, layer: 'rate', lines: true, fissures: 'known',
        callouts: (c) => [
          { at: [-111.6, 33.39], title: 'Apache Junction / East Mesa bowl', sub: 'About 10 to 13 mm a year, line of sight', side: 'left' },
          c.named('phoenix_east', 'Central Arizona Project Canal', 'Central Arizona Project canal'),
        ] },
      body: `<p>In the East Valley the Apache Junction and East Mesa bowl drops about <b>10 to 13 mm a year</b>, measured along the radar's line of sight. Isolated faster readings near Queen Creek and in the West Valley sit beside data gaps and are not confirmed.</p>
        <p>Radar ranks <b>${pb.n} state benchmarks</b> here almost as the surveys do (rank correlation <b>${pb.spearman.toFixed(2)}</b>). Sizes are not comparable: the surveys average mostly back to 1997, some to the 1970s.</p>
        <p>Freeways, the Central Arizona Project canal, rail and power lines are ranked the same way, as a relative order only: the signal here is about ten times weaker than at Willcox. ${sw('#1c1b19')}Black lines are mapped earth fissures.</p>`,
    },
    extra.length ? {
      id: 'more', kicker: 'Measured, not yet checked',
      title: `The same script, pointed at ${nT('measured')} more places`,
      view: { site: extra[0].id, center: extra[0].center, zoom: extra[0].zoom - 0.3, layer: 'rate', lines: true, fissures: 'known' },
      body: `<p>Adding a place takes one command and a few minutes of reading NASA's archive. ${extra.length <= 4 ? names(extra) : nT('measured') + ' places ' + names(extra)} were packed that way.</p>
        <p>This is <b>${extra[0].name}</b> (${extra[0].region}), where the fastest ground reads about <b>${f0(-extra[0].summary.fast_mmyr)} mm a year</b> relative to the steadiest ground in the window${extra[0].summary.valid_share < 0.5 ? `. Only ${Math.round(extra[0].summary.valid_share * 100)}% of the window kept a usable signal over the farm fields; the grey hatching is ground the radar could not read` : ''}. Its highways, canals, rail and pipelines are ranked exactly as at Willcox.</p>
        <p><b>No surveyor or GPS has checked these numbers here.</b> They are shown as measurements waiting for ground truth, in black on the map, never in the same colour as the checked sites.</p>`,
    } : null,
    {
      id: 'chennai', kicker: 'The frontier',
      title: 'Chennai: the honest answer is "not yet"',
      view: { site: 'chennai', center: [80.2, 13.07], zoom: 11.1, layer: 't149', points: 'chennai',
        callouts: [{ at: [80.248, 13.137], title: 'Kodungaiyur', sub: 'A candidate, not a finding. The ring around it reads the same.', side: 'left' }] },
      body: `<p>Outside North and Central America there is no ready-made radar history to start from. In Chennai StrainWatch has <b>${ch.noise[0].months.toFixed(1)} months</b> of NISAR. The measured noise floor is about ${ch.noise[0].sigma_cum.toFixed(0)} mm, so the slowest sinking we could detect today is about <b>${ch.noise[0].mdr_now.toFixed(0)} mm a year</b>.</p>
        <p>Published rates for Chennai are 15 to 32 mm a year. So this map is <b>noise, shown as noise</b>.</p>
        <p>How long until it is not? For 30 mm a year: ${rng(mtd(30, 'fixed'))} months if noise stays flat, ${rng(mtd(30, 'random_walk'))} if it adds up. For 15 mm a year: ${rng(mtd(15, 'fixed'))} months at best. StrainWatch reports that clock for any new place.</p>`,
    },
    {
      id: 'end', kicker: 'Your turn',
      title: 'Now draw your own line',
      view: { site: null, center: [-98, 36.5], zoom: 3.9 },
      body: `<p>Open the map, zoom into any place, and draw or upload any line inside a processed window. You get the ranked pieces, a profile along the line, the sinking history under each piece, a one-page report, and a file for the GIS you already use.</p>
        <p class="fine">This is a screening index. Fissures are narrower than a radar pixel; we flag the strain field around them. It is not a damage assessment and not a forecast.</p>
        <p><button class="btn teal" data-act="open">Open the map</button></p>`,
    },
  ].filter(Boolean);
}
