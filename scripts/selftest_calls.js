/* ============================================================================
   Self-test for the call, its judgement and the record.  Run:
     node scripts/selftest_calls.js

   The session call, the post-mortem that judges it, the published record the
   workflow keeps (scripts/daily_call.js, data/calls.json) and what is learned
   from it. Same rules as scripts/selftest.js: the real browser modules in a vm
   (scripts/ktvm.js), no dependencies, and every check is something that was
   wrong once or would be expensive to be wrong about:

     one direction        the card, the record and the verdict used to read the
                          lean three different ways
     the stage clock      a stale feed froze a "forecast" for a session that had
                          already traded
     the record wins      two browsers must show the same call for a session
                          the scheduled run has frozen, and neither may write
                          its own over it
     one lesson a day     a session with a day-before and a pre-open call
                          taught the desk the same thing twice
     a replayed week      the workflow script itself, run three times on a
                          scratch copy of the data with a test clock: freeze,
                          freeze again before the open, judge after the close
     the crowd            the mood of the market reaches the line, read the
                          other way only at the extremes
     the gap              the size and lean learned from line against market,
                          measured against the model's own line, never its
                          last correction
     the training log     every call and judgement appended once, with the
                          gap every fifteen minutes
   ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { load, readJSON, ROOT } = require('./ktvm');

const MODULES = ['config', 'core', 'indicators', 'levels', 'candles', 'patterns', 'structures', 'data',
                 'analogs', 'vol', 'forecast', 'postmortem', 'ledger', 'learn', 'trail', 'evidence',
                 'engine', 'lessons'];

let pass = 0, fail = 0;
const asyncChecks = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

const IST = '+05:30';
function at(iso) { return Date.parse(iso + IST); }
function kt(iso) {
  const KT = load(MODULES, { quiet: true, now: iso ? at(iso) : null });
  const lex = readJSON('config/lexicon.json', null);
  KT.core.setLexicon(lex || { bullish: {}, bearish: {}, impact_high: [], impact_medium: [], relevance: [], noise: [], sector_map: {} });
  const ev = readJSON('data/events.json', null);
  if (ev) KT.forecast.setHolidays(ev.holidays || []);
  return KT;
}

/* A snapshot committed during market hours ends in a session still trading
   (the one of 30 Oct 2026 stops at 12:41 IST), and every replay below settles
   whole sessions. A part-session at the end is left out, so the checks read
   the same whatever hour the data was saved. */
