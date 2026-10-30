/* ============================================================================
   The training log: every frozen call and every judgement, kept for good.

   data/calls.json is the record the page reads, and it is trimmed to stay
   small (scripts/daily_call.js): after a few sessions a call loses its lane
   notes, its cue prices and its minute line. That is right for a file every
   browser downloads and wrong for learning, where the inputs of a call made
   two months ago are exactly what is needed to see why it missed.

   So the workflow also appends each call to a log on its own branch,
   `training-log`, which is never force-pushed and never served by the site:

     log/YYYY-MM.jsonl   one JSON object per line, three kinds of event
                         frozen   a call when it was frozen: what it said, the
                                  odds, its ranges, every input's push and
                                  note, the cue prices, the situation, the
                                  learned knobs it was made with, its line
                                  every fifteen minutes
                         judged   the same call after the close: what the
                                  session did, the gap between line and
                                  market every fifteen minutes, the verdict,
                                  the reasons it missed, which inputs pointed
                                  the right way, the lesson it filed
                         run      one a workflow run: what it froze and
                                  judged, and what the record had learned
     summary.md          the record so far in plain words and tables,
                         rewritten every run: read this first
     README.md           what is here and how the events join (by id)
     state.json          counts of what the log holds

   Written by .github/workflows/history.yml through scripts/training_log.sh,
   right after daily_call.js. Never throws; a failed run leaves the log as it
   was, and the next run picks up whatever it missed (it logs every row the
   record holds that the log does not).

   Run:  node scripts/training_log.js --out <checkout of the training-log branch>
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { load, readJSON } = require('./ktvm');

const SCHEMA = 1;
const SYMBOLS = ['NIFTY', 'SENSEX'];
const STEP_MIN = 15;              // the line and the gap, every fifteen minutes
const IST_SEC = 19800;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}
function round(n, d) { const p = Math.pow(10, d || 0); return Math.round(n * p) / p; }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function iso(ms) { return isNum(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null; }
function hm(sec) { return new Date((sec + IST_SEC) * 1000).toISOString().slice(11, 16); }
function istMin(sec) { const d = new Date((sec + IST_SEC) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); }

function unpack(r) {
  if (!r || r.path || !r.pp || !Array.isArray(r.pp.v)) return r;
  const c = Object.assign({}, r);
  c.path = r.pp.v.map((v, i) => ({ time: r.pp.t0 + i * r.pp.dt, value: v }));
  delete c.pp;
  return c;
}

function candlesOf(sym) {
  const j = readJSON('data/candles_' + sym + '_1H.json', null);
  if (!j || !Array.isArray(j.candles)) return [];
  return j.candles.filter(r => r && r[4] > 0).map(r => ({ time: r[0], close: r[4] }));
}
// The bar whose minute holds t (ledger.js barAt, the same rule).
function closeAt(candles, t) {
  let lo = 0, hi = candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 && t < candles[best].time + 60 ? candles[best].close : null;
}

// The line at every quarter hour of the session, and its last point.
function quarterPoints(p) {
  if (!Array.isArray(p) || !p.length) return [];
  const out = p.filter(pt => istMin(pt.time) % STEP_MIN === 0);
  const last = p[p.length - 1];
  if (!out.length || out[out.length - 1].time !== last.time) out.push(last);
  return out;
}

/* ------------------------------------------------------------- events */
function frozenEvent(KT, r) {
  const end = r.end || {};
  const fp = r.ctx && r.ctx.fp;
  let situation = null;
  try { situation = fp && KT.lessons ? KT.lessons.describe(KT.lessons.fingerprint(fp)) || null : null; } catch (e) { situation = null; }
  return {
    event: 'frozen', v: SCHEMA, id: r.id, symbol: r.symbol, session: r.session, stage: r.stage,
    timeframe: r.timeframe, source: r.source || null, lockedAt: iso(r.lockedAt),
    anchor: { time: isNum(r.anchorTime) ? hm(r.anchorTime) : null, price: r.anchorPrice },
    call: {
      dir: KT.ledger && KT.ledger.callDirOf ? KT.ledger.callDirOf(r) : null,
      pUpClose: isNum(end.pUpClose) ? end.pUpClose : null,
      direction: r.direction || null, confidence: isNum(r.confidence) ? r.confidence : null,
      open: isNum(r.openPrice) ? round(r.openPrice, 2) : null,
      openGapPct: isNum(r.openGapPct) ? r.openGapPct : null,
      target: isNum(r.target) ? round(r.target, 2) : null,
      targetPct: isNum(r.targetPct) ? r.targetPct : null,
      low68: isNum(end.low68) ? end.low68 : null, high68: isNum(end.high68) ? end.high68 : null,
      low95: isNum(end.low95) ? end.low95 : null, high95: isNum(end.high95) ? end.high95 : null,
    },
    lanes: (r.lanes || []).map(l => ({ id: l.id, c: l.contribution, note: String(l.note || '').slice(0, 200) })),
    openParts: (r.openParts || []).slice(0, 5),
    context: r.ctx ? { at: r.ctx.at || null, cues: r.ctx.cues || null, fii: r.ctx.fii || null, dii: r.ctx.dii || null, fp: fp || null } : null,
    situation: situation,
    headline: r.topHeadline || null,
    learned: r.learned || null,
    line: quarterPoints(r.path).map(pt => [hm(pt.time), round(pt.value, 2)]),
    trimmed: !!r.compact,
  };
}

