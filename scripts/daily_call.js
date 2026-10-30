/* ============================================================================
   The daily call, frozen and judged by the workflow.

   The page freezes a call for the next session the first time it is opened
   for one (ledger.js lock()). That record lives in one browser: a phone and a
   laptop keep different ones, a cleared cache loses it, and an evening nobody
   opened the page is a session with no call at all. "Where does tomorrow go,
   and was today's call right" cannot depend on any of that.

   So the workflow does it as well, with the page's own modules (loaded
   through ktvm.js, not ported, so the call here and the call on the page are
   the same arithmetic):

     evening   after the close (16:40 IST): settles today's call against
               today's minute bars, writes the judgement (postmortem.js) and
               the lesson it files, then freezes the call for the next session
     morning   before the open (08:25 IST): freezes the pre-open call, which
               has the overnight US session and Asia's morning in it

   Every browser reads the record (data/calls.json, ledger.setShared) and
   shows its call instead of freezing its own. A browser still freezes for a
   stock, or for a session the record does not have.

   The record also carries what it has learned (learn.adoptShared): the
   opening-gap gain and the lane weights, fitted from the judged sessions
   under the same guardrails as the page's own learner (learn.js), and used
   by the next call this script freezes as well as by every browser.

   Never throws. A failed run leaves the previous record in place.
   Run:  node scripts/daily_call.js
         node scripts/daily_call.js --now 2026-10-30T16:40:00+05:30   (a test clock)
   ========================================================================== */
'use strict';
const { load, readJSON, writeJSON } = require('./ktvm');

const SYMBOLS = ['NIFTY', 'SENSEX'];
const MODULES = ['config', 'core', 'indicators', 'levels', 'candles', 'patterns', 'structures', 'data',
                 'analogs', 'vol', 'forecast', 'postmortem', 'ledger', 'learn', 'trail', 'evidence',
                 'engine', 'lessons'];
const OUT = 'data/calls.json';
const VERSION = 1;
const KEEP_SESSIONS = 80;       // per symbol, about four months
const BOTH_STAGES_SESSIONS = 20; // newer than this, both of a session's calls are kept
const FULL_PATH_SESSIONS = 3;   // newer than this, a row keeps every projected minute
const ACTIVE_DAYS = 12;         // rows this recent are handed to the ledger to settle
const PRE_OPEN_FROM = 8 * 60;   // 08:00 IST: the US session is shut, Asia is trading
const OPEN_MIN = 9 * 60 + 15, CLOSE_MIN = 15 * 60 + 30;
const MAX_LESSONS = 160;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function round(n, d) { const p = Math.pow(10, d || 0); return Math.round(n * p) / p; }

/* ------------------------------------------------------------- the tape

   The minute bars the page itself falls back to, which the workflow
   refreshes just before this runs (scripts/fetch_market.py). */
function candlesOf(sym) {
  const j = readJSON('data/candles_' + sym + '_1H.json', null);
  if (!j || !Array.isArray(j.candles)) return [];
  return j.candles
    .filter(r => r && r[4] > 0 && r[1] > 0)
    .map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4] }));
}

/* Whether the tape reaches the last session that should be on it by now.
   A tape that stops at 14:30, or yesterday, would freeze tomorrow's call
   from a mid-afternoon price and settle today's against a guess. Returns
   null when it is complete, or what is missing. */
function tapeGap(KT, candles, nowSec) {
  const fmt = KT.core.fmt, closed = d => KT.forecast.isClosed(d);
  const keyOf = d => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const minsOf = d => d.getHours() * 60 + d.getMinutes();
  if (!candles.length) return 'no minute bars on file';

  const now = fmt.ist(nowSec), nowKey = keyOf(now), nowMin = minsOf(now);
  // The latest session that has opened by now.
  let t = nowSec, d = now, guard = 0;
  if (closed(d) || nowMin < OPEN_MIN) {
    do { t -= 86400; d = fmt.ist(t); } while (closed(d) && ++guard < 12);
  }
  const want = keyOf(d), wantShut = want < nowKey || nowMin >= CLOSE_MIN;

  const last = fmt.ist(candles[candles.length - 1].time);
  const lastKey = keyOf(last), lastMin = minsOf(last);
  const label = x => String(x).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  if (lastKey < want) return 'the bars end on ' + label(lastKey) + ', and ' + label(want) + ' has traded since';
  if (lastKey === want && wantShut && lastMin < CLOSE_MIN - 5) {
    return 'the bars for ' + label(want) + ' stop at ' + String(Math.floor(lastMin / 60)).padStart(2, '0') + ':' +
           String(lastMin % 60).padStart(2, '0') + ', before the close';
  }
  return null;
}

