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
                 'vol', 'forecast', 'postmortem', 'ledger', 'learn', 'trail', 'evidence', 'ipo',
                 'orders', 'streetcalls', 'stocks', 'lessons', 'desk'];

let pass = 0, fail = 0;
/* Checks that need a promise to settle (the desk run, the AI budget) are
   queued here as functions and run one after another at the end, so two of
   them can never share the day's budget or the stubbed network at once. */
const asyncChecks = [];
let SANDBOX = null;
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
  // data.js's request helpers need these two; the page has them for free.
  sb.AbortController = AbortController;
  sb.location = { origin: 'http://localhost', hash: '', pathname: '/' };
  SANDBOX = sb;
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
/* The news lane only counts headlines from the last 48 hours of wall-clock
   time, so a snapshot that is a few days old would make every news check go
   dark and fail for a reason that has nothing to do with the code. Shift the
   whole feed so its newest item is ten minutes old; spacing is preserved. */
function freshen(items) {
  const ts = items.map(n => n && n.ts).filter(Number.isFinite);
  if (!ts.length) return items;
  const shift = (Date.now() / 1000 - 600) - Math.max.apply(null, ts);
  return items.map(n => (n && Number.isFinite(n.ts) ? Object.assign({}, n, { ts: n.ts + shift }) : n));
}
const news = freshen((readJSON('data/news.json', {}).news_items || []).slice(0, 300));
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
  const news = freshen((readJSON('data/news.json', {}).news_items || []).slice(0, 200));
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
                  news: freshen(readJSON('data/news.json', {}).news_items || []),
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

  /* After the bell. A series whose last minute bar is 15:29 (most NSE stocks
     have no 15:30 print; the index does) read as a session with one minute
     left, and at 20:00 the page offered RELIANCE "74% by 15:30 today
     (1 minutes)" (seen live, 29 Oct 2026). */
  const last1529 = istAt(15, 29, 21), close21 = istAt(15, 30, 21);
  ok('after the bell a series ending on its 15:29 bar is forecast from the close',
     KT.forecast.sessionOrigin(last1529, istAt(20, 0, 21)) === close21);
  ok('before the bell that bar is still the last minute of today',
     KT.forecast.sessionOrigin(last1529, last1529 + 30) === last1529);
  {
    const bars = [];
    for (let i = 0; i < 375; i++) {
      const c = 22000 + Math.sin(i / 17) * 40 + i * 0.05;
      bars.push({ time: istAt(9, 15, 21) + i * 60, open: c, high: c + 3, low: c - 3, close: c, volume: 0 });
    }
    const late = KT.forecast.build({ candles: bars.map(b => Object.assign({}, b)), timeframe: '1S', news: [], vix: 12,
                                     nowSec: istAt(20, 0, 21) });
    const d0 = late && new Date((late.path[0].time + 19800) * 1000);
    const d1 = late && new Date((late.path[late.path.length - 1].time + 19800) * 1000);
    ok('and the forecast is the whole next session, to its close',
       !!late && late.path.length === 375 && d0.getUTCDate() === 22 && d1.getUTCDate() === 22 &&
       d1.getUTCHours() * 60 + d1.getUTCMinutes() === 930,
       late ? late.path.length + ' minutes, ' + d0.toISOString().slice(5, 16) + ' to ' + d1.toISOString().slice(5, 16) : 'null');
    const lastMin = KT.forecast.build({ candles: bars.map(b => Object.assign({}, b)), timeframe: '1S', news: [], vix: 12,
                                        nowSec: last1529 + 30 });
    ok('one minute reads as "1 minute"', !!lastMin && lastMin.horizonLabel === '1 minute',
       lastMin ? lastMin.horizonLabel : 'null');
  }

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