function judgedEvent(r, candles) {
  const p = r.postmortem, o = r.outcome || {};
  let worst = null;
  const gap = quarterPoints(r.path).map(pt => {
    const did = closeAt(candles, pt.time);
    const off = did != null ? round(did - pt.value, 2) : null;
    if (off != null && (!worst || Math.abs(off) > Math.abs(worst.off))) worst = { at: hm(pt.time), off: off };
    return [hm(pt.time), round(pt.value, 2), did != null ? round(did, 2) : null, off];
  });
  return {
    event: 'judged', v: SCHEMA, id: r.id, symbol: r.symbol, session: r.session, stage: r.stage,
    verdict: p.verdict, right: p.right, callDir: p.callDir, moveDir: p.moveDir,
    said: p.said, did: p.did, errPts: p.errPts, errPct: p.errPct, openErrPts: p.openErrPts,
    inside68: p.inside68, inside95: p.inside95,
    reasons: (p.reasons || []).map(x => ({ kind: x.kind, text: String(x.text || '').slice(0, 260) })),
    lanesRight: ((p.lanes && p.lanes.right) || []).map(l => l.id),
    lanesWrong: ((p.lanes && p.lanes.wrong) || []).map(l => l.id),
    turn: isNum(p.turn) ? hm(p.turn) : null,
    summary: p.summary || null, lesson: p.lesson || null,
    session_line: { mae: o.mae, maePct: o.maePct, skill: o.skill, directionRate: o.directionRate,
                    points: o.n, of: o.total },
    worstGap: worst,
    gap: candles.length ? gap : null,     // [time, line, market, market minus line]
  };
}

function runEvent(rec) {
  const L = rec.learned || {};
  const run = rec.run || {};
  return {
    event: 'run', v: SCHEMA, at: rec.generated_at || null,
    frozen: run.frozen || [], settled: run.settled || [], judged: run.judged || [], notes: (run.notes || []).slice(0, 12),
    learned: {
      samples: L.samples || 0, weights: L.weights || null,
      openGain: L.openGain, openSamples: L.openSamples,
      closeGain: L.closeGain, closeBias: L.closeBias, closeSamples: L.closeSamples, closeRaw: L.closeRaw, closeT: L.closeT,
      held: (L.held || []).slice(0, 12),
    },
    stats: SYMBOLS.reduce((o, s) => { o[s] = rec.symbols && rec.symbols[s] ? rec.symbols[s].stats || null : null; return o; }, {}),
  };
}

/* ------------------------------------------------------------- storage */
function readEvents(dir) {
  const logDir = path.join(dir, 'log');
  if (!fs.existsSync(logDir)) return [];
  const out = [];
  fs.readdirSync(logDir).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().forEach(f => {
    fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').forEach(line => {
      if (!line.trim()) return;
      try { out.push(JSON.parse(line)); } catch (e) { /* a torn line is skipped, never fatal */ }
    });
  });
  return out;
}
function keyOf(e) { return e.event + '|' + (e.event === 'run' ? e.at : e.id); }
function monthOf(e) {
  if (e.session) return e.session.slice(0, 7);
  return String(e.at || new Date().toISOString()).slice(0, 7);
}

