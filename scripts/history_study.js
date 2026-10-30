/* ============================================================================
   Twenty years of patterns, counted by the page's own detectors.

   The pattern table on the page measures every candlestick and chart pattern
   on whatever history is loaded: a month of five-minute bars, a year of daily
   ones. "Bullish engulfing, 9 times, went its way 6" is honest and also nine
   samples. This runs the same detectors (patterns.js, structures.js, loaded
   through ktvm.js, not ported) over the whole daily record from
   fetch_history.py, so each pattern also carries its twenty-year count and
   how it resolved, one session and five sessions on.

   It also writes the base rates a reader needs to judge any of those numbers:
   how often the index simply rose the next day, overall and in each kind of
   tape (trending or range-bound, calm or stressed VIX).

   Writes data/study.json. Never throws: a failure is written into the file.
   Run: node scripts/history_study.js
   ========================================================================== */
'use strict';
const { load, readJSON, writeJSON } = require('./ktvm');

const TARGETS = ['NIFTY', 'SENSEX', 'BANKNIFTY'];

function wilson(k, n) {
  if (!n) return null;
  const p = k / n, z = 1.96, den = 1 + z * z / n;
  const centre = p + z * z / (2 * n);
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.round((centre - half) / den * 1000) / 10, Math.round((centre + half) / den * 1000) / 10];
}

// The exchange's 09:15 IST on each date, so the page's IST clock reads it right.
function toCandles(s) {
  const out = [];
  for (let i = 0; i < s.d.length; i++) {
    const o = s.o && s.o[i], h = s.h && s.h[i], l = s.l && s.l[i], c = s.c[i];
    if (!(c > 0) || !(o > 0) || !(h > 0) || !(l > 0)) continue;
    const [y, m, d] = s.d[i].split('-').map(Number);
    out.push({ time: Math.floor(Date.UTC(y, m - 1, d, 3, 45) / 1000), open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c });
  }
  return out;
}

function patternTable(KT, candles) {
  const found = KT.patterns.detect(candles);
  const h1 = KT.patterns.hitRates(candles, found, 1);
  const h5 = KT.patterns.hitRates(candles, found, 5);
  return Object.keys(h5).map(k => {
    const a = h1[k], b = h5[k];
    const wins5 = b.hitRate != null ? Math.round(b.hitRate / 100 * b.n) : null;
    return {
      key: k, name: b.name, dir: b.dir, n: b.n,
      hit1: a ? a.hitRate : null, up1: a ? a.upRate : null, avg1: a ? a.avgMove : null,
      hit5: b.hitRate, up5: b.upRate, avg5: b.avgMove, ci5: wins5 != null ? wilson(wins5, b.n) : null,
      last: b.hits.length ? new Date(b.hits[b.hits.length - 1].time * 1000).toISOString().slice(0, 10) : null,
    };
  }).filter(r => r.n >= 5).sort((x, y) => y.n - x.n);
}

/* Chart structures (triangles, flags, double tops) are found on swing
   pivots whose width scales with the series: a fifth of a year of daily bars
   per pivot over twenty years would find two triangles in the whole record.
   So the record is read in consecutive windows of about two years, each the
   size the page itself works with, and the outcomes are added up. A shape
   that straddles two windows is missed rather than counted twice. */
function structureTable(KT, candles) {
  const WIN = 480, by = {};
  for (let start = 0; start + 200 <= candles.length; start += WIN) {
    const out = KT.structures.outcomes(candles.slice(start, start + WIN), { maxWait: 40 });
    Object.keys(out).forEach(k => {
      const g = out[k];
      const t = by[k] = by[k] || { key: k, name: g.name, dir: g.dir, seen: 0, triggered: 0, hits: 0, stops: 0, resolved: 0 };
      t.seen += g.seen || 0; t.triggered += g.triggered || 0; t.hits += g.hits || 0;
      t.stops += g.stops || 0; t.resolved += g.resolved || 0;
    });
  }
  return Object.keys(by).map(k => {
    const t = by[k];
    t.hitRate = t.resolved ? Math.round(t.hits / t.resolved * 1000) / 10 : null;
    t.ci = t.resolved ? wilson(t.hits, t.resolved) : null;
    return t;
  }).sort((x, y) => y.resolved - x.resolved);
}

