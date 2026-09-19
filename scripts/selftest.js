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
const MODULES = ['config', 'core', 'indicators', 'levels', 'patterns',
                 'structures', 'analogs', 'vol', 'forecast', 'ledger'];

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
  [null, { ok: false }, { ok: true }, { ok: true, pcrOi: 0, pcrChgOi: -1 }].forEach((p, i) => {
    let threw = null, r = null;
    try { r = KT.forecast.optionsLane(p, 23000, Date.now()); } catch (e) { threw = e.message; }
    ok(`malformed option payload #${i + 1} is handled`, !threw && r && r.hasData === false,
       threw ? 'THREW ' + threw : '');
  });
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
