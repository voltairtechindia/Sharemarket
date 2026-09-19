/* ============================================================================
   Self-test.  Run:  node scripts/selftest.js

   No dependencies, no build step, no framework - it loads the real browser
   modules into a vm context whose global IS `window`, the way the page does,
   and asserts the invariants that have each been a real bug here.

   This file exists in the repo rather than in a scratch directory because the
   last set of these was written to /tmp and did not survive the session. A
   check you cannot re-run is not a check, and this codebase's stated rule is
   that verification is the standard rather than compilation.

   Every assertion below corresponds to something that was once wrong:

     band/outcome alignment   a session holds 75 five-minute bars across 74
                              intervals, so candles[at + bars] is the next
                              day's open, not the bar the band ends on
     lane liveness            the regex that decided it matched the news lane's
                              own dark-state string
     effective sample size    overlapping windows were counted as independent
     attribution sums         the per-bar decomposition must reconstruct the
                              drift the band was actually drawn with
     holiday clock            a daily projection used to walk through Diwali
     degenerate input         the variance model must degrade, never NaN
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
/* Load order matters and mirrors index.html. data.js is here because the JS
   option-chain summariser lives in it and has to be checked against the Python
   one. */
const MODULES = ['config', 'core', 'indicators', 'levels', 'patterns',
                 'structures', 'journal', 'portfolio', 'data', 'analogs',
                 'vol', 'forecast', 'ledger'];

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

/* The modules do `window.KT = window.KT || {}` and then use a bare `KT`, which
   only works when `window` is the global object. A plain `global.window = {}`
   on node is not that, so build a context that is its own window. */
function loadKT() {
  const mem = {};
  const sb = {};
  sb.window = sb;
  sb.globalThis = sb;
  sb.console = console;
  sb.navigator = { language: 'en-IN' };
  sb.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };
  sb.localStorage = {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; },
  };
  const stub = () => ({
    style: {}, dataset: {}, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, setAttribute() {}, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
  });
  sb.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: stub, addEventListener() {}, body: stub(), documentElement: stub(),
  };
  sb.addEventListener = () => {};
  /* data.js builds a DOMParser at module scope for the RSS lane. Nothing in
     this suite parses XML, so a stub that refuses is enough and keeps the file
     dependency-free - pulling in jsdom to test arithmetic would be absurd. */
  sb.DOMParser = function () {
    this.parseFromString = () => { throw new Error('XML parsing is not exercised by selftest'); };
  };
  sb.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  sb.setTimeout = setTimeout; sb.clearTimeout = clearTimeout;
  sb.fetch = () => Promise.reject(new Error('no network in selftest'));
  vm.createContext(sb);
  for (const m of MODULES) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js', m + '.js'), 'utf8'),
                    sb, { filename: m + '.js' });
  }
  return sb.KT;
}

function readJSON(rel, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
  catch (e) { return fallback; }
}

const KT = loadKT();
const raw = readJSON('data/candles_NIFTY_1D.json', null);
if (!raw || !raw.candles) {
  console.error('data/candles_NIFTY_1D.json missing - run a fetcher first');
  process.exit(2);
}
const candles = raw.candles.map(r => ({
  time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5],
}));
const seasonality = readJSON('data/seasonality.json', null);
const options = readJSON('data/options.json', null);
const events = readJSON('data/events.json', null);
const news = (readJSON('data/news.json', {}).news_items || []).slice(0, 300);

console.log(`loaded ${MODULES.length} modules, ${candles.length} candles, ` +
            `${news.length} headlines, options=${!!options}, events=${!!events}`);