/* The join itself, with no lock() in the way. Three of seventeen sessions on
   one browser's record were locked at :14, :23 and :01 past the minute and
   read "in progress" for weeks (seen live, 29 Oct 2026). */
{
  const t0 = Math.floor(Date.UTC(2026, 9, 29, 3, 45) / 1000);        // 29 Oct 2026, 09:15 IST
  const bars = Array.from({ length: 61 }, (_, i) => ({ time: t0 + 60 * i, open: 100, high: 100, low: 100, close: 100 + i / 10 }));
  const row = { id: 'COVSYM:2026-10-29:1S:advance', symbol: 'COVSYM', session: '2026-10-29', stage: 'advance',
                timeframe: '1S', lockedAt: Date.now(), anchorPrice: 100, openPrice: 100, openGapPct: null,
                path: bars.slice(0, 60).map(b => ({ time: b.time + 14, value: 100 })) };
  const sc = KT.ledger.scoreLock(row, bars);
  ok('a lock carrying a live bar\u2019s seconds is scored, each point against the bar it falls in',
     !!sc && sc.n === 60 && sc.pairs[5].actual === bars[5].close, sc ? sc.n + ' of 60 joined' : 'null');
  const sh = KT.ledger.scoreLock(row, bars.filter((_, i) => i !== 5));
  ok('a bar the feed dropped still drops its point instead of borrowing a neighbour\u2019s price',
     !!sh && sh.n === 59 && !sh.pairs.some(pr => pr.time === row.path[5].time));
  const keep = KT.core.store.get('fcLocks', []);
  // Each case starts from the same unsettled row, so one cannot pass because
  // an earlier one already froze it.
  const settleWith = series => {
    KT.core.store.set('fcLocks', keep.concat([JSON.parse(JSON.stringify(row))]));
    return KT.ledger.settleLocks(series, 'COVSYM');
  };
  const morning = bars.slice(0, 25).concat(bars.slice(59));
  const noTail = bars.slice(0, 50).concat([{ time: t0 + 7200, open: 100, high: 100, low: 100, close: 101 }]);
  ok('a lock is not frozen on a morning of bars', settleWith(morning) === 0);
  ok('nor without a price from its last tenth, where its close lives', settleWith(noTail) === 0);
  ok('and is frozen once the day is there',
     settleWith(bars) === 1 && KT.ledger.locks('COVSYM', 5)[0].outcome.closeActual === bars[59].close);
  KT.core.store.set('fcLocks', keep);
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
  ok('the lanes still sum to 1',
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
  // panels.js reads the page's own cards, so it counts as a reader here.
  const pnSrc0 = fs.existsSync(path.join(ROOT, 'assets/js/panels.js'))
    ? fs.readFileSync(path.join(ROOT, 'assets/js/panels.js'), 'utf8') : '';
  const orphans = [...declared].filter(id =>
    !used.has(id) && !new RegExp('[\'"#]' + id + '\\b').test(appSrc + chartSrc + pnSrc0));
  ok('orphan ids are few enough to be deliberate',
     orphans.length < 40, `${orphans.length} declared ids nothing reads`);
}

/* ===================================================== PREDICTION TRAIL

   Added 6 Oct 2026. The trail is only worth showing if every point on it is
   something the model could have drawn at the time it claims - so the test
   that matters is that a point is identical whether or not the future exists
   in the series it was computed from. */
section('TRAIL — the remembered line');
{
  const T = KT.trail;
  const ser = T.seriesFor(candles);
  let mism = 0;
  [120, 400, 800, candles.length - 5].forEach(i => {
    const a = KT.forecast.momentumLane(T.snapAt(ser, i, candles[i].close), null).score;
    const b = KT.forecast.momentumLane(KT.ind.snapshot(candles.slice(0, i + 1)), null).score;
    if (Math.abs(a - b) > 1e-12) mism++;
  });
  ok('one pass of causal series equals a snapshot per bar', mism === 0, 'the momentum inputs read at index i');

  const full = T.replay(candles, '1D', { lead: 3, symbol: 'TEST-A', span: 160 });
  ok('the replay produces scored points', full.points.filter(p => p.a != null).length > 100,
     `${full.points.length} points in ${full.ms}ms`);
  ok('every point was made before the bar it points at', full.points.every(p => p.m < p.t));

  /* No look-ahead: cut the series just after a point's own target and
     rebuild. If anything in the replay reads past the bar it was made on,
     the prediction changes. */
  const pick = full.points.filter(p => p.a != null)[40];
  const cut = candles.findIndex(c => c.time === pick.t);
  const part = T.replay(candles.slice(0, cut + 2), '1D', { lead: 3, symbol: 'TEST-B', span: 160 });
  const same = part.points.find(p => p.m === pick.m);
  ok('a point is identical with the future removed', !!same && same.p === pick.p,
     same ? `${pick.p} vs ${same.p}` : 'point missing from the truncated replay');

  const st = T.stats(full.points, 3);
  const scored = full.points.filter(p => p.a != null);
  const mae = scored.reduce((t, p) => t + Math.abs(p.e), 0) / scored.length;
  ok('the average miss is the mean absolute error', Math.abs(st.maePts - mae) < 0.01, `${st.maePts} pts`);
  ok('every scored point lands in exactly one bucket', st.above + st.below + st.inside === st.n);
  ok('the comparison with a flat line is reported', st.skill > 0 && isFinite(st.skill), `skill ${st.skill}`);

  const g = T.grade({ p: 100, b: 100, sd: 0.5 }, 100.2);
  ok('a miss inside the carried range reads as on target', g.side === 'on' && g.inside === true);
  const g2 = T.grade({ p: 100, b: 100, sd: 0.1 }, 100.5);
  ok('a miss outside it reads above or below', g2.side === 'above' && g2.e === 0.5);

  /* First write wins: a second forecast for the same bar must not replace
     the one already recorded, or the live record could be improved after
     the fact. */
  const fc = (v) => ({ timeframe: '1D', lastClose: 100, z68: 1, direction: 'BULLISH',
    path: [{ time: 1791275700 + 300, value: v }, { time: 1791275700 + 600, value: v }, { time: 1791275700 + 900, value: v }],
    lower: [{ value: v - 1 }, { value: v - 1 }, { value: v - 1 }] });
  KT.trail.clearLive('TEST');
  T.recordLive(fc(101), { symbol: 'TEST', lastTime: 1791275700, leads: [3] });
  T.recordLive(fc(150), { symbol: 'TEST', lastTime: 1791275700 + 30, leads: [3] });
  const rows = T.liveLoad('TEST', '1D', 3);
  ok('the live record keeps the first forecast of a bar', rows.length === 1 && rows[0].p === 101, `${rows.length} row(s)`);
  KT.trail.clearLive('TEST');
}

/* ============================================================ ORDER BOOK */
section('ORDERS — FIFO, P&L and XIRR');
{
  const O = KT.orders;
  O.load(); O.clear();
  O.add({ symbol: 'reliance', side: 'BUY', qty: 10, price: 1000, date: '2025-01-10' });
  O.add({ symbol: 'RELIANCE', side: 'BUY', qty: 10, price: 1200, date: '2025-06-10' });
  O.add({ symbol: 'RELIANCE', side: 'SELL', qty: 15, price: 1300, date: '2026-02-10', charges: 20 });
  O.add({ symbol: 'TCS', side: 'SELL', qty: 5, price: 2200, date: '2026-10-01', product: 'MIS' });
  O.add({ symbol: 'TCS', side: 'BUY', qty: 5, price: 2100, date: '2026-10-01', product: 'MIS' });
  const b = O.book({ RELIANCE: { price: 1218 }, TCS: { price: 2100 } });
  ok('realised P&L matches first-in first-out', b.realised === 4000, `${b.realised}`);
  const rel = b.positions.find(p => p.symbol === 'RELIANCE');
  ok('the open lot is the later purchase', rel.qty === 5 && rel.avgPrice === 1200, `${rel.qty} @ ${rel.avgPrice}`);
  ok('unrealised is price against the open lot', rel.unrealised === 90, `${rel.unrealised}`);
  ok('a lot held twelve months is long-term', b.closed.some(c => c.symbol === 'RELIANCE' && c.term === 'long-term'));
  ok('a sell before a buy books as a short', b.closed.some(c => c.symbol === 'TCS' && c.side === 'short' && c.pnl === 500));
  ok('charges come off the realised figure', b.netRealised === 3980, `${b.netRealised}`);
  let threw = false;
  try { O.add({ symbol: 'X', side: 'BUY', qty: 0, price: 10 }); } catch (e) { threw = true; }
  ok('a zero-quantity order is refused', threw);
  const x = O.xirr([{ date: '2025-01-01', amt: -100 }, { date: '2026-01-01', amt: 110 }]);
  ok('XIRR of 100 to 110 over a year is ten percent', Math.abs(x - 10) < 0.05, `${x}%`);
  O.clear();
}

/* ========================================================== STREET CALLS */
section('STREET CALLS — published tips, parsed conservatively');
{
  const uni = readJSON('data/universe.json', { symbols: [] }).symbols;
  const n = KT.streetcalls.setUniverse(uni);
  ok('the stock index builds', n > 1000, `${n} names`);
  const P = h => KT.streetcalls.parse({ headline: h, ts: 1, source: 'test' });
  const a = P("Nomura retains 'Buy' on Godrej Consumer, target price Rs 1,110");
  ok('a broker call is read whole', a && a.rating === 'buy' && a.broker === 'Nomura' && a.target === 1110 &&
     a.stocks.indexOf('GODREJCP') !== -1, a ? `${a.broker} ${a.rating} ${a.stocks} ${a.target}` : 'no parse');
  const b2 = P("DMart falls 6.7% as Citi, Goldman retain sell call");
  ok('a sell call is a sell', b2 && b2.rating === 'sell' && b2.stocks.indexOf('DMART') !== -1, b2 ? b2.stocks.join(',') : 'no parse');
  ok('a question is not a call', P('Meesho shares jump 6%. Buy, sell or hold the stock?') === null);
  const c = P('Motilal Oswal initiates coverage on Molbio Diagnostics stock with Buy, sees 21% upside');
  ok('the broker is not mistaken for the stock', c && c.stocks.length === 1 && c.stocks[0] === 'MOLBIO',
     c ? c.stocks.join(',') : 'no parse');
  const e = P('Top 2 stocks to buy or sell for tomorrow: Nykaa, LIC by Chandan Taparia - Check stop-loss, targets');
  ok('a buy-or-sell list is a pick, not a buy', e && e.rating === 'pick', e ? e.rating : 'no parse');
  const f = P('Kotak, BoB, PB Fintech: Macquarie Upgrades Nine Stocks, Downgrades One');
  ok('the broker is the one doing the calling', f && f.broker === 'Macquarie', f ? String(f.broker) : 'no parse');
  ok('a which-to-buy comparison is not a call',
     P('Maruti Suzuki vs TVS Motor vs Mahindra: Which auto stock to buy ahead of festive season? Check target price') === null);
  ok('an upgrade to a forecast is not an upgrade to a stock',
     P('India GDP growth gets a wave of upgrades after robust Q1 show') === null &&
     P("McDonald's stock falls as it unveils plan to spend big on restaurant upgrades") === null);
  ok('a credit-rating action is not a broker call',
     P('Shriram Finance Gets Quadruple Rating Upgrades; Fitch Joins AAA Club with BBB- Rating') === null);
  const g = P("'India's drone leader': Buy Ideaforge stock for 27% upside, says Ashika Securities");
  ok('a broker that is also a listed company is not the stock', g && g.stocks.join() === 'IDEAFORGE',
     g ? g.stocks.join(',') : 'no parse');
  const d = P('Jefferies keeps Buy on Sun Pharma, raises target to Rs 2,100');
  ok('a brand name the press uses resolves to the listed company', d && d.stocks[0] === 'SUNPHARMA',
     d ? d.stocks.join(',') : 'no parse');
}

/* ============================================================ NSE EXTRAS */
section('DATA — the NSE extras and the screener');
{
  const csv = '""Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Oct 06, 2026"",,,\r\n' +
    'Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short       ,Option Index Call Long\r\n' +
    'FII,30285,324010,3442046,2831549,393444\r\nTOTAL,428208,428208,7921065,7921065,3518112\r\n';
  const p = KT.data.parseParticipantCsv(csv);
  ok('the participant file parses', p && p.rows.FII && p.rows.FII.longPct === 8.55, p ? `FII ${p.rows.FII.longPct}% long` : 'no parse');
  ok('and reads its own date', p && p.date === '06-Oct-2026', p && p.date);
  ok('a refusal page is not a file', KT.data.parseParticipantCsv('Access Denied\nYou do not have permission') === null);
  const t = KT.data.nseDate('06-Oct-2026 14:46');
  ok('NSE timestamps are read as IST', t === Date.UTC(2026, 9, 6, 9, 16) / 1000, `${t}`);
  const dataSrc = fs.readFileSync(path.join(ROOT, 'assets/js/data.js'), 'utf8');
  ok('the screener request stays a simple request', /text\/plain/.test(dataSrc.slice(dataSrc.indexOf('function tvScan'), dataSrc.indexOf('function tvScan') + 600)),
     'a JSON content type would trigger a preflight the screener refuses');
  const cfg = fs.readFileSync(path.join(ROOT, 'assets/js/config.js'), 'utf8');
  ok('GIFT Nifty is shown, not fed to the model',
     !/gift_nifty/.test(fs.readFileSync(path.join(ROOT, 'assets/js/forecast.js'), 'utf8')) && /gift_nifty/.test(cfg));
}

/* =================================================== THE TWO NEW PAGES */
section('MARKUP — the profile page and the data hub');
{
  [['profile.html', 'assets/js/profile-app.js'], ['data.html', 'assets/js/hub-app.js']].forEach(pair => {
    const html = fs.readFileSync(path.join(ROOT, pair[0]), 'utf8');
    const src = fs.readFileSync(path.join(ROOT, pair[1]), 'utf8');
    const declared = new Set();
    let m;
    const idRx = /\bid="([A-Za-z0-9_-]+)"/g;
    while ((m = idRx.exec(html))) declared.add(m[1]);
    // Ids the script builds into its own templates exist when it writes to them.
    while ((m = idRx.exec(src))) declared.add(m[1]);
    const used = new Set();
    const useRx = /(?:core\.)?(?:text|el)\('([A-Za-z0-9_-]+)'|getElementById\('([A-Za-z0-9_-]+)'\)/g;
    while ((m = useRx.exec(src))) used.add(m[1] || m[2]);
    const missing = [...used].filter(id => !declared.has(id));
    ok(pair[0] + ' declares every id its script writes to', missing.length === 0,
       missing.length ? 'missing: ' + missing.join(', ') : `${used.size} ids`);
  });
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('orders.js loads before portfolio.js on the terminal',
     idx.indexOf('assets/js/orders.js') > 0 && idx.indexOf('assets/js/orders.js') < idx.indexOf('assets/js/portfolio.js'));
  ok('every page links to the other three',
     ['index.html', 'profile.html', 'data.html'].every(f => {
       const h = fs.readFileSync(path.join(ROOT, f), 'utf8');
       return /href="profile\.html"/.test(h) && /href="data\.html"/.test(h) && /href="index\.html"/.test(h);
     }));
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
  // Bank Nifty, India VIX and (since 6 Oct 2026) GIFT Nifty.
  ok('quote-only tickers are marked in the markup',
     (html.match(/class="tick is-quote"/g) || []).length === 3);
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
  /* These assertions were written against the 20 Sep 2026 capture, whose
     reference issue was NSE's own IPO. snapshot.yml now copies the live file
     over data/ipo.json four times a day, so the reference issue is gone from
     it and the block below would throw rather than test. Skipped and said
     so, which is the honest state - not counted as a pass. */
  if (!nse) {
    console.log('  SKIP  issue-level IPO checks: data/ipo.json is a live snapshot without the 20 Sep reference issue');
  } else {
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

/* ================================================================ V2

   Added 29 Oct 2026 with the forecast-first page. Four things can go wrong
   here without any error on screen, and each has a check:

     the desk sees the answer   a prompt that carries the engine's verdict
                                turns the AI lane into an echo
     a free-tier reply          anything that is not the asked-for JSON must
                                be refused, not coerced into a vote
     a stock's news             a headline about Reliance Power must not move
                                Reliance Industries
     the page and the code      every id app.js, chart.js and panels.js
                                writes to exists on the one page */
section('V2 — the AI desk');
{
  const D = KT.desk;
  // The page waits 800 ms between steps and up to 4 s before a retry; the
  // behaviour is the same at a fraction of it.
  KT.CONFIG.ai.deskGapMs = 40;
  KT.CONFIG.ai.deskRetryWaitMs = 20;
  const minute = minuteCandles.length > 100 ? minuteCandles : candles;
  /* A state object shaped like app.js's, with a forecast whose verdict fields
     carry values nothing else on the page could produce. If any of them
     reaches a prompt, the desk was shown the answer. */
  const built = KT.forecast.build({ candles: minute.slice(), timeframe: '1S', news, seasonality, options,
                                    global: globalCues, vix: 12.3 });
  const f = Object.assign({}, built, {
    direction: 'BULLISH', bias: 0.789, confidence: 87, target: 99876.54, targetPct: 4.321,
    rangeLow: 11111.11, rangeHigh: 22222.22, narrative: 'ZZSECRET NARRATIVE',
    checkpoints: built.checkpoints.map(c => Object.assign({}, c, { value: 33333.33, pUp: 91, low: 31111.11, high: 35555.55 })),
    path: built.path.map(p => ({ time: p.time, value: 44444.44 })),
  });
  const S = {
    symbol: 'NIFTY', timeframe: '1S', candles: minute.slice(),
    quote: { price: minute[minute.length - 1].close, changePct: 0.31, prevClose: minute[minute.length - 2].close },
    indicators: KT.ind.snapshot(minute), levels: KT.levels.build(minute),
    structures: KT.structures.detect(minute), structureStats: KT.structures.outcomes(minute),
    global: globalCues, flows: readJSON('data/flows.json', null), options: options, vix: 12.3,
    forecast: f, settings: { key: 'test-key', model: 'test/model' },
  };
  /* No headlines in this one: a headline is somebody else's text and could
     contain any word or number, and the leak being tested is in the code. */
  const F = D.gather(S, { news: [] });
  const LEAKS = ['BULLISH', 'BEARISH', 'RANGE-BOUND', '99876', '99,876', '11111', '11,111', '22222', '22,222',
                 '33333', '33,333', '44444', '44,444', 'ZZSECRET', '4.321', '0.789'];
  const analysts = D.roleList(F).map(r => ({ id: r.id, label: r.label, score: 0.3,
    why: 'Price is above the 20 EMA and the session is holding its gains.', points: ['RSI 58'] }));
  const prompts = []
    .concat(D.roleList(F).map(r => D.prompts.analyst(F, r)))
    .concat([D.prompts.debate(F, analysts),
             D.prompts.final(F, analysts, { bull: 'b'.repeat(30), bear: 'c'.repeat(30), stronger: 'bull', why: 'x' }, '', ''),
             D.prompts.quick(F, '', '')]);
  const text = prompts.map(p => p.system + '\n' + p.user).join('\n');
  const leaked = LEAKS.filter(s => text.indexOf(s) !== -1);
  ok('no desk prompt carries the engine’s verdict', leaked.length === 0,
     leaked.length ? 'leaked: ' + leaked.join(', ') : prompts.length + ' prompts, ' + text.length + ' chars');
  ok('and the prompts do carry the evidence',
     /RSI \d+/.test(text) && /Global cues/.test(text) && /headlines/i.test(text) && /Levels:/.test(text));
  ok('the horizon is the question: its end time is given, its price is not',
     F.horizon.endTime === built.path[built.path.length - 1].time && /IST/.test(F.horizon.text));
  ok('an index desk gets a market internals analyst, a stock desk a company analyst',
     D.roleList(F).map(r => r.id).join(',') === 'technical,news,macro,internals');
  ok('the final prompt forbids trade instructions', /never tell anyone to buy, sell/i.test(prompts[5].system));

  /* Parsing. Every shape below has arrived, or its kind has, from the free pool. */
  const pa = D.parse.analyst;
  ok('a fenced analyst reply parses',
     !!pa('```json\n{"score": 0.4, "why": "Breadth is broad and banks lead the advance today.", "points": ["31 of 50 up"]}\n```'));
  ok('smart quotes and a trailing comma are repaired',
     !!pa('{“score”: -0.2, “why”: “Crude is up two percent and the rupee is weak.”,}'));
  ok('a score off the scale is refused, not clamped',
     pa('{"score": 4, "why": "Everything points up, very strongly so this morning."}') === null);
  ok('a classifier verdict is not an analyst', pa('User Safety: safe') === null);
  ok('a one-word reason is not an analysis', pa('{"score": 0.5, "why": "bullish"}') === null);

  const pf = D.parse.final;
  const fin = pf('{"rating": "Lean Up", "score": -0.4, "confidence": 0.7, "why": "Breadth and the cues agree, but the news is mixed and the open is flat.", "risk": "A break below support.", "watch": "The 11:00 RBI minutes."}');
  ok('a rating is normalised and wins over a contradicting score',
     fin && fin.rating === 'lean_up' && fin.score > 0, fin ? fin.rating + ' ' + fin.score : 'null');
  ok('a 0-1 confidence is read as a percentage', fin && fin.confidence === 70);
  ok('broker words map onto the five steps',
     D.parse.rating('Strong Buy') === 'strong_up' && D.parse.rating('underweight') === 'lean_down' &&
     D.parse.rating('HOLD') === 'neutral' && D.parse.rating('banana') === null);
  ok('a sentence that tells the reader to trade is dropped',
     D.noAdvice('Banks led the move. You should buy on dips here. Watch 24,200.') === 'Banks led the move. Watch 24,200.');
  ok('a broker call reported as news is kept',
     D.noAdvice('Nomura retains a buy rating on the stock.') === 'Nomura retains a buy rating on the stock.');
  ok('a decimal point is not the end of a sentence',
     D.noAdvice('GIFT Nifty +1.17% points to a firm start. You should buy now. PCR 1.12 and max pain 22,900.') ===
     'GIFT Nifty +1.17% points to a firm start. PCR 1.12 and max pain 22,900.',
     'the first live run printed "+1. 17%"');
  const rf = D.ruleFinal(analysts, null);
  ok('when the final step fails, the analysts’ average stands in, labelled as arithmetic',
     rf && rf.source === 'rule' && rf.rating === 'lean_up');

  /* A whole run against a scripted model: six requests, in the right order,
     the vote it hands the forecast, and the budget it spends. */
  const realAsk = KT.data.askModel;
  const seen = [];
  const REPLY = {
    'desk:technical': '{"score": 0.3, "why": "Price holds above the 20 EMA with RSI at 58.", "points": ["above 20 EMA"]}',
    'desk:news': '{"score": 0.1, "why": "Headlines are mixed with a mild positive tilt from banks.", "points": []}',
    'desk:macro': '{"score": -0.1, "why": "Crude is firmer and FII sold in cash yesterday.", "points": []}',
    'desk:internals': '{"score": 0.4, "why": "Breadth is broad with 34 of 50 members higher.", "points": []}',
    'desk:debate': '{"bull": "Broad breadth and a firm trend favour a higher close today.", "bear": "Foreign selling and firmer crude can cap the rally into the close.", "stronger": "bull", "why": "Breadth is the stronger evidence."}',
    'desk:final': '{"rating": "lean_up", "score": 0.32, "confidence": 61, "why": "Three of four analysts lean up and the debate favours the bull case.", "risk": "A break below support at the morning low.", "watch": "Whether banks hold their gains after lunch."}',
    'desk:reflect': '{"lesson": "When breadth is broad but FII sell, the up lean held into the close."}',
  };
  KT.data.askModel = (key, model, system, user, opts) => {
    seen.push({ purpose: opts && opts.purpose, user, fallback: opts && opts.fallbackModel, override: opts && opts.modelOverride, at: Date.now() });
    return Promise.resolve(REPLY[opts && opts.purpose] || '{}');
  };
  asyncChecks.push(() => { KT.core.store.remove('aiUse'); return D.run(S, { extras: { news } }); });
  asyncChecks.push(() => Promise.resolve(D.latest('NIFTY')).then(row => {
    ok('a full desk run makes six requests: four analysts, a debate, a final call',
       seen.length === 6 && seen.slice(0, 4).every(x => /^desk:(technical|news|macro|internals)$/.test(x.purpose)) &&
       seen[4].purpose === 'desk:debate' && seen[5].purpose === 'desk:final',
       seen.map(x => x.purpose).join(' '));
    const starts = seen.slice(0, 4).map(x => x.at);
    ok('the four analysts go one after another, not in one burst',
       starts[3] - starts[0] >= 3 * KT.CONFIG.ai.deskGapMs - 5, (starts[3] - starts[0]) + ' ms first to last');
    ok('the run is stored with its price, horizon and situation',
       row && row.final.rating === 'lean_up' && row.price > 0 && row.horizon.endTime && row.fp && row.fp.kind === 'index');
    const vote = D.voteFor('NIFTY');
    ok('the vote the forecast reads is the final call’s, with a lifetime',
       vote && vote.score === 0.32 && vote.ttlMs >= 20 * 60000 && vote.ttlMs <= 3 * 3600000);
    ok('a vote older than its lifetime is not handed over', D.voteFor('NIFTY', Date.now() + 4 * 3600000) === null);
    const lane = KT.forecast.modelLane({ score: 0.3, why: 'x', at: Date.now() - 60 * 60000, ttlMs: 3 * 3600000 });
    ok('the model lane honours a vote’s own lifetime past the old twenty minutes', lane.hasData === true);
    ok('but never past six hours, whatever the vote claims',
       KT.forecast.modelLane({ score: 0.3, why: 'x', at: Date.now() - 7 * 3600000, ttlMs: 48 * 3600000 }).hasData === false);
    ok('a plain vote still goes dark after twenty minutes',
       KT.forecast.modelLane({ score: 0.3, why: 'x', at: Date.now() - 30 * 60000 }).hasData === false);

    /* Settlement: a run whose horizon has passed is scored against the close
       at that time, and a lesson is written about it. */
    const endBar = minute[minute.length - 20];
    const S2 = Object.assign({}, S, {
      forecast: Object.assign({}, f, { path: [{ time: minute[minute.length - 60].time, value: 1 }, { time: endBar.time, value: 1 }] }),
      quote: { price: minute[minute.length - 60].close },
    });
    seen.length = 0;
    return D.run(S2, { mode: 'quick', extras: { news } }).catch(e => ({ err: e }));
  }).then(q => {
    ok('an unreadable reply is asked once more, of the free pool itself, then refused, never invented',
       seen.length === 2 && seen.every(x => x.purpose === 'desk:quick') && !seen[0].override &&
       seen[1].override === KT.CONFIG.defaultModel && !seen[1].fallback && !!(q && q.err),
       seen.map(x => x.purpose + (x.override ? ' to ' + x.override : '')).join(', '));
    return null;
  }).then(() => {
    // The quick reply above is '{}' (no script for it), so that run failed and
    // the full run stays the latest; craft the settled run directly instead.
    const S3 = Object.assign({}, S, {
      forecast: Object.assign({}, f, { path: [{ time: minute[minute.length - 30].time, value: 1 }] }),
      quote: { price: minute[minute.length - 40].close },
    });
    REPLY['desk:quick'] = '{"analysts": {"technical": 0.2, "news": 0.1, "macro": 0, "internals": 0.3}, "rating": "lean_up", "score": 0.3, "confidence": 55, "why": "Breadth and trend lean up while news is mixed.", "risk": "Support breaks.", "watch": "Banks."}';
    seen.length = 0;
    return D.run(S3, { mode: 'quick', extras: { news } });
  }).then(row => {
    ok('a quick read carries all four analyst scores', row && row.analysts.filter(a => !a.failed).length === 4);
    ok('a quick read that answers is one request', seen.length === 1, seen.length + ' sent');
    const settled = D.settle('NIFTY', minute, 60);
    const mine = settled.filter(r => r.id === row.id)[0];
    const end = minute.filter(c => c.time <= row.horizon.endTime).pop();
    const move = (end.close - row.price) / row.price * 100;
    ok('a run past its horizon is settled against the close at that time',
       mine && Math.abs(mine.outcome.endPrice - Math.round(end.close * 100) / 100) < 0.01 &&
       Math.abs(mine.outcome.movePct - move) < 0.001,
       mine ? 'moved ' + mine.outcome.movePct + '%, ' + (mine.outcome.right === null ? 'unscored' : mine.outcome.right ? 'right' : 'wrong') : 'not settled');
    ok('and never twice', D.settle('NIFTY', minute, 60).filter(r => r.id === row.id).length === 0);
    return D.reflect(S, mine).then(lesson => {
      ok('the AI writes the lesson when the budget allows', lesson && lesson.source === 'ai' && /^When /.test(lesson.text));
      ok('the lesson is filed under the situation it was made in', lesson && lesson.fp && lesson.runId === row.id);
      return D.reflect(Object.assign({}, S, { settings: { key: '' } }), mine);
    });
  }).then(again => {
    ok('one lesson per run, whoever writes it', again && again.source === 'ai');
    const rec = D.record('NIFTY');
    ok('the desk keeps its own record', rec.settled >= 1);
  }).catch(e => ok('the scripted desk run completed', false, String(e && e.stack || e)))
    .then(() => { KT.data.askModel = realAsk; }));

  /* The first live run (29 Oct 2026): two of six calls drew 429 from a busy
     free model and the final call fell back to arithmetic. A step that fails
     for a passing reason is asked once more, with the free pool behind the
     chosen model; one that fails twice says why. */
  asyncChecks.push(() => {
    const tries = [];
    let finalTries = 0;
    KT.core.store.remove('aiUse');
    KT.data.askModel = (key, model, system, user, opts) => {
      const pp = opts && opts.purpose;
      tries.push({ purpose: pp, fallback: opts && opts.fallbackModel });
      if (pp === 'desk:technical') return Promise.reject(new Error('HTTP 429'));
      if (pp === 'desk:final' && ++finalTries === 1) return Promise.reject(new Error('HTTP 429'));
      return Promise.resolve(REPLY[pp] || '{}');
    };
    return D.run(S, { extras: { news } }).then(row => {
      const fin = tries.filter(t => t.purpose === 'desk:final');
      ok('a busy model is asked once more, the second time with the free pool behind it',
         fin.length === 2 && !fin[0].fallback && fin[1].fallback === KT.CONFIG.defaultModel,
         tries.map(t => t.purpose.replace('desk:', '') + (t.fallback ? '+pool' : '')).join(' '));
      ok('so the final call is the AI\u2019s, not the arithmetic stand-in', row.final.source !== 'rule' && row.final.rating === 'lean_up');
      const tech = row.analysts.filter(a => a.id === 'technical')[0];
      ok('a step that fails twice says why', !!tech && tech.failed === true && tech.failWhy === 'busy' &&
         /busy/.test(D.failText(tech.failWhy)));
      ok('every request is on the run\u2019s count, retries included', row.calls === 8, row.calls + ' calls');
    }).catch(e => ok('the retry run completed', false, String(e && e.stack || e)))
      .then(() => { KT.data.askModel = realAsk; });
  });
}

section('V2 — lessons');
{
  const Lz = KT.lessons;
  const fpA = Lz.fingerprint({ kind: 'index', symbol: 'NIFTY', timeframe: '1S', adx: 12, rsi: 72, vix: 18.5, newsTone: -0.4, fiiNetCr: -2100, gapPct: 0.6 });
  ok('a situation is buckets, not numbers',
     fpA.trend === 'range' && fpA.rsi === 'overbought' && fpA.vix === 'stressed' && fpA.news === 'negative' &&
     fpA.flows === 'fii-selling' && fpA.gap === 'gap-up');
  ok('and reads as words', /range-bound/.test(Lz.describe(fpA)) && /FII selling/.test(Lz.describe(fpA)));
  const fpB = Lz.fingerprint({ kind: 'stock', symbol: 'TCS', timeframe: '1D', adx: 30, price: 110, ema50: 100, rsi: 40, vix: 11, newsTone: 0.5, fiiNetCr: 1200 });
  ok('alike situations score high and unlike ones low',
     Lz.similarity(fpA, fpA) === 1 && Lz.similarity(fpA, fpB) < Lz.MIN_SIMILARITY,
     'unlike: ' + Lz.similarity(fpA, fpB).toFixed(2));
  const before = Lz.count();
  Lz.add({ runId: 'T1', symbol: 'NIFTY', fp: fpA, text: 'When the tape is range-bound and FII sell, fade the gap-up.', outcome: { movePct: -0.4, right: true }, source: 'ai' });
  Lz.add({ runId: 'T2', symbol: 'TCS', fp: fpB, text: 'When TCS trends up on positive news, the lean holds.', outcome: { movePct: 0.8, right: true }, source: 'ai' });
  Lz.add({ runId: 'T1', symbol: 'NIFTY', fp: fpA, text: 'a second write for the same run', source: 'ai' });
  ok('one lesson per run', Lz.count() === before + 2);
  const got = Lz.relevant(fpA, { k: 3 });
  ok('retrieval returns the similar situation and not the unlike one',
     got.length >= 1 && got[0].lesson.runId === 'T1' && got.every(g => g.lesson.runId !== 'T2'));
  ok('lessons reach the prompt with their outcome', /call was right, price -0\.40%/.test(Lz.forPrompt(got)));
  ok('the arithmetic fallback says what happened',
     /was wrong: price moved \+0\.50%/.test(Lz.ruleText({ score: -0.3 }, { movePct: 0.5, right: false }, fpA)));
  const dump = Lz.exportJson();
  Lz.clear();
  ok('export and import round-trip', Lz.count() === 0 && Lz.importJson(dump).added >= 2 && Lz.count() >= 2);
}

section('V2 — any NSE stock');
{
  const St = KT.stocks;
  const uni = readJSON('data/universe.json', null);
  const n = St.setUniverse(uni);
  ok('the stock list loads from the universe file', n > 2000, n + ' symbols');
  if (n > 2000) {
    const top = q => (St.search(q, 5)[0] || {}).symbol;
    ok('search finds a ticker typed exactly', top('RELIANCE') === 'RELIANCE' && top('tcs') === 'TCS');
    ok('search finds a company by name', top('infosys') === 'INFY', top('infosys'));
    ok('and the indices', top('nifty') === 'NIFTY');
    const rel = St.matcherFor('RELIANCE');
    ok('company headlines match their company',
       rel.test('RIL shares jump after Jio tariff hike') && rel.test('Reliance Industries Q2 profit beats estimates'));
    /* "Bajaj", "Adani" and "Reliance" are each a name six to nine listed
       companies answer to. Matched alone they would file Bajaj Auto's sales
       under Bajaj Finance. */
    ok('a group name does not match the wrong company',
       !rel.test('Reliance Power wins a 500 MW order') &&
       !St.matcherFor('BAJFINANCE').test('Bajaj Auto sales rise 12% in October') &&
       !St.matcherFor('ADANIENT').test('Adani Ports cargo volumes rise') &&
       St.matcherFor('BAJFINANCE').test('Bajaj Finance AUM grows 28%'));
    ok('the ticker in capitals still counts', rel.test('RELIANCE hits a record high'));
    const cons = readJSON('data/constituents.json', null);
    if (cons && St.setPopular(cons) > 40) {
      ok('index members rank above namesakes in search', top('reli') === 'RELIANCE', top('reli'));
    }
    ok('a short ticker only matches in capitals',
       St.matcherFor('TCS').test('TCS bags a $1 billion deal') && !St.matcherFor('TCS').test('the tcs of it'));
    const pool = [{ headline: 'RBI keeps the repo rate unchanged' }, { headline: 'Infosys wins a large deal' },
                  { headline: 'TCS bags a large deal in Europe' }];
    ok('a stock forecast reads its own news and the macro news, not its rivals’',
       St.forecastNews('TCS', pool).length === 2 && St.newsFor('TCS', pool).length === 1);
    ok('registering a stock gives it a Yahoo symbol and marks it',
       St.register('RELIANCE') === 'RELIANCE' && KT.CONFIG.symbols.RELIANCE.stock === true &&
       KT.CONFIG.symbols.RELIANCE.yahoo === 'RELIANCE.NS');
    ok('an unknown symbol is refused', St.register('NOTASTOCK123') === null);
    ok('the beta scale defaults to one until the screener answers', St.gapScale('RELIANCE') === 1);

    /* The news lane's relevance follows the focus and returns when it is cleared. */
    const F2 = KT.forecast;
    F2.setFocus(St.focusFor('TCS'));
    const company = F2.relevanceOf({ headline: 'TCS bags a large deal in Europe' });
    const macro = F2.relevanceOf({ headline: 'RBI keeps the repo rate unchanged' });
    const rival = F2.relevanceOf({ headline: 'Infosys wins a large deal' });
    ok('in focus, the company’s own story counts most',
       company.w === 1 && macro.w === 0.6 && rival.w < 0.3, [company.w, macro.w, rival.w].join(' / '));
    F2.setFocus(null);
    ok('and clearing the focus restores the index reading', F2.relevanceOf({ headline: 'RBI keeps the repo rate unchanged' }).w === 1);

    // A stock gaps by its beta, not by NIFTY's amount.
    const base = { candles: minuteCandles.length ? minuteCandles.slice() : candles.slice(), timeframe: '1S', news, global: globalCues };
    const g1 = KT.forecast.build(Object.assign({}, base)).open;
    const g2 = KT.forecast.build(Object.assign({}, base, { candles: base.candles.slice(), gapScale: 1.5 })).open;
    ok('the opening gap scales with the stock’s beta',
       !g1.hasData || Math.abs(g2.gapPct - Math.round(g1.gapPct * 1.5 * 1000) / 1000) < 0.002,
       g1.hasData ? g1.gapPct + '% → ' + g2.gapPct + '%' : 'no cues in the snapshot');
  }
}

section('V2 — the price model (Kronos)');
{
  const F3 = KT.forecast, w3 = KT.CONFIG.forecast.weights;
  const par3 = 1 / Object.keys(w3).length;
  ok('the price model starts below par and below the checkable lanes',
     w3.kronos > 0 && w3.kronos < par3 &&
     ['news', 'momentum', 'global', 'structure', 'seasonal', 'options', 'levels'].every(k => w3[k] > w3.kronos),
     `kronos ${w3.kronos} against par ${par3.toFixed(3)}`);
  const mc = minuteCandles.length ? minuteCandles : candles;
  const last = mc[mc.length - 1];
  const mk = (over) => Object.assign({ ok: true, stub: false, series: { 'NIFTY:5m': {
    base_time: last.time, base_close: last.close,
    steps: [1, 2, 3].map(i => ({ t: last.time + i * 300, p10: last.close * 0.995, p50: last.close * 1.01, p90: last.close * 1.025 })),
  } } }, over || {});
  ok('a run made by the stub is refused', F3.setKronos(mk({ stub: true })) === false);
  ok('a failed run is refused', F3.setKronos(mk({ ok: false })) === false);
  F3.setKronos(mk());
  const lane = F3.kronosLane(mc.slice(), '1S', last.close, 'NIFTY');
  ok('a fresh run votes its median against its own spread',
     lane.hasData && Math.abs(lane.score - (0.01 / 0.015)) < 1e-6, lane.note);
  ok('a run for another symbol stays dark', F3.kronosLane(mc.slice(), '1S', last.close, 'SENSEX').hasData === false);
  const expired = mk(); expired.series['NIFTY:5m'].steps = [{ t: last.time - 60, p10: 1, p50: 2, p90: 3 }];
  F3.setKronos(expired);
  ok('an expired run stays dark', F3.kronosLane(mc.slice(), '1S', last.close, 'NIFTY').hasData === false);
  const other = mk(); other.series['NIFTY:5m'].base_close = last.close * 1.03;
  F3.setKronos(other);
  ok('a run that read a different series stays dark', F3.kronosLane(mc.slice(), '1S', last.close, 'NIFTY').hasData === false);
  F3.setKronos(mk());
  const withK = F3.build({ candles: mc.slice(), timeframe: '1S', news, symbol: 'NIFTY' });
  ok('in the blend it is one more lane, renormalised like the rest',
     withK.lanes.some(l => l.id === 'kronos' && l.hasData && l.contribution > 0));
  F3.setKronos(null);
  ok('and with no run it drops out', !F3.build({ candles: mc.slice(), timeframe: '1S', news, symbol: 'NIFTY' })
       .lanes.find(l => l.id === 'kronos').hasData);
  const kj = readJSON('data/kronos.json', null);
  ok('the shipped file parses and is not a stub', kj && kj.stub === false);
  const py = fs.readFileSync(path.join(ROOT, 'scripts/kronos_forecast.py'), 'utf8');
  ok('the script never raises and keeps the last good run',
     /carry_forward\("kronos\.json"/.test(py) && /except Exception/.test(py));
  const wf = ['.github/workflows/kronos.yml', 'docs/workflows/kronos.yml'].find(f => fs.existsSync(path.join(ROOT, f)));
  ok('a workflow runs it, in the live branch’s concurrency group',
     !!wf && /kronos_forecast\.py/.test(fs.readFileSync(path.join(ROOT, wf), 'utf8')) &&
     /group: live-data/.test(fs.readFileSync(path.join(ROOT, wf), 'utf8')), wf);
}

section('V2 — the AI budget');
{
  const Dt = KT.data;
  asyncChecks.push(() => {
    KT.core.store.remove('aiUse');
    const b0 = Dt.aiBudget();
    ok('a fresh day starts at the free limit', b0.used === 0 && b0.left === KT.CONFIG.ai.freeDailyLimit);
    SANDBOX.fetch = () => Promise.reject(new Error('offline'));
    return Dt.askModel('k', 'm', 's', 'u', { purpose: 'desk:test' }).catch(() => null);
  });
  asyncChecks.push(() => Promise.resolve().then(() => {
    const b1 = Dt.aiBudget();
    ok('a request is counted when it is sent, success or not', b1.used === 1 && b1.by.desk === 1);
    SANDBOX.fetch = () => Promise.resolve({ ok: false, status: 429,
      text: () => Promise.resolve('{"error":{"message":"Rate limit exceeded: free-models-per-day"}}') });
    return Dt.askModel('k', 'm', 's', 'u', { purpose: 'desk:test' }).catch(() => null);
  }).then(() => {
    const b2 = Dt.aiBudget();
    ok('a daily-limit 429 marks the day spent', b2.blocked === true && b2.left === 0);
    return Dt.askModel('k', 'm', 's', 'u', {}).then(() => false, e => /daily AI limit/.test(e.message));
  }).then(refused => {
    ok('and no further request is sent that day', refused === true);
    SANDBOX.fetch = () => Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve('Rate limit exceeded: 20 per minute') });
    KT.core.store.remove('aiUse');
    return Dt.askModel('k', 'm', 's', 'u', {}).catch(() => null);
  }).then(() => {
    ok('a per-minute 429 does not', Dt.aiBudget().blocked === false);
    KT.core.store.remove('aiUse');
    SANDBOX.fetch = () => Promise.reject(new Error('no network in selftest'));
  }));
  asyncChecks.push(() => {
    let sent = null;
    KT.core.store.remove('aiUse');
    SANDBOX.fetch = (url, init) => {
      sent = JSON.parse(init.body);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ choices: [{ message: {
        content: 'A reply long enough to count as a real answer from the model, not a label.' } }] }) });
    };
    return Dt.askModel('k', 'chosen/model:free', 's', 'u', { fallbackModel: 'openrouter/free' }).then(() => {
      ok('a retry names the chosen model first and the free pool second, in one request',
         !!sent && sent.model === undefined && Array.isArray(sent.models) &&
         sent.models.join(' ') === 'chosen/model:free openrouter/free');
      return Dt.askModel('k', 'chosen/model:free', 's', 'u', {});
    }).then(() => {
      ok('a first try names only the chosen model', !!sent && sent.model === 'chosen/model:free' && sent.models === undefined);
      return Dt.askModel('k', 'chosen/model:free', 's', 'u', { modelOverride: 'openrouter/free' });
    }).then(() => {
      ok('a second ask after an empty reply goes to the pool itself', !!sent && sent.model === 'openrouter/free' && sent.models === undefined);
    }).catch(e => ok('the fallback request was sent', false, String(e)))
      .then(() => { KT.core.store.remove('aiUse'); SANDBOX.fetch = () => Promise.reject(new Error('no network in selftest')); });
  });

  const appSrc4 = fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8');
  const vote4 = appSrc4.slice(appSrc4.indexOf('function maybeAskModelVote()'), appSrc4.indexOf('function parseVote('));
  const narr4 = appSrc4.slice(appSrc4.indexOf('function maybeEnrichNarrative()'), appSrc4.indexOf('function openSymbol('));
  ok('the single-call vote and narrative stop at the reserve, and give way to the AI desk',
     /aiReserved\(\)/.test(vote4) && /aiReserved\(\)/.test(narr4) && /C\.ui && C\.ui\.desk/.test(appSrc4));
}