/* ---------------------------------------------------------- the record

   Read from the live branch (the workflow seeds data/ from it) and, with
   --also, from main's copy, which snapshot.yml refreshes four times a day.
   The live branch is force-pushed by three workflows; if one of them ever
   pushes over this one, the next run still finds every row in one copy or
   the other. Rows merge by id, the copy that knows more winning. */
function validRecord(r) { return !!(r && r.v === VERSION && r.symbols && typeof r.symbols === 'object'); }
function richness(r) { return (r && r.outcome ? 2 : 0) + (r && r.postmortem ? 1 : 0); }

function loadRecord(alsoPath) {
  const prev = readJSON(OUT, null);
  const rec = validRecord(prev) ? prev : { v: VERSION, symbols: {}, learned: null, lessons: [] };
  let also = null;
  if (alsoPath) { try { also = JSON.parse(require('fs').readFileSync(alsoPath, 'utf8')); } catch (e) { also = null; } }
  if (!validRecord(also)) return rec;
  Object.keys(also.symbols).forEach(sym => {
    const mine = (rec.symbols[sym] = rec.symbols[sym] || { rows: [] });
    const byId = {};
    (mine.rows || []).forEach(r => { byId[r.id] = r; });
    (also.symbols[sym].rows || []).forEach(r => {
      if (r && r.id && (!byId[r.id] || richness(r) > richness(byId[r.id]))) byId[r.id] = r;
    });
    mine.rows = Object.keys(byId).map(k => byId[k]);
  });
  const have = {};
  (rec.lessons = Array.isArray(rec.lessons) ? rec.lessons : []).forEach(l => { if (l.runId) have[l.runId] = true; });
  (Array.isArray(also.lessons) ? also.lessons : []).forEach(l => { if (l && l.runId && !have[l.runId]) { rec.lessons.push(l); have[l.runId] = true; } });
  if (also.learned && (!rec.learned || (also.learned.updatedAt || 0) > (rec.learned.updatedAt || 0))) rec.learned = also.learned;
  return rec;
}

function rowsOf(rec, sym) {
  const s = rec.symbols[sym];
  return s && Array.isArray(s.rows) ? s.rows.map(unpackPath) : [];
}

function dayKeyMinus(KT, nowSec, days) {
  return KT.postmortem.dateKey(nowSec - days * 86400);
}

/* The rows a browser needs in full are the ones still in play. A judged
   session keeps its numbers and its judgement; the cue prices, the lane
   notes and every projected minute were read when it was judged and are not
   needed again. */
function compact(r) {
  const c = Object.assign({}, r);
  delete c.path; delete c.pp; delete c.lanes; delete c.openParts; delete c.pmTriedAt; delete c.topHeadline;
  if (c.ctx) c.ctx = { at: c.ctx.at || null, fp: c.ctx.fp || null };
  if (c.postmortem) {
    const p = Object.assign({}, c.postmortem);
    p.reasons = (p.reasons || []).slice(0, 4).map(x => ({ kind: x.kind, w: x.w, text: String(x.text || '').slice(0, 220) }));
    if (p.lanes) {
      const ids = l => ({ id: l.id, label: l.label });
      p.lanes = { right: (p.lanes.right || []).map(ids), wrong: (p.lanes.wrong || []).map(ids) };
    }
    c.postmortem = p;
  }
  c.compact = true;
  return c;
}

/* A minute path is a start, a step and the values: a quarter of the size of
   375 {time, value} pairs, which is most of the file. ledger.setShared
   unpacks it the same way. */
function packPath(r) {
  const p = r.path;
  if (!Array.isArray(p) || p.length < 3) return r;
  const dt = p[1].time - p[0].time;
  for (let i = 2; i < p.length; i++) if (p[i].time - p[i - 1].time !== dt) return r;
  const c = Object.assign({}, r);
  c.pp = { t0: p[0].time, dt: dt, v: p.map(x => round(x.value, 2)) };
  delete c.path;
  return c;
}
function unpackPath(r) {
  if (!r || r.path || !r.pp || !Array.isArray(r.pp.v)) return r;
  const c = Object.assign({}, r);
  c.path = r.pp.v.map((v, i) => ({ time: r.pp.t0 + i * r.pp.dt, value: v }));
  delete c.pp;
  return c;
}