/* ------------------------------------------------------------- summary */
function pct(v, d) { return isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(d == null ? 2 : d) + '%' : 'n/a'; }
function pts(v) { return isNum(v) ? (v > 0 ? '+' : '') + Math.round(v) : 'n/a'; }
function px(v) { return isNum(v) ? Math.round(v).toLocaleString('en-IN') : 'n/a'; }

// One judged call a session, the one it is judged on: pre-open over day-before.
function bySession(judged) {
  const by = {};
  judged.forEach(e => {
    const k = e.symbol + '|' + e.session;
    const rank = x => (x.stage === 'open' ? 1 : 0);
    if (!by[k] || rank(e) > rank(by[k])) by[k] = e;
  });
  return Object.keys(by).map(k => by[k]).sort((a, b) => (a.session < b.session ? 1 : a.session > b.session ? -1 : 0));
}

function summarise(events) {
  const frozen = {}, judgedAll = [], runs = [];
  events.forEach(e => {
    if (e.event === 'frozen') frozen[e.id] = e;
    else if (e.event === 'judged') judgedAll.push(e);
    else if (e.event === 'run') runs.push(e);
  });
  const judged = bySession(judgedAll);
  const L = [];
  const last = runs.length ? runs[runs.length - 1] : null;
  L.push('# Training log: where the calls went right and wrong', '');
  L.push('Rewritten by `scripts/training_log.js` after every run of the history workflow' +
         (last && last.at ? ' (last: ' + last.at + ')' : '') + '. Not served by the site. ' +
         'Every number here is recomputed from `log/*.jsonl`; README.md has the schema.', '');
  const nf = Object.keys(frozen).length;
  L.push(nf + ' call' + (nf === 1 ? '' : 's') + ' frozen, ' + judgedAll.length + ' judged, ' + runs.length + ' run' + (runs.length === 1 ? '' : 's') + ' logged.', '');

  SYMBOLS.forEach(sym => {
    const rows = judged.filter(e => e.symbol === sym);
    L.push('## ' + sym, '');
    if (!rows.length) { L.push('No judged session yet.', ''); return; }
    let right = 0, wrong = 0, flat = 0, up = 0, moved = 0, abs = 0, absPts = 0, net = 0, m = 0, in68 = 0, n68 = 0, in95 = 0, n95 = 0, openAbs = 0, openN = 0;
    rows.forEach(e => {
      if (e.verdict === 'right') right++; else if (e.verdict === 'wrong') wrong++; else flat++;
      if (e.did && isNum(e.did.pct) && Math.abs(e.did.pct) >= 0.02) { moved++; if (e.did.pct > 0) up++; }
      if (isNum(e.errPct)) { abs += Math.abs(e.errPct); absPts += Math.abs(e.errPts || 0); net += e.errPct; m++; }
      if (e.inside68 != null) { n68++; if (e.inside68) in68++; }
      if (e.inside95 != null) { n95++; if (e.inside95) in95++; }
      if (isNum(e.openErrPts)) { openAbs += Math.abs(e.openErrPts); openN++; }
    });
    L.push('| | |', '| --- | --- |');
    L.push('| Judged sessions | ' + rows.length + ' |');
    L.push('| Right / wrong / no lean or flat | ' + right + ' / ' + wrong + ' / ' + flat + ' |');
    L.push('| "Always up" would have been right | ' + up + ' of ' + moved + ' |');
    if (m) {
      L.push('| Close off the line, average | ' + Math.round(absPts / m) + ' points (' + (abs / m).toFixed(2) + '%) |');
      L.push('| Net miss (market minus line) | ' + pct(net / m) + (Math.abs(net / m) < 0.05 ? ', no lean' : net > 0 ? ', the market closed above the line' : ', the market closed below the line') + ' |');
    }
    if (n68) L.push('| Close inside its likely range (68%) | ' + in68 + ' of ' + n68 + ' |');
    if (n95) L.push('| Close inside its wide range (95%) | ' + in95 + ' of ' + n95 + ' |');
    if (openN) L.push('| Open off the call, average | ' + Math.round(openAbs / openN) + ' points |');
    L.push('');

    const shown = Math.min(20, rows.length);
    L.push((shown === 1 ? 'The last session' : 'The last ' + shown + ' sessions') + ', newest first (the call each session is judged on):', '');
    L.push('| Session | Call | Odds up | Line said | Closed | Off by | Verdict | First reason |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    rows.slice(0, 20).forEach(e => {
      const said = e.callDir > 0 ? 'up' : e.callDir < 0 ? 'down' : 'no lean';
      const why = e.verdict === 'right' ? '' : (e.reasons && e.reasons[0] ? e.reasons[0].text.replace(/\|/g, '/').slice(0, 110) : '');
      L.push('| ' + e.session + ' | ' + said + ' (' + e.stage + ') | ' + (e.said && isNum(e.said.pUpClose) ? e.said.pUpClose + '%' : 'n/a') +
             ' | ' + px(e.said && e.said.target) + ' | ' + px(e.did && e.did.close) + ' (' + pct(e.did && e.did.pct) + ')' +
             ' | ' + pts(e.errPts) + ' | ' + e.verdict + ' | ' + why + ' |');
    });
    L.push('');

    // Situations, from the frozen call's context.
    const sit = {};
    rows.forEach(e => {
      const f = frozen[e.id];
      const fp = f && f.context && f.context.fp;
      if (!fp || e.right == null) return;
      const tags = [];
      if (f.situation) f.situation.split(', ').forEach(t => tags.push(t));
      tags.forEach(t => {
        const s = (sit[t] = sit[t] || { n: 0, right: 0 });
        s.n++; if (e.right) s.right++;
      });
    });
    const sitRows = Object.keys(sit).filter(k => sit[k].n >= 2).sort((a, b) => sit[b].n - sit[a].n);
    if (sitRows.length) {
      L.push('By the situation the call was made in (two or more sessions):', '');
      L.push('| Situation | Sessions | Right |', '| --- | --- | --- |');
      sitRows.slice(0, 16).forEach(k => L.push('| ' + k + ' | ' + sit[k].n + ' | ' + sit[k].right + ' (' + Math.round(sit[k].right / sit[k].n * 100) + '%) |'));
      L.push('');
    }
  });

  // Why it missed, over every wrong call.
  const why = {};
  judged.filter(e => e.verdict === 'wrong').forEach(e => (e.reasons || []).forEach(x => { why[x.kind] = (why[x.kind] || 0) + 1; }));
  const WORDS = { open: 'most of the miss was already there at the open', cues: 'the overnight cues moved after the freeze',
                  news: 'strong news after the freeze', flows: 'FII flows that day', size: 'a bigger move than its own range',
                  turn: 'the session turned against the line', signals: 'its own inputs pointed the wrong way', event: 'an event on the calendar' };
  const whyKeys = Object.keys(why).sort((a, b) => why[b] - why[a]);
  L.push('## Why the wrong calls missed', '');
  if (!whyKeys.length) L.push('No wrong call yet.');
  whyKeys.forEach(k => L.push('- ' + (WORDS[k] || k) + ': ' + why[k]));
  L.push('');

  // Inputs: how often each pointed the way the session went.
  const lane = {};
  judged.forEach(e => {
    (e.lanesRight || []).forEach(id => { (lane[id] = lane[id] || { r: 0, w: 0 }).r++; });
    (e.lanesWrong || []).forEach(id => { (lane[id] = lane[id] || { r: 0, w: 0 }).w++; });
  });
  const laneKeys = Object.keys(lane).sort((a, b) => (lane[b].r + lane[b].w) - (lane[a].r + lane[a].w));
  L.push('## Inputs: pointed the way the session went', '');
  if (!laneKeys.length) L.push('Nothing judged yet.');
  else {
    L.push('| Input | Right way | Wrong way | Rate |', '| --- | --- | --- | --- |');
    laneKeys.forEach(k => {
      const x = lane[k], n = x.r + x.w;
      L.push('| ' + k + ' | ' + x.r + ' | ' + x.w + ' | ' + Math.round(x.r / n * 100) + '% |');
    });
  }
  L.push('');

  // The biggest gaps, which are the sessions most worth reading in full.
  const big = judged.filter(e => isNum(e.errPts)).sort((a, b) => Math.abs(b.errPts) - Math.abs(a.errPts)).slice(0, 5);
  if (big.length) {
    L.push('## The five biggest gaps between line and close', '');
    big.forEach(e => L.push('- ' + e.symbol + ' ' + e.session + ' (' + e.stage + '): ' + pts(e.errPts) + ' points. ' +
                            (e.summary || '') + (e.worstGap ? ' Widest at ' + e.worstGap.at + ' (' + pts(e.worstGap.off) + ').' : '') +
                            ' id `' + e.id + '`'));
    L.push('');
  }

  if (last) {
    const l = last.learned || {};
    L.push('## What the record had learned at the last run', '');
    L.push('- judged sessions behind the fit: ' + (l.samples || 0));
    L.push('- opening gap gain: ' + (isNum(l.openGain) ? l.openGain : 1) + ' from ' + (l.openSamples || 0) + ' opens');
    L.push('- session move size: ' + (isNum(l.closeGain) ? l.closeGain : 1) + ', lean ' + (isNum(l.closeBias) ? pct(l.closeBias) : '0%') +
           ' from ' + (l.closeSamples || 0) + ' sessions' + (isNum(l.closeRaw) ? ' (raw slope ' + l.closeRaw + (isNum(l.closeT) ? ', lean t ' + l.closeT : '') + ')' : ''));
    if (l.weights) L.push('- lane weights: ' + Object.keys(l.weights).map(k => k + ' ' + l.weights[k]).join(', '));
    else L.push('- lane weights: the starting set (nothing has cleared its evidence bar yet)');
    if (last.notes && last.notes.length) L.push('- notes from that run: ' + last.notes.join(' | '));
    L.push('');
  }
  return L.join('\n');
}

