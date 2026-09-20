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
const MODULES = ['config', 'core', 'indicators', 'levels', 'candles', 'patterns',
                 'structures', 'journal', 'portfolio', 'data', 'analogs',
                 'vol', 'forecast', 'ledger', 'learn', 'evidence', 'ipo'];

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
// The session view runs on 1-minute bars, which is the hourly view's file.
const minuteRaw = readJSON('data/candles_NIFTY_1H.json', null);
const minuteCandles = (minuteRaw && minuteRaw.candles ? minuteRaw.candles : []).map(r => ({
  time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5],
}));
const globalCues = readJSON('data/global.json', null);

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
  /* 1-99, not 0-100. An opening gap drives the raw figure to 100 inside the
     first hour, and a page that prints a certainty has stopped describing a
     forecast. */
  ok('checkpoint probabilities never print certainty',
     f.checkpoints.every(c => c.pUp >= 1 && c.pUp <= 99),
     f.checkpoints.map(c => c.pUp).join('/'));
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

    /* build() calls newsLane twice with different pools - everything, then the
       international subset. A single-slot cache meant each call evicted the
       other and both re-clustered on every one-second tick: 0.25ms alone
       against 116ms per alternating pair, most of a 140ms build. */
    const intl = { region: 'international', halfLifeSec: 43200 };
    KT.forecast.newsLane(news); KT.forecast.newsLane(news, intl);
    const t1 = Date.now();
    for (let i = 0; i < 20; i++) { KT.forecast.newsLane(news); KT.forecast.newsLane(news, intl); }
    const pair = (Date.now() - t1) / 20;
    ok('alternating pools do not thrash the cluster cache', pair < 10, `${pair.toFixed(2)}ms per pair`);

    // the whole build, which the page runs once a second
    const ctx = { candles: candles.slice(), timeframe: '1D',
                  news: (readJSON('data/news.json', {}).news_items || []),
                  seasonality, options, vix: 11.4,
                  levels: KT.levels.build(candles),
                  structures: KT.structures.detect(candles) };
    KT.forecast.build(ctx);
    const t2 = Date.now();
    for (let i = 0; i < 10; i++) KT.forecast.build(ctx);
    const per2 = (Date.now() - t2) / 10;
    ok('a steady-state build fits inside the one-second tick',
       per2 < 60, `${per2.toFixed(1)}ms per tick`);

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

  /* The hover card renders lastClose * (1 + driftPct/100) as the centre for a
     bar. If that is not the point the chart draws, the card is describing a
     line nobody can see - which is what happened: the analogue shifts the path
     after the attribution is built, and the two disagreed by up to 18.3 points
     on the live series. */
  {
    let worst = 0;
    f.attribution.forEach((a, i) => {
      worst = Math.max(worst, Math.abs(f.path[i].value - f.lastClose * (1 + a.driftPct / 100)));
    });
    ok('the hover centre is the point actually drawn',
       worst < 1, `worst gap ${worst.toFixed(3)} points`);
    if (f.analog && f.analog.ok && f.analog.quality > 5) {
      ok('the analogue is named as its own contributor',
         f.attribution.some(a => a.analogPct), 'analogue applied and attributed');
    }
  }
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

/* ====================================================== THE OPENING CALL

   Added 20 Sep 2026 along with the lane. Every assertion here is a way the
   gap model could look right and be worthless. */