section('PAGE — one page, its cards and the code');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const classic = fs.readFileSync(path.join(ROOT, 'classic.html'), 'utf8');
  const appSrc5 = fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8');
  const chartSrc5 = fs.readFileSync(path.join(ROOT, 'assets/js/chart.js'), 'utf8');
  const cfgSrc5 = fs.readFileSync(path.join(ROOT, 'assets/js/config.js'), 'utf8');
  const pnSrc = fs.readFileSync(path.join(ROOT, 'assets/js/panels.js'), 'utf8');
  function ids(h) { const s = new Set(); let m; const rx = /\bid="([A-Za-z0-9_-]+)"/g; while ((m = rx.exec(h))) s.add(m[1]); return s; }
  function used(src, rx) { const s = new Set(); let m; while ((m = rx.exec(src))) s.add(m[1] || m[2]); return s; }
  const appUsed = new Set([...used(appSrc5, /(?:core\.)?(?:text|el)\('([A-Za-z0-9_-]+)'|getElementById\('([A-Za-z0-9_-]+)'\)/g),
                           ...used(chartSrc5, /(?:core\.)?(?:text|el)\('([A-Za-z0-9_-]+)'|getElementById\('([A-Za-z0-9_-]+)'\)/g)]);
  const pnUsed = used(pnSrc, /(?:\$|setText)\('([A-Za-z0-9_-]+)'/g);
  const inPage = ids(html);
  const miss = [...appUsed, ...pnUsed].filter(id => !inPage.has(id)).sort();
  ok('the page declares every id app.js, chart.js and panels.js write to', miss.length === 0,
     miss.length ? 'missing: ' + miss.join(', ') : (appUsed.size + pnUsed.size) + ' ids');
  const dup = [...inPage].filter(id => (html.match(new RegExp('id="' + id + '"', 'g')) || []).length > 1);
  ok('no id is declared twice', dup.length === 0, dup.join(', '));

  const order = ['assets/js/config.js', 'assets/js/core.js', 'assets/js/data.js', 'assets/js/forecast.js',
                 'assets/js/postmortem.js', 'assets/js/ledger.js', 'assets/js/learn.js', 'assets/js/chart.js',
                 'assets/js/streetcalls.js', 'assets/js/stocks.js', 'assets/js/lessons.js', 'assets/js/desk.js',
                 'assets/js/app.js', 'assets/js/panels.js'].map(p => html.indexOf('src="' + p + '"'));
  ok('the page loads its modules in dependency order', order.every((p, i) => p > 0 && (i === 0 || p > order[i - 1])), order.join(' < '));
  ok('classic.html only forwards to the one page',
     /location\.replace\('index\.html'/.test(classic) && !/assets\/js\/app\.js/.test(classic));
  ok('the retired V2 files are gone and nothing loads them',
     !['assets/js/v2.js', 'assets/js/v2-config.js', 'assets/v2.css'].some(f => fs.existsSync(path.join(ROOT, f))) &&
     !/v2\.js|v2-config\.js|v2\.css/.test(html));
  ok('the other pages link back to the terminal',
     ['profile.html', 'data.html', 'ipo.html'].every(f => /href="index\.html"/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))));
  ok('the chart frames NOW at the centre', /ui\.centreNow/.test(chartSrc5) && /centreNow:\s*true/.test(cfgSrc5));
  ok('panels.js escapes what it interpolates', /function esc\(/.test(pnSrc) &&
     !/innerHTML\s*=\s*[^;]*\+\s*(?:l\.text|r\.text|p\.lesson|it\.name|n\.headline)\b/.test(pnSrc));
  ok('the chart reading rounds its window to a whole bar',
     /Math\.round\(f\.forecastBars/.test(appSrc5),
     'the session view’s 1.5 ratio made it 562.5 bars and c[1313.5] threw every evening');
  ok('a failed load reaches the call card', /loadFailed\(S\.symbol, e\)/.test(appSrc5) && /onLoadError/.test(pnSrc));
  ok('the record card redraws when the replay lands, not a minute later',
     /trailHooks\[th\]\(S\)/.test(appSrc5) && /onTrail/.test(pnSrc));
  ok('a stale quote or stale candles cannot be forecast under a new symbol',
     /S\.quote = null;/.test(appSrc5) && /S\.candles = \[\];/.test(appSrc5) && /S\.symbol !== symAt/.test(appSrc5));
  ok('a finished session with no verdict says which: waiting for its prices, or never scored',
     /not scored/.test(pnSrc) && /waiting for its prices/.test(pnSrc) && /r\.expired/.test(pnSrc));
  ok('the published record of calls is read at boot and on a slow timer',
     /function loadCalls\(/.test(appSrc5) && /loadCalls\(true\)/.test(appSrc5) && /calls:\s*'data\/calls\.json'/.test(cfgSrc5) &&
     /'data\/calls\.json'/.test(cfgSrc5.slice(cfgSrc5.indexOf('liveFiles'))));
}

/* The call, its judgement, the record and the learning have their own file
   (scripts/selftest_calls.js): it replays the workflow script three times on
   a scratch copy of the data. Run from here so one command checks it all. */
section('CALLS — scripts/selftest_calls.js');
asyncChecks.push(() => {
  let out = '';
  try {
    out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'selftest_calls.js')],
                                                 { encoding: 'utf8', timeout: 170000 });
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  const m = /(\d+) passed, (\d+) failed/.exec(out);
  if (!m) { ok('scripts/selftest_calls.js ran', false, out.slice(-400)); return; }
  out.split('\n').filter(l => /^  FAIL/.test(l)).forEach(l => console.log(l));
  pass += +m[1]; fail += +m[2];
  console.log('  ' + m[1] + ' passed, ' + m[2] + ' failed in scripts/selftest_calls.js');
});

section('V2 — the checks that wait on a promise');
asyncChecks.reduce((p, fn) => p.then(fn).catch(e => ok('an async check threw', false, String(e && e.stack || e))), Promise.resolve())
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