/* One row a session, the one it is judged on: the pre-open call where there
   is one, the day-before call otherwise. The same rule as the page
   (panels.sessionRows). */
function judgedRows(rows) {
  const by = {};
  rows.forEach(r => {
    const cur = by[r.session];
    const rank = x => (x.timeframe === '1S' ? 2 : 0) + (x.stage === 'open' ? 1 : 0);
    if (!cur || rank(r) > rank(cur)) by[r.session] = r;
  });
  return Object.keys(by).sort().reverse().map(k => by[k]);
}

function wilson(k, n) {
  if (!n) return null;
  const p = k / n, z = 1.96, den = 1 + z * z / n;
  const centre = p + z * z / (2 * n);
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [round((centre - half) / den * 100, 1), round((centre + half) / den * 100, 1)];
}

/* What the record says, per symbol: how often the call was right against
   the bar it has to clear (always up), whether its odds meant what they
   said, how often the close landed inside its own ranges, and how far off
   the open was. */
function statsOf(KT, rows) {
  const judged = judgedRows(rows).filter(r => r.outcome && r.outcome.closeActual > 0 && r.anchorPrice > 0);
  const out = { sessions: judged.length, direction: { n: 0, right: 0 }, alwaysUp: { n: 0, up: 0 },
                calibration: [], bands: { inside68: { n: 0, k: 0 }, inside95: { n: 0, k: 0 } },
                open: { n: 0, biasPct: null, maePct: null }, lanes: [] };
  const buckets = [[0, 45, 'down'], [45, 55, 'no lean'], [55, 65, 'up'], [65, 101, 'up, strongly']]
    .map(b => ({ from: b[0], to: Math.min(b[1], 100), label: b[2], n: 0, up: 0 }));
  let openSum = 0, openAbs = 0;
  judged.forEach(r => {
    const move = (r.outcome.closeActual - r.anchorPrice) / r.anchorPrice * 100;
    const dir = KT.ledger.callDirOf(r);
    if (Math.abs(move) >= 0.02) {
      out.alwaysUp.n++; if (move > 0) out.alwaysUp.up++;
      if (dir !== 0) { out.direction.n++; if (move * dir > 0) out.direction.right++; }
    }
    const p = r.end && typeof r.end.pUpClose === 'number' ? r.end.pUpClose : null;
    if (p != null) {
      const b = buckets.find(x => p >= x.from && p < x.to) || buckets[buckets.length - 1];
      b.n++; if (move > 0) b.up++;
    }
    const pm = r.postmortem;
    if (pm && pm.inside68 != null) { out.bands.inside68.n++; if (pm.inside68) out.bands.inside68.k++; }
    if (pm && pm.inside95 != null) { out.bands.inside95.n++; if (pm.inside95) out.bands.inside95.k++; }
    // The opening print itself, as the judgement recorded it (learn.openGainFrom).
    const opened = pm && pm.did && pm.did.open > 0 ? pm.did.open : r.outcome.openActual;
    if (opened > 0 && r.openPrice > 0) {
      const e = (opened - r.openPrice) / r.anchorPrice * 100;
      out.open.n++; openSum += e; openAbs += Math.abs(e);
    }
  });
  const d = out.direction;
  d.rate = d.n ? round(d.right / d.n * 100, 1) : null; d.ci = wilson(d.right, d.n);
  out.alwaysUp.rate = out.alwaysUp.n ? round(out.alwaysUp.up / out.alwaysUp.n * 100, 1) : null;
  out.calibration = buckets.map(b => ({ from: b.from, to: b.to, label: b.label, n: b.n,
                                        upRate: b.n ? round(b.up / b.n * 100, 1) : null }));
  if (out.open.n) { out.open.biasPct = round(openSum / out.open.n, 3); out.open.maePct = round(openAbs / out.open.n, 3); }
  out.lanes = KT.postmortem.laneRecord(judged).map(l => ({ id: l.id, label: l.label, right: l.right, n: l.n, rate: l.rate, ci: l.ci }));
  return out;
}