const minuteRaw = (function (raw) {
  if (!raw || !raw.candles || !raw.candles.length) return raw;
  const lastKey = istKey(raw.candles[raw.candles.length - 1][0]);
  const lastMin = Math.max.apply(null, raw.candles.filter(r => istKey(r[0]) === lastKey).map(r => istMinute(r[0])));
  return lastMin >= 15 * 60 + 29 ? raw
    : Object.assign({}, raw, { candles: raw.candles.filter(r => istKey(r[0]) !== lastKey) });
})(readJSON('data/candles_NIFTY_1H.json', null));
const minutes = (minuteRaw && minuteRaw.candles || []).map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4] }));
function istKey(sec) { return new Date((sec + 19800) * 1000).toISOString().slice(0, 10); }
function istMinute(sec) { const d = new Date((sec + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
const days = [];
minutes.forEach(c => { const k = istKey(c.time); if (days.indexOf(k) === -1) days.push(k); });
const lastDay = days[days.length - 1], prevDay = days[days.length - 2];
function upTo(key) { return minutes.filter(c => istKey(c.time) <= key).map(c => Object.assign({}, c)); }
function sessionCall(KT, candles, extra) {
  return KT.engine.buildForecast(Object.assign({
    symbol: 'NIFTY', candles: candles, news: [], seasonality: null, timeframe: '1S', livePrice: null,
    indicators: KT.ind.snapshot(candles), levels: KT.levels.build(candles),
    structures: KT.structures.detect(candles), structureStats: null,
    global: null, flows: null, options: null, vix: null, conformal: null, modelVote: null,
  }, extra || {}));
}
// The weekday after a key, for clocks set "the next morning".
function nextDay(key) {
  const d = new Date(key + 'T12:00:00Z');
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

if (days.length < 3) {
  console.log('data/candles_NIFTY_1H.json has fewer than three sessions; nothing to replay.');
  process.exit(1);
}

/* ======================================================================= */
section('LEDGER - one direction, the odds of the close');
{
  const KT = kt(null);
  const L = KT.ledger;
  ok('55% to close higher is an up call', L.callDirOf({ end: { pUpClose: 55 } }) === 1);
  ok('45% is a down call', L.callDirOf({ end: { pUpClose: 45 } }) === -1);
  ok('between them, no lean', L.callDirOf({ end: { pUpClose: 50 } }) === 0 && L.callDirOf({ end: { pUpClose: 54 } }) === 0);
  ok('a row frozen before the odds were kept falls back to the target',
     L.callDirOf({ anchorPrice: 100, target: 100.5 }) === 1 && L.callDirOf({ anchorPrice: 100, target: 100.01 }) === 0);
  const f = sessionCall(KT, upTo(prevDay));
  const p = KT.forecast.closeOdds(f);
  ok('the close odds are a whole percentage', Number.isInteger(p) && p >= 1 && p <= 99, String(p));
}

/* ======================================================================= */
section('LEDGER - the stage clock');
{
  const tape = upTo(prevDay);
  const evening = prevDay + 'T16:40:00', morning = lastDay + 'T08:31:00';
  let KT = kt(evening);
  let f = sessionCall(KT, tape);
  ok('after the close the call is about the next session', KT.ledger.sessionKeyOf(f) === lastDay, KT.ledger.sessionKeyOf(f));
  ok('and it is the day-before stage', KT.ledger.stageNow(f) === 'advance');
  KT = kt(morning); f = sessionCall(KT, tape);
  ok('08:31 in a browser is still the day before', KT.ledger.stageNow(f) === 'advance');
  ok('08:31 for the scheduled run is the pre-open', KT.ledger.stageNow(f, { preOpenFrom: 480 }) === 'open');
  KT = kt(lastDay + 'T09:05:00'); f = sessionCall(KT, tape);
  ok('09:05 is the pre-open for everyone', KT.ledger.stageNow(f) === 'open');
  KT = kt(lastDay + 'T09:20:00'); f = sessionCall(KT, tape);
  ok('after the open nothing is frozen', KT.ledger.stageNow(f) === null && KT.ledger.stageNow(f, { preOpenFrom: 480 }) === null);
  KT = kt(nextDay(lastDay) + 'T08:31:00'); f = sessionCall(KT, tape);
  ok('a stale tape cannot freeze a session that already traded', KT.ledger.stageNow(f) === null &&
     KT.ledger.stageNow(f, { preOpenFrom: 480 }) === null && KT.ledger.lock(f, { symbol: 'NIFTY' }) === null);
  KT = kt(evening); f = sessionCall(KT, tape);
  const row = KT.ledger.lock(f, { symbol: 'NIFTY', source: 'workflow', preOpenFrom: 480 });
  ok('the scheduled run\'s call carries its own id', row && /:wf$/.test(row.id) && row.source === 'workflow', row && row.id);
  ok('and keeps the odds it gave the close', row && row.end && Number.isInteger(row.end.pUpClose));
  const again = KT.ledger.lock(f, { symbol: 'NIFTY', source: 'workflow', preOpenFrom: 480 });
  ok('a second freeze of the same stage returns the first, untouched', again && again.id === row.id && again.lockedAt === row.lockedAt);
}

/* ======================================================================= */
section('LEDGER - the published record wins its sessions');
{
  const tape = upTo(prevDay);
  const W = kt(prevDay + 'T16:40:00');
  const f = sessionCall(W, tape);
  const adv = W.ledger.lock(f, { symbol: 'NIFTY', source: 'workflow' });
  const pack = r => {
    const c = JSON.parse(JSON.stringify(r));
    c.pp = { t0: r.path[0].time, dt: r.path[1].time - r.path[0].time, v: r.path.map(p => p.value) };
    delete c.path;
    return c;
  };
  const open = Object.assign(pack(adv), { id: adv.id.replace(':advance:', ':open:'), stage: 'open', lockedAt: adv.lockedAt + 3600e3 });
  const record = { v: 1, symbols: { NIFTY: { rows: [pack(adv), open] } } };

  // A browser that froze its own call for the same session before the record arrived.
  const B = kt(prevDay + 'T20:00:00');
  const fb = sessionCall(B, tape);
  const mine = B.ledger.lock(fb, { symbol: 'NIFTY' });
  ok('a browser freezes its own call while the record has none', mine && !/:wf$/.test(mine.id));
  ok('the record loads, packed minute paths unpacked', B.ledger.setShared(JSON.parse(JSON.stringify(record))) === 2 &&
     B.ledger.locks('NIFTY', 10).every(r => Array.isArray(r.path) && r.path.length === adv.path.length));
  const shown = B.ledger.lock(fb, { symbol: 'NIFTY' });
  ok('the call for that session is now the record\'s, its latest stage', shown && shown.id === open.id, shown && shown.id);
  ok('the browser\'s own call stays out of the record it shows', B.ledger.locks('NIFTY', 10).every(r => r.id !== mine.id));
  const stored = B.core.store.get('fcLocks', []);
  ok('and nothing new was written for the covered session', stored.length === 1 && stored[0].id === mine.id);
  ok('a record row is known as one', B.ledger.isRecord(shown) && !B.ledger.isRecord(mine));
}

/* ======================================================================= */
section('LEDGER - settling a record row here, one lesson a session');
{
  const tape = upTo(prevDay), full = upTo(lastDay);
  const W = kt(prevDay + 'T16:40:00');
  const f = sessionCall(W, tape);
  // What it knew when it froze: the situation a lesson is filed under.
  const snap = W.postmortem.snapshot({ symbol: 'NIFTY', timeframe: '1S', forecast: f, indicators: W.ind.snapshot(tape),
                                       global: null, vix: null, flows: null });
  const adv = W.ledger.lock(f, { symbol: 'NIFTY', source: 'workflow', snapshot: snap });
  const open = Object.assign(JSON.parse(JSON.stringify(adv)), { id: adv.id.replace(':advance:', ':open:'), stage: 'open', lockedAt: adv.lockedAt + 3600e3 });
  const B = kt(lastDay + 'T15:45:00');
  B.ledger.setShared({ v: 1, symbols: { NIFTY: { rows: [JSON.parse(JSON.stringify(adv)), open] } } });
  const changed = B.ledger.settleLocks(full, 'NIFTY', { news: [], now: null, events: null, expiry: null });
  const rows = B.ledger.locks('NIFTY', 10);
  ok('both record calls settle here at the close', changed === 2 && rows.every(r => r.outcome && r.outcome.closeActual > 0), 'settled ' + changed);
  ok('and are judged', rows.every(r => r.postmortem && /^(right|wrong|flat|no-call)$/.test(r.postmortem.verdict)));
  const lessons = B.lessons.all();
  ok('one lesson for the session, from the pre-open call', lessons.length === 1 && /:open:wf$/.test(lessons[0].runId),
     lessons.map(l => l.runId).join(', '));
  ok('the settled copies are kept in this browser', B.core.store.get('fcLocks', []).length === 2);
  // A finished session's bars often stop at 15:29: the 15:29 bar runs to the bell.
  const B2 = kt(lastDay + 'T15:45:00');
  B2.ledger.setShared({ v: 1, symbols: { NIFTY: { rows: [JSON.parse(JSON.stringify(adv)), JSON.parse(JSON.stringify(open))] } } });
  const no1530 = full.filter(c => (c.time + 19800) % 86400 < 15.5 * 3600 || istKey(c.time) < lastDay);
  const settled1529 = B2.ledger.settleLocks(no1530, 'NIFTY', { news: [], now: null, events: null, expiry: null });
  // Some saved tapes have no 15:30 bar to take away; either way the tape
  // handed over must end on the 15:29 bar.
  const end1529 = no1530.length && istKey(no1530[no1530.length - 1].time) === lastDay &&
    istMinute(no1530[no1530.length - 1].time) === 15 * 60 + 29;
  ok('a session whose bars stop at 15:29 still settles that evening',
     end1529 && settled1529 === 2,
     'settled ' + settled1529 + (no1530.length === full.length ? ', the saved tape had no 15:30 bar' : ''));
  // The record publishes its own settled version: the copy that knows more wins, a tie goes to the record.
  const pub = rows.map(r => Object.assign(JSON.parse(JSON.stringify(r)), { publishedMark: true }));
  B.ledger.setShared({ v: 1, symbols: { NIFTY: { rows: pub } } });
  ok('once the record has judged them too, its version is shown', B.ledger.locks('NIFTY', 10).every(r => r.publishedMark));
}

/* ======================================================================= */
section('POSTMORTEM - the verdict and the words');
{
  const KT = kt(null);
  const key = lastDay, t0 = Math.floor(Date.parse(key + 'T09:15:00' + IST) / 1000);
  const bars = (from, to, openAt) => Array.from({ length: 375 }, (_, i) => {
    const v = from + (to - from) * i / 374, o = i === 0 && openAt != null ? openAt : v;
    return { time: t0 + i * 60, open: o, high: Math.max(o, v) + 1, low: Math.min(o, v) - 1, close: v };
  });
  const lock = (pUp, target) => ({
    symbol: 'NIFTY', session: key, stage: 'advance', timeframe: '1S', lockedAt: (t0 - 18 * 3600) * 1000,
    anchorPrice: 22000, openPrice: 22010, target: target, end: { pUpClose: pUp, low68: 21800, high68: 22200, low95: 21600, high95: 22400 },
    path: Array.from({ length: 375 }, (_, i) => ({ time: t0 + (i + 1) * 60, value: 22010 + (target - 22010) * i / 374 })),
    lanes: [{ id: 'momentum', label: 'Momentum', contribution: 0.2 }, { id: 'global', label: 'Global cue', contribution: -0.1 }],
  });
  let p = KT.postmortem.build(lock(62, 22100), { candles: bars(22010, 22120) });
  ok('an up call on an up day is right', p && p.verdict === 'right' && p.right === true && p.callDir === 1 && p.moveDir === 1);
  ok('the inputs that pointed the way are kept', p.lanes.right.some(l => l.id === 'momentum') && p.lanes.wrong.some(l => l.id === 'global'));
  p = KT.postmortem.build(lock(62, 22100), { candles: bars(21700, 21650, 21700) });
  ok('an up call on a down day is wrong', p.verdict === 'wrong' && p.right === false);
  ok('a miss made mostly at the open is named as the open', p.reasons.some(r => r.kind === 'open'), p.reasons.map(r => r.kind).join(','));
  ok('the wrong-way inputs are named', p.reasons.some(r => r.kind === 'signals' && /momentum/.test(r.text)));
  p = KT.postmortem.build(lock(62, 22100), { candles: bars(21850, 21500, 21850) });
  ok('a miss made mostly during the day is not blamed on the open', !p.reasons.some(r => r.kind === 'open'), p.reasons.map(r => r.kind).join(','));
  ok('a close outside the wide range is named as the size of the move', p.inside95 === false && p.reasons.some(r => r.kind === 'size'));
  p = KT.postmortem.build(lock(50, 22011), { candles: bars(22010, 22012) });
  ok('a call with no lean is not scored right or wrong', p.verdict === 'no-call' && p.right === null);
  ok('and never prints a negative zero', !/-0\.00%/.test(p.summary + ' ' + p.lesson), p.summary);
  ok('the lesson is filed under its situation', /^In /.test(p.lesson), p.lesson.slice(0, 60));
}

/* ======================================================================= */
section('LEARN - the published fit');
{
  const KT = kt(null);
  const C = KT.CONFIG;
  ok('no fit, no weights: the forecast keeps its starting set', KT.learn.weights() === null);
  const w = {};
  Object.keys(C.forecast.weights).forEach(k => { w[k] = C.forecast.weights[k]; });
  w.momentum = w.momentum * 1.08; w.news = 0.000001;
  KT.learn.adoptShared({ weights: w, openGain: 1.3, openSamples: 12, samples: 25, history: [{ at: 1, moved: [] }] });
  const got = KT.learn.weights();
  const sum = Object.keys(C.forecast.weights).reduce((s, k) => s + got[k], 0);
  ok('the record\'s weights are used, and still sum to one', got && got.source === 'record' && Math.abs(sum - 1) < 0.001, sum.toFixed(4));
  ok('no input is driven below the floor', got.news >= KT.learn.FLOOR - 1e-9, String(got.news));
  const betas = KT.learn.openBetas();
  ok('the gap gain applies once there are enough judged opens', betas && betas.fitted &&
     Math.abs(betas[Object.keys(KT.forecast.openBetaDefaults)[0]] / KT.forecast.openBetaDefaults[Object.keys(KT.forecast.openBetaDefaults)[0]] - 1.3) < 1e-9);
  KT.learn.adoptShared({ openGain: 1.3, openSamples: 4, samples: 4 });
  ok('and not before', KT.learn.openBetas() === null && KT.learn.weights() === null);
  KT.learn.adoptShared({ openGain: 9, openSamples: 40 });
  ok('a gain outside the guardrails is clamped', Math.abs(KT.learn.summary().openGain - KT.learn.MAX_GAIN) < 1e-9);
  // The realised gap is the opening print, not the first projected minute's close.
  KT.core.store.set('fcLocks', Array.from({ length: 12 }, (_, i) => ({
    id: 'r' + i, symbol: 'NIFTY', session: '2026-01-' + String(10 + i), lockedAt: i, anchorPrice: 100, openGapPct: 0.5,
    outcome: { openActual: 99 }, postmortem: { did: { open: 101.5 } },
  })));
  const g = KT.learn.openGainFrom('NIFTY');
  ok('the open gain reads the opening print', g.n === 12 && g.raw === 3, JSON.stringify(g));
}

/* ======================================================================= */
section('FORECAST - the price models');
{
  const KT = kt(null);
  const raw = readJSON('data/candles_NIFTY_1D.json', null);
  const c5 = raw.candles.map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4] }));
  const last = c5[c5.length - 1];
  const run = drift => ({ ok: true, stub: false, series: { 'NIFTY:5m': { base_time: last.time, base_close: last.close,
    steps: Array.from({ length: 75 }, (_, i) => ({ t: last.time + 64800 + i * 300, p10: last.close * (1 + drift - 0.006),
      p50: last.close * (1 + drift), p90: last.close * (1 + drift + 0.006) })) } } });
  ok('no run, no vote', KT.forecast.kronosLane(c5, '1D', last.close, 'NIFTY').hasData === false);
  KT.forecast.setChronos({ ok: true, stub: true, series: {} });
  ok('a stub run is refused', KT.forecast.kronosLane(c5, '1D', last.close, 'NIFTY').hasData === false);
  KT.forecast.setKronos(run(0.003));
  const one = KT.forecast.kronosLane(c5, '1D', last.close, 'NIFTY');
  ok('one model votes alone', one.hasData && one.models === 1 && one.score > 0.4);
  KT.forecast.setChronos(run(-0.002));
  const two = KT.forecast.kronosLane(c5, '1D', last.close, 'NIFTY');
  ok('two models are averaged', two.hasData && two.models === 2 && Math.abs(two.score - (0.5 - 1 / 3) / 2) < 0.01, two.score.toFixed(3));
  ok('and a split between them is said, not averaged away', /opposite ways/.test(two.note));
  ok('no model is named on the page', !/kronos|chronos/i.test(one.note + two.note));
}

