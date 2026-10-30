/* ============================================================================
   Why the line and the market parted.

   The frozen call for a session (ledger.lock) is judged once the session is
   over (ledger.settleLocks). This file writes the judgement down in words:
   right or wrong, by how much, and what the call did not know when it was
   frozen.

   The rule this project holds everywhere else holds here too: an invented
   cause is the same sin in prose as an invented number. So every reason
   below is a checkable fact with a time on it, never a claim that it caused
   the move:

     open     how much of the miss was already there at 09:15
     cues     what GIFT Nifty, US futures, crude, the rupee and the rest did
              between the moment the call was frozen and the close
     news     strong, index-relevant headlines that landed after the freeze
              and pointed the way price went
     flows    FII cash that day, when it pushed the same way
     size     a move bigger than the range the call gave itself
     turn     the minute the two lines parted for good
     signals  which of the call's own inputs pointed the wrong way
     event    expiry, a scheduled release, a holiday next door

   The same module runs in the browser and in the workflow's call runner, so
   a session judged on the owner's laptop and in GitHub Actions reads the same.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core, fmt = core.fmt;

  var VERSION = 1;
  var FLAT_PCT = 0.02;              // the dead zone callOf()/scoreRow() use
  var FRESH_SEC = 8 * 3600;         // cue changes only if judged this soon after the close

  /* A cue move worth naming, in percent (bps for the US 10y). Roughly one
     ordinary day's move for each instrument: smaller than this is weather. */
  var CUE_MOVE = {
    gift_nifty: 0.4, us_futures: 0.6, nasdaq_fut: 0.8, dow_fut: 0.6,
    nikkei: 1.0, hangseng: 1.2, ftse: 0.8, crude: 2.0, gold: 1.5,
    usdinr: 0.25, dxy: 0.4, us10y: 8, cboe_vix: 8, vix: 6,
  };
  // Which way a rise in each cue pushes NIFTY. Gold is not given a side.
  var CUE_SIGN = {
    gift_nifty: 1, us_futures: 1, nasdaq_fut: 1, dow_fut: 1, nikkei: 1, hangseng: 1, ftse: 1,
    crude: -1, usdinr: -1, dxy: -1, us10y: -1, cboe_vix: -1, vix: -1, gold: 0,
  };
  var CUE_LABEL = {
    gift_nifty: 'GIFT Nifty', us_futures: 'S&P 500 futures', nasdaq_fut: 'Nasdaq futures',
    dow_fut: 'Dow futures', nikkei: 'Nikkei', hangseng: 'Hang Seng', ftse: 'FTSE',
    crude: 'Brent crude', gold: 'Gold', usdinr: 'the rupee (USD/INR)', dxy: 'the dollar index',
    us10y: 'the US 10y yield', cboe_vix: 'the US VIX', vix: 'India VIX',
  };
  var IMPACT_W = { high: 3, medium: 2, low: 1 };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function r2(v) { return Math.round(v * 100) / 100; }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function sgn(v, dead) { return Math.abs(v) < (dead || 0) ? 0 : v > 0 ? 1 : -1; }
  function istMin(sec) { var d = fmt.ist(sec); return d.getHours() * 60 + d.getMinutes(); }
  function hhmm(sec) {
    var d = fmt.ist(sec);
    return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }
  function dateKey(sec) {
    var d = fmt.ist(sec), m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  // 09:15 IST on the session's own date, from its 'YYYY-MM-DD' key.
  function sessionOpenSec(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    if (!m) return null;
    var open = C.market && C.market.regular ? C.market.regular.from : 555;
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0) / 1000) - 19800 + open * 60;
  }
  function pts(v) { return (v >= 0 ? '+' : '-') + Math.round(Math.abs(v)).toLocaleString('en-IN'); }
  function pct(v, d) {
    var s = v.toFixed(d == null ? 2 : d);
    if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);          // never "-0.00%"
    return (s.charAt(0) === '-' ? '' : '+') + s + '%';
  }
  function price(v) { return fmt.price(v); }

  /* =============================================================== snapshot

     What the call knew, kept on the lock row so the judgement can say what
     changed after it. Prices, not change percentages: a change is relative to
     a previous settlement that moves under it overnight, a price is not. */
  function snapshot(S) {
    if (!S) return null;
    var out = { at: Math.floor(Date.now() / 1000), cues: {} };
    var items = S.global && S.global.items;
    if (items) {
      Object.keys(CUE_SIGN).forEach(function (k) {
        var row = items[k];
        if (row && isNum(row.price) && row.price > 0) out.cues[k] = row.price;
      });
    }
    if (isNum(S.vix) && S.vix > 0) out.cues.vix = S.vix;
    var fl = S.flows || {};
    if (fl.fii && isNum(fl.fii.netCr)) out.fii = { netCr: fl.fii.netCr, date: fl.fii.date || null };
    if (fl.dii && isNum(fl.dii.netCr)) out.dii = { netCr: fl.dii.netCr, date: fl.dii.date || null };
    var f = S.forecast, ind = S.indicators || {};
    var newsLane = f && f.lanes ? f.lanes.filter(function (l) { return l.id === 'news'; })[0] : null;
    // The lesson fingerprint's inputs, so a lesson can be filed under the
    // situation the call was made in, not the one it was judged in.
    out.fp = {
      kind: S.symbol && C.symbols[S.symbol] && C.symbols[S.symbol].stock ? 'stock' : 'index',
      symbol: S.symbol || null, timeframe: f ? f.timeframe : S.timeframe,
      adx: isNum(ind.adx) ? r2(ind.adx) : null, rsi: isNum(ind.rsi) ? r2(ind.rsi) : null,
      price: f && isNum(f.lastClose) ? f.lastClose : null,
      ema50: isNum(ind.ema50) ? r2(ind.ema50) : null,
      vix: isNum(S.vix) ? S.vix : null,
      gapPct: f && f.open && f.open.hasData ? f.open.gapPct : null,
      newsTone: newsLane && newsLane.hasData ? r3(newsLane.score) : null,
      fiiNetCr: out.fii ? out.fii.netCr : null,
    };
    return out;
  }

  /* ============================================================ the session

     The candles that belong to the locked window: from the session's open to
     the path's last point. A frozen call claims nothing before 09:15. */
  function windowOf(lock, candles) {
    if (!lock || !lock.path || !lock.path.length || !candles || !candles.length) return null;
    var from = sessionOpenSec(lock.session);
    var to = lock.path[lock.path.length - 1].time;
    if (from == null) from = lock.path[0].time - 60;
    var bars = [];
    for (var i = 0; i < candles.length; i++) {
      var b = candles[i];
      if (b.time >= from && b.time <= to) bars.push(b);
    }
    return bars.length ? { from: from, to: to, bars: bars } : null;
  }

  // The path's value at a bar: the last locked point at or before it.
  function pathAt(path, t) {
    var lo = 0, hi = path.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (path[mid].time <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best >= 0 ? path[best].value : null;
  }

  /* The minute the lines parted for good: the last time the error changed
     sign, provided it then grew past a fifth of the final miss. A day that
     was off from the first minute has no turn; the open reason covers it. */
  function turnOf(lock, bars) {
    var errs = [];
    for (var i = 0; i < bars.length; i++) {
      var p = pathAt(lock.path, bars[i].time);
      if (p == null) continue;
      errs.push({ t: bars[i].time, e: bars[i].close - p });
    }
    if (errs.length < 10) return null;
    var final = errs[errs.length - 1].e;
    if (Math.abs(final) / lock.anchorPrice * 100 < 0.15) return null;
    var lastCross = -1;
    for (var j = 1; j < errs.length; j++) {
      if ((errs[j].e > 0) !== (errs[j - 1].e > 0)) lastCross = j;
    }
    if (lastCross <= 0) return null;
    // Must have run on after the crossing, not crossed in the last minutes.
    if (errs.length - lastCross < 15) return null;
    return { time: errs[lastCross].t, finalErr: r2(final) };
  }

  /* ================================================================ reasons */
  function cueReasons(lock, now, missDir) {
    var then = lock.ctx;
    if (!then || !then.cues || !now || !now.cues) return { checked: false, items: [] };
    var items = [];
    Object.keys(then.cues).forEach(function (k) {
      var a = then.cues[k], b = now.cues[k];
      if (!isNum(a) || !isNum(b) || a <= 0) return;
      var chg = k === 'us10y' ? (b - a) * 100 : (b - a) / a * 100;     // bps for the yield
      var need = CUE_MOVE[k];
      if (!need || Math.abs(chg) < need) return;
      var push = (CUE_SIGN[k] || 0) * sgn(chg);
      if (!push || push !== missDir) return;
      var word = k === 'usdinr' ? (chg > 0 ? 'weakened' : 'strengthened') : (chg > 0 ? 'rose' : 'fell');
      var size = k === 'us10y' ? Math.round(Math.abs(chg)) + ' bps' : Math.abs(chg).toFixed(k === 'usdinr' ? 2 : 1) + '%';
      items.push({ key: k, chg: r2(chg), w: Math.min(1, Math.abs(chg) / need / 3),
                   text: (CUE_LABEL[k] || k) + ' ' + word + ' ' + size });
    });
    items.sort(function (x, y) { return y.w - x.w; });
    return { checked: true, items: items };
  }

  function newsReasons(news, fromSec, toSec, missDir) {
    var out = [], scanned = 0;
    (news || []).forEach(function (n) {
      if (!n || !n.ts) return;
      scanned++;
      if (n.ts <= fromSec || n.ts > toSec) return;
      var s = n.sentiment || 0;
      if (sgn(s, 0.05) !== missDir) return;
      var rel = KT.forecast && KT.forecast.relevanceOf ? KT.forecast.relevanceOf(n).w : 1;
      if (rel < 0.6) return;
      var strength = Math.abs(s) * (IMPACT_W[n.impact] || 1) * rel;
      if (strength < 0.9) return;
      out.push({ headline: String(n.headline || '').slice(0, 140), source: n.source || '', ts: n.ts,
                 strength: r2(strength) });
    });
    out.sort(function (a, b) { return b.strength - a.strength; });
    return { scanned: scanned, top: out.slice(0, 3), n: out.length };
  }

  function eventReasons(lock, opts, fromSec, toSec) {
    var out = [];
    var ev = opts.events && opts.events.events;
    (ev || []).forEach(function (e) {
      if (!e || !e.ts || e.ts <= fromSec || e.ts > toSec) return;
      if (e.impact !== 'high') return;
      out.push((e.country ? e.country + ' ' : '') + e.title + ' at ' + hhmm(e.ts) + ' IST');
    });
    var exp = opts.expiry;           // 'YYYY-MM-DD' of the nearest index expiry, if known
    if (exp && exp === lock.session) out.unshift('it was an expiry day');
    return out.slice(0, 2);
  }

  /* ================================================================= build */
  function build(lock, opts) {
    opts = opts || {};
    if (!lock || !lock.path || !lock.path.length || !isNum(lock.anchorPrice)) return null;
    var win = windowOf(lock, opts.candles);
    if (!win) return null;

    var anchor = lock.anchorPrice;
    var first = win.bars[0], last = win.bars[win.bars.length - 1];
    var openActual = isNum(first.open) ? first.open : first.close;
    var close = lock.outcome && isNum(lock.outcome.closeActual) ? lock.outcome.closeActual : last.close;
    var hi = -Infinity, lo = Infinity;
    win.bars.forEach(function (b) { hi = Math.max(hi, b.high != null ? b.high : b.close); lo = Math.min(lo, b.low != null ? b.low : b.close); });

    var target = isNum(lock.target) ? lock.target : lock.path[lock.path.length - 1].value;
    var saidPct = (target - anchor) / anchor * 100;
    var movePct = (close - anchor) / anchor * 100;
    // One definition of the call's direction for the card, the record and
    // this judgement (ledger.callDirOf): the odds it gave the close.
    var callDir = KT.ledger && KT.ledger.callDirOf ? KT.ledger.callDirOf(lock) : sgn(saidPct, FLAT_PCT);
    var moveDir = sgn(movePct, FLAT_PCT);
    var errPts = close - target, errPct = errPts / anchor * 100;
    var missDir = sgn(errPts, anchor * 0.0002);   // which way the market went against the line

    var verdict, right;
    if (!callDir) { verdict = 'no-call'; right = null; }
    else if (!moveDir) { verdict = 'flat'; right = null; }
    else { right = callDir === moveDir; verdict = right ? 'right' : 'wrong'; }

    var end = lock.end || null;
    var inside68 = end && isNum(end.low68) ? close >= end.low68 && close <= end.high68 : null;
    var inside95 = end && isNum(end.low95) ? close >= end.low95 && close <= end.high95 : null;

    var reasons = [];
    var lockedSec = Math.floor((lock.lockedAt || 0) / 1000);

    /* ---- the open */
    var openCalled = isNum(lock.openPrice) ? lock.openPrice : null;
    var openErr = openCalled != null ? openActual - openCalled : null;
    if (openErr != null && missDir) {
      var share = Math.abs(openErr) / Math.max(Math.abs(errPts), anchor * 0.0005);
      if (Math.abs(openErr) / anchor * 100 >= 0.15 && sgn(openErr) === missDir && share >= 0.4) {
        reasons.push({ kind: 'open', w: r2(Math.min(1, share)),
          text: 'Most of the miss was there at the open: it opened at ' + price(openActual) +
                ', the call said ' + price(openCalled) + ' (' + pts(openErr) + ' pts).' });
      }
    }

    /* ---- what the cues did after the freeze */
    var now = opts.now || null;
    var fresh = now && isNum(now.at) && now.at - win.to <= FRESH_SEC && now.at >= win.to - 1800;
    var cues = fresh ? cueReasons(lock, now, missDir) : { checked: false, items: [] };
    if (cues.items.length) {
      var top = cues.items.slice(0, 3);
      reasons.push({ kind: 'cues', w: r2(Math.min(1, top.reduce(function (s, c) { return s + c.w; }, 0))),
        text: 'After the call was frozen, ' + top.map(function (c) { return c.text; }).join(', ') + '.' });
    }

    /* ---- headlines that landed after the freeze, pointing the way price went */
    var nw = missDir ? newsReasons(opts.news, lockedSec, win.to, missDir) : { scanned: 0, top: [], n: 0 };
    if (nw.top.length) {
      var lead = nw.top[0];
      reasons.push({ kind: 'news', w: r2(Math.min(1, nw.top.reduce(function (s, n) { return s + n.strength; }, 0) / 6)),
        text: nw.n + ' strong headline' + (nw.n === 1 ? '' : 's') + ' after the call pointed ' +
              (missDir > 0 ? 'up' : 'down') + '. The loudest, at ' + hhmm(lead.ts) + ': "' + lead.headline + '"' +
              (lead.source ? ' (' + lead.source + ')' : '') + '.' });
    }

    /* ---- institutional cash that day */
    var fii = now && now.fii;
    if (fii && isNum(fii.netCr) && missDir && Math.abs(fii.netCr) >= 1000 && sgn(fii.netCr) === missDir &&
        sameDay(fii.date, lock.session)) {
      reasons.push({ kind: 'flows', w: 0.3,
        text: 'FII ' + (fii.netCr > 0 ? 'bought' : 'sold') + ' ₹' + Math.round(Math.abs(fii.netCr)).toLocaleString('en-IN') +
              ' crore in cash that day.' });
    }

    /* ---- a move bigger than the call's own range */
    if (inside95 === false) {
      reasons.push({ kind: 'size', w: 0.5,
        text: 'A bigger move than the call allowed for: it closed outside even the wide range (' +
              price(end.low95) + ' to ' + price(end.high95) + ').' });
    } else if (inside68 === false && verdict === 'wrong') {
      reasons.push({ kind: 'size', w: 0.2,
        text: 'It closed outside the likely range (' + price(end.low68) + ' to ' + price(end.high68) + ').' });
    }

    /* ---- the minute the two lines parted */
    var turn = verdict === 'wrong' || Math.abs(errPct) >= 0.3 ? turnOf(lock, win.bars) : null;
    if (turn) {
      var near = (opts.news || []).filter(function (n) {
        return n && n.ts && Math.abs(n.ts - turn.time) <= 1200 && Math.abs(n.sentiment || 0) >= 0.2 &&
               (KT.forecast && KT.forecast.relevanceOf ? KT.forecast.relevanceOf(n).w >= 0.6 : true);
      }).sort(function (a, b) { return Math.abs(b.sentiment) - Math.abs(a.sentiment); })[0];
      reasons.push({ kind: 'turn', w: 0.2,
        text: 'The lines parted at ' + hhmm(turn.time) + ' and did not meet again' +
              (near ? '; around then: "' + String(near.headline).slice(0, 110) + '"' : '') + '.' });
    }

    /* ---- the call's own inputs, in hindsight */
    var laneWrong = [], laneRight = [];
    (lock.lanes || []).forEach(function (l) {
      if (!isNum(l.contribution) || Math.abs(l.contribution) < 0.01 || !moveDir) return;
      ((l.contribution > 0) === (moveDir > 0) ? laneRight : laneWrong)
        .push({ id: l.id, label: l.label, c: r3(l.contribution) });
    });
    laneWrong.sort(function (a, b) { return Math.abs(b.c) - Math.abs(a.c); });
    laneRight.sort(function (a, b) { return Math.abs(b.c) - Math.abs(a.c); });
    if (verdict === 'wrong' && laneWrong.length) {
      reasons.push({ kind: 'signals', w: 0.3,
        text: 'Pointed the wrong way: ' + laneWrong.slice(0, 3).map(function (l) { return l.label.toLowerCase(); }).join(', ') +
              (laneRight.length ? '. The right way: ' + laneRight.slice(0, 2).map(function (l) { return l.label.toLowerCase(); }).join(', ') : '') + '.' });
    }

    /* ---- the calendar */
    var evs = eventReasons(lock, opts, lockedSec, win.to);
    if (evs.length && (verdict === 'wrong' || Math.abs(errPct) >= 0.3)) {
      reasons.push({ kind: 'event', w: 0.15, text: 'On the calendar: ' + evs.join('; ') + '.' });
    }

    reasons.sort(function (a, b) { return b.w - a.w; });

    var out = {
      v: VERSION, at: Math.floor(Date.now() / 1000), session: lock.session, stage: lock.stage,
      verdict: verdict, right: right, callDir: callDir, moveDir: moveDir,
      said: { target: r2(target), pct: r3(saidPct), open: openCalled != null ? r2(openCalled) : null,
              pUpClose: lock.end && isNum(lock.end.pUpClose) ? lock.end.pUpClose : null },
      did: { open: r2(openActual), close: r2(close), high: r2(hi), low: r2(lo), pct: r3(movePct) },
      errPts: r2(errPts), errPct: r3(errPct),
      openErrPts: openErr != null ? r2(openErr) : null,
      inside68: inside68, inside95: inside95,
      reasons: reasons.slice(0, 5),
      lanes: { wrong: laneWrong.slice(0, 4), right: laneRight.slice(0, 4) },
      turn: turn ? turn.time : null,
      cuesChecked: cues.checked, newsScanned: nw.scanned,
    };
    out.summary = summaryOf(out);
    out.lesson = lessonOf(out, lock);
    return out;
  }

  function sameDay(nseDate, key) {
    // FII dates arrive as '29-Oct-2026' from NSE or '2026-10-29' from the workflow.
    if (!nseDate || !key) return false;
    if (nseDate === key) return true;
    var t = KT.data && KT.data.nseDate ? KT.data.nseDate(nseDate) : null;   // epoch seconds
    return t ? dateKey(t) === key : false;
  }

  /* One line for the record list. */
  function summaryOf(p) {
    var said = p.callDir > 0 ? 'up' : p.callDir < 0 ? 'down' : 'flat';
    var head = p.verdict === 'right' ? 'Right' : p.verdict === 'wrong' ? 'Wrong' : p.verdict === 'flat' ? 'Market went nowhere' : 'No lean called';
    var tail = p.reasons.length && p.verdict !== 'right' ? ' ' + shortReason(p.reasons[0]) : '';
    return head + ': said ' + said + ' (' + pct(p.said.pct) + '), closed ' + pct(p.did.pct) + '.' + tail;
  }
  function shortReason(r) {
    var map = { open: 'Most of it was at the open.', cues: 'Cues moved after the freeze.',
                news: 'News after the freeze.', flows: 'FII flows.', size: 'Bigger move than its range.',
                turn: 'Turned intraday.', signals: 'Its signals pointed the wrong way.', event: 'Event day.' };
    return map[r.kind] || '';
  }

  /* The lesson filed for next time, in the situation the call was made in. */
  function lessonOf(p, lock) {
    var words = '';
    if (KT.lessons && lock.ctx && lock.ctx.fp) {
      try { words = KT.lessons.describe(KT.lessons.fingerprint(lock.ctx.fp)); } catch (e) { words = ''; }
    }
    var who = (lock.symbol || 'the index');
    var said = p.callDir > 0 ? 'up' : p.callDir < 0 ? 'down' : 'flat';
    var lead = words ? 'In ' + words + ': ' : 'In a setup like this: ';
    // The short form: the full reason sits beside the lesson on the card.
    var why = p.reasons.length ? ' ' + shortReason(p.reasons[0]) : '';
    if (p.verdict === 'right') return lead + 'the ' + said + ' call on ' + who + ' held (' + pct(p.did.pct) + ').';
    if (p.verdict === 'no-call' || p.verdict === 'flat') {
      return lead + 'no lean was called (' + pct(p.said.pct) + ') and ' + who + ' closed ' + pct(p.did.pct) + '.' +
             (Math.abs(p.did.pct) >= 0.15 ? why : '');
    }
    return lead + 'the call said ' + said + ' and ' + who + ' went ' + (p.moveDir > 0 ? 'up' : 'down') + ' ' +
           pct(Math.abs(p.did.pct)).replace('+', '') + '.' + why;
  }

  /* ========================================================= the record

     Per input, how often it pointed the way the session actually went, over
     every judged frozen call. One row a session, so this is slow evidence,
     and every rate carries its interval. */
  function laneRecord(rows) {
    var by = {};
    (rows || []).forEach(function (r) {
      var p = r.postmortem;
      if (!p || !p.lanes) return;
      p.lanes.right.forEach(function (l) { (by[l.id] = by[l.id] || { id: l.id, label: l.label, right: 0, n: 0 }).right++; by[l.id].n++; });
      p.lanes.wrong.forEach(function (l) { (by[l.id] = by[l.id] || { id: l.id, label: l.label, right: 0, n: 0 }).n++; });
    });
    var wil = KT.ledger && KT.ledger.wilson;
    return Object.keys(by).map(function (k) {
      var x = by[k];
      x.rate = x.n ? Math.round(x.right / x.n * 100) : null;
      x.ci = wil ? wil(x.right, x.n) : null;
      return x;
    }).sort(function (a, b) { return b.n - a.n || b.rate - a.rate; });
  }

  KT.postmortem = {
    VERSION: VERSION, CUE_MOVE: CUE_MOVE, CUE_SIGN: CUE_SIGN,
    snapshot: snapshot, build: build, laneRecord: laneRecord,
    sessionOpenSec: sessionOpenSec, turnOf: turnOf, dateKey: dateKey,
  };
})(window.KT);