/* The lane weights, moved by the rules learn.js applies in a browser: only a
   lane with enough judged sessions, only when its interval clears a coin, at
   most MAX_STEP of its weight a step, never below FLOOR. One step for each
   new judged session at most, so two runs a day on the same record do not
   push the same evidence twice. */
function fitWeights(KT, prev, lanes, newest) {
  const C = KT.CONFIG, L = KT.learn;
  const base = prev && prev.weights ? Object.assign({}, prev.weights) : null;
  const next = Object.assign({}, C.forecast.weights, base || {});
  const moved = [], held = [];
  if (prev && prev.fittedThrough && newest && newest <= prev.fittedThrough) {
    return { weights: base, moved: moved, held: [{ why: 'no session judged since the last fit' }], stepped: false };
  }
  lanes.forEach(l => {
    if (!Object.prototype.hasOwnProperty.call(next, l.id)) return;
    if (l.n < L.MIN_SAMPLE) { held.push({ id: l.id, why: 'only ' + l.n + ' of ' + L.MIN_SAMPLE + ' sessions' }); return; }
    const ci = l.ci;
    const edge = !ci ? 0 : ci[0] > 50 ? (ci[0] - 50) / 50 : ci[1] < 50 ? (ci[1] - 50) / 50 : 0;
    if (!edge) { held.push({ id: l.id, why: 'interval straddles 50%' }); return; }
    const step = Math.max(-L.MAX_STEP, Math.min(L.MAX_STEP, edge));
    const was = next[l.id];
    next[l.id] = Math.max(L.FLOOR, was * (1 + step));
    moved.push({ id: l.id, label: l.label, from: round(was, 4), to: round(next[l.id], 4), rate: l.rate, n: l.n, ci: ci });
  });
  if (!moved.length) return { weights: base, moved: moved, held: held, stepped: true };
  // Sum to one at four decimals, the remainder on the largest (learn.js normalise).
  let sum = 0, tot = 0, big = null;
  Object.keys(next).forEach(k => { sum += next[k]; });
  Object.keys(next).forEach(k => {
    next[k] = round(next[k] / sum, 4); tot += next[k];
    if (big === null || next[k] > next[big]) big = k;
  });
  next[big] = round(next[big] + (1 - tot), 4);
  return { weights: next, moved: moved, held: held, stepped: true };
}