/* How often the next session closed higher, overall and by the kind of tape
   it followed. Every hit rate on the page is read against this, not against
   50%: an index that rose on 54% of days makes a 55% signal nearly nothing. */
function baseRates(KT, candles, vix) {
  const out = { all: { n: 0, up: 0 }, trend: {}, vix: {} };
  const closes = candles.map(c => c.close);
  const vixAt = {};
  if (vix) vix.d.forEach((d, i) => { vixAt[d] = vix.c[i]; });
  for (let i = 60; i < candles.length - 1; i++) {
    const up = candles[i + 1].close > candles[i].close;
    out.all.n++; if (up) out.all.up++;
    const win = candles.slice(i - 59, i + 1);
    const snap = KT.ind.snapshot(win);
    const trend = snap && snap.adx != null && snap.adx < 18 ? 'range'
      : snap && snap.ema50 != null ? (closes[i] >= snap.ema50 ? 'uptrend' : 'downtrend') : null;
    if (trend) { const t = out.trend[trend] = out.trend[trend] || { n: 0, up: 0 }; t.n++; if (up) t.up++; }
    const day = new Date(candles[i].time * 1000).toISOString().slice(0, 10);
    const v = vixAt[day];
    if (v) {
      const b = v < 12 ? 'calm' : v < 17 ? 'normal' : 'stressed';
      const t = out.vix[b] = out.vix[b] || { n: 0, up: 0 }; t.n++; if (up) t.up++;
    }
  }
  const fin = g => ({ n: g.n, upRate: g.n ? Math.round(g.up / g.n * 1000) / 10 : null, ci: wilson(g.up, g.n) });
  return {
    all: fin(out.all),
    trend: Object.fromEntries(Object.keys(out.trend).map(k => [k, fin(out.trend[k])])),
    vix: Object.fromEntries(Object.keys(out.vix).map(k => [k, fin(out.vix[k])])),
  };
}

function main() {
  const t0 = Date.now();
  const payload = { generated_at: new Date().toISOString(), ok: false, source: 'scripts/history_study.js',
                    method: 'the page’s own detectors (patterns.js, structures.js) over the whole daily record',
                    symbols: {}, errors: [] };
  try {
    const hist = readJSON('data/history_daily.json', null);
    if (!hist || !hist.series) throw new Error('data/history_daily.json missing: run scripts/fetch_history.py');
    const KT = load(['config', 'core', 'indicators', 'levels', 'candles', 'patterns', 'structures'], { quiet: true });
    for (const t of TARGETS) {
      const s = hist.series[t];
      if (!s || !s.o || !s.h) { payload.errors.push({ symbol: t, error: 'no OHLC history' }); continue; }
      try {
        const c = toCandles(s);
        const t1 = Date.now();
        payload.symbols[t] = {
          span: { from: s.d[0], to: s.d[s.d.length - 1], bars: c.length },
          patterns: patternTable(KT, c),
          structures: structureTable(KT, c),
          base: baseRates(KT, c, hist.series.INDIAVIX),
          seconds: Math.round((Date.now() - t1) / 100) / 10,
        };
        const r = payload.symbols[t];
        console.log(`  [ok ] ${t.padEnd(9)} ${c.length} bars, ${r.patterns.length} patterns, ${r.structures.length} structures, ` +
                    `up next day ${r.base.all.upRate}% of ${r.base.all.n}  ${r.seconds}s`);
      } catch (e) {
        payload.errors.push({ symbol: t, error: String(e && e.message || e).slice(0, 300) });
        console.log(`  [FAIL] ${t} ${e && e.stack || e}`);
      }
    }
    payload.ok = Object.keys(payload.symbols).length > 0;
  } catch (e) {
    payload.error = String(e && e.message || e).slice(0, 300);
    console.log('history study failed:', e && e.stack || e);
  }
  payload.seconds = Math.round((Date.now() - t0) / 100) / 10;
  // The last good study is kept when this run produced nothing.
  if (!payload.ok) {
    const prev = readJSON('data/study.json', null);
    if (prev && prev.ok) { prev.carried_over = true; prev.carry_reason = payload.error || 'this run produced nothing usable'; writeJSON('data/study.json', prev); return; }
  }
  writeJSON('data/study.json', payload);
}

main();