section('FORECAST — the opening gap');
{
  // Comments explaining why the row was removed obviously mention it, so
  // strip them before grepping - otherwise the test fails on its own epitaph.
  const strip = x => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = strip(fs.readFileSync(path.join(ROOT, 'assets/js/forecast.js'), 'utf8'));

  /* The bug that started this: `sgx_nifty` was fetched from Yahoo `^NSEI`,
     which is NIFTY spot, and carried 0.24 of the global lane. An opening-gap
     model reading it would have been handed the answer. It must be gone from
     both tables, and there is no honest way to reintroduce it without a real
     GIFT Nifty feed - so the test names the symbol too. */
  ok('the index does not vote on itself in the global lane',
     !/sgx_nifty/.test(src), 'a lane fed from ^NSEI would make the gap call circular');
  ok('the fetcher no longer labels ^NSEI as GIFT Nifty',
     !/\("sgx_nifty", "GIFT Nifty", "\^NSEI"/.test(
       fs.readFileSync(path.join(ROOT, 'scripts/fetch_global.py'), 'utf8')
         .replace(/^\s*#.*$/gm, '')));

  const betas = KT.forecast.openBetaDefaults;
  ok('no opening beta reads a NIFTY-derived series',
     !Object.keys(betas).some(k => /nifty|nsei/i.test(k)), Object.keys(betas).join(', '));

  const price = 23300;
  ok('no cues means no call, not a zero call',
     KT.forecast.openLane(null, null, price).hasData === false);
  ok('an empty items map is still no call',
     KT.forecast.openLane({ items: {} }, null, price).hasData === false);

  const up = KT.forecast.openLane(
    { items: { us_futures: { changePct: 1.2 }, nikkei: { changePct: 0.8 } } }, null, price);
  const down = KT.forecast.openLane(
    { items: { us_futures: { changePct: -1.2 }, nikkei: { changePct: -0.8 } } }, null, price);
  ok('risk-on overnight opens the index higher', up.hasData && up.gapPct > 0 && up.price > price,
     `${up.gapPct}% -> ${up.price}`);
  ok('the call is symmetric', Math.abs(up.gapPct + down.gapPct) < 1e-9);

  // A weaker rupee is a headwind even when US futures are up. Sign, not size.
  const rupee = KT.forecast.openLane({ items: { usdinr: { changePct: 1.0 } } }, null, price);
  ok('a weaker rupee opens the index lower', rupee.gapPct < 0, `${rupee.gapPct}%`);

  /* One feed printing nonsense must not draw the projection off the chart.
     Brent has come through this repo's own feed at -8.7% in a day. */
  const wild = KT.forecast.openLane({
    items: { us_futures: { changePct: 40 }, nasdaq_fut: { changePct: 40 },
             nikkei: { changePct: 40 }, hangseng: { changePct: 40 } } }, null, price);
  ok('a mad print cannot open the index more than 1.5% away',
     Math.abs(wild.gapPct) <= 1.5 + 1e-9, `${wild.gapPct}%`);

  ok('an unfitted call says it is unfitted', up.fitted === false);

  if (globalCues && globalCues.items) {
    const real = KT.forecast.openLane(globalCues, null, price);
    ok('the real cue file produces a finite call',
       !real.hasData || (isFinite(real.price) && Math.abs(real.gapPct) <= 1.5),
       real.hasData ? `${real.gapPct}% on ${real.cues} cues` : 'no cues in file');
  }
}

/* ======================================================= THE SESSION VIEW */
section('FORECAST — the session view');
{
  const tf = KT.CONFIG.timeframes['1S'];
  ok('the session timeframe exists and is one bar a minute', !!tf && tf.barSec === 60);
  ok('it projects to the bell rather than to a bar count', tf.sessionForecast === true);
  ok('it reads the hourly view’s candle file rather than a duplicate',
     tf.bakedAs === '1H' &&
     KT.CONFIG.baked.candles('NIFTY', '1S') === 'data/candles_NIFTY_1H.json');

  /* The whole reason sessionForecast exists: at 09:20 "the rest of today" is
     370 minutes and at 15:00 it is 30. A fixed count is wrong at both ends. */
  const istAt = (h, m, day) => {
    const d = Date.UTC(2026, 8, day, h - 5, m - 30, 0);   // 21 Sep 2026 is a Monday
    return Math.floor(d / 1000);
  };
  const at0920 = KT.forecast.barsToSessionClose(istAt(9, 20, 21), 60);
  const at1500 = KT.forecast.barsToSessionClose(istAt(15, 0, 21), 60);
  const shut = KT.forecast.barsToSessionClose(istAt(19, 0, 20), 60);   // Sunday evening
  ok('mid-session it counts the minutes actually left', at0920 === 370, `09:20 -> ${at0920}`);
  ok('late in the session it counts fewer', at1500 === 30, `15:00 -> ${at1500}`);
  ok('while shut it projects a whole session', shut === 375, `shut -> ${shut}`);
  ok('a fixed bar count would have been wrong at both ends', at0920 !== at1500);

  if (minuteCandles.length > 400) {
    const sctx = () => ({
      candles: minuteCandles.slice(), timeframe: '1S', news, seasonality,
      options, global: globalCues, vix: 11.9,
    });
    /* Cold and warm are different budgets and conflating them hid the real
       number here: the first 375-bar build measured 772ms and the next three
       averaged 48ms. Almost all of the first one is the variance fit, which
       volContext caches on the last bar, plus JIT warm-up. Boot pays cold
       once; the one-second tick pays warm 25,000 times a session, and it is
       the second number that decides whether the live price stutters. */
    const cold0 = Date.now();
    const sf = KT.forecast.build(sctx());
    const cold = Date.now() - cold0;
    const warm0 = Date.now();
    for (let i = 0; i < 3; i++) KT.forecast.build(sctx());
    const ms = Math.round((Date.now() - warm0) / 3);
    ok('a session forecast builds', !!sf && sf.path.length > 0, sf ? `${sf.path.length} minutes` : '');
    if (sf) {
      ok('one point per minute, strictly increasing',
         sf.path.every((p, i) => i === 0 || p.time > sf.path[i - 1].time));
      ok('every projected minute is inside market hours on a weekday',
         sf.path.every(p => {
           const d = new Date((p.time + 19800) * 1000);
           const min = d.getUTCHours() * 60 + d.getUTCMinutes();
           return min >= 555 && min <= 930 && d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
         }));
      ok('the path ends at the close, not part way through',
         (() => {
           const d = new Date((sf.path[sf.path.length - 1].time + 19800) * 1000);
           return d.getUTCHours() * 60 + d.getUTCMinutes() === 930;
         })());
      /* 375 bars is five times the daily view's horizon and this runs on the
         one-second tick. The eighth bug in CLAUDE.md was a 116ms build; this
         has to stay well inside the budget or the live price stutters. */
      ok('a warm 375-minute build fits inside the one-second tick', ms < 150, `${ms}ms warm`);
      ok('the cold build does not stall boot', cold < 1500, `${cold}ms cold`);
      /* The gap is a level shift, so all three lines must start from the same
         opening price. They used to start from last close, which put the news
         and pattern lines at a price the market would not open at and read as
         disagreement that was really a missing gap. */
      if (sf.open && sf.open.applies && sf.open.hasData) {
        ok('the projection starts at the predicted open',
           Math.abs(sf.path[0].value - sf.open.price) / sf.open.price < 0.002,
           `path ${sf.path[0].value} vs open ${sf.open.price}`);
        ok('the component lines open at the same price',
           Math.abs(sf.pathNews[0].value - sf.pathPattern[0].value) / sf.open.price < 0.004);
        /* The checkpoint probability must be measured against the predicted
           open once a gap is called, not against yesterday's close. Against
           the close every checkpoint printed 99-100% the moment a gap of
           0.9% was in the path - true, and an answer to a question the open
           had already settled. */
        ok('probabilities are measured against the predicted open, not the last close',
           sf.checkpoints.every(c => c.pUpFrom != null &&
             Math.abs(c.pUpFrom - sf.open.price) / sf.open.price < 0.0001),
           `ref ${sf.checkpoints[0].pUpFrom} vs open ${sf.open.price}`);
        ok('and they are no longer pinned at certainty',
           sf.checkpoints.some(c => c.pUp < 95),
           sf.checkpoints.map(c => c.pUp).join('/'));
      } else {
        ok('with the gap behind us the open block says so', sf.open.applies === false ||
           sf.open.hasData === false);
        ok('and probabilities fall back to the last close',
           sf.checkpoints.every(c => Math.abs(c.pUpFrom - sf.lastClose) < 0.01));
      }
    }
  }
}

/* ==================================================== PREDICTED VS ACTUAL */
section('LEDGER — the session lock');
{
  const base = minuteCandles.length > 400 ? minuteCandles : candles;
  const f2 = KT.forecast.build({
    candles: base.slice(), timeframe: minuteCandles.length > 400 ? '1S' : '1D',
    news, seasonality, options, global: globalCues, vix: 11.9,
  });
  /* The bug this test exists for: stageNow() read the wall clock only, so on
     a Sunday afternoon - minute count past 09:15 - it returned null and
     refused to freeze Monday's call. That is the one evening the feature is
     for. The session being forecast decides the stage, not the time of day. */
  ok('a forecast for a later session is always the day-before call',
     KT.ledger.stageNow({ path: [{ time: Math.floor(Date.now() / 1000) + 86400 * 3, value: 1 }] }) === 'advance',
     'a Sunday afternoon must still be able to call Monday');

  const first = KT.ledger.lock(f2, { symbol: 'TESTSYM' });
  const second = KT.ledger.lock(f2, { symbol: 'TESTSYM' });

  if (!first) {
    /* stageNow() returns null during the session, which is correct: there is
       nothing left to freeze once the market has opened. */
    ok('no lock is written once the session is under way', second === null);
  } else {
    ok('a lock is written', !!first.path && first.path.length > 0, `${first.path.length} points`);
    ok('a second call returns the same lock rather than a new one', second.id === first.id);
    ok('the locked path is never rewritten',
       second.path.length === first.path.length &&
       second.path.every((p, i) => p.value === first.path[i].value &&
                                   p.time === first.path[i].time));
    ok('the lock carries the opening call it was made with',
       first.openPrice != null && isFinite(first.openPrice));

    /* Scoring must join on time. Handed a candle series with a bar missing in
       the middle, index arithmetic would compare every later minute with the
       wrong one; joining by time simply skips it. */
    const fake = first.path.map((p, i) => ({
      time: p.time, open: p.value, high: p.value, low: p.value, close: p.value + i,
    }));
    const holed = fake.filter((_, i) => i !== 5);
    const full = KT.ledger.scoreLock(first, fake);
    const gap = KT.ledger.scoreLock(first, holed);
    ok('a perfect-but-drifting tape scores the drift, not zero', full && full.n === fake.length);
    ok('a missing bar drops one comparison and shifts none',
       gap && gap.n === full.n - 1 &&
       gap.pairs.every(pr => {
         const match = full.pairs.find(q => q.time === pr.time);
         return match && match.predicted === pr.predicted && match.actual === pr.actual;
       }),
       'joined by time, not by index');
    ok('the open is scored separately from the day',
       full && full.openPredicted != null && full.openActual != null);
    ok('skill is measured against price not moving',
       full && (full.skill === null || full.skill >= 0));
  }
}

/* ============================================================ THE LEARNER */
section('LEARN — guardrails');
{
  KT.learn.reset();
  ok('starts unfitted, so build() uses the CONFIG weights',
     KT.learn.weights() === null && KT.learn.summary().fitted === false);
  ok('no opening gain until there are mornings to learn from',
     KT.learn.openBetas() === null);

  /* A model asking for more than one step gets dropped, not clamped. Clamping
     would honour 8% of a request that shows the model misunderstood the task,
     and hide that it did. */
  const cur = KT.CONFIG.forecast.weights.news;
  KT.learn.propose({ text: 'quadruple the news lane', model: 'test',
                     changes: { news: cur * 4 } });
  ok('a proposal outside one step is dropped, not shrunk',
     KT.learn.proposal().changes.length === 0);

  KT.learn.propose({ text: 'nudge news up', model: 'test',
                     changes: { news: cur * 1.05 } });
  ok('a proposal inside one step survives', KT.learn.proposal().changes.length === 1);
  ok('a proposal cannot invent a lane',
     (KT.learn.propose({ text: 'x', changes: { sgx_nifty: 0.5, news: cur * 1.02 } }),
      KT.learn.proposal().changes.every(c => KT.CONFIG.forecast.weights.hasOwnProperty(c.id))));

  ok('a proposal changes nothing until it is accepted', KT.learn.weights() === null);
  KT.learn.accept();
  const after = KT.learn.weights();
  ok('accepting applies it and marks the weights fitted', !!after && after.fitted === true);
  ok('the accepted weights still sum to 1',
     Math.abs(Object.keys(KT.CONFIG.forecast.weights)
       .reduce((a, k) => a + after[k], 0) - 1) < 1e-6);
  ok('no lane is ever driven below the floor',
     Object.keys(KT.CONFIG.forecast.weights).every(k => after[k] >= KT.learn.FLOOR));
  ok('the step is kept in the history so the change is checkable',
     KT.learn.history().length === 1 && KT.learn.history()[0].source === 'proposal');

  /* The thin-sample guard. A lane right 4 times out of 5 has said nothing -
     Wilson runs 38% to 99% - and must not move anything. */
  KT.learn.reset();
  const res = KT.learn.update('NOSUCHSYM', '1D', { force: true });
  ok('an empty record moves no weight', res.moved.length === 0);
  ok('and leaves the model on the CONFIG weights', KT.learn.weights() === null);
  KT.learn.reset();
}

/* ============================================= THE CHART DRAWS TWO LINES */
section('CHART — the band lines are gone');
{
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/chart.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ['upSeries', 'loSeries', 'up2Series', 'lo2Series'].forEach(name => {
    ok(`${name} is no longer drawn`, !new RegExp('\\b' + name + '\\b').test(src));
  });
  ok('the two lines that replaced them are drawn',
     /lockSeries\s*=\s*chart\.addLineSeries/.test(src) &&
     /actualSeries\s*=\s*chart\.addLineSeries/.test(src));
  /* Removing the lines from the chart must not remove the band from the
     model: the hover card quotes it, calibrate() scores it, and the ledger
     settles against it. Deleting it to tidy the chart would silently gut the
     accuracy panel. */
  ok('the band is still computed for the panels that score it',
     f && f.upper && f.lower && f.upper2 && f.lower2 &&
     f.upper.length === f.path.length,
     'drawn is not the same question as computed');
  ok('checkpoints still carry both bands',
     f.checkpoints.every(c => c.low != null && c.high != null &&
                              c.low95 != null && c.high95 != null));
}

/* ================================================= THE CANDLESTICK LIBRARY */
section('CANDLES — the pattern table');
{
  const SET = KT.candles.SET;
  ok('the table is the full canon, not a handful',
     KT.candles.families >= 60 && SET.length >= 80,
     `${SET.length} detectors across ${KT.candles.families} families`);

  const keys = SET.map(d => d.key);
  ok('no duplicate keys', new Set(keys).size === keys.length);
  ok('every row is complete',
     SET.every(d => d.key && d.name && d.why && d.need >= 2 && [1, 0, -1].includes(d.dir)));
  ok('every row declares how far back it reads',
     SET.every(d => typeof d.test === 'function' && d.need >= 2));

  /* A hammer and a hanging man are the SAME candle. The only thing separating
     them is what came before, so a detector that ignores trend context is not
     detecting either one - it is detecting a shape and guessing. */
  // Long lower wick, small upper, a real body: the classic hammer shape.
  const shape = { open: 99.5, high: 100.4, low: 96, close: 100.2 };
  const upTrend = [], downTrend = [];
  for (let i = 0; i < 12; i++) {
    upTrend.push({ time: i * 300, open: 90 + i, high: 91 + i, low: 89 + i, close: 90.8 + i });
    downTrend.push({ time: i * 300, open: 115 - i, high: 116 - i, low: 114 - i, close: 114.2 - i });
  }
  upTrend.push({ ...shape, time: 12 * 300 });
  downTrend.push({ ...shape, time: 12 * 300 });
  const hammer = SET.find(d => d.key === 'hammer');
  const hanging = SET.find(d => d.key === 'hanging_man');
  const A = 2.0, last = 12;
  ok('the same candle is a hammer after a fall',
     hammer.test(downTrend, last, A) && !hanging.test(downTrend, last, A));
  ok('and a hanging man after a rise',
     hanging.test(upTrend, last, A) && !hammer.test(upTrend, last, A),
     'trend context is what separates them');

  /* Thresholds must be in ATR, not points, or every rule breaks the moment the
     instrument or the timeframe changes. Scaling every price by 10 must not
     change a single verdict once the ATR is scaled with it. */
  const base = downTrend.map(b => ({ ...b }));
  const scaled = base.map(b => ({ time: b.time, open: b.open * 10, high: b.high * 10,
                                  low: b.low * 10, close: b.close * 10 }));
  const differ = SET.filter(d => {
    let a = false, b = false;
    try { a = !!d.test(base, last, A); } catch (e) { a = null; }
    try { b = !!d.test(scaled, last, A * 10); } catch (e) { b = null; }
    return a !== b;
  }).map(d => d.key);
  ok('every threshold is in ATR, so a 10x price change flips no verdict',
     differ.length === 0, differ.length ? 'scale-dependent: ' + differ.join(', ') : `${SET.length} detectors`);

  // No detector may read past the end of the series or throw on a short one.
  let threw = null;
  try {
    for (let n = 2; n < 14; n++) KT.patterns.detect(base.slice(0, n));
    KT.patterns.detect([]);
  } catch (e) { threw = e.message; }
  ok('a series too short for a detector is skipped, not crashed', threw === null, threw || '');
}

section('PATTERNS — the scan, and its cache');
{
  const found = KT.patterns.detect(candles.slice());
  const keysHit = {};
  found.forEach(p => { keysHit[p.key] = (keysHit[p.key] || 0) + 1; });
  ok('the real series fires a broad share of the table',
     Object.keys(keysHit).length >= 45,
     `${Object.keys(keysHit).length} distinct patterns, ${found.length} hits on ${candles.length} bars`);

  /* The cache is the only reason 86 detectors are affordable on a one-second
     tick, and a cache that returns something different from a full scan is a
     silent wrong answer rather than a slow one. Force a cold scan by handing
     it a series whose first bar differs, then compare. */
  const warm = KT.patterns.detect(candles.slice());
  ok('the cached scan equals the scan it caches',
     warm.length === found.length &&
     warm.every((p, i) => p.key === found[i].key && p.index === found[i].index),
     `${warm.length} hits both ways`);

  /* A new bar must invalidate it. Keying on the close instead of the time
     would invalidate on every tick and cache nothing; keying on length alone
     would never notice a series replaced with a different one. */
  const grown = candles.slice();
  const lastBar = grown[grown.length - 1];
  grown.push({ time: lastBar.time + 300, open: lastBar.close, high: lastBar.close + 20,
               low: lastBar.close - 60, close: lastBar.close + 2 });
  const after = KT.patterns.detect(grown);
  ok('a new bar is picked up rather than served from cache',
     after.length >= found.length, `${found.length} -> ${after.length}`);

  const t0 = Date.now();
  for (let i = 0; i < 10; i++) {
    candles[candles.length - 1].close += 0.01;
    KT.patterns.detect(candles);
  }
  const perTick = (Date.now() - t0) / 10;
  ok('a warm scan fits inside the one-second tick', perTick < 15, `${perTick.toFixed(1)}ms per tick`);

  const stats = KT.patterns.hitRates(candles, found);
  const rows = Array.isArray(stats) ? stats : Object.keys(stats).map(k => stats[k]);
  ok('every pattern found carries its own measured record',
     rows.length > 0 && rows.every(r => r.n != null || r.hits != null),
     `${rows.length} scored`);

  ok('the chart is not flooded with markers',
     KT.patterns.markers(found, stats, 8).length <= 8,
     'the full table belongs in the panel, not on the candles');
}

/* ================================================== THE MODEL AS A LANE */
section('FORECAST — the model lane');
{
  const now = Date.now();
  ok('no vote means the lane drops out, not votes zero',
     KT.forecast.modelLane(null, now).hasData === false);
  ok('a malformed vote drops out too',
     KT.forecast.modelLane({ score: NaN, at: now }, now).hasData === false);

  const fresh = KT.forecast.modelLane({ score: 0.6, at: now, why: 'x' }, now);
  ok('a fresh vote is live and carries its score', fresh.hasData && fresh.score === 0.6);

  /* Stale is dark, not quiet. Twenty-minute-old headlines are not a current
     read of anything, and a lane that keeps voting on them is the same lie as
     restamping a carried-forward option chain. */
  const stale = KT.forecast.modelLane(
    { score: 0.6, at: now - KT.forecast.MODEL_MAX_AGE_MS - 1000, why: 'x' }, now);
  ok('a stale vote goes dark rather than stale', stale.hasData === false, stale.note);

  ok('a vote outside the scale is clamped, never trusted as given',
     KT.forecast.modelLane({ score: 9, at: now }, now).score === 1 &&
     KT.forecast.modelLane({ score: -9, at: now }, now).score === -1);

  const w = KT.CONFIG.forecast.weights;
  /* Less than an equal share. Nine lanes at par is 0.111; the one lane whose
     reasoning cannot be re-derived from its inputs gets less than par until
     the record says otherwise. */
  const par = 1 / Object.keys(w).length;
  ok('the model gets less than an equal share of the vote',
     w.model > 0 && w.model < par,
     `model ${w.model} against a par share of ${par.toFixed(3)}`);
  ok('and less than every lane whose working is checkable arithmetic',
     ['news', 'momentum', 'global', 'structure', 'seasonal', 'options'].every(k => w[k] > w.model));
  ok('nine lanes still sum to 1',
     Math.abs(Object.keys(w).reduce((a, k) => a + w[k], 0) - 1) < 1e-9);

  /* The lane must renormalise away when dark, not drag the bias toward zero.
     Two builds, identical but for the vote: the other lanes' contributions
     must be LARGER when the model is absent, because its weight went to them. */
  const base = { candles: candles.slice(), timeframe: '1D', news, seasonality, options, vix: 11.9 };
  const without = KT.forecast.build(base);
  const with_ = KT.forecast.build(Object.assign({}, base, {
    modelVote: { score: 0, at: Date.now(), why: 'no view either way, evidence is mixed here' },
  }));
  const newsWithout = without.lanes.find(l => l.id === 'news').contribution;
  const newsWith = with_.lanes.find(l => l.id === 'news').contribution;
  ok('a dark model lane hands its weight to the lanes that did report',
     Math.abs(newsWithout) > Math.abs(newsWith),
     `news contributes ${newsWithout} with the model dark, ${newsWith} with it live`);

  /* The prompt must not contain the engine's own verdict. Show a model the
     answer and it agrees with the answer; the lane is then a mirror wearing a
     lane's clothes, which is the sgx_nifty failure one level up. */
  const appSrc = fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8');
  const voteFn = appSrc.slice(appSrc.indexOf('function maybeAskModelVote()'),
                              appSrc.indexOf('function parseVote('));
  ok('the vote prompt never shows the model the engine’s answer',
     !/f\.direction|f\.bias|f\.confidence|f\.rangeLow|f\.rangeHigh|f\.target/.test(voteFn),
     'it gets the evidence, not the verdict');
  ok('and it does hand over the real evidence',
     /headlines|cues|positioning|readings/i.test(voteFn));

  /* parseVote lives in app.js, which this suite does not load as a module -
     app.js boots a page. It is lifted out and exercised directly, because it
     is the only thing standing between a free-tier router's output and 8% of
     the forecast, and the OpenRouter call itself cannot be reached from CI. */
  const pvSrc = appSrc.slice(appSrc.indexOf('function parseVote('),
                             appSrc.indexOf('function maybeEnrichNarrative('));
  // eslint-disable-next-line no-new-func
  const parseVote = new Function(pvSrc + '; return parseVote;')();

  const good = parseVote('{"score": 0.4, "why": "Overnight futures are firm and the option chain leans long."}');
  ok('a well-formed vote parses', good && good.score === 0.4);
  ok('a fenced reply still parses',
     !!parseVote('```json\n{"score": -0.3, "why": "Crude is up sharply and the rupee is weakening into the open."}\n```'));

  /* Each of these arrived, or its shape arrived, from the free pool during
     work on this repo. None may become a vote. */
  ok('a classifier verdict is not a vote', parseVote('User Safety: safe') === null);
  ok('prose with no JSON is not a vote',
     parseVote('I think the market goes up today because of strong global cues.') === null);
  ok('an empty completion is not a vote', parseVote('') === null && parseVote(null) === null);
  ok('a missing score is not a vote',
     parseVote('{"why": "The evidence here is mixed and points nowhere in particular."}') === null);
  ok('a one-word reason is not an explanation',
     parseVote('{"score": 0.5, "why": "bullish"}') === null);

  /* Out of scale is DROPPED, not clamped. A model answering 5 has misread the
     question, and quietly turning that into 1 would hide that it did. */
  ok('a vote on the wrong scale is dropped rather than clamped',
     parseVote('{"score": 5, "why": "Very strongly bullish given the overnight move in US futures."}') === null &&
     parseVote('{"score": -12, "why": "Very strongly bearish given the overnight move in US futures."}') === null);
  ok('but the edges of the real scale are accepted',
     parseVote('{"score": 1, "why": "Everything in the evidence points the same way this morning."}').score === 1);
}

/* ================================================ MARKUP AND CODE AGREE

   app.js writes to elements by id. index.html declares them. Nothing has ever
   checked that the two lists match, and the failure is silent by design:
   core.text() on a missing id does nothing at all, so a panel that was renamed
   or never added simply never appears and no error is raised anywhere.

   This session added four panels and the ids for them; a typo in any one would
   have shipped a blank box. */
section('MARKUP — every id the code writes to exists');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8');
  const chartSrc = fs.readFileSync(path.join(ROOT, 'assets/js/chart.js'), 'utf8');

  const declared = new Set();
  let m;
  const idRx = /\bid="([A-Za-z0-9_-]+)"/g;
  while ((m = idRx.exec(html))) declared.add(m[1]);

  /* Ids the code reaches for, from the three call shapes that exist here.
     Template literals and variables are skipped - those are built at runtime
     and cannot be checked statically, which is a limit worth naming rather
     than papering over. */
  const used = new Set();
  const useRx = /(?:core\.)?(?:text|el)\('([A-Za-z0-9_-]+)'|getElementById\('([A-Za-z0-9_-]+)'\)/g;
  for (const src of [appSrc, chartSrc]) {
    while ((m = useRx.exec(src))) used.add(m[1] || m[2]);
  }

  const missing = [...used].filter(id => !declared.has(id)).sort();
  ok('no id is written to that the markup does not declare',
     missing.length === 0,
     missing.length ? 'missing from index.html: ' + missing.join(', ')
                    : `${used.size} ids used, ${declared.size} declared`);

  /* The reverse is not an error - plenty of ids exist for CSS or for the
     browser's own use - but an id declared and never touched by anything is
     usually a panel somebody forgot to wire, which is this repo's recurring
     bug wearing markup. Reported, not failed. */
  const orphans = [...declared].filter(id =>
    !used.has(id) && !new RegExp('[\'"#]' + id + '\\b').test(appSrc + chartSrc));
  ok('orphan ids are few enough to be deliberate',
     orphans.length < 40, `${orphans.length} declared ids nothing reads`);
}

/* ============================================= THE PANELS THIS SESSION ADDED */
section('PANELS — sectors, movers, flows');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ['sector-heat', 'sector-board-read', 'movers-up', 'movers-dn',
   'flow-fii', 'flow-dii', 'flows-read', 'cr-text', 'cr-dot'].forEach(id => {
    ok(`#${id} is in the markup`, new RegExp('id="' + id + '"').test(html));
  });

  /* The sector list widened from eight indices to eighteen. The forecast and
     the heatmap must agree about what a sector is, which is why one regex
     serves both - two lists is two lists to get out of step. */
  const dataSrc = fs.readFileSync(path.join(ROOT, 'assets/js/data.js'), 'utf8');
  ok('one sector list, not two',
     (dataSrc.match(/var SECTOR_RX/g) || []).length === 1 &&
     !/NIFTY \(IT\|BANK\|AUTO\|PHARMA\|FMCG\|METAL\|REALTY\|ENERGY\)/.test(dataSrc),
     'the old eight-sector regex is gone');
  ok('financial services is on the board',
     /FINANCIAL SERVICES/.test(dataSrc), 'the heaviest sector in the index');

  /* Indian money scale. "FII bought 599.54" is not a sentence anybody says. */
  const f = KT.core.fmt;
  ok('flows read in crore', f.crore(599.54) === '600 Cr', f.crore(599.54));
  ok('big numbers step up to lakh crore', /L Cr$/.test(f.crore(456789)), f.crore(456789));
  ok('small ones step down to lakh', /\bL$/.test(f.crore(0.42)), f.crore(0.42));
  ok('flows keep their sign', f.croreSigned(-1234).indexOf('−') === 0, f.croreSigned(-1234));
  ok('counts use Indian grouping', f.count(1234567) === '12,34,567', f.count(1234567));

  /* Bank Nifty and India VIX are on the board and are not chartable. Clicking
     one used to switch the chart to a symbol with no candle series behind it
     and leave the page on "Loading" forever. */
  ok('quote-only tickers are marked in the markup',
     (html.match(/class="tick is-quote"/g) || []).length === 2);
  const appSrc2 = fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8');
  ok('and the click handler refuses to switch to them',
     /is-quote/.test(appSrc2.slice(appSrc2.indexOf("el('ticker-strip')"),
                                   appSrc2.indexOf("el('ticker-strip')") + 700)));

  /* Dead files. CLAUDE.md opens with the rule; these were the violations. */
  ['data/predictions.json', 'data/live_impact.json', 'data/social.json',
   'data/rss_config.json', 'data/market.json',
   'config/keywords.yml', 'config/watchlist.yml'].forEach(f2 => {
    ok(`${f2} is gone`, !fs.existsSync(path.join(ROOT, f2)));
  });
  ok('and nothing writes market.json any more',
     !/write_json\("market\.json"/.test(
       fs.readFileSync(path.join(ROOT, 'scripts/fetch_market.py'), 'utf8')));

  /* Every panel's render function has to be called from recompute(), which is
     the one place the page redraws from.

     This is not hypothetical. All four of this session's render calls were
     inserted next to the FIRST `renderEvidence();` in the file, which is
     inside the evidence button's click handler rather than inside
     recompute() - so the four new panels rendered only if you clicked "Break
     it down", and shipped blank otherwise. Nothing failed: no console error,
     no exception, four empty boxes. The browser check caught it; this makes
     it a test rather than a thing somebody has to remember to look at. */
  const appSrc3 = fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8');
  const recomputeStart = appSrc3.indexOf('function recompute()');
  const recomputeEnd = appSrc3.indexOf('\n  }', appSrc3.indexOf('updateLedger(news)'));
  const recomputeBody = appSrc3.slice(recomputeStart, recomputeEnd);
  ['renderChartRead', 'renderSectorBoard', 'renderMovers', 'renderFlows',
   'renderEvidence', 'renderForecast', 'renderOpenCall', 'renderLockScore'].forEach(fn => {
    ok(`${fn}() is called from recompute()`,
       recomputeStart > 0 && recomputeEnd > recomputeStart &&
       new RegExp('\\b' + fn + '\\(').test(recomputeBody),
       'a panel wired anywhere else renders only when that other thing happens');
  });

  /* The movers panel is only possible if the workflow prices index members.
     It used to walk the universe alphabetically and take the first 400. */
  const stocksSrc = fs.readFileSync(path.join(ROOT, 'scripts/fetch_stocks.py'), 'utf8');
  ok('the stock fetcher prices index members first',
     /_constituents\(\)/.test(stocksSrc) && /constituents\.json/.test(stocksSrc));
}

/* ===================================================================== IPO */
section('IPO — the engine');
{
  const raw = readJSON('data/ipo.json', null);
  ok('data/ipo.json exists and parses', !!raw && raw.ok === true);

  const m = KT.ipo.build(raw || {});
  ok('build returns a model', m.ok === true, `${m.issues.length} issues`);
  ok('every issue is placed in exactly one phase',
     m.issues.every(i => ['open', 'closing-today', 'upcoming', 'closed'].includes(i.phase)));
  ok('open and upcoming are disjoint',
     !m.open.some(a => m.upcoming.some(b => b.symbol === a.symbol)));

  /* A bad build is worse than no build here: an issue value is what the
     "biggest IPO" ranking sorts on and what the money-on-the-table tile adds
     up, so a wrong one is wrong in three places at once. */
  const nse = m.issues.find(i => i.symbol === 'NSE');
  ok('issue value is shares times the cap, in crore',
     Math.abs(nse.issueValueCr - 1785 * 88642911 / 1e7) < 1,
     `${nse.issueValueCr} Cr`);
  ok('one lot is the cap times the lot size', nse.lotValue === 1785 * 8, `₹${nse.lotValue}`);
  ok('band width is measured off the floor', nse.bandWidthPct === 5, `${nse.bandWidthPct}%`);

  /* The category book. Sub-category rows have no quota of their own, and
     dividing a bid by a blank quota is how a breakdown line ends up looking
     like a 50x subscription. */
  const bk = nse.card.book;
  ok('the book keeps only real categories',
     bk.rows.every(r => r.offered > 0) && bk.by.qib && bk.by.retail,
     bk.rows.map(r => r.label).join(', '));
  ok('QIB and retail are read separately',
     bk.by.qib.times > 1.5 && bk.by.retail.times < 1,
     `QIB ${bk.by.qib.times}x, retail ${bk.by.retail.times}x`);

  /* The demand curve is the one object that answers a shape question. */
  const d = nse.card.demand;
  ok('the demand curve spans the band', d && d.floor === 1700 && d.cap === 1785, `${d.floor}–${d.cap}`);
  ok('prices are strictly increasing along the curve',
     d.points.every((p, i) => i === 0 || p.price > d.points[i - 1].price));
  ok('atCap is the share of bids surviving at the top',
     d.atCapPct > 99 && d.atCapPct <= 100, `${d.atCapPct}%`);

  /* Scoring. The rule that matters is the one the index terminal's lanes
     follow: a factor with no input drops out rather than voting zero, because
     a neutral score for absent data is an opinion nobody formed. */
  const c = nse.card;
  ok('every factor reports hasData explicitly',
     c.factors.every(f => typeof f.hasData === 'boolean'), `${c.factors.length} factors`);
  ok('a factor with no data scores nothing and says why',
     c.factors.filter(f => !f.hasData).every(f => f.score === 0 && f.note.length > 20));
  ok('the total is bounded', c.total >= -1 && c.total <= 1, String(c.total));
  ok('coverage is carried next to the total, not hidden',
     c.covered > 0 && c.of === 5 && /not a recommendation/i.test(c.basis));

  /* A pure offer for sale must be deducted for. Every rupee goes to the
     selling shareholder and none into the company - not a reason to avoid an
     issue, but a fact about where the money lands, and the page would be
     hiding it if the score ignored it. */
  const struct = c.factors.find(f => f.id === 'structure');
  ok('a pure offer for sale is marked down', struct.hasData && struct.score < 0,
     struct.note.slice(0, 60));

  /* Thin coverage must not read as a confident score. */
  const spectraa = m.issues.find(i => i.symbol === 'SPECTRAA');
  ok('an 18x book scores well on demand',
     spectraa.card.factors.find(f => f.id === 'demand').score > 0.8);
  ok('but its coverage is reported as thin', spectraa.card.covered < 3,
     `${spectraa.card.covered} of 5 factors`);

  /* Subscription is strongly non-linear in what it predicts: 0.8x and 1.2x
     are different outcomes, 40x and 60x are the same one. A linear score
     would let one huge SME book dominate the whole page. */
  const fake = (t) => KT.ipo.score({ isSme: false, subscription: t, phase: 'open',
                                     bandLow: 100, bandHigh: 105, detail: null },
                                   { buckets: null });
  ok('subscription saturates rather than running away',
     fake(60).factors[0].score === fake(200).factors[0].score,
     'both clamp to 1.00');
  ok('under-subscription is negative, over is positive',
     fake(0.5).factors[0].score < 0 && fake(3).factors[0].score > 0);

  /* Risk flags are the part a reader should see before applying. */
  const risky = KT.ipo.score({ isSme: true, subscription: 25, phase: 'closing-today',
                               bandLow: null, bandHigh: null, detail: null }, { buckets: null });
  const flags = risky.factors.find(f => f.id === 'risk').flags;
  ok('SME, a lottery allotment, a closing book and no band all flag',
     flags.length >= 4, `${flags.length} flags`);

  /* No GMP, on purpose. */
  ok('no grey market premium is published', m.gmp === null);
  /* Omitting it silently would read as an oversight. Each of the three
     places a reader could look says why it is absent. */
  ok('and every layer says why rather than omitting it silently',
     [/grey market/i.test(fs.readFileSync(path.join(ROOT, 'assets/js/ipo.js'), 'utf8')),
      /grey market/i.test(fs.readFileSync(path.join(ROOT, 'scripts/fetch_ipo.py'), 'utf8')),
      /grey.market/i.test(fs.readFileSync(path.join(ROOT, 'ipo.html'), 'utf8'))]
       .every(Boolean),
     'engine, fetcher and page');

  /* Calendar and ranking. */
  ok('the calendar groups by the month an issue opens',
     m.calendar.length >= 1 && m.calendar[0].issues.length === m.issues.length,
     m.calendar.map(c2 => c2.label + ': ' + c2.issues.length).join(', '));
  ok('the biggest list is ranked by issue value and excludes closed issues',
     m.headline[0].symbol === 'NSE' && m.headline.every(i => i.phase !== 'closed'));

  /* History says how many it measured, and refuses to invent a base rate. */
  ok('with nothing priced, the base rate factor goes dark rather than guessing',
     m.history.n === 0 &&
     nse.card.factors.find(f => f.id === 'history').hasData === false);
}

section('IPO — the page and the fetcher');
{
  const html = fs.readFileSync(path.join(ROOT, 'ipo.html'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'assets/js/ipo-app.js'), 'utf8');

  const declared = new Set();
  let mm;
  const idRx = /\bid="([A-Za-z0-9_-]+)"/g;
  while ((mm = idRx.exec(html))) declared.add(mm[1]);
  const used = new Set();
  const useRx = /(?:core\.)?(?:text|el)\('([A-Za-z0-9_-]+)'/g;
  while ((mm = useRx.exec(appSrc))) used.add(mm[1]);
  const missing = [...used].filter(id => !declared.has(id)).sort();
  ok('every id the IPO page writes to exists in its markup',
     missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : `${used.size} ids`);

  ok('the page shares the terminal’s stylesheet rather than forking the palette',
     /assets\/style\.css/.test(html) && /assets\/ipo\.css/.test(html));
  ok('the two pages link to each other',
     /href="index\.html"/.test(html) &&
     /href="ipo\.html"/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));

  /* Company names and lead managers come from an exchange feed, which is
     somebody else's input arriving in this page, and it is built into HTML. */
  ok('everything interpolated into markup is escaped',
     /function esc\(/.test(appSrc) &&
     !/innerHTML\s*=\s*[^;]*\+\s*(?:r|d)\.(?:company|symbol)\b(?!\s*\))/.test(appSrc),
     'esc() on every feed-sourced string');

  const py = fs.readFileSync(path.join(ROOT, 'scripts/fetch_ipo.py'), 'utf8');
  ['all-upcoming-issues', 'ipo-current-issue', 'public-past-issues', 'ipo-detail'].forEach(p2 => {
    ok(`the fetcher reads /${p2}`, py.includes(p2));
  });
  ok('listing gains are computed, not copied',
     /def listing_gain/.test(py) && /query1\.finance\.yahoo\.com/.test(py),
     'issue price against the listing-day close from the symbol’s own series');
  ok('a failed run keeps the last good file', /carry_forward\("ipo\.json"/.test(py) ||
     /carry_forward\(\s*"ipo\.json"/.test(py));
  ok('the workflow runs it',
     /fetch_ipo\.py/.test(fs.readFileSync(path.join(ROOT, '.github/workflows/live-data.yml'), 'utf8')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