/* ======================================================================= */
section('LEARN - one step per new evidence');
{
  const KT = kt(null);
  let n = 30;
  // A lane whose interval sits wholly below a coin, on a record that only grows when told to.
  KT.ledger.aggregate = () => ({ n: n, lanes: [{ id: 'news', label: 'News flow', n: n, rate: 30, ci: [18, 44] }] });
  const first = KT.learn.update('NIFTY', '1D');
  ok('a lane below a coin loses weight on the first look', first.moved && first.moved.length === 1 && first.moved[0].to < first.moved[0].from);
  const st = KT.core.store.get('fcLearn', null); st.updatedAt = 0; KT.core.store.set('fcLearn', st);
  const again = KT.learn.update('NIFTY', '1D');
  ok('an hour later on the same record it does not step again', !!again.skipped && again.moved.length === 0, again.skipped);
  n = 36;
  const st2 = KT.core.store.get('fcLearn', null); st2.updatedAt = 0; KT.core.store.set('fcLearn', st2);
  const third = KT.learn.update('NIFTY', '1D');
  ok('new settled calls allow the next step', third.moved && third.moved.length === 1);
  const w = KT.learn.weights();
  ok('so a bad week cannot walk a lane to the floor in a day', w.news > KT.learn.FLOOR * 2, String(w.news));
}