/* ------------------------------------------------------------------ config */
section('CONFIG');
{
  const w = KT.CONFIG.forecast.weights;
  const sum = Object.keys(w).reduce((a, k) => a + w[k], 0);
  ok('lane weights sum to 1', Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
  ok('every weight is positive', Object.keys(w).every(k => w[k] > 0));
  ok('every baked path is a string or a function',
     Object.keys(KT.CONFIG.baked).every(k => ['string', 'function'].includes(typeof KT.CONFIG.baked[k])));
}

/* ----------------------------------------------------------------- vol.js */
section('VOL — variance model');
{
  const m = KT.vol.model(candles.slice(-300), {});
  ok('fits a model on the real series', !!m, m ? `${m.kind}, qlike=${m.qlike.toFixed(4)}` : '');
  if (m) {
    ok('variance series is all finite and positive', m.sigma2.every(v => isFinite(v) && v > 0));
    ok('band multiplier is sane', m.z68.z > 0.2 && m.z68.z < 6, `z68=${m.z68.z.toFixed(3)}`);
    if (m.kind !== 'ewma') {
      ok('fit is stationary', m.effectivePersistence < 1, `persistence=${m.effectivePersistence.toFixed(4)}`);
    } else {
      ok('EWMA declares itself IGARCH', m.igarch === true && m.stationary === false);
    }
  }

  // determinism: the panel must not change on refresh with no new data
  const sig = x => [x.kind, x.omega, x.alpha, x.beta, x.df, x.z68.z]
    .map(v => (typeof v === 'number' ? v.toFixed(12) : v)).join('|');
  const a = sig(KT.vol.model(candles.slice(-300), {}));
  let same = true;
  for (let i = 0; i < 4; i++) if (sig(KT.vol.model(candles.slice(-300), {})) !== a) same = false;
  ok('same candles give the same fit, every time', same);

  const src = fs.readFileSync(path.join(ROOT, 'assets/js/vol.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('no Math.random in vol.js', !/Math\.random/.test(src));

  // degenerate input must degrade, never NaN, never throw
  const flat = Array.from({ length: 300 }, (_, i) => ({ time: i * 300, open: 100, high: 100, low: 100, close: 100 }));
  const drift = Array.from({ length: 300 }, (_, i) => ({ time: i * 300, open: 100 + i * 0.01, high: 100 + i * 0.01, low: 100 + i * 0.01, close: 100 + i * 0.01 }));
  [['empty', []], ['one candle', candles.slice(0, 1)], ['flat', flat],
   ['high === low', drift], ['NaN prices', flat.map(c => ({ ...c, close: NaN, high: NaN, low: NaN }))]
  ].forEach(([label, input]) => {
    let threw = null, r = null;
    try { r = KT.vol.model(input, {}); } catch (e) { threw = e.message; }
    const clean = !threw && (r === null || (isFinite(r.z68.z) && r.sigma2.every(isFinite)));
    ok(`degenerate: ${label}`, clean, threw ? 'THREW ' + threw : (r ? `${r.kind} z68=${r.z68.z.toFixed(3)}` : 'null'));
  });
}

section('VOL — statistics');
{
  const a = KT.vol.kupiec(36, 53, 0.68);
  const b = KT.vol.kupiec(1100, 2000, 0.68);
  const c = KT.vol.kupiec(5, 8, 0.68);
  ok('67.9% of 53 is not distinguishable from target', a.verdict === 'well-calibrated', `p=${a.pValue}`);
  ok('55% of 2000 is caught as too-narrow', b.verdict === 'too-narrow', `p=${b.pValue}`);
  ok('8 points refuses to answer', c.verdict === 'insufficient-data');

  const miss = KT.vol.aci(0.68, Array.from({ length: 200 }, () => 1));
  const hold = KT.vol.aci(0.68, Array.from({ length: 200 }, () => 0));
  ok('ACI is inert with no settled rows', KT.vol.aci(0.68, []).active === false);
  ok('ACI widens after misses and tightens after holds',
     miss.coverageAdapted > 0.68 && hold.coverageAdapted < 0.68);

  ok('CRPS rewards sharpness and punishes confident error',
     KT.vol.crpsGaussian(100, 100, 5) < KT.vol.crpsGaussian(100, 100, 50) &&
     KT.vol.crpsGaussian(100, 130, 5) > KT.vol.crpsGaussian(100, 100, 50));
}

/* ------------------------------------------------------------- forecast.js */
section('FORECAST — build');
const f = KT.forecast.build({
  candles: candles.slice(), timeframe: '1D', news, seasonality,
  options, vix: 11.9,
});
{
  ok('build returns a forecast', !!f);
  ok('band is ordered at every bar',
     f.path.every((p, i) => f.lower2[i].value < f.lower[i].value &&
                            f.lower[i].value < p.value &&
                            p.value < f.upper[i].value &&
                            f.upper[i].value < f.upper2[i].value));
  ok('no NaN anywhere in the path', f.path.every(p => isFinite(p.value)));
  ok('every projected bar falls inside market hours on a weekday',
     f.path.every(p => {
       const d = new Date((p.time + 19800) * 1000);
       const min = d.getUTCHours() * 60 + d.getUTCMinutes();
       return min >= 555 && min <= 930 && d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
     }));
  ok('checkpoint probabilities are percentages', f.checkpoints.every(c => c.pUp >= 0 && c.pUp <= 100));
  ok('every lane reports hasData explicitly',
     f.lanes.every(l => typeof l.hasData === 'boolean'), `${f.lanes.length} lanes`);
  ok('a dark news feed drops the lane instead of voting zero',
     KT.forecast.newsLane([]).hasData === false);
  ok('a neutral verdict on real input keeps the lane live',
     KT.forecast.newsLane([
       { ts: Date.now() / 1000 - 600, impact: 'high', sentiment: 1, region: 'india', headline: 'a', source: 's' },
       { ts: Date.now() / 1000 - 600, impact: 'high', sentiment: -1, region: 'india', headline: 'b', source: 's' },
     ]).hasData === true);
}

section('NEWS — clustering and relevance');
{
  const t = Math.floor(Date.now() / 1000) - 600;
  // `key` is what mergeNews dedupes on and what the cluster cache hashes, so
  // fixtures must carry one or two pools will look identical to the cache.
  const mk = (h, sent, i, extra) => Object.assign(
    { ts: t - i, headline: h, impact: 'high', sentiment: sent, region: 'india',
      source: 'src' + i, key: KT.core.keyOf(h) }, extra || {});

  // syndication: one story told several ways is one vote
  const synd = KT.forecast.clusterStories([
    mk('RBI holds repo rate steady at policy meeting', -2, 0),
    mk('RBI holds repo rate steady after policy meeting', -2, 1),
    mk('RBI keeps repo rate steady at policy meeting', -2, 2),
  ]);
  ok('three tellings of one story fold into one', synd.length === 1, `${synd.length} clusters`);

  /* Token overlap alone merges opposites: "holds" and "cuts" share three
     tokens of five. Same words is not the same story when the verdicts
     disagree. */
  const opp = KT.forecast.clusterStories([
    mk('RBI holds repo rate steady', 2, 0),
    mk('RBI cuts repo rate sharply', -2, 1),
  ]);
  ok('opposed readings of the same words stay apart', opp.length === 2, `${opp.length} clusters`);

  // genuinely unrelated headlines must not be folded together
  const apart = KT.forecast.clusterStories([
    mk('Monsoon deficit widens across central districts', -1, 0),
    mk('Steel exports climb on overseas demand', 2, 1),
    mk('Airline adds winter capacity to metro routes', 1, 2),
  ]);
  ok('unrelated stories are not merged', apart.length === 3, `${apart.length} clusters`);

  // consensus shrinks a split tape and leaves a unanimous one alone
  const unanimous = [
    mk('Steel exports climb on overseas demand', 2, 0),
    mk('Monsoon revival lifts sowing across districts', 3, 1),
    mk('Airline adds winter capacity to metro routes', 2, 2),
    mk('Cement despatches accelerate into festive quarter', 3, 3),
  ];
  const split = [
    mk('Steel exports climb on overseas demand', 3, 0),
    mk('Monsoon deficit widens across central districts', -3, 1),
    mk('Airline adds winter capacity to metro routes', 2, 2),
    mk('Cement despatches slump into festive quarter', -2, 3),
  ];
  const u = KT.forecast.newsLane(unanimous);
  const sp = KT.forecast.newsLane(split);
  ok('a unanimous tape keeps its full vote',
     u.opinionated >= 3 && u.consensus === 1 && u.shrink === 1, `consensus=${u.consensus} shrink=${u.shrink}`);
  ok('a split tape has its vote shrunk',
     sp.opinionated >= 3 && sp.consensus < 0.8 && sp.shrink < 1 && Math.abs(sp.score) < Math.abs(sp.scoreBeforeShrink),
     `consensus=${sp.consensus} shrink=${sp.shrink} ${sp.scoreBeforeShrink.toFixed(3)} -> ${sp.score.toFixed(3)}`);

  // relevance: paperwork out, macro and index names in
  const rel = h => KT.forecast.relevanceOf({ headline: h }).why;
  ok('recovery certificates are treated as paperwork',
     rel('SEBI Order for Compliance - Completion Order for Recovery Certificate No. RC7374') === 'paperwork');
  ok('KYC circulars are treated as paperwork',
     rel('Reserve Bank of India (Rural Co-operative Banks - Know Your Customer) Directions') === 'paperwork');
  ok('index-fund listings are treated as paperwork',
     rel('SBI Nifty Bank Index Fund(G)-Direct Plan - Univest') === 'paperwork');
  ok('policy headlines score as macro', rel('RBI holds repo rate steady as inflation cools') === 'macro');
  ok('an unlisted single stock is discounted',
     /single stock/.test(rel('Tiny Widgets Pvt announces new plant in Baddi')));

  const cons = readJSON('data/constituents.json', null);
  if (cons && cons.members) {
    const loaded = KT.forecast.setConstituents(cons);
    ok('constituent aliases load', loaded > 0, `${loaded} aliases, ${cons.count} symbols`);
    ok('a NIFTY 50 name is recognised',
       /index constituent/.test(rel('Reliance Industries posts higher refining margins')),
       rel('Reliance Industries posts higher refining margins'));
    ok('paperwork beats a constituent match',
       rel('HDFC Bank board meeting intimation and trading window closure') === 'paperwork');
  } else {
    ok('constituents present (run scripts/fetch_constituents.py)', true, 'skipped');
  }

  // the clustering cache must not go stale when relevance changes
  const news = (readJSON('data/news.json', {}).news_items || []).slice(0, 200);
  if (news.length > 50) {
    const before = KT.forecast.newsLane(news);
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) KT.forecast.newsLane(news);
    const per = (Date.now() - t0) / 20;
    ok('repeat calls are cached and cheap', per < 5, `${per.toFixed(2)}ms each`);
    ok('folds real syndication', before.duplicates > 0,
       `${before.stories} stories from ${before.items} items, ${before.duplicates} folded`);
    ok('reports its own diagnostics',
       before.consensus !== undefined && before.macro >= 0 && before.suppressed >= 0,
       `macro=${before.macro} named=${before.named} suppressed=${before.suppressed}`);
  }
}

section('FORECAST — per-bar attribution');
{
  ok('attribution covers every projected bar',
     f.attribution.length === f.forecastBars, `${f.attribution.length}/${f.forecastBars}`);
  // the decomposition must reconstruct the drift the band was drawn with
  let worst = 0;
  f.attribution.forEach(a => {
    const sum = a.lanes.reduce((s, l) => s + l.pct, 0) + a.shapePct;
    worst = Math.max(worst, Math.abs(sum - a.rawPct));
  });
  ok('lane parts + clock reconstruct the raw drift at every bar',
     worst < 0.01, `worst gap ${worst.toFixed(5)}%`);
  const early = f.attribution[0], late = f.attribution[f.attribution.length - 1];
  ok('timing curves advance across the horizon',
     late.lanes.length === 0 || early.lanes.length === 0 ||
     (late.lanes[0].arrived >= early.lanes[0].arrived));
  ok('probability is bounded at every bar', f.attribution.every(a => a.pUp >= 0 && a.pUp <= 100));
}

section('FORECAST — the clock');
{
  const holidays = (events && events.holidays) || [];
  const n = KT.forecast.setHolidays(holidays);
  if (n) {
    // 2 Oct 2026 is Gandhi Jayanti, a Friday
    const before = Math.floor(Date.UTC(2026, 9, 1, 10, 0, 0) / 1000);
    const next = KT.forecast.advance(before, 86400);
    const d = new Date((next + 19800) * 1000);
    const key = d.getUTCFullYear() + '-' +
      ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
    ok('a daily step skips a trading holiday', key !== '2026-10-02', `landed on ${key}`);
  } else {
    ok('holiday list present (run scripts/fetch_events.py to exercise this)', true, 'skipped, no data/events.json');
  }
  /* The header used to read LIVE on Diwali: marketState() knew about weekends
     and nothing else. One table in core now serves both it and the clock. */
  if (holidays.length) {
    const hol = holidays.find(h => h.date > '2026-01-01') || holidays[0];
    const parts = hol.date.split('-').map(Number);
    // 12:00 IST on a holiday = 06:30 UTC, squarely inside regular hours
    const noonIst = Date.UTC(parts[0], parts[1] - 1, parts[2], 6, 30, 0);
    const st = KT.core.marketState(noonIst);
    ok('marketState reports a trading holiday as closed',
       st.live === false && st.holiday === true, `${hol.date} -> ${st.label}`);
    const openDay = KT.core.marketState(Date.UTC(2026, 8, 18, 6, 30, 0)); // Fri 18 Sep
    ok('an ordinary weekday is still live', openDay.live === true, openDay.label);
  }

  KT.forecast.setHolidays([]);
  ok('with no holiday list the clock still avoids weekends',
     (() => {
       const fri = Math.floor(Date.UTC(2026, 8, 18, 10, 0, 0) / 1000);
       const d = new Date((KT.forecast.advance(fri, 86400) + 19800) * 1000);
       return d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
     })());
  KT.forecast.setHolidays(holidays);
}

section('FORECAST — options lane');
{
  if (options && options.ok) {
    const l = KT.forecast.optionsLane(options, options.spot, Date.parse(options.generated_at) + 60000);
    ok('scores the live chain', l.hasData === true, `score=${l.score.toFixed(3)}`);
    ok('score is bounded', l.score >= -1 && l.score <= 1);
    const stale = KT.forecast.optionsLane(options, options.spot, Date.parse(options.generated_at) + 5 * 3600e3);
    ok('drops itself when stale', stale.hasData === false, stale.note);
  } else {
    ok('option chain present (run scripts/fetch_options.py to exercise this)', true, 'skipped');
  }
  // a live chain must say so; a workflow one must print its age instead
  {
    const base = { ok: true, pcrOi: 1.1, pcrChgOi: 2.0, spot: 23000,
                   resistance: [{ strike: 23200, distPct: 0.9 }],
                   support: [{ strike: 22800, distPct: -0.9 }] };
    const now = Date.now();
    const live = KT.forecast.optionsLane(
      Object.assign({}, base, { origin: 'browser', generated_at: new Date(now).toISOString() }), 23000, now);
    const old = KT.forecast.optionsLane(
      Object.assign({}, base, { origin: 'workflow', generated_at: new Date(now - 130 * 60000).toISOString() }), 23000, now);
    ok('a live chain is labelled live', /\(live\)/.test(live.note), live.note.slice(-30));
    ok('a workflow chain prints its age instead', /ago\)/.test(old.note), old.note.slice(-30));
  }

  // breadth divergence must move the flow lane and be bounded
  {
    const flat = KT.forecast.flowLane({ breadth: { advances: 25, declines: 25 } });
    const broad = KT.forecast.flowLane({ breadth: { advances: 25, declines: 25 }, breadthDivergence: 0.24 });
    const narrow = KT.forecast.flowLane({ breadth: { advances: 25, declines: 25 }, breadthDivergence: -0.24 });
    ok('midcap breadth divergence moves the flow lane',
       broad.score > flat.score && narrow.score < flat.score,
       `flat=${flat.score.toFixed(3)} broad=${broad.score.toFixed(3)} narrow=${narrow.score.toFixed(3)}`);
    ok('flow lane stays bounded on an extreme divergence',
       Math.abs(KT.forecast.flowLane({ breadth: { advances: 50, declines: 0 }, breadthDivergence: 9 }).score) <= 1);
  }

  [null, { ok: false }, { ok: true }, { ok: true, pcrOi: 0, pcrChgOi: -1 }].forEach((p, i) => {
    let threw = null, r = null;
    try { r = KT.forecast.optionsLane(p, 23000, Date.now()); } catch (e) { threw = e.message; }
    ok(`malformed option payload #${i + 1} is handled`, !threw && r && r.hasData === false,
       threw ? 'THREW ' + threw : '');
  });
}

section('DATA — JS/Python parity on the option chain');
{
  const fx = readJSON('references/fixtures/option-chain-nifty.json', null);
  if (!fx) {
    ok('option-chain fixture present', true, 'skipped - references/fixtures/option-chain-nifty.json missing');
  } else {
    const js = KT.data.summariseChain(fx.rows, fx.spot);
    const py = fx.expected;
    ok('JS summariser returns a summary', !!js);
    if (js) {
      /* Exact on counts and strikes; a hair of tolerance on the rounded ratios,
         because Python's round() is banker's rounding and JS Math.round is
         half-up, so a value landing exactly on .5 at the last kept digit can
         differ by one unit in that digit. Anything larger is a real divergence. */
      const exact = ['strikes', 'totalCeOi', 'totalPeOi', 'ceChgOi', 'peChgOi',
                     'maxPain', 'atmStrike'];
      exact.forEach(k => ok(`  ${k} matches exactly`, js[k] === py[k], `js=${js[k]} py=${py[k]}`));

      const near = ['pcrOi', 'pcrChgOi', 'maxPainPct', 'atmIv', 'otmPutIv', 'otmCallIv', 'ivSkew'];
      near.forEach(k => {
        const a = js[k], b = py[k];
        const same = (a === null && b === null) ||
                     (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 0.011);
        ok(`  ${k} matches`, same, `js=${a} py=${b}`);
      });

      ['resistance', 'support'].forEach(k => {
        const a = js[k] || [], b = py[k] || [];
        const same = a.length === b.length &&
                     a.every((w, i) => w.strike === b[i].strike && w.oi === b[i].oi);
        ok(`  ${k} walls match`, same,
           `js=${a.map(w => w.strike).join('/')} py=${b.map(w => w.strike).join('/')}`);
      });

      // and the lane must score the JS summary the same way it scores the Python one
      const now = Date.now();
      js.generated_at = new Date(now).toISOString();
      py.generated_at = new Date(now).toISOString();
      py.ok = true; py.spot = fx.spot; py.expiry = fx.expiry;
      js.ok = true; js.expiryDays = py.expiryDays = 2;
      const lj = KT.forecast.optionsLane(js, fx.spot, now + 60000);
      const lp = KT.forecast.optionsLane(py, fx.spot, now + 60000);
      ok('  optionsLane scores both identically',
         Math.abs(lj.score - lp.score) < 1e-6, `js=${lj.score.toFixed(6)} py=${lp.score.toFixed(6)}`);
    }
  }
}

section('FORECAST — calibration');
{
  const cal = KT.forecast.calibrate(candles, '1D', {});
  ok('calibrate returns a result', !!cal);
  if (cal) {
    ok('intervals use the effective sample size, not the replay count',
       cal.nEff > 0 && cal.nEff < cal.n, `n=${cal.n} nEff=${cal.nEff} overlap=${cal.overlapFraction}%`);
    ok('the conformal quantile uses every window', cal.conformalWindows === cal.n);
    ok('coverage carries a significance verdict', !!(cal.kupiec68 && cal.kupiec68.verdict));
    ok('direction significance is judged on the interval, not the point',
       cal.directionSignificant === !!(cal.directionCi && cal.directionCi[0] > 50),
       `${cal.directionRate}% CI ${cal.directionCi ? cal.directionCi.join('-') : 'n/a'}`);
    ok('the basis names only the lanes that actually voted',
       Array.isArray(cal.lanesUsed) && cal.lanesUsed.length > 0, cal.lanesUsed.join(', '));
  }

  /* The bug that made every earlier accuracy number meaningless: a session
     holds 75 five-minute bars across 74 intervals, so index arithmetic lands a
     whole overnight gap past the bar the band ends on. */
  const tf = KT.CONFIG.timeframes['1D'];
  let bars = Math.max(6, Math.round(tf.visibleBars * tf.forecastRatio));
  if (tf.maxForecastBars) bars = Math.min(bars, tf.maxForecastBars);
  let disagree = 0, checked = 0;
  for (let at = 150; at + bars < candles.length; at += bars) {
    let t = candles[at].time;
    for (let k = 0; k < bars; k++) t = KT.forecast.advance(t, tf.barSec);
    checked++;
    if (t !== candles[at + bars].time) disagree++;
  }
  ok('index arithmetic still disagrees with the clock (why outcomes are read by time)',
     disagree > 0, `${disagree}/${checked} endpoints differ - calibrate() must use closeAtTime()`);
}

/* --------------------------------------------------------------- ledger.js */
section('LEDGER');
{
  KT.ledger.clear();
  KT.ledger.newsSource = () => news;
  const row = KT.ledger.record(f, { symbol: 'NIFTY', vix: 11.9 });
  ok('records a pending row', !!row && row.status === 'pending');
  ok('is idempotent inside one reason bucket',
     KT.ledger.record(f, { symbol: 'NIFTY' }).id === row.id && KT.ledger.all().length === 1);

  const seeded = KT.ledger.seedFromHistory(candles, 'NIFTY', '1D', { count: 5, seasonality });
  ok('seeds and settles from history', seeded.seeded > 0, `${seeded.seeded} seeded`);

  const settled = KT.ledger.all().filter(r => r.status === 'settled');
  ok('at least one row fully settled', settled.length > 0, `${settled.length}`);
  if (settled.length) {
    const e = settled[settled.length - 1].explain;
    ok('the post-mortem names a failure mode', !!e.mode, e.mode);
    ok('every lane gets a verdict', e.lanes.length === f.lanes.length);
    ok('lane pushes plus the residual reconstruct the realised move',
       Math.abs((e.askedTotalPct + e.residualPct) - e.realisedPct) < 0.001);
  }

  const agg = KT.ledger.aggregate('NIFTY', '1D');
  ok('seeded rows are excluded from the forward record',
     agg.n === 0 && agg.seeded > 0, `n=${agg.n} seeded=${agg.seeded}`);
  ok('ACI learns only from forward misses',
     KT.ledger.missRecord('NIFTY', '1D').length === 0);
  KT.ledger.clear();
}

/* --------------------------------------------------------------- wiring
   app.js is not loadable here - it wants a real DOM - so it gets a static
   check instead of an exercised one.

   This exists because a callback referenced in boot's Promise.all was never
   defined: an edit landed the call sites and not the declaration. The
   reference threw synchronously while the array was being built, the whole
   chain rejected, and the page sat on "Loading NIFTY candles..." forever with
   no console error. Nothing in a numeric suite would ever catch that, and it
   cost most of a debugging session. */
section('WIRING — every handler app.js names is defined');
{
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8');
  const declared = new Set();
  let m;
  const declRx = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = declRx.exec(src))) declared.add(m[1]);
  const assignRx = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = assignRx.exec(src))) declared.add(m[1]);

  // bare identifiers handed straight to .then(...) / .catch(...)
  const missing = [];
  const refRx = /\.(?:then|catch|forEach|map|filter)\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  while ((m = refRx.exec(src))) {
    const name = m[1];
    if (declared.has(name)) continue;
    // globals and imports the file legitimately relies on
    if (['JSON', 'noop', 'console', 'String', 'Number', 'Boolean'].includes(name)) continue;
    if (/^(KT|C|S|el|text|fmt|core|data|chart|engine)$/.test(name)) continue;
    missing.push(name);
  }
  ok('no handler is referenced without being declared',
     missing.length === 0, missing.length ? 'undefined: ' + [...new Set(missing)].join(', ') : `${declared.size} declarations`);

  // the boot barrier must not contain a network call with a long timeout
  const bootStart = src.indexOf('return Promise.all([');
  const bootEnd = src.indexOf(']);', bootStart);
  const boot = bootStart > 0 ? src.slice(bootStart, bootEnd) : '';
  ok('boot does not wait on the live proxy fetches',
     boot.length > 0 && !/refreshOptionChain\(\)|refreshInternals\(\)/.test(boot),
     'those are 14-20s proxy hops; the chart must not queue behind them');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