const README = [
  '# training-log',
  '',
  'Every session call the terminal froze and how it went, appended by the history',
  'workflow (`scripts/training_log.js`, run from `.github/workflows/history.yml`',
  'right after `scripts/daily_call.js`). This branch is never force-pushed and the',
  'site never reads it. It exists so the record can be studied and learned from:',
  'by a person, by a training script, or by Claude.',
  '',
  '## Read this first',
  '',
  '`summary.md`: the record in plain words, the last twenty sessions, why the',
  'wrong calls missed, which inputs pointed the right way, the biggest gaps and',
  'what the model had learned at the last run. Rewritten every run.',
  '',
  '## The log',
  '',
  '`log/YYYY-MM.jsonl`, one JSON object a line, filed by the month of the session.',
  'Three kinds, joined by `id` (the call\'s id, e.g. `NIFTY:2026-11-02:1S:open:wf`):',
  '',
  '- `frozen`: the call as it was frozen. `call` (direction `dir` 1/0/-1 from the',
  '  odds, `pUpClose` the odds of closing above the last close, the open it',
  '  expected, the line\'s end `target`, the 68% and 95% ranges), `lanes` (every',
  '  input that reported: its push on the line `c` and its note), `openParts`',
  '  (what drove the opening call), `context` (cue prices, FII and DII cash, the',
  '  raw situation `fp`), `situation` (the same in words), `headline` (the',
  '  strongest headline at the freeze), `learned` (the move size `g` and lean `b`',
  '  it was drawn with), `line` (the line every fifteen minutes, IST).',
  '- `judged`: the same call after the close. `verdict` (right, wrong, flat,',
  '  no-call), `said` and `did` (open, close, high, low, move), `errPts` and',
  '  `errPct` (close minus the line\'s end), `inside68`/`inside95`, `reasons` (what',
  '  it did not know, as facts with times: the open, cues after the freeze, news,',
  '  flows, size, the turn, its own inputs, the calendar), `lanesRight` and',
  '  `lanesWrong`, `turn` (when the two lines parted for good), `lesson` (what it',
  '  filed for next time), `session_line` (mean absolute error of the whole line',
  '  and its skill against "price stays put", below 1 is better), `gap` (every',
  '  fifteen minutes: time, line, market, market minus line) and `worstGap`.',
  '- `run`: one a workflow run. What it froze, settled and judged, its notes, and',
  '  what the record had learned (lane weights, opening gap gain, move size and',
  '  lean with their samples) plus the per-symbol stats.',
  '',
  'Each session has up to two calls: `advance` (frozen the evening before) and',
  '`open` (frozen before the open). The page judges a session on the `open` call',
  'when there is one.',
  '',
  '## How the calls are made',
  '',
  'The forecast is arithmetic over weighted inputs (`assets/js/forecast.js`), the',
  'judgement is `assets/js/postmortem.js`, and the learning is',
  '`assets/js/learn.js`. `docs/calls.md` on `main` explains all three.',
  '',
  '`state.json` counts what the log holds. A rerun never writes an event twice:',
  'the writer reads the log itself before appending.',
  '',
].join('\n');