/* ======================================================================= */
section('DESK - the sentiment analyst');
{
  const calls = [];
  const MMI = { success: true, data: { date: '2026-10-30T03:57:00.109Z', indicator: 72.4, lastDay: { indicator: 61.2 }, lastWeek: { indicator: 48 }, lastMonth: { indicator: 35.5 } } };
  const nowIso = new Date(Date.now() - 3600e3).toISOString();
  const ST = { messages: [
    { body: 'Nifty holding 22900, looks strong into expiry', created_at: nowIso, entities: { sentiment: { basic: 'Bullish' } } },
    { body: 'Join our Telegram for free tips https://t.me/x', created_at: nowIso, entities: {} },
    { body: 'Breadth is weak under the surface &amp; banks lag', created_at: nowIso, entities: { sentiment: { basic: 'Bearish' } } },
  ] };
  const KT = load(['config', 'core', 'indicators', 'levels', 'candles', 'patterns', 'structures', 'data', 'analogs', 'vol', 'forecast',
                   'postmortem', 'ledger', 'learn', 'trail', 'evidence', 'engine', 'streetcalls', 'stocks', 'lessons', 'desk'], {
    quiet: true,
    fetch: (url) => {
      calls.push(url);
      const body = /tickertape/.test(url) ? JSON.stringify(MMI) : /NIFTY50\.NSE/.test(url) ? JSON.stringify(ST) : null;
      return Promise.resolve(body ? { ok: true, status: 200, text: () => Promise.resolve(body) }
                                  : { ok: false, status: 404, text: () => Promise.resolve('') });
    },
  });
  KT.core.setLexicon({ bullish: {}, bearish: {}, impact_high: [], impact_medium: [], relevance: [], noise: [], sector_map: {} });
  asyncChecks.push(() => KT.data.getSentiment('NIFTY').then(x => {
    ok('the mood index and the stream both arrive, through the proxy chain', !!x && x.mood && x.mood.now === 72.4 && x.crowd && x.crowd.symbol === 'NIFTY50.NSE' &&
       calls.every(u => /^https:\/\/r\.jina\.ai\//.test(u)), calls.length + ' requests');
    ok('the gauge is read on its own scale', x.mood.zone === 'extreme greed' && x.mood.day === 61.2 && x.mood.month === 35.5);
    ok('promotions are dropped before the analyst sees the stream', x.crowd.n === 2 && x.crowd.promo === 1 && x.crowd.bull === 1 && x.crowd.bear === 1 &&
       !x.crowd.items.some(i => /telegram/i.test(i.text)) && x.crowd.items.some(i => /surface & banks/.test(i.text)));
    const n0 = calls.length;
    return KT.data.getSentiment('NIFTY').then(y => ok('and kept for ten minutes', y === x && calls.length === n0));
  }).then(() => KT.data.getSentiment('SENSEX')).then(z => {
    ok('SENSEX, which has no stream, still gets the mood index', !!z && z.mood && z.crowd === null);
    const S = { symbol: 'NIFTY', timeframe: '1S', candles: minutes.slice(-400), quote: {}, indicators: {}, levels: {} };
    const F0 = KT.desk.gather(S, { news: [] });
    const F1 = KT.desk.gather(S, { news: [], sentiment: { mood: { now: 72.4, zone: 'extreme greed', day: 61.2 }, crowd: null } });
    ok('without the crowd\'s numbers the desk has its four analysts', KT.desk.roleList(F0).map(r => r.id).join() === 'technical,news,macro,internals');
    const roles = KT.desk.roleList(F1);
    ok('with them a fifth reads the mood', roles.map(r => r.id).join() === 'technical,news,macro,internals,sentiment' &&
       /Market Mood Index[^\n]*72\.4, extreme greed/.test(roles[4].brief));
    const q = KT.desk.prompts.quick(F1, '', '');
    ok('the one-call read scores all five', /"sentiment": <score>/.test(q.user) && /a sentiment analyst/.test(q.system));
    ok('a full run is budgeted at seven requests', KT.desk.CALLS.full === 7);
  }));
}

/* ======================================================================= */
section('DAILY CALL - pieces');
{
  const D = require('./daily_call');
  const row = { id: 'x', path: [{ time: 60, value: 1.234 }, { time: 120, value: 2 }, { time: 180, value: 3 }] };
  const packed = D.packPath(row);
  ok('a regular minute path packs to a start, a step and the values', packed.pp && !packed.path && packed.pp.dt === 60 && packed.pp.v[0] === 1.23);
  const back = D.unpackPath(packed);
  ok('and unpacks to the same times', back.path.map(p => p.time).join() === '60,120,180');
  ok('an irregular path is left as it is', D.packPath({ path: [{ time: 60, value: 1 }, { time: 120, value: 1 }, { time: 200, value: 1 }] }).path.length === 3);
  const c = D.compact({ id: 'y', path: row.path, lanes: [{ id: 'a', label: 'A', contribution: 0.1, note: 'long' }],
                        ctx: { at: 5, cues: { x: 1 }, fp: { kind: 'index' } },
                        postmortem: { reasons: [{ kind: 'open', w: 1, text: 'x'.repeat(400) }], lanes: { right: [{ id: 'a', label: 'A', c: 0.1 }], wrong: [] } } });
  ok('a judged row keeps its judgement and drops its minute path', !c.path && !c.lanes && c.ctx.fp && !c.ctx.cues &&
     c.postmortem.reasons[0].text.length === 220 && c.postmortem.lanes.right[0].id === 'a' && c.compact);
  const minutesPath = []; for (let i = 0; i < 375; i++) minutesPath.push({ time: 1000020 + i * 60, value: 25000 + i });
  const sk = D.compact({ id: 'z', path: minutesPath, learned: { g: 0.8, b: 0 } }, true);
  ok('a recent judged row keeps a five-minute sketch of its line, for the chart', sk.path && sk.path.length === 75 &&
     sk.path[1].time - sk.path[0].time === 300 && sk.path[74].time === minutesPath[374].time, sk.path && String(sk.path.length));
  ok('the sketch packs like a minute path, and an old row keeps none', D.packPath(sk).pp && D.packPath(sk).pp.dt === 300 &&
     !D.compact({ id: 'z', path: minutesPath }, false).path);
  ok('a compacted row keeps the learned size and lean it was drawn with', sk.learned && sk.learned.g === 0.8);
  const KT = kt(null);
  ok('one row a session: the pre-open call beats the day before', D.judgedRows([
    { session: 'd1', stage: 'advance', timeframe: '1S', id: 'a' }, { session: 'd1', stage: 'open', timeframe: '1S', id: 'o' },
    { session: 'd2', stage: 'advance', timeframe: '1S', id: 'b' }]).map(r => r.id).join() === 'b,o');
  const lanes = [{ id: 'momentum', label: 'Momentum', n: 30, right: 22, rate: 73, ci: [55.6, 85.8] },
                 { id: 'news', label: 'News', n: 30, right: 15, rate: 50, ci: [33.2, 66.8] },
                 { id: 'global', label: 'Global', n: 8, right: 8, rate: 100, ci: [67.6, 100] }];
  const fit = D.fitWeights(KT, null, lanes, 'd9');
  ok('a lane whose interval clears a coin earns weight, by at most the step', fit.moved.length === 1 && fit.moved[0].id === 'momentum' &&
     fit.moved[0].to / fit.moved[0].from <= 1 + KT.learn.MAX_STEP + 1e-9);
  ok('a lane short of the sample, or straddling 50%, is held', fit.held.some(h => h.id === 'global') && fit.held.some(h => h.id === 'news'));
  const again = D.fitWeights(KT, { weights: fit.weights, fittedThrough: 'd9' }, lanes, 'd9');
  ok('the same evidence is not applied twice', again.stepped === false && JSON.stringify(again.weights) === JSON.stringify(fit.weights));
  const quiet = D.tapeGap(kt(prevDay + 'T16:40:00'), upTo(prevDay), Math.floor(at(prevDay + 'T16:40:00') / 1000));
  ok('a complete tape after the close has no gap', quiet === null, String(quiet));
  const cut = upTo(prevDay).filter(x => (x.time + 19800) % 86400 < 14.5 * 3600 || istKey(x.time) < prevDay);
  const gap = D.tapeGap(kt(prevDay + 'T16:40:00'), cut, Math.floor(at(prevDay + 'T16:40:00') / 1000));
  ok('a tape that stops before the close is caught', gap && /before the close/.test(gap), String(gap));
  const stale = D.tapeGap(kt(lastDay + 'T16:40:00'), upTo(prevDay), Math.floor(at(lastDay + 'T16:40:00') / 1000));
  ok('a tape a session behind is caught', stale && /has traded since/.test(stale), String(stale));
}

/* ======================================================================= */
section('CROWD - the mood of the market as a lane');
{
  const iso = lastDay + 'T11:00:00';
  const KT = kt(iso);
  const F = KT.forecast, nowMs = at(iso), nowSec = Math.floor(nowMs / 1000);
  const W = KT.CONFIG.forecast.weights;
  const sum = Object.keys(W).reduce((t, k) => t + W[k], 0);
  ok('the crowd has a weight, and the weights still sum to one', W.crowd > 0 && Math.abs(sum - 1) < 1e-9, sum.toFixed(6));
  const mood = v => ({ at: nowSec, mood: { now: v, zone: 'z', at: nowSec } });
  ok('extreme greed is read the other way', F.crowdLane(mood(85), nowMs).score < 0, String(F.crowdLane(mood(85), nowMs).score));
  ok('extreme fear is read the other way', F.crowdLane(mood(15), nowMs).score > 0);
  const mid = F.crowdLane(mood(55), nowMs);
  ok('the middle is read but votes nothing', mid.hasData && mid.score === 0, mid.note);
  ok('a reading a day and a half old goes dark', !F.crowdLane({ at: nowSec - 40 * 3600, mood: { now: 90, at: nowSec - 40 * 3600 } }, nowMs).hasData);
  const st = (b, r) => ({ at: nowSec, crowd: { bull: b, bear: r, n: b + r, to: nowSec } });
  ok('a stream three to one bullish leans the other way', F.crowdLane(st(24, 6), nowMs).score < 0);
  ok('a balanced stream votes nothing', F.crowdLane(st(15, 13), nowMs).score === 0);
  ok('seven tagged posts are too few to vote', !F.crowdLane(st(6, 1), nowMs).hasData);
  ok('Reddit counts when the workflow got through', F.crowdLane({ at: nowSec, reddit: { ok: true, bull: 18, bear: 2, n: 30 } }, nowMs).score < 0);
  const file = { generated_at: new Date(nowMs).toISOString(), mood: { now: 82, zone: 'extreme greed', at: nowSec },
                 symbols: { NIFTY: { crowd: { bull: 20, bear: 2, n: 22, to: nowSec } } }, reddit: { ok: false, why: 'HTTP 403' } };
  const sN = F.socialFor(file, 'NIFTY'), sS = F.socialFor(file, 'SENSEX');
  ok('the workflow file reads per symbol, SENSEX on the mood alone', sN && sN.mood && sN.crowd && !sN.reddit && sS && sS.mood && !sS.crowd);
  const tape = upTo(prevDay);
  const without = sessionCall(KT, tape), withC = sessionCall(KT, tape, { social: sN });
  const laneOf = (f, id) => f.lanes.filter(l => l.id === id)[0];
  ok('the crowd is a lane of the line when it is read', laneOf(withC, 'crowd').hasData && laneOf(withC, 'crowd').score < 0 && withC.crowd,
     laneOf(withC, 'crowd').note);
  ok('and dark, with its weight passed on, when it is not', !laneOf(without, 'crowd').hasData && !without.crowd);
  ok('it moves the line', withC.target !== without.target, without.target + ' -> ' + withC.target);
}

/* ======================================================================= */
section('LEARN - the gap between the line and the market');
{
  const KT = kt(lastDay + 'T17:00:00');
  const L = KT.learn;
  const day = i => '2026-0' + (7 + Math.floor(i / 28)) + '-' + String(1 + (i % 28)).padStart(2, '0');
  // A judged session call: the line said `said`% from its open to its close,
  // the session did `did`%.
  const row = (i, said, did, learned) => ({
    id: 'NIFTY:' + day(i) + ':1S:open:wf', symbol: 'NIFTY', session: day(i), stage: 'open', timeframe: '1S',
    lockedAt: 1000 + i, anchorPrice: 25000, openPrice: 25000, target: 25000 * (1 + said / 100),
    path: [{ time: 100 + i, value: 25000 }], learned: learned || null,
    outcome: { closeActual: 25000 * (1 + did / 100) },
    postmortem: { said: { open: 25000, target: 25000 * (1 + said / 100) },
                  did: { open: 25000, close: 25000 * (1 + did / 100), pct: did }, verdict: 'right', errPct: did - said },
  });
  const set = rows => KT.core.store.set('fcLocks', rows);
  const alt = i => (i % 2 ? 1 : -1) * (0.3 + (i % 5) * 0.05);
  set(Array.from({ length: 12 }, (_, i) => row(i, alt(i), alt(i) / 2)));
  const twice = L.closeFitFrom('NIFTY');
  ok('a line that keeps calling twice the move is drawn smaller', twice.n === 12 && twice.raw === 0.5 && twice.gain < 1 && twice.gain > 0.5,
     JSON.stringify(twice));
  set(Array.from({ length: 12 }, (_, i) => row(i, alt(i) * 0.5, alt(i) / 2, { g: 0.5, b: 0 })));
  const again = L.closeFitFrom('NIFTY');
  ok('a line already drawn at half size fits the same, so a correction never feeds on itself', again.raw === twice.raw && again.gain === twice.gain,
     JSON.stringify(again));
  set(Array.from({ length: 9 }, (_, i) => row(i, alt(i), alt(i) / 2)));
  ok('nine sessions are too few to move anything', L.closeFitFrom('NIFTY').gain === 1 && L.closeFitFrom('NIFTY').n === 9);
  set(Array.from({ length: 24 }, (_, i) => row(i, alt(i), alt(i) + 0.2 + (i % 3 - 1) * 0.02)));
  const lean = L.closeFitFrom('NIFTY');
  ok('a close that keeps landing above the line earns a small lean up', lean.bias > 0 && lean.bias <= L.MAX_BIAS_PCT && lean.t >= 2,
     JSON.stringify(lean));
  set(Array.from({ length: 24 }, (_, i) => row(i, alt(i), alt(i) + (i % 2 ? 0.2 : -0.2))));
  ok('a miss that goes both ways earns no lean', L.closeFitFrom('NIFTY').bias === 0);
  set([]);

  const tape = upTo(prevDay);
  const plain = sessionCall(KT, tape);
  L.adoptShared({ closeGain: 0.6, closeBias: 0, closeSamples: 14 });
  const terms = L.closeTerms();
  const sized = sessionCall(KT, tape);
  const laneSum = f => f.attribution[f.attribution.length - 1].lanes.reduce((t, l) => t + l.pct, 0);
  const ratio = laneSum(sized) / laneSum(plain);
  ok('the record\'s fit resizes the line\'s drift', terms && terms.source === 'record' && Math.abs(ratio - 0.6) < 0.02 &&
     sized.learned && sized.learned.gain === 0.6, 'ratio ' + ratio.toFixed(3));
  const KT2 = kt(prevDay + 'T16:40:00');
  KT2.learn.adoptShared({ closeGain: 0.6, closeBias: 0.05, closeSamples: 14 });
  const frozen = KT2.ledger.lock(sessionCall(KT2, tape), { symbol: 'NIFTY', source: 'workflow', preOpenFrom: 480 });
  ok('a frozen call carries the size and lean it was drawn with', frozen && frozen.learned && frozen.learned.g === 0.6 &&
     frozen.learned.b === 0.05, frozen ? JSON.stringify(frozen.learned) : 'nothing frozen');
  L.adoptShared({ closeGain: 1, closeBias: 0, closeSamples: 3 });
  ok('below the minimum sample the record changes nothing', L.closeTerms() === null);
}

/* ======================================================================= */
section('DESK - its own record in the final prompt');
{
  const KT = load(['config', 'core', 'indicators', 'levels', 'candles', 'patterns', 'structures', 'data', 'analogs', 'vol', 'forecast',
                   'postmortem', 'ledger', 'learn', 'trail', 'evidence', 'engine', 'streetcalls', 'stocks', 'lessons', 'desk'], { quiet: true });
  KT.core.setLexicon({ bullish: {}, bearish: {}, impact_high: [], impact_medium: [], relevance: [], noise: [], sector_map: {} });
  const mk = (d, said, did, verdict, why) => ({
    id: 'NIFTY:' + d + ':1S:open:wf', symbol: 'NIFTY', session: d, stage: 'open', timeframe: '1S', lockedAt: Date.parse(d),
    anchorPrice: 25000, path: [{ time: 1, value: 25000 }],
    postmortem: { verdict: verdict, callDir: said > 0 ? 1 : -1, said: { target: 25000 + said, pUpClose: said > 0 ? 60 : 40 },
                  did: { close: 25000 + did, pct: did / 250 }, errPts: did - said, errPct: (did - said) / 250,
                  reasons: why ? [{ kind: 'open', text: why }] : [] },
  });
  KT.core.store.set('fcLocks', [mk('2026-10-26', 80, 120, 'right'), mk('2026-10-27', 60, -90, 'wrong', 'Most of the miss was there at the open.'),
                                 mk('2026-10-28', -50, -20, 'right')]);
  const txt = KT.desk.recordText('NIFTY');
  ok('the desk reads where its line went wrong', /Right 2, wrong 1 of the last 3 judged sessions/.test(txt) &&
     /2026-10-27: said up/.test(txt) && /-150 points from the line/.test(txt) && /at the open/.test(txt), txt.split('\n')[0]);
  const F = KT.desk.gather({ symbol: 'NIFTY', timeframe: '1S', candles: minutes.slice(-400), quote: {}, indicators: {}, levels: {} }, { news: [] });
  const pr = KT.desk.prompts.final(F, [], null, '', '', txt);
  const pq = KT.desk.prompts.quick(F, '', '', txt);
  ok('and the final prompt carries it, in both modes', /own recent record/.test(pr.user) && /Right 2, wrong 1/.test(pr.user) &&
     /Right 2, wrong 1/.test(pq.user));
}

/* ======================================================================= */
section('STUDIES - the levels traders draw, and the rules measured');
{
  const KT = load(['config', 'core', 'indicators', 'studies'], { quiet: true });
  const St = KT.studies;
  const prev = { high: 110, low: 90, close: 105 };
  const cp = St.cpr(prev);
  ok('CPR from yesterday\'s high, low and close', cp.P === 101.67 && cp.BC === 100 && cp.TC === 103.33 && cp.widthPct === 3.28, JSON.stringify(cp));
  const pv = St.floorPivots(prev);
  ok('floor pivots', pv.R1 === 113.33 && pv.S1 === 93.33 && pv.R2 === 121.67 && pv.S2 === 81.67, JSON.stringify(pv));
  const cm = St.camarilla(prev);
  ok('Camarilla H3 and L4', cm.H3 === 110.5 && cm.L4 === 94, JSON.stringify(cm));
  ok('round numbers around NIFTY step by 100, with the 500s marked', (() => { const r = St.roundLevels(23041, 'NIFTY'); return r.length === 7 && r[3].price === 23000 && r.some(x => x.price === 23000 && x.strong); })());
  const oi = St.oiLevels({ ok: true, resistance: [{ strike: 24000 }], support: [{ strike: 21500 }], maxPain: 22700, pcrOi: 0.9, expiryDays: 4 });
  ok('the option walls are read from the chain the options lane reads', oi.callWall === 24000 && oi.putWall === 21500 && oi.maxPain === 22700);
  // A record built so each rule's answer is known: every day gaps up 0.5%
  // and gives the whole gap back by the close (a full fade, never filled
  // above), on a flat range.
  const days = [];
  let c = 1000;
  for (let i = 0; i < 300; i++) {
    const o = c * 1.005, cl = c * 0.999;
    const d = new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    days.push({ key: d, time: Math.floor(Date.parse(d + 'T03:45:00Z') / 1000), open: o, high: o * 1.001, low: cl * 0.999, close: cl });
    c = cl;
  }
  const m = St.measureRules(days, null);
  const rule = k => m.rules.filter(r => r.key === k)[0];
  ok('a gap up that always fades is measured as fading every time', rule('gap_up_fade').n >= 250 && rule('gap_up_fade').rate === 100, JSON.stringify(rule('gap_up_fade')));
  ok('and as filling every time', rule('gap_up_fill').rate === 100);
  ok('the gap follow-through slope is negative when gaps are given back', m.gapFollow && m.gapFollow.beta < -0.5, JSON.stringify(m.gapFollow));
  ok('a rule that never applies is counted as none, not as a rate', rule('gap_down_fill').n === 0 && rule('gap_down_fill').rate === null);
  const sess = St.sessionsOf([{ time: 1793251500, open: 1, high: 3, low: 0.5, close: 2 }, { time: 1793251560, open: 2, high: 4, low: 1, close: 3 },
                              { time: 1793337900, open: 3, high: 3.5, low: 2.5, close: 3.2 }]);
  ok('minute bars fold into one row a session', sess.length === 2 && sess[0].high === 4 && sess[0].close === 3 && sess[1].open === 3);
}

/* ======================================================================= */
section('DRIVERS - why it is moving');
{
  const KT = load(['config', 'core', 'indicators', 'levels', 'candles', 'patterns', 'structures', 'studies', 'data', 'analogs', 'vol', 'forecast', 'drivers'], { quiet: true });
  const D = KT.drivers;
  const L = (beta) => ({ n: 4800, beta: beta, corr: 0.3, hit: 61 });
  const world = [
    { key: 'NQ', live: 'nasdaq_fut', unit: 'pct', closesBefore: false, overnight: { gap: L(0.18), close: L(0.2) } },
    { key: 'ES', live: 'us_futures', unit: 'pct', closesBefore: false, overnight: { gap: L(0.3), close: L(0.35) } },
    { key: 'HANGSENG', live: 'hangseng', unit: 'pct', closesBefore: true, overnight: { gap: L(0.1), close: L(0.1) }, sameDay: L(0.22) },
    { key: 'US10Y', live: 'us10y', unit: 'points', closesBefore: false, overnight: { gap: L(-1), close: L(-1.5) } },
  ];
  const global = { items: {
    nasdaq_fut: { label: 'Nasdaq futures', price: 100, prevClose: 103.37, changePct: -3.26 },
    us_futures: { label: 'S&P 500 futures', price: 100, prevClose: 101.16, changePct: -1.15 },
    hangseng: { label: 'Hang Seng', price: 100, prevClose: 100.36, changePct: -0.36, hourPct: -0.2 },
    us10y: { label: 'US 10y yield', price: 4.53, prevClose: 4.59, changePct: -1.3 },
    copper: { label: 'Copper', price: 6.5, prevClose: 6.58, changePct: -1.19 },
  } };
  const ctx = { symbol: 'NIFTY', global: global, historyModel: { models: { NIFTY: { world: world } } }, prevClose: 23000, live: true,
                forecast: { lastClose: 23000, lanes: [] }, flows: { fii: { netCr: -944, date: '29-Oct-2026' } } };
  const ex = D.explain(ctx);
  const row = id => ex.world.rows.filter(r => r.id === id)[0];
  ok('a market\'s push is its measured link times its move, in points', row('nasdaq_fut').pushPts === Math.round(0.2 * -3.26 / 100 * 23000), String(row('nasdaq_fut').pushPts));
  ok('a market that closes before NSE is read on the same day once NSE trades', row('hangseng').link.kind === 'same day' && row('hangseng').link.beta === 0.22);
  ok('a yield is read in points, not percent', row('us10y').unit === 'points' && Math.abs(row('us10y').move + 0.06) < 1e-9 && row('us10y').pushPts > 0);
  ok('one move counted once: a group is worth its strongest link, not the sum', ex.world.explainedPts === row('nasdaq_fut').pushPts + row('hangseng').pushPts + row('us10y').pushPts,
     ex.world.explainedPts + ' vs ' + [row('nasdaq_fut').pushPts, row('us_futures').pushPts, row('hangseng').pushPts, row('us10y').pushPts].join(','));
  ok('a market with no measured link claims no points, only its usual direction', row('copper').pushPts === null && row('copper').dir === -1 && !row('copper').measured);
  ok('FII selling stays on the card next to the measured pushes', ex.dragging.some(x => x.id === 'fii'));
  const pre = D.explain(Object.assign({}, ctx, { live: false }));
  ok('before the open the link is the one to the opening gap', pre.world.rows.filter(r => r.id === 'us_futures')[0].link.kind === 'overnight, to the open');
}

/* ======================================================================= */
section('REASONS - what the world did in the same window');
{
  const KT = kt(lastDay + 'T12:00:00');
  const c = upTo(lastDay).slice(-120);
  const t0 = c[0].time;
  // A Hang Seng fall planted across the whole window, nothing else moving.
  const tape = [];
  for (let t = Math.floor(t0 / 300) * 300 - 600; t <= c[c.length - 1].time + 600; t += 300) {
    tape.push({ t: t, v: { hangseng: 20000 * (1 - (t - t0) / 3600 * 0.01), crude: 80 } });
  }
  const rs = KT.engine.buildReasons(c, [], '1D', tape);
  ok('a notable window names the market abroad that moved with it', rs.some(r => r.world && r.world.length && r.world[0].key === 'hangseng' && /Hang Seng -/.test(r.text)),
     rs.filter(r => r.world && r.world.length).length + ' of ' + rs.length + ' points');
  const bare = KT.engine.buildReasons(c, [], '1D');
  ok('without the tape the points are what they were', bare.every(r => !r.world || !r.world.length));
}

/* ======================================================================= */
section('LEARN - the gap, from the daily view\'s calls too');
{
  const KT = kt(lastDay + 'T17:00:00');
  const day = i => '2026-0' + (7 + Math.floor(i / 28)) + '-' + String(1 + (i % 28)).padStart(2, '0');
  const row = (i, tf, said, did) => ({
    id: 'NIFTY:' + day(i) + ':' + tf + ':advance', symbol: 'NIFTY', session: day(i), stage: 'advance', timeframe: tf,
    lockedAt: 1000 + i, anchorPrice: 25000, openPrice: 25000, target: 25000 * (1 + said / 100), path: [{ time: 100 + i, value: 25000 }],
    outcome: { closeActual: 25000 * (1 + did / 100) },
    postmortem: { said: { open: 25000, target: 25000 * (1 + said / 100) }, did: { open: 25000, close: 25000 * (1 + did / 100), pct: did }, verdict: 'wrong' },
  });
  const alt = i => (i % 2 ? 1 : -1) * (0.3 + (i % 5) * 0.05);
  KT.core.store.set('fcLocks', Array.from({ length: 12 }, (_, i) => row(i, '1D', alt(i), -alt(i))));
  const fit = KT.learn.closeFitFrom('NIFTY');
  ok('a browser\'s daily-view calls count toward the fit', fit.n === 12 && fit.raw === -1 && fit.gain === KT.learn.MIN_GAIN, JSON.stringify(fit));
  KT.core.store.set('fcLocks', Array.from({ length: 12 }, (_, i) => row(i, '1H', alt(i), -alt(i))));
  ok('an hourly-view call does not: it is not a claim about the session', KT.learn.closeFitFrom('NIFTY').n === 0);
  KT.core.store.set('fcLocks', Array.from({ length: 14 }, (_, i) => row(i, '1D', alt(i), -alt(i) * 0.5)));
  const chk = KT.learn.closeFitCheck('NIFTY');
  ok('the check scores each session with itself left out, and a line that keeps pointing the wrong way is helped by the learned size',
     chk.n === 14 && chk.learned < chk.base && chk.intradayRight === 0 && chk.intradayCalls === 14, JSON.stringify(chk));
}

/* ======================================================================= */
section('DAILY CALL - a replayed evening, morning and evening');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-calls-'));
  fs.mkdirSync(path.join(tmp, 'data')); fs.mkdirSync(path.join(tmp, 'config'));
  ['events.json', 'constituents.json', 'seasonality.json', 'flows.json', 'options.json', 'quote.json', 'candles_SENSEX_1H.json']
    .forEach(f => { try { fs.copyFileSync(path.join(ROOT, 'data', f), path.join(tmp, 'data', f)); } catch (e) { /* optional */ } });
  fs.copyFileSync(path.join(ROOT, 'config/lexicon.json'), path.join(tmp, 'config/lexicon.json'));
  const writeTape = key => fs.writeFileSync(path.join(tmp, 'data/candles_NIFTY_1H.json'), JSON.stringify({
    candles: minuteRaw.candles.filter(r => istKey(r[0]) <= key) }));
  const sensex = readJSON('data/candles_SENSEX_1H.json', null);
  const writeSensex = key => sensex && fs.writeFileSync(path.join(tmp, 'data/candles_SENSEX_1H.json'), JSON.stringify({
    candles: sensex.candles.filter(r => istKey(r[0]) <= key) }));
  const runAt = iso => execFileSync(process.execPath, [path.join(__dirname, 'daily_call.js'), '--now', iso + IST],
                                    { env: Object.assign({}, process.env, { KT_DATA_ROOT: tmp }), encoding: 'utf8' });
  const rec = () => JSON.parse(fs.readFileSync(path.join(tmp, 'data/calls.json'), 'utf8'));
  try {
    writeTape(prevDay); writeSensex(prevDay);
    runAt(prevDay + 'T16:40:00');
    let r = rec();
    const ids = r.symbols.NIFTY.rows.map(x => x.id);
    ok('the evening run freezes the next session', ids.length === 1 && ids[0] === 'NIFTY:' + lastDay + ':1S:advance:wf', ids.join());
    ok('with its minute path packed', r.symbols.NIFTY.rows[0].pp && r.symbols.NIFTY.rows[0].pp.v.length > 300);
    runAt(lastDay + 'T08:31:00');
    r = rec();
    ok('the morning run adds the pre-open call', r.symbols.NIFTY.rows.length === 2 && r.run.frozen.indexOf('NIFTY:' + lastDay + ':1S:open:wf') !== -1);
    writeTape(lastDay); writeSensex(lastDay);
    runAt(lastDay + 'T16:42:00');
    r = rec();
    const judged = r.symbols.NIFTY.rows.filter(x => x.session === lastDay);
    ok('the next evening judges both calls', judged.length === 2 && judged.every(x => x.outcome && x.postmortem), judged.map(x => x.id).join());
    ok('and freezes the session after', r.symbols.NIFTY.rows.some(x => x.session > lastDay && x.stage === 'advance'));
    ok('one lesson per symbol for the day', r.lessons.filter(l => l.symbol === 'NIFTY').length === 1 &&
       /:open:wf$/.test(r.lessons.filter(l => l.symbol === 'NIFTY')[0].runId));
    ok('the record keeps its stats', r.symbols.NIFTY.stats && r.symbols.NIFTY.stats.sessions === 1 &&
       r.symbols.NIFTY.stats.open.n === 1);
    ok('and what it has learned', r.learned && r.learned.fittedThrough === lastDay && r.learned.samples === 1 && r.learned.weights === null);
    ok('including how far its closes were from the line', r.symbols.NIFTY.stats.close.n === 1 && r.symbols.NIFTY.stats.close.maePts >= 0 &&
       r.learned.closeSamples === 1 && r.learned.closeGain === 1);

    // The training log, written from the record the way the workflow does.
    const logDir = path.join(tmp, 'tlog');
    const runLog = () => execFileSync(process.execPath, [path.join(__dirname, 'training_log.js'), '--out', logDir],
                                      { env: Object.assign({}, process.env, { KT_DATA_ROOT: tmp }), encoding: 'utf8' });
    const out1 = runLog();
    const TL = require('./training_log');
    const ev = TL.readEvents(logDir);
    const kinds = k => ev.filter(e => e.event === k);
    const nRows = Object.keys(r.symbols).reduce((t, k) => t + r.symbols[k].rows.length, 0);
    ok('the training log takes every call, every judgement and the run', kinds('frozen').length === nRows &&
       kinds('judged').length >= 2 && kinds('run').length === 1, out1.trim());
    const jd = kinds('judged').filter(e => e.symbol === 'NIFTY' && e.stage === 'open')[0];
    ok('a judgement carries the gap between line and market every fifteen minutes', jd && jd.gap && jd.gap.length >= 20 &&
       jd.gap.every(g => /^\d\d:\d\d$/.test(g[0])) && jd.gap.filter(g => g[2] != null).length >= 20 && typeof jd.errPts === 'number' &&
       jd.worstGap && typeof jd.worstGap.off === 'number', jd ? jd.gap.length + ' points, widest ' + JSON.stringify(jd.worstGap) : 'none');
    const fz = jd && kinds('frozen').filter(e => e.id === jd.id)[0];
    ok('and the frozen call it joins carries every input and its line', fz && fz.lanes.length >= 3 && fz.line.length >= 20 &&
       fz.call && fz.call.pUpClose != null && fz.context && fz.context.fp);
    const summary = fs.readFileSync(path.join(logDir, 'summary.md'), 'utf8');
    ok('the summary reads the record in plain words', /## NIFTY/.test(summary) && /\| Judged sessions \| 1 \|/.test(summary) &&
       /The last session, newest first/.test(summary) && fs.existsSync(path.join(logDir, 'README.md')));
    const out2 = runLog();
    ok('a second run writes nothing twice', TL.readEvents(logDir).length === ev.length && /: 0 new events/.test(out2), out2.trim());
    const before = JSON.stringify(r.symbols);
    runAt(lastDay + 'T17:30:00');
    ok('a second run on the same evening changes nothing', JSON.stringify(rec().symbols) === before);
    // A copy of the record from main, missing a judgement and holding one older session.
    const main = JSON.parse(JSON.stringify(r));
    main.symbols.NIFTY.rows.forEach(x => { if (x.session === lastDay) { delete x.outcome; delete x.postmortem; } });
    main.symbols.NIFTY.rows.push(Object.assign({}, main.symbols.NIFTY.rows[main.symbols.NIFTY.rows.length - 1],
      { id: 'NIFTY:' + prevDay + ':1S:advance:wf', session: prevDay }));
    fs.writeFileSync(path.join(tmp, 'main.json'), JSON.stringify(main));
    execFileSync(process.execPath, [path.join(__dirname, 'daily_call.js'), '--now', lastDay + 'T17:45:00' + IST, '--also', path.join(tmp, 'main.json')],
                 { env: Object.assign({}, process.env, { KT_DATA_ROOT: tmp }), encoding: 'utf8' });
    r = rec();
    ok('merging main\'s copy keeps the judged rows and adds the missing one',
       r.symbols.NIFTY.rows.filter(x => x.session === lastDay).every(x => x.postmortem) &&
       r.symbols.NIFTY.rows.some(x => x.id === 'NIFTY:' + prevDay + ':1S:advance:wf'));
  } catch (e) {
    ok('the replay ran', false, String(e && e.stack || e).slice(0, 400));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

asyncChecks.reduce((p, fn) => p.then(fn).catch(e => ok('an async check threw', false, String(e && e.stack || e))), Promise.resolve())
  .then(() => {
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exitCode = fail ? 1 : 0;
  });