/* ------------------------------------------------------------------ run */
function main() {
  const t0 = Date.now();
  const nowArg = arg('--now');
  const nowMs = nowArg ? Date.parse(nowArg) : Date.now();
  if (!isFinite(nowMs)) { console.log('bad --now: ' + nowArg); process.exitCode = 2; return; }
  const nowSec = Math.floor(nowMs / 1000);

  const rec = loadRecord(arg('--also'));
  const run = { at: new Date(nowMs).toISOString(), frozen: [], settled: [], judged: [], notes: [] };

  let KT;
  try {
    KT = load(MODULES, { quiet: true, now: nowArg ? nowMs : null });
  } catch (e) {
    console.log('could not load the page modules: ' + (e && e.stack || e));
    process.exitCode = 1;
    return;
  }
  const core = KT.core, F = KT.forecast;

  // The same inputs the page loads at boot (app.js), from the same files.
  const lex = readJSON('config/lexicon.json', null);
  core.setLexicon(lex || { bullish: {}, bearish: {}, impact_high: [], impact_medium: [], relevance: [], noise: [], sector_map: {} });
  if (!lex) run.notes.push('lexicon missing: news scored as neutral');
  const events = readJSON('data/events.json', null);
  if (events) F.setHolidays(events.holidays || []);
  const cons = readJSON('data/constituents.json', null);
  if (cons && cons.members) F.setConstituents(cons);
  const kronos = readJSON('data/kronos.json', null);
  if (kronos && F.setKronos) F.setKronos(kronos);
  const chronos = readJSON('data/chronos.json', null);
  if (chronos && F.setChronos) F.setChronos(chronos);
  const hist = readJSON('data/history_model.json', null);
  if (hist && F.setHistory) F.setHistory(hist);
  const newsFile = readJSON('data/news.json', null);
  if (newsFile) KT.data.adoptBakedNews(newsFile);
  const news = KT.data.getNews();
  const seasonality = readJSON('data/seasonality.json', null);
  const global = readJSON('data/global.json', null);
  const flows = readJSON('data/flows.json', null);
  const options = readJSON('data/options.json', null);
  const quote = readJSON('data/quote.json', null);
  const vixQ = quote && quote.quotes && quote.quotes.INDIAVIX;
  const vix = vixQ && vixQ.price > 0 ? vixQ.price : null;
  if (F.setFocus) F.setFocus(null);
  // The learned knobs the record already holds, so this call is made with them.
  if (rec.learned && KT.learn.adoptShared) KT.learn.adoptShared(rec.learned);

  const expSec = options && options.expiry ? KT.data.nseDate(options.expiry) : null;
  const judgeBase = { news: news, events: events, expiry: expSec ? KT.postmortem.dateKey(expSec) : null };
  const activeFrom = dayKeyMinus(KT, nowSec, ACTIVE_DAYS);

  for (const sym of SYMBOLS) {
    const all = rowsOf(rec, sym);
    try {
      const candles = candlesOf(sym);
      // Only the rows still in play go through the ledger: its store keeps
      // the last forty, and the record is longer than that.
      const active = all.filter(r => r.session >= activeFrom);
      core.store.set('fcLocks', JSON.parse(JSON.stringify(active)));

      const gap = tapeGap(KT, candles, nowSec);
      let f = null, snap = null;
      if (candles.length >= 30) {
        const ind = KT.ind.snapshot(candles);
        const lv = KT.levels.build(candles);
        f = KT.engine.buildForecast({
          symbol: sym, candles: candles, news: news, seasonality: seasonality, timeframe: '1S', livePrice: null,
          gapScale: null, indicators: ind, levels: lv, structures: KT.structures.detect(candles),
          structureStats: KT.structures.outcomes(candles), global: global, flows: flows, options: options,
          vix: vix, conformal: null, modelVote: null,
        });
        snap = KT.postmortem.snapshot({ symbol: sym, timeframe: '1S', forecast: f, indicators: ind,
                                        global: global, vix: vix, flows: flows });
      }

      // Judge first: a finished session is settled whatever the tape says
      // about the next one, as long as its own bars are complete.
      const before = {};
      active.forEach(r => { before[r.id] = { o: !!r.outcome, p: !!r.postmortem }; });
      if (candles.length >= 2) KT.ledger.settleLocks(candles, sym, Object.assign({ now: snap }, judgeBase));

      if (gap) {
        run.notes.push(sym + ': nothing frozen, ' + gap);
      } else if (f && f.path && f.path.length) {
        const row = KT.ledger.lock(f, { symbol: sym, snapshot: snap, source: 'workflow', preOpenFrom: PRE_OPEN_FROM });
        if (row && !before[row.id]) run.frozen.push(row.id);
        else if (row) run.notes.push(sym + ': ' + row.session + ' already has its ' + row.stage + ' call');
        else run.notes.push(sym + ': nothing to freeze now (the next session is under way, or already traded)');
      } else {
        run.notes.push(sym + ': no forecast (' + candles.length + ' minute bars)');
      }

      // Back into the record, by id. The ledger's rows win: they are the
      // same rows, settled or judged since.
      const after = core.store.get('fcLocks', []);
      const byId = {};
      all.forEach(r => { byId[r.id] = r; });
      after.forEach(r => {
        const b = before[r.id];
        if (b && !b.o && r.outcome) run.settled.push(r.id);
        if ((!b || !b.p) && r.postmortem) run.judged.push(r.id);
        byId[r.id] = r;
      });
      let rows = Object.keys(byId).map(k => byId[k])
        .sort((a, b) => (b.session > a.session ? 1 : b.session < a.session ? -1 : b.lockedAt - a.lockedAt));
      /* How much of the record is kept, newest first: the last few sessions
         in full, the last month with both of its calls, and before that only
         the call each session was judged on. */
      const sessions = [];
      rows.forEach(r => { if (sessions.indexOf(r.session) === -1) sessions.push(r.session); });
      const rankOf = {};
      sessions.forEach((s, i) => { rankOf[s] = i; });
      const judgedIds = {};
      judgedRows(rows).forEach(r => { judgedIds[r.id] = true; });
      rows = rows.filter(r => rankOf[r.session] < KEEP_SESSIONS &&
                              (rankOf[r.session] < BOTH_STAGES_SESSIONS || judgedIds[r.id])).map(r => {
        // Too old for the minute bars still on file: it will never be scored.
        if (r.session < activeFrom && !r.outcome) r.expired = true;
        const done = r.postmortem || r.session < activeFrom;
        return rankOf[r.session] >= FULL_PATH_SESSIONS && done && !r.compact ? compact(r) : r;
      });
      const latest = rows.filter(r => r.timeframe === '1S')[0] || null;
      rec.symbols[sym] = {
        rows: rows.map(packPath),
        latest: latest ? { id: latest.id, session: latest.session, stage: latest.stage } : null,
        stats: statsOf(KT, rows),
      };
      const s = rec.symbols[sym].stats;
      console.log('  [ok ] ' + sym.padEnd(7) + rows.length + ' rows, ' + s.sessions + ' judged sessions' +
                  (s.direction.n ? ', right ' + s.direction.right + ' of ' + s.direction.n : '') +
                  (gap ? '  (' + gap + ')' : ''));
    } catch (e) {
      run.notes.push(sym + ': failed, ' + String(e && e.message || e).slice(0, 200));
      console.log('  [FAIL] ' + sym + ' ' + (e && e.stack || e));
      rec.symbols[sym] = rec.symbols[sym] || { rows: all, latest: null, stats: null };
    }
  }

  /* What the record has learned. Fitted on NIFTY's record: SENSEX moves
     with it session for session, and counting both would count most
     sessions twice. */
  try {
    const nifty = rowsOf(rec, 'NIFTY');
    core.store.set('fcLocks', JSON.parse(JSON.stringify(nifty)));
    const open = KT.learn.openGainFrom('NIFTY');
    const stats = rec.symbols.NIFTY && rec.symbols.NIFTY.stats;
    const judged = judgedRows(nifty).filter(r => r.postmortem);
    const newest = judged.length ? judged[0].session : null;
    const prev = rec.learned || null;
    const fit = fitWeights(KT, prev, (stats && stats.lanes) || [], newest);
    const history = (prev && Array.isArray(prev.history) ? prev.history : []).slice(-59);
    if (fit.moved.length) history.push({ at: nowMs, session: newest, moved: fit.moved });
    rec.learned = {
      updatedAt: nowMs, fittedOn: 'NIFTY',
      fittedThrough: fit.stepped ? newest : (prev && prev.fittedThrough) || null,
      samples: judged.length,
      weights: fit.weights || null,
      held: fit.held.slice(0, 12),
      history: history,
      openGain: open.gain, openSamples: open.n, openRaw: open.raw != null ? open.raw : null,
      minSample: KT.learn.MIN_SAMPLE, minOpenSample: KT.learn.MIN_OPEN_SAMPLE,
    };
  } catch (e) {
    run.notes.push('learning step failed: ' + String(e && e.message || e).slice(0, 200));
  }

  // The lessons the judgements filed, kept with the record so every
  // browser's desk reads them (lessons.importJson dedupes by runId).
  try {
    const have = {};
    const lessons = (Array.isArray(rec.lessons) ? rec.lessons : []).slice();
    lessons.forEach(l => { if (l.runId) have[l.runId] = true; });
    KT.lessons.all().forEach(l => { if (!l.runId || !have[l.runId]) { lessons.push(l); have[l.runId] = true; } });
    lessons.sort((a, b) => a.at - b.at);
    rec.lessons = lessons.slice(-MAX_LESSONS);
  } catch (e) {
    run.notes.push('lessons not kept: ' + String(e && e.message || e).slice(0, 200));
  }

  rec.v = VERSION;
  delete rec.error;
  rec.generated_at = new Date(nowMs).toISOString();
  rec.source = 'scripts/daily_call.js';
  rec.ok = SYMBOLS.some(s => rec.symbols[s] && rec.symbols[s].stats);
  run.seconds = round((Date.now() - t0) / 1000, 1);
  rec.run = run;
  writeJSON(OUT, rec);
  console.log('frozen: ' + (run.frozen.join(', ') || 'none') + ' | settled: ' + (run.settled.join(', ') || 'none') +
              ' | judged: ' + (run.judged.join(', ') || 'none'));
  run.notes.forEach(n => console.log('  note: ' + n));
}

if (require.main === module) {
  try { main(); } catch (e) { console.log('daily call failed: ' + (e && e.stack || e)); process.exitCode = 1; }
}
// For the self-test (scripts/selftest_calls.js).
module.exports = { packPath, unpackPath, compact, judgedRows, statsOf, fitWeights, tapeGap, loadRecord, wilson };