/* ------------------------------------------------------------------ run */
function main() {
  const out = arg('--out');
  if (!out) { console.log('usage: node scripts/training_log.js --out <dir>'); process.exitCode = 2; return; }
  const rec = readJSON('data/calls.json', null);
  if (!rec || !rec.symbols) { console.log('no data/calls.json, nothing to log'); return; }
  const KT = load(['config', 'core', 'lessons', 'postmortem', 'ledger'], { quiet: true });

  fs.mkdirSync(path.join(out, 'log'), { recursive: true });
  const existing = readEvents(out);
  const seen = {};
  existing.forEach(e => { seen[keyOf(e)] = true; });

  const fresh = [];
  SYMBOLS.forEach(sym => {
    const s = rec.symbols[sym];
    if (!s || !Array.isArray(s.rows)) return;
    const candles = candlesOf(sym);
    s.rows.map(unpack).sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : a.lockedAt - b.lockedAt))
      .forEach(r => {
        if (!r || !r.id) return;
        if (!seen['frozen|' + r.id]) {
          const e = frozenEvent(KT, r);
          fresh.push(e); seen[keyOf(e)] = true;
        }
        if (r.postmortem && !seen['judged|' + r.id]) {
          const e = judgedEvent(r, candles);
          fresh.push(e); seen[keyOf(e)] = true;
        }
      });
  });
  if (rec.generated_at && !seen['run|' + rec.generated_at]) {
    const e = runEvent(rec);
    fresh.push(e); seen[keyOf(e)] = true;
  }

  const byMonth = {};
  fresh.forEach(e => { (byMonth[monthOf(e)] = byMonth[monthOf(e)] || []).push(JSON.stringify(e)); });
  Object.keys(byMonth).forEach(m => {
    fs.appendFileSync(path.join(out, 'log', m + '.jsonl'), byMonth[m].join('\n') + '\n');
  });

  const all = existing.concat(fresh);
  fs.writeFileSync(path.join(out, 'summary.md'), summarise(all) + '\n');
  fs.writeFileSync(path.join(out, 'README.md'), README);
  fs.writeFileSync(path.join(out, 'state.json'), JSON.stringify({
    v: SCHEMA, updatedAt: new Date().toISOString(), events: all.length,
    frozen: all.filter(e => e.event === 'frozen').length,
    judged: all.filter(e => e.event === 'judged').length,
    runs: all.filter(e => e.event === 'run').length,
  }, null, 1) + '\n');
  const kinds = fresh.reduce((o, e) => { o[e.event] = (o[e.event] || 0) + 1; return o; }, {});
  console.log('training log: ' + fresh.length + ' new event' + (fresh.length === 1 ? '' : 's') +
              (fresh.length ? ' (' + Object.keys(kinds).map(k => kinds[k] + ' ' + k).join(', ') + ')' : '') +
              ', ' + all.length + ' in all');
}

if (require.main === module) {
  try { main(); } catch (e) { console.log('training log failed: ' + (e && e.stack || e)); process.exitCode = 1; }
}
module.exports = { frozenEvent, judgedEvent, runEvent, summarise, quarterPoints, readEvents, keyOf };
