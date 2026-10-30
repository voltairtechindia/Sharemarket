/* ============================================================================
   The four cards that answer "what happens next, and was the last call right".

   app.js does the work: the lanes, the loops, the ledger and the one frozen
   call a session (sessionCall). This file draws, from the same state, after
   every recompute:

     next session   the frozen call for the next (or current) session, its
                    open, its range, the two prices that decide it, and how
                    the other readers (the AI desk) see it
     said vs did    the last judged call: right or wrong, by how much, and
                    what it did not know (postmortem.js); then every session
     AI desk        run it, read it, see what it cost
     learned        the lessons filed after each judged call and desk run,
                    which inputs have pointed the right way, what the learner
                    has moved

   It also owns the stock search in the market watch, the #s= links, and the
   desk's automation (settle, reflect, the automatic NIFTY runs).

   Nothing here computes a forecast. A number on these cards that is not in
   S.call, S.forecast, the ledger or the desk's own record is a bug.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core, fmt = core.fmt;
  var $ = function (id) { return document.getElementById(id); };

  function esc(x) {
    return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function setText(id, v) { var n = $(id); if (n) n.textContent = v; }
  // An index is said to the point, a stock under a thousand to the paisa.
  function px(v) {
    if (!isNum(v)) return '—';
    return Math.abs(v) >= 1000 ? fmt.int(Math.round(v)) : fmt.price(v);
  }
  function ageText(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function hhmm(epochSec) { return fmt.timeShort(epochSec); }
  function dayLabel(epochSec) {
    var d = fmt.ist(epochSec);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + fmt.dayShort(epochSec);
  }
  function sameIstDay(a, b) {
    var x = fmt.ist(a), y = fmt.ist(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  }
  function whenLabel(epochSec) {
    if (!epochSec) return '';
    return sameIstDay(epochSec, Math.floor(Date.now() / 1000)) ? hhmm(epochSec) + ' today' : dayLabel(epochSec) + ', ' + hhmm(epochSec);
  }
  function istDateKey(epochSec) {
    var d = fmt.ist(epochSec == null ? Math.floor(Date.now() / 1000) : epochSec);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  // Noon IST on a 'YYYY-MM-DD' key, so the weekday cannot slip across midnight.
  function keySec(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], 6, 30) / 1000) : null;
  }
  function sessionLabel(key) { var t = keySec(key); return t ? dayLabel(t) : (key || ''); }

  var state = { firstRenderAt: 0, keyChecked: false, desk: null };

  /* ============================================================ THE ANSWER

     The lean is read off the probability at the end of the horizon, because
     that is the number printed next to it: "Leaning up, 61%" means the
     forecast gives 61% to finishing higher, never two numbers that look like
     one. The two prices are a tested level when one is close enough to be
     reached inside the horizon (three quarters of the likely range), the
     range itself otherwise. */
  function answerOf(f, levels) {
    if (!f || !f.checkpoints || !f.checkpoints.length) return null;
    var cps = f.checkpoints, end = cps[cps.length - 1], first = cps[0];
    var pUp = isNum(end.pUp) ? end.pUp : 50;
    var lean = pUp >= 55 ? 'up' : pUp <= 45 ? 'down' : 'flat';
    var prob = lean === 'down' ? 100 - pUp : pUp;
    var from = isNum(end.pUpFrom) ? end.pUpFrom : f.lastClose;
    var lv = levels || {};
    var span = Math.max(1e-9, (end.high - end.low) || f.lastClose * 0.004);
    var sup = lv.nearestSupport && lv.nearestSupport.level < from ? lv.nearestSupport : null;
    var res = lv.nearestResistance && lv.nearestResistance.level > from ? lv.nearestResistance : null;
    var hold, flip, basis = 'range';
    if (lean === 'up') {
      if (sup && from - sup.level <= span * 0.75) { hold = sup.level; basis = 'level'; }
      else hold = Math.min(from, first.low);
      flip = Math.min(hold - span * 0.15, end.low);
      if (!(flip < hold)) flip = hold - span * 0.3;
    } else if (lean === 'down') {
      if (res && res.level - from <= span * 0.75) { hold = res.level; basis = 'level'; }
      else hold = Math.max(from, first.high);
      flip = Math.max(hold + span * 0.15, end.high);
      if (!(flip > hold)) flip = hold + span * 0.3;
    } else {
      hold = sup && from - sup.level <= span ? sup.level : end.low;
      flip = res && res.level - from <= span ? res.level : end.high;
    }
    return { f: f, lean: lean, prob: prob, pUp: pUp, from: from, end: end, hold: hold, flip: flip, basis: basis,
             nextTest: lean === 'up' ? res : lean === 'down' ? sup : null,
             gap: f.open && f.open.applies && f.open.hasData ? f.open : null };
  }
  function leanWord(lean) { return lean === 'up' ? 'Leaning up' : lean === 'down' ? 'Leaning down' : 'No clear lean'; }
  function leanOfP(pUp) { return pUp >= 55 ? 'up' : pUp <= 45 ? 'down' : 'flat'; }

  /* Are the candles today's? When the live feed through the public proxy does
     not answer, the page draws from the last saved copy: the right fallback,
     and the wrong thing to leave unsaid. */
  function tradingDay(d) {
    return C.market.weekdays.indexOf(d.getDay()) !== -1 && !(core.isHoliday && core.isHoliday(d));
  }
  function staleness(candles) {
    if (!candles || !candles.length) return null;
    var lastT = candles[candles.length - 1].time;
    var now = fmt.ist(), mins = now.getHours() * 60 + now.getMinutes();
    var want = new Date(now.getTime());
    if (!(tradingDay(want) && mins >= C.market.regular.from)) {
      for (var i = 0; i < 12; i++) {
        want = new Date(want.getTime() - 86400000);
        if (tradingDay(want)) break;
      }
    }
    var wantKey = want.getFullYear() + '-' + String(want.getMonth() + 1).padStart(2, '0') + '-' + String(want.getDate()).padStart(2, '0');
    var lagMin = (Date.now() / 1000 - lastT) / 60;
    if (istDateKey(lastT) < wantKey || (core.marketState().live && lagMin > 25)) return { lastT: lastT, label: whenLabel(lastT) };
    return null;
  }

  /* ========================================================= NEXT SESSION */
  function renderCall(S) {
    var leanEl = $('call-lean');
    if (!leanEl) return;
    var call = S.call && S.call.symbol === S.symbol ? S.call : null;
    var lk = call && call.locked;
    var live = call ? answerOf(call.forecast, call.levels) : null;
    var meta = C.symbols[S.symbol] || { label: S.symbol };

    if (!live && !lk) {
      leanEl.textContent = S.candles && S.candles.length ? 'Building the session call…' : 'Reading the market…';
      leanEl.className = 'call-lean';
      setText('call-prob', ''); setText('call-range', ''); setText('call-levels', '');
      var vEmpty = $('call-views'); if (vEmpty) vEmpty.innerHTML = '';
      return;
    }

    // Which session, and whether it is still ahead or under way.
    var key = lk ? lk.session : (KT.ledger && KT.ledger.sessionKeyOf ? KT.ledger.sessionKeyOf(call.forecast) : null);
    var today = istDateKey();
    var ms = core.marketState();
    // A call for a session already over means the prices on hand are behind.
    setText('call-title', key && key < today ? 'Last frozen call' : key === today && ms.live ? 'This session'
                          : key === today ? 'Today\'s session' : 'Next session');
    setText('call-day', key ? sessionLabel(key) : '');
    var fromRecord = !!(lk && KT.ledger.isRecord && KT.ledger.isRecord(lk));
    setText('call-stage', lk ? 'frozen ' + whenLabel(Math.floor(lk.lockedAt / 1000)) +
                             (lk.stage === 'open' ? ', pre-open' : '') : 'not frozen yet');
    var stageEl = $('call-stage');
    if (stageEl) stageEl.title = lk
      ? 'Frozen ' + (lk.stage === 'open' ? 'before the open, once the overnight cues were in' : 'the day before') +
        (fromRecord ? ' by the scheduled run, so it is the same call in every browser' : ' in this browser') +
        '. It is never rewritten, and it is the call this session is judged on.'
      : 'The scheduled run freezes the call after the close and again before the open. Until it has, the page ' +
        'freezes its own the first time it computes one for a session that has not opened yet.';

    /* The frozen numbers win; the live read is shown only where it differs.
       The odds are of closing above the last close (forecast.closeOdds), the
       question the session is judged on. */
    var liveP = call && call.forecast && KT.forecast.closeOdds ? KT.forecast.closeOdds(call.forecast) : (live ? live.pUp : null);
    var pUp = lk && lk.end && isNum(lk.end.pUpClose) ? lk.end.pUpClose : isNum(liveP) ? liveP : 50;
    var lean = leanOfP(pUp), prob = lean === 'down' ? 100 - pUp : pUp;
    var anchor = lk && isNum(lk.anchorPrice) ? lk.anchorPrice : call && call.forecast ? call.forecast.lastClose : null;
    leanEl.textContent = leanWord(lean);
    leanEl.className = 'call-lean ' + lean;
    var probEl = $('call-prob');
    if (probEl) {
      probEl.textContent = lean === 'flat' ? pUp + '% up' : prob + '%';
      probEl.className = 'call-prob num ' + lean;
      probEl.title = 'The chance it gives the close of ending ' + (lean === 'down' ? 'below' : 'above') +
                     (anchor ? ' ' + px(anchor) + ', the last close' : ' the last close') + '. Between 45% and 55% it calls no lean.';
    }

    var open = lk && isNum(lk.openPrice) ? lk.openPrice : live && live.gap ? live.gap.price : null;
    var gapPct = lk && isNum(lk.openGapPct) ? lk.openGapPct : live && live.gap ? live.gap.gapPct : null;
    var lo = lk && lk.end && isNum(lk.end.low68) ? lk.end.low68 : live ? live.end.low : null;
    var hi = lk && lk.end && isNum(lk.end.high68) ? lk.end.high68 : live ? live.end.high : null;
    var centre = lk && isNum(lk.target) ? lk.target : live ? live.end.value : null;
    var bits = [];
    if (open != null && key !== today) {
      bits.push(gapPct != null && Math.abs(gapPct) < 0.05 ? 'Opens about flat, near ' + px(open) + '.'
                : 'Opens near ' + px(open) + (gapPct != null ? ' (' + fmt.pct(gapPct) + ')' : '') + '.');
    }
    if (lo != null && hi != null) {
      bits.push('Closes between ' + px(lo) + ' and ' + px(hi) + ', most likely near ' + px(centre) +
                (anchor ? ' (' + fmt.pct((centre - anchor) / anchor * 100) + ')' : '') + '.');
    }
    setText('call-range', bits.join(' '));

    /* The price that decides the call is the last close itself: an up call
       is right if the session closes above it, whatever happens on the way.
       The walls either side are the tested levels the session starts between. */
    var lv = $('call-levels');
    if (lv) {
      var L = call && call.levels || {};
      var ref = isNum(open) ? open : anchor;
      var sup = L.nearestSupport && isNum(ref) && L.nearestSupport.level < ref ? L.nearestSupport : null;
      var res = L.nearestResistance && isNum(ref) && L.nearestResistance.level > ref ? L.nearestResistance : null;
      var walls = (sup ? 'Support near <b class="num">' + esc(px(sup.level)) + '</b>' : '') +
                  (sup && res ? ', resistance near ' : res ? 'Resistance near ' : '') +
                  (res ? '<b class="num">' + esc(px(res.level)) + '</b>' : '') + (sup || res ? '.' : '');
      lv.innerHTML = !isNum(anchor) ? walls
        : (lean === 'up' ? 'Right if it closes above <b class="num">' + esc(px(anchor)) + '</b>, the last close. '
          : lean === 'down' ? 'Right if it closes below <b class="num">' + esc(px(anchor)) + '</b>, the last close. '
          : 'About even odds of closing above <b class="num">' + esc(px(anchor)) + '</b>, the last close. ') + walls;
      lv.title = 'Support and resistance are the nearest levels the chart has respected, either side of where the session starts.';
    }

    // The other readers, each with its own record where it has one.
    var views = [];
    if (lk && isNum(liveP) && Math.abs(liveP - pUp) >= 8) {
      var ll = leanOfP(liveP);
      views.push('<li><span class="call-view-k">Live read now</span><span class="call-view-v ' + ll + '">' +
                 esc(leanWord(ll)) + ' ' + (ll === 'down' ? 100 - liveP : liveP) + '%' +
                 '</span><span class="call-view-n">moved since the freeze</span></li>');
    }
    var run = KT.desk ? KT.desk.latest(S.symbol) : null;
    if (run && run.final) {
      var vote = KT.desk.voteFor(S.symbol);
      views.push('<li><span class="call-view-k">AI desk</span><span class="call-view-v ' + esc(run.final.tone) + '">' +
                 esc(run.final.label) + ' ' + esc(run.final.confidence) + '%</span><span class="call-view-n">' +
                 esc(ageText(run.at)) + (vote ? '' : ', too old to count') + '</span></li>');
    } else if (KT.desk) {
      views.push('<li><span class="call-view-k">AI desk</span><span class="call-view-v flat">' +
                 (S.settings && S.settings.key ? 'not run yet' : 'needs a key') + '</span></li>');
    }
    /* The two learned readers that are not the AI desk, each with its own
       record where it has one: the twenty-year model and the price model. */
    var hm = S.historyModel && S.historyModel.ok && S.historyModel.models ? S.historyModel.models[S.symbol] : null;
    if (hm && key && hm.session === key) {
      var hp = Math.round(hm.pUp * 100), hl = leanOfP(hp);
      var hrec = (hm[hm.infoSet] || {}).record;
      views.push('<li title="' + esc('Trained walk-forward on every session since ' + (hrec ? hrec.from.slice(0, 4) : '2007') +
                 ': each year scored by a model that never saw it. ' + (hm.infoSet === 'preopen' ? 'Includes the overnight US session.' : 'As of the close, before the US session.')) + '">' +
                 '<span class="call-view-k">20-year model</span><span class="call-view-v ' + hl + '">' +
                 (hl === 'flat' ? 'no lean ' + hp + '%' : (hl === 'down' ? 'down ' + (100 - hp) : 'up ' + hp) + '%') + '</span>' +
                 '<span class="call-view-n">' + (hrec ? 'right ' + hrec.hit + '% out of sample, always-up ' + hrec.baselines.alwaysUp + '%' : '') +
                 '</span></li>');
    }
    var lanes = call && call.forecast && call.forecast.lanes || [];
    lanes.forEach(function (l) {
      if (!l.hasData || l.id !== 'kronos') return;
      var dir = l.score > 0.05 ? 'up' : l.score < -0.05 ? 'down' : 'flat';
      views.push('<li title="' + esc(l.note || '') + '"><span class="call-view-k">' + esc(l.label || 'Price model') + '</span>' +
                 '<span class="call-view-v ' + dir + '">' + esc(dir === 'up' ? 'up' : dir === 'down' ? 'down' : 'no lean') + '</span>' +
                 '<span class="call-view-n">' + esc(String(l.note || '').slice(0, 70)) + '</span></li>');
    });
    var stock = KT.app.isStockView() ? stockFund(S.symbol) : null;
    if (stock && isNum(stock.targetAvg) && isNum(stock.upsidePct) && stock.analysts) {
      views.push('<li><span class="call-view-k">Street</span><span class="call-view-v ' + (stock.upsidePct >= 0 ? 'up' : 'down') + '">' +
                 esc(fmt.pct(stock.upsidePct, 1)) + '</span><span class="call-view-n">' + esc(stock.analysts) +
                 ' analysts, avg target ' + esc(fmt.price(stock.targetAvg)) + '</span></li>');
    }
    if (S.quote && S.quote.delayMin) {
      views.push('<li><span class="call-view-k">Price</span><span class="call-view-v flat">' + esc(S.quote.delayMin) +
                 ' min delayed</span></li>');
    }
    var vEl = $('call-views');
    if (vEl) vEl.innerHTML = views.join('');

    var stale = staleness(call ? call.candles : S.candles);
    var st = $('call-stale');
    if (st) {
      st.hidden = !stale;
      st.textContent = stale ? 'Prices from ' + stale.label + ': the live feed did not answer, so this is drawn from the last saved copy.' : '';
    }
    void meta;
  }

  /* ============================================================ SAID VS DID

     One row per session: the call frozen before it opened against where it
     closed. The session view's call is the record; older rows from the
     5-minute and hourly views count where no session-view call exists. */
  function sessionRows(symbol) {
    if (!KT.ledger || !KT.ledger.locks) return [];
    var rank = function (r) { return (r.timeframe === '1S' ? 2 : 0) + (r.stage === 'open' ? 1 : 0); };
    var bySession = {};
    // The whole record: the published one runs to months, a browser's to weeks.
    KT.ledger.locks(symbol, 400).forEach(function (r) {
      var cur = bySession[r.session];
      if (!cur || rank(r) > rank(cur)) bySession[r.session] = r;
    });
    return Object.keys(bySession).map(function (k) { return bySession[k]; })
      .sort(function (x, y) { return y.session < x.session ? -1 : y.session > x.session ? 1 : 0; });
  }
  function callOf(r) {
    var anchor = r.anchorPrice, target = r.target;
    if (!isNum(anchor) || !isNum(target)) return { dir: 0 };
    var pct = (target - anchor) / anchor * 100;
    var dir = KT.ledger.callDirOf ? KT.ledger.callDirOf(r) : (Math.abs(pct) < 0.02 ? 0 : pct > 0 ? 1 : -1);
    return { dir: dir, pct: pct, target: target, p: r.end && isNum(r.end.pUpClose) ? r.end.pUpClose : null };
  }
  function scoreRow(r) {
    var o = r.outcome, call = callOf(r);
    if (!o || !isNum(o.closeActual)) return null;
    var move = (o.closeActual - r.anchorPrice) / r.anchorPrice * 100;
    var right = call.dir === 0 || Math.abs(move) < 0.02 ? null : (move * call.dir > 0);
    return { move: move, right: right, close: o.closeActual, skill: o.skill };
  }
  function sessionRecord(symbol) {
    var rows = sessionRows(symbol), n = 0, k = 0, beat = 0, beatN = 0;
    rows.forEach(function (r) {
      var s = scoreRow(r);
      if (!s) return;
      if (s.right !== null) { n++; if (s.right) k++; }
      if (isNum(s.skill)) { beatN++; if (s.skill < 1) beat++; }
    });
    return { n: n, right: k, ci: n && KT.ledger.wilson ? KT.ledger.wilson(k, n) : null, beat: beat, beatN: beatN, rows: rows };
  }

  var REASON_ICON = { open: 'Open', cues: 'Cues', news: 'News', flows: 'Flows', size: 'Size', turn: 'Turn', signals: 'Inputs', event: 'Calendar' };

  function renderJudge(S, rec) {
    var lastBox = $('judge-last'), list = $('judge-list');
    if (!list) return;
    rec = rec || sessionRecord(S.symbol);
    var todayKey = istDateKey();
    /* A finished session with no verdict is waiting for its prices (the
       scheduled run, or this page, judges it once they are in) until its
       minute bars are older than any feed keeps them: then it is lost. */
    var agedKey = istDateKey(Math.floor(Date.now() / 1000) - 8 * 86400);
    function lost(r) { return !scoreRow(r) && (r.expired || r.session < agedKey); }
    function waiting(r) { return !scoreRow(r) && !lost(r) && r.session < todayKey; }

    // The latest judged session, written out in full.
    var judged = rec.rows.filter(function (r) { return scoreRow(r); })[0];
    if (lastBox) {
      if (!judged) {
        lastBox.innerHTML = '<p class="fine">No session has been judged yet. Each call is frozen before its session and judged ' +
                            'once the session is over: right or wrong, by how much, and what it did not know.</p>';
      } else {
        var p = judged.postmortem, s = scoreRow(judged), c = callOf(judged);
        var mark = s.right === true ? 'right' : s.right === false ? 'wrong' : 'flat';
        var word = s.right === true ? 'Right' : s.right === false ? 'Wrong' : c.dir === 0 ? 'No lean called' : 'Went nowhere';
        var said = c.dir > 0 ? 'up' : c.dir < 0 ? 'down' : 'no clear lean';
        var odds = c.p != null && c.dir !== 0 ? ', ' + (c.dir < 0 ? 100 - c.p : c.p) + '%' : '';
        var html = '<div class="jl-head ' + mark + '"><span class="jl-mark">' + esc(word) + '</span>' +
          '<span class="jl-day">' + esc(sessionLabel(judged.session)) + '</span></div>' +
          '<p class="jl-line">Said ' + said + esc(odds) + ', most likely near <b class="num">' + esc(px(c.target)) + '</b> (' + esc(fmt.pct(c.pct)) + '). ' +
          'Closed <b class="num">' + esc(px(s.close)) + '</b> (<span class="' + (s.move >= 0 ? 'up' : 'down') + '">' +
          esc(fmt.pct(s.move)) + '</span>), off by <b class="num">' + esc(px(Math.abs(s.close - c.target))) + '</b> pts.</p>';
        if (p && p.reasons && p.reasons.length && mark !== 'right') {
          html += '<p class="jl-k">What it did not know</p><ul class="jl-reasons">' + p.reasons.slice(0, 4).map(function (r) {
            return '<li><span class="jl-tag">' + esc(REASON_ICON[r.kind] || r.kind) + '</span><span>' + esc(r.text) + '</span></li>';
          }).join('') + '</ul>';
        } else if (p && mark === 'right' && p.lanes && p.lanes.right.length) {
          html += '<p class="jl-line muted">Pointed the right way: ' + esc(p.lanes.right.slice(0, 3).map(function (l) { return l.label.toLowerCase(); }).join(', ')) + '.</p>';
        } else if (!p && mark === 'wrong') {
          html += '<p class="fine">Judged before the reasons were recorded, or without the prices of that day on hand, so only the numbers are kept.</p>';
        }
        if (p && p.lesson) html += '<p class="jl-lesson"><b>Filed for next time:</b> ' + esc(p.lesson) + '</p>';
        lastBox.innerHTML = html;
      }
    }

    var rows = rec.rows.slice(0, 8);
    list.innerHTML = rows.map(function (r) {
      var c = callOf(r), s = scoreRow(r), gone = lost(r), due = waiting(r);
      var mark = !s ? (gone ? 'unscored' : 'pending') : s.right === true ? 'right' : s.right === false ? 'wrong' : 'flat';
      var markTxt = !s ? (gone ? 'not scored' : due ? 'to judge' : 'open') : s.right === true ? 'right' : s.right === false ? 'wrong' : 'no call';
      var said = c.dir > 0 ? 'Up' : c.dir < 0 ? 'Down' : 'Flat';
      var why = r.postmortem && r.postmortem.summary ? r.postmortem.summary : '';
      return '<li class="jr ' + mark + '"' + (why ? ' title="' + esc(why) + '"' : '') + '>' +
        '<span class="jr-d">' + esc(sessionLabel(r.session)) + '</span>' +
        '<span class="jr-s ' + (c.dir > 0 ? 'up' : c.dir < 0 ? 'down' : 'flat') + '">' + esc(said) +
          (isNum(c.target) ? ' <span class="num">' + esc(px(c.target)) + '</span>' : '') + '</span>' +
        '<span class="jr-a">' + (s ? '<span class="num">' + esc(px(s.close)) + '</span> <span class="' + (s.move >= 0 ? 'up' : 'down') + '">' +
          esc(fmt.pct(s.move)) + '</span>' : gone ? '<span class="muted">no prices on file</span>'
          : due ? '<span class="muted">waiting for its prices</span>' : r.session === todayKey ? 'in progress' : 'not yet traded') + '</span>' +
        '<span class="jr-m">' + esc(markTxt) + '</span></li>';
    }).join('');
    setText('judge-n', rec.rows.length ? rec.rows.length + ' session' + (rec.rows.length === 1 ? '' : 's') : 'none yet');

    var sum = [];
    if (rec.n) {
      sum.push('Direction right on ' + rec.right + ' of ' + rec.n + ' sessions' +
               (rec.ci ? ' (the true rate could be ' + rec.ci[0] + '% to ' + rec.ci[1] + '%)' : '') + '.');
      // The bar it has to clear on the same sessions: calling up every day.
      var st = S.record && S.record.symbols && S.record.symbols[S.symbol] && S.record.symbols[S.symbol].stats;
      if (st && st.alwaysUp && st.alwaysUp.n >= 5) {
        sum.push('Calling up every day would have been right on ' + st.alwaysUp.rate + '% of them.');
      }
      if (rec.beatN) sum.push('Beat a no-change line on ' + rec.beat + ' of ' + rec.beatN + '.');
    }
    var lostN = rec.rows.filter(lost).length;
    if (lostN) {
      sum.push(lostN + ' earlier frozen call' + (lostN === 1 ? ' was' : 's were') + ' never scored: no minute prices for ' +
               (lostN === 1 ? 'that session were' : 'those sessions were') + ' on hand before they aged out.');
    }
    var dueN = rec.rows.filter(waiting).length;
    if (dueN) {
      sum.push(dueN === 1 ? 'One finished session is waiting for its prices to be judged.'
               : dueN + ' finished sessions are waiting for their prices to be judged.');
    }
    if (KT.desk) {
      var dr = KT.desk.record(S.symbol);
      if (dr.n) sum.push('AI desk: ' + dr.right + ' of ' + dr.n + ' calls right.');
    }
    setText('judge-sum', sum.join(' '));
  }

  /* ============================================================== AI DESK */
  function budgetText() {
    var b = KT.desk ? KT.desk.budget() : null;
    if (!b || !b.limit) return '';
    if (b.blocked || b.left <= 0) return 'AI limit reached, resets 05:30 IST';
    return b.left + ' of ' + b.limit + ' AI calls left today';
  }
  function scoreBar(s) {
    var w = Math.round(Math.min(1, Math.abs(s)) * 50);
    return '<span class="pn-sbar" aria-hidden="true"><span class="pn-sfill ' + (s >= 0 ? 'up' : 'down') + '" style="' +
           (s >= 0 ? 'left:50%;width:' + w + '%' : 'right:50%;width:' + w + '%') + '"></span></span>';
  }

  function renderDesk(S) {
    var body = $('desk-body');
    if (!body || !KT.desk) return;
    var hasKey = !!(S.settings && S.settings.key);
    var b = KT.desk.budget();
    setText('desk-budget', hasKey ? budgetText() : 'no key');
    var run = KT.desk.latest(S.symbol);
    var running = !!(state.desk && state.desk.running);
    var html = '';
    if (running) {
      var st = state.desk.stage || {};
      html += '<div class="pn-live"><span class="pn-spin" aria-hidden="true"></span><span>' + esc(st.text || 'Starting') + '…</span></div>';
      var got = state.desk.analysts || {};
      Object.keys(got).forEach(function (k) {
        var a = got[k];
        html += '<div class="pn-analyst"><span class="pn-analyst-k">' + esc(a.label) + '</span>' + scoreBar(a.score) +
                '<span class="pn-analyst-v num">' + (a.score >= 0 ? '+' : '') + a.score.toFixed(2) + '</span></div>';
      });
    } else if (state.desk && state.desk.error) {
      html += '<p class="pn-error">' + esc(state.desk.error) + '</p>';
    }
    if (run && run.final && !running) {
      var fin = run.final, vote = KT.desk.voteFor(S.symbol);
      html += '<div class="pn-final ' + esc(fin.tone) + '">' +
        '<div class="pn-final-head"><span class="pn-rating">' + esc(fin.label) + '</span>' +
        '<span class="pn-final-conf">' + esc(fin.confidence) + '% sure</span>' +
        '<span class="pn-final-age">' + esc(ageText(run.at)) + (run.mode === 'quick' ? ' · quick read' : '') + '</span></div>' +
        '<p class="pn-final-why">' + esc(fin.why) + '</p>' +
        (fin.risk ? '<p class="pn-final-risk"><b>Would be wrong if:</b> ' + esc(fin.risk) + '</p>' : '') +
        (fin.watch ? '<p class="pn-final-risk"><b>Watching:</b> ' + esc(fin.watch) + '</p>' : '') +
        (vote ? '' : '<p class="fine">Older than its lifetime, so it no longer feeds the line. Run the desk again for a fresh read.</p>') +
      '</div>';
      html += '<div class="pn-analysts">' + (run.analysts || []).map(function (a) {
        if (!a || a.failed) {
          return '<div class="pn-analyst failed"><span class="pn-analyst-k">' + esc(a ? a.label : 'Analyst') + '</span>' +
                 '<span class="pn-analyst-why muted">did not answer' +
                 (a && a.failWhy && KT.desk.failText ? ' (' + esc(KT.desk.failText(a.failWhy)) + ')' : '') + '</span></div>';
        }
        return '<details class="pn-analyst"><summary><span class="pn-analyst-k">' + esc(a.label) + '</span>' + scoreBar(a.score) +
               '<span class="pn-analyst-v num">' + (a.score >= 0 ? '+' : '') + a.score.toFixed(2) + '</span></summary>' +
               (a.why ? '<p class="pn-analyst-why">' + esc(a.why) + '</p>' : '') +
               (a.points && a.points.length ? '<ul class="pn-points">' + a.points.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>' : '') +
               '</details>';
      }).join('') + '</div>';
      if (run.debate) {
        html += '<details class="pn-debate"><summary>Bull against bear <span class="muted">' +
                esc(run.debate.stronger === 'even' ? 'even' : run.debate.stronger + ' case stronger') + '</span></summary>' +
                '<p><b class="up">Bull.</b> ' + esc(run.debate.bull) + '</p><p><b class="down">Bear.</b> ' + esc(run.debate.bear) + '</p>' +
                (run.debate.why ? '<p class="muted">' + esc(run.debate.why) + '</p>' : '') + '</details>';
      }
      if (run.lessonsUsed && run.lessonsUsed.length) {
        html += '<p class="fine">Read ' + run.lessonsUsed.length + ' lesson' + (run.lessonsUsed.length === 1 ? '' : 's') +
                ' from similar situations before deciding.</p>';
      }
    } else if (!run && !running) {
      html += '<p class="fine">Four analysts (technical, news, flows and macro, ' +
              (KT.app.isStockView() ? 'company' : 'market internals') + '), and a fifth on the crowd\'s mood when its sources answer, ' +
              'read the evidence on their own. A bull and a bear argue it out, ' +
              'then a final call is made with what would prove it wrong. It never sees the forecast\'s answer.</p>';
      if (!hasKey) html += '<p class="fine">Add an OpenRouter key in Settings to run it. Everything else on the page works without one.</p>';
    }
    body.innerHTML = html;

    var runBtn = $('desk-run'), qBtn = $('desk-quick');
    if (runBtn) {
      runBtn.disabled = running || !hasKey || b.left < KT.desk.CALLS.full;
      runBtn.textContent = running ? 'Running…' : 'Run the desk';
      runBtn.title = !hasKey ? 'Add an OpenRouter key in Settings first' :
        b.left < KT.desk.CALLS.full ? 'Needs ' + KT.desk.CALLS.full + ' AI calls; ' + b.left + ' left today' : 'Six or seven AI requests (seven with the sentiment analyst), a few more if a step has to be asked twice';
    }
    if (qBtn) {
      qBtn.disabled = running || !hasKey || b.left < 1;
      qBtn.title = !hasKey ? 'Add an OpenRouter key in Settings first' : 'One AI request';
    }
    var auto = $('desk-auto');
    if (auto) auto.checked = KT.desk.autoEnabled();
    var note = $('desk-note');
    if (note) {
      var bits = [];
      if (hasKey && b.by && Object.keys(b.by).length) {
        bits.push('Used today: ' + Object.keys(b.by).map(function (k) { return b.by[k] + ' ' + k; }).join(', ') + '.');
      }
      if (hasKey) bits.push('Counted in this browser; another device on the same key is not seen here.');
      note.textContent = bits.join(' ');
    }
  }

  /* Company evidence for the desk's fourth analyst on a stock: the exchange's
     event calendar, bulk and block deals and insider filings, market-wide
     lists through the shared proxy, fetched at most hourly and filtered here.
     Whatever has not answered in eight seconds is left out. */
  var nseCache = {};
  function cached(key, maxAgeMs, fetcher) {
    var hit = nseCache[key];
    if (hit && Date.now() - hit.at < maxAgeMs) return Promise.resolve(hit.v);
    return fetcher().then(function (v) { nseCache[key] = { at: Date.now(), v: v }; return v; })
      .catch(function () { return hit ? hit.v : null; });
  }
  function withinMs(p, ms) {
    return Promise.race([p, new Promise(function (res) { setTimeout(function () { res(null); }, ms); })]);
  }
  function companyExtras(sym) {
    var d = KT.data;
    return Promise.all([
      withinMs(KT.stocks.fundamentals(sym, 5 * 60000), 8000),
      withinMs(KT.stocks.extras(sym), 8000),
      withinMs(cached('events', 6 * 3600000, function () { return d.getEventCalendar ? d.getEventCalendar() : Promise.resolve(null); }), 8000),
      withinMs(cached('deals', 3600000, function () { return d.getLargeDeals ? d.getLargeDeals() : Promise.resolve(null); }), 8000),
      withinMs(cached('insider', 3600000, function () { return d.getInsiderFilings ? d.getInsiderFilings() : Promise.resolve(null); }), 8000),
    ]).then(function (r) {
      var fund = r[0] || null;
      if (fund && r[1]) Object.keys(r[1]).forEach(function (k) { if (r[1][k] != null) fund[k] = r[1][k]; });
      function mine(x) { return x && x.rows ? x.rows.filter(function (row) { return row.symbol === sym; }) : []; }
      return {
        fundamentals: fund,
        events: mine(r[2]).map(function (e) { return { purpose: e.purpose, desc: e.desc, date: e.date }; }),
        deals: mine(r[3]).map(function (x) { return { client: x.client, side: x.side, valueCr: x.valueCr, kind: x.kind }; }),
        filings: mine(r[4]).map(function (x) { return { headline: 'Insider disclosure: ' + (x.type || 'filing') + (x.reg ? ' (' + x.reg + ')' : '') }; }),
      };
    });
  }
  // The street line reads the screener row, from its own ten-minute cache.
  var lastFund = {};
  function stockFund(sym) {
    if (!KT.stocks) return null;
    KT.stocks.fundamentals(sym, 10 * 60000).then(function (r) { if (r) lastFund[sym] = r; }).catch(function () {});
    return lastFund[sym] || null;
  }

  function runDesk(mode, auto) {
    var S = KT.app.state;
    if (!KT.desk || KT.desk.busy()) return Promise.resolve(null);
    state.desk = { running: true, stage: { text: auto ? 'Automatic run starting' : 'Gathering the evidence' }, analysts: {} };
    renderDesk(S);
    var symbolAtStart = S.symbol;
    // The company's data on a stock, and on any symbol the crowd's numbers
    // for the sentiment analyst; each waits a few seconds at most.
    var prep = Promise.all([
      KT.app.isStockView() ? companyExtras(S.symbol) : Promise.resolve({}),
      KT.data.getSentiment ? withinMs(KT.data.getSentiment(S.symbol), 9000) : Promise.resolve(null),
    ]).then(function (r) {
      var x = r[0] || {}, live = r[1] || null;
      // The workflow's reading (data/social.json) when the live one does not
      // answer, and its Reddit sample either way: the browser cannot reach Reddit.
      var file = KT.forecast.socialFor ? KT.forecast.socialFor(S.social, symbolAtStart) : null;
      x.sentiment = live ? (file && file.reddit ? { at: live.at, mood: live.mood, crowd: live.crowd, reddit: file.reddit } : live) : file;
      return x;
    });
    return prep.then(function (extras) {
      if (extras && extras.fundamentals) lastFund[symbolAtStart] = extras.fundamentals;
      return KT.desk.run(S, {
        mode: mode, extras: extras,
        onProgress: function (p) {
          if (!state.desk) return;
          if (p.stage === 'analyst' && p.analyst) state.desk.analysts[p.id] = p.analyst;
          else state.desk.stage = p;
          if (KT.app.state.symbol === symbolAtStart) renderDesk(KT.app.state);
        },
      });
    }).then(function (row) {
      state.desk = null;
      KT.app.recompute();
      return row;
    }).catch(function (e) {
      var m = String(e && e.message || e);
      state.desk = { error: /budget|limit/.test(m) ? 'Not enough AI calls left today for this run.'
                     : /no key/.test(m) ? 'Add an OpenRouter key in Settings first.'
                     : /analysts answered/.test(m) ? 'The AI did not answer well enough this time (' + m + '). Try again in a minute.'
                     : 'The desk could not finish: ' + m + '.' };
      renderDesk(KT.app.state);
      return null;
    });
  }

  // After every recompute: settle desk calls past their horizon, write the
  // lessons, and start an automatic run when one is due.
  function deskWork(S) {
    if (!KT.desk) return;
    var tf = C.timeframes[S.timeframe];
    var settled = [];
    try { settled = KT.desk.settle(S.symbol, S.candles, tf ? tf.barSec : 60); } catch (e) { settled = []; }
    settled.forEach(function (r) {
      KT.desk.reflect(S, r).then(function () { renderLearned(KT.app.state); }).catch(function () {});
    });
    if (!state.keyChecked && S.settings && S.settings.key && KT.data.checkKey) {
      state.keyChecked = true;
      KT.data.checkKey(S.settings.key).then(function () { renderDesk(KT.app.state); });
    }
    // Wait for the live lanes to land before an automatic run reads them.
    var settledIn = Date.now() - state.firstRenderAt > 20000;
    var newsIn = KT.data.getNews && KT.data.getNews().length > 20;
    if (settledIn && newsIn && KT.desk.shouldAuto(S)) runDesk('full', true);
  }

  /* ============================================================== LEARNED */
  function renderLearned(S) {
    var box = $('learned-lessons');
    if (!box || !KT.lessons) return;
    var mine = KT.lessons.recent(5, S.symbol);
    var list = mine.length ? mine : KT.lessons.recent(5);
    var n = KT.lessons.count();
    setText('learned-n', n ? n + ' lesson' + (n === 1 ? '' : 's') : 'none yet');
    box.innerHTML = !list.length
      ? '<li class="fine">Nothing yet. Every judged session and every desk call past its horizon files a lesson under the ' +
        'situation it was made in, and the next call in a similar situation reads it first.</li>'
      : list.map(function (l) {
          var o = l.outcome || {};
          var mark = o.right === true ? 'right' : o.right === false ? 'wrong' : 'flat';
          var src = /^lock:/.test(l.runId || '') ? 'frozen call' : l.source === 'ai' ? 'AI desk, in its words' : 'AI desk, arithmetic';
          return '<li class="pn-lesson ' + mark + '"><span class="pn-lesson-meta">' + esc(l.symbol || '') + ' · ' +
            esc(dayLabel(Math.floor(l.at / 1000))) + ' · ' + esc(src) +
            (o.movePct != null ? ' · <span class="' + (o.movePct >= 0 ? 'up' : 'down') + '">' + esc(fmt.pct(o.movePct)) + '</span>' : '') +
            '</span><span class="pn-lesson-t">' + esc(l.text) + '</span></li>';
        }).join('');

    // Which inputs have pointed the way the session went, call by call.
    var lanesBox = $('learned-lanes');
    if (lanesBox && KT.postmortem && KT.ledger) {
      // One row a session, so a session with two frozen calls counts once.
      var lr = KT.postmortem.laneRecord(sessionRows(S.symbol)).filter(function (x) { return x.n >= 3; }).slice(0, 6);
      lanesBox.innerHTML = lr.length
        ? '<p class="jl-k">Inputs, on judged sessions</p>' + lr.map(function (x) {
            return '<div class="kv"><span class="kv-k">' + esc(x.label) + '</span><span class="kv-v ' +
              (x.ci && x.ci[0] > 50 ? 'up' : x.ci && x.ci[1] < 50 ? 'down' : '') + '" title="' +
              esc(x.ci ? 'The true rate could be ' + x.ci[0] + '% to ' + x.ci[1] + '%.' : '') + '">' +
              x.right + ' of ' + x.n + ' right</span></div>';
          }).join('')
        : '';
    }

    /* Twenty years: what the model has shown out of sample, which inputs
       carry it, and the base rate every hit rate is read against. */
    var yb = $('learned-years');
    if (yb) {
      var hm = S.historyModel && S.historyModel.ok && S.historyModel.models ? S.historyModel.models[S.symbol] : null;
      var st = S.study && S.study.symbols ? S.study.symbols[S.symbol] : null;
      var parts = [];
      if (hm) {
        var set = hm[hm.infoSet] || {}, rec = set.record;
        if (rec) {
          parts.push('<div class="kv"><span class="kv-k">20-year model, out of sample</span><span class="kv-v" title="' +
            esc('Each year from ' + rec.from.slice(0, 4) + ' scored by a model fitted only on the years before it. ' +
                'Always-up: ' + rec.baselines.alwaysUp + '%. Tomorrow repeats today: ' + rec.baselines.repeat + '%.') + '">' +
            rec.hit + '% of ' + rec.n.toLocaleString('en-IN') + (rec.ci ? ' (' + rec.ci[0] + '-' + rec.ci[1] + '%)' : '') + '</span></div>');
          parts.push('<div class="kv"><span class="kv-k">Always up / repeat yesterday</span><span class="kv-v">' +
            rec.baselines.alwaysUp + '% / ' + rec.baselines.repeat + '%</span></div>');
        }
        var imp = (set.importance || []).filter(function (g) { return g.aucDrop > 0.002; }).slice(0, 4);
        if (imp.length) {
          parts.push('<p class="fine">What carries it, most first: ' + esc(imp.map(function (g) { return g.label; }).join('; ')) + '.</p>');
        }
      }
      if (st && st.base && st.base.all) {
        parts.push('<p class="fine">Since ' + esc(st.span.from.slice(0, 4)) + ' the index closed higher the next session ' +
          st.base.all.upRate + '% of the time: the bar every hit rate here has to clear, not 50%.</p>');
      }
      yb.innerHTML = parts.length ? '<p class="jl-k">Twenty years</p>' + parts.join('') : '';
    }

    var w = $('learned-weights');
    if (w && KT.learn && KT.learn.summary) {
      var sum = KT.learn.summary(), bits = [];
      if (!sum.fitted) {
        var judgedN = Math.max(sum.samples || 0, sum.recordSamples || 0);
        bits.push('Lane weights are still the starting set: ' + judgedN + ' judged session' + (judgedN === 1 ? '' : 's') +
                  ' so far, and an input needs ' + sum.minSample + ' before the learner may move its weight.');
      } else {
        var hist = KT.learn.history ? KT.learn.history() : [];
        var moved = hist.length && hist[0].moved ? hist[0].moved : [];
        bits.push('Lane weights tuned from ' + sum.samples + (sum.source === 'record' ? ' judged sessions in the published record, ' : ' settled calls, ') +
                  sum.steps + ' step' + (sum.steps === 1 ? '' : 's') + ' taken.');
        if (moved.length) {
          bits.push('Last step: ' + moved.slice(0, 3).map(function (m) {
            return (m.id === 'model' ? 'AI desk' : (m.label || m.id)).toLowerCase() + ' ' + m.from.toFixed(3) + ' → ' + m.to.toFixed(3);
          }).join(', ') + '.');
        }
      }
      // The opening gap: are the gaps it calls too big or too small.
      if (sum.openSamples >= 10 && isNum(sum.openGain) && sum.openGain !== 1) {
        bits.push('Opening gaps are called ' + (sum.openGain > 1 ? 'larger' : 'smaller') + ' than the starting model would, ×' +
                  sum.openGain.toFixed(2) + ', from ' + sum.openSamples + ' opens.');
      }
      /* The gap between the frozen line and the market (learn.closeFitFrom):
         whether the moves it draws are too big or too small, and any lean it
         keeps missing by. Says how far off it is until there is a sample. */
      var minClose = sum.minCloseSample || 10;
      if ((sum.closeSamples || 0) < minClose) {
        bits.push('The gap between each frozen line and where the market went is being measured: ' +
                  (sum.closeSamples || 0) + ' of ' + minClose + ' judged sessions before it may resize the line.');
      } else if (isNum(sum.closeGain)) {
        var g = sum.closeGain, b = sum.closeBias || 0;
        bits.push('From the gap between its lines and the market over ' + sum.closeSamples + ' sessions, the session move is now drawn ' +
                  (Math.abs(g - 1) < 0.005 ? 'at the starting size' : '×' + g.toFixed(2) + (g < 1 ? ' (it was calling moves too big)' : ' (it was calling moves too small)')) +
                  (b ? ', and the close is nudged ' + (b > 0 ? 'up' : 'down') + ' ' + Math.abs(b).toFixed(2) + '% for a lean it kept missing by' : '') + '.');
      }
      // Whether its odds have meant what they said, from the published record.
      var st = S.record && S.record.symbols && S.record.symbols[S.symbol] && S.record.symbols[S.symbol].stats;
      if (st && st.close && st.close.n >= 3 && isNum(st.close.maePts)) {
        bits.push('Its frozen closes have been ' + Math.round(st.close.maePts) + ' points off on average over ' + st.close.n +
                  ' sessions' + (isNum(st.close.biasPct) && Math.abs(st.close.biasPct) >= 0.05
                    ? ', and on average the market closed ' + Math.abs(st.close.biasPct).toFixed(2) + '% ' +
                      (st.close.biasPct > 0 ? 'above' : 'below') + ' the line' : '') + '.');
      }
      var cal = st && st.calibration ? st.calibration.filter(function (b) { return b.n >= 5 && b.label !== 'no lean'; }) : [];
      if (cal.length) {
        bits.push('When it gave ' + cal.map(function (b) {
          return b.from + (b.to >= 100 ? '%+' : '-' + b.to + '%') + ' for up, the close was up ' + b.upRate + '% of ' + b.n;
        }).join('; ') + '.');
      }
      w.textContent = bits.join(' ');
    }
  }

  /* =============================================================== SEARCH

     The market watch's search box, which used to filter four rows, now finds
     any NSE stock too. The row filter in app.js still runs on the same input;
     this adds the list of matches under it. */
  var sugg = { items: [], active: -1 };

  function openSymbol(sym, opts) {
    opts = opts || {};
    if (!sym) return;
    sym = String(sym).toUpperCase();
    if (!KT.app.openSymbol(sym)) return;
    if (KT.stocks && KT.stocks.isStock(sym)) KT.stocks.remember(sym);
    if (!opts.fromHash) {
      try { history.replaceState(null, '', sym === C.defaultSymbol ? location.pathname : '#s=' + encodeURIComponent(sym)); } catch (e) { /* file:// */ }
    }
    state.desk = null;
    var inp = $('mw-search');
    if (inp) { inp.value = ''; inp.dispatchEvent(new Event('input')); inp.blur(); }
    closeSuggest();
    showLoading(sym);
    var r = KT.app.state;
    renderDesk(r); renderLearned(r);
  }

  function closeSuggest() {
    var ul = $('mw-suggest');
    if (ul) { ul.classList.add('hidden'); ul.innerHTML = ''; }
    var inp = $('mw-search');
    if (inp) inp.setAttribute('aria-expanded', 'false');
    sugg = { items: [], active: -1 };
  }

  function showSuggest(q) {
    var ul = $('mw-suggest'), inp = $('mw-search');
    if (!ul || !KT.stocks) return;
    var items;
    if (!q) {
      items = KT.stocks.recent().map(function (s) {
        var row = KT.stocks.lookup(s);
        return { symbol: s, name: row ? row.name : '', recent: true };
      });
      if (!items.length) { closeSuggest(); return; }
    } else if (!KT.stocks.ready()) {
      ul.innerHTML = '<li class="pn-sugg-note">Loading the list of NSE stocks…</li>';
      ul.classList.remove('hidden');
      return;
    } else {
      items = KT.stocks.search(q, 8);
    }
    sugg = { items: items, active: items.length ? 0 : -1 };
    ul.innerHTML = !items.length
      ? '<li class="pn-sugg-note">No NSE stock or index matches “' + esc(q) + '”.</li>'
      : (q ? '' : '<li class="pn-sugg-note">Recent</li>') + items.map(function (it, i) {
          return '<li role="option" class="pn-sugg' + (i === 0 ? ' is-active' : '') + '" data-sym="' + esc(it.symbol) + '" aria-selected="' + (i === 0) + '">' +
            '<span class="pn-sugg-s">' + esc(it.symbol) + '</span><span class="pn-sugg-n">' + esc(it.name || '') + '</span>' +
            (it.index ? '<span class="chip brand">index</span>' : '') + '</li>';
        }).join('');
    ul.classList.remove('hidden');
    if (inp) inp.setAttribute('aria-expanded', 'true');
  }

  function moveActive(d) {
    var ul = $('mw-suggest');
    if (!ul || !sugg.items.length) return;
    sugg.active = (sugg.active + d + sugg.items.length) % sugg.items.length;
    ul.querySelectorAll('.pn-sugg').forEach(function (li, i) {
      li.classList.toggle('is-active', i === sugg.active);
      li.setAttribute('aria-selected', String(i === sugg.active));
    });
  }

  function wireSearch() {
    var inp = $('mw-search'), ul = $('mw-suggest');
    if (!inp || !ul) return;
    inp.addEventListener('input', core.debounce(function () { showSuggest(inp.value.trim()); }, 80));
    inp.addEventListener('focus', function () { showSuggest(inp.value.trim()); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
      else if (e.key === 'Escape') { closeSuggest(); inp.blur(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        var it = sugg.items[sugg.active];
        var typed = inp.value.trim().toUpperCase();
        if (it) openSymbol(it.symbol);
        else if (typed && KT.stocks && (KT.stocks.lookup(typed) || C.symbols[typed])) openSymbol(typed);
      }
    });
    inp.addEventListener('blur', function () { setTimeout(closeSuggest, 160); });
    ul.addEventListener('mousedown', function (e) {
      var li = e.target.closest ? e.target.closest('.pn-sugg') : null;
      if (!li) return;
      e.preventDefault();
      openSymbol(li.getAttribute('data-sym'));
    });
    // "/" focuses the search from anywhere, unless the key is typed into a field.
    document.addEventListener('keydown', function (e) {
      var tag = e.target && e.target.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') { e.preventDefault(); inp.focus(); }
    });
  }

  function symbolFromHash() {
    var m = /(?:^#|&)s=([^&]+)/.exec(location.hash || '');
    return m ? decodeURIComponent(m[1]).toUpperCase().replace(/[^A-Z0-9&_-]/g, '') : null;
  }

  /* ============================================================== LESSONS */
  function wireLessons() {
    var ex = $('lessons-export'), im = $('lessons-import'), file = $('lessons-file');
    if (ex) ex.addEventListener('click', function () {
      if (!KT.lessons) return;
      var blob = new Blob([KT.lessons.exportJson()], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'lessons-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });
    if (im && file) {
      im.addEventListener('click', function () { file.click(); });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (!f || !KT.lessons) return;
        f.text().then(function (t) {
          var res = KT.lessons.importJson(t);
          setText('learned-weights', res.error ? 'Import failed: ' + res.error + '.' : res.added + ' lesson' + (res.added === 1 ? '' : 's') + ' added.');
          renderLearned(KT.app.state);
        });
        file.value = '';
      });
    }
  }

  function wireDesk() {
    var run = $('desk-run'), quick = $('desk-quick'), auto = $('desk-auto');
    if (run) run.addEventListener('click', function () { runDesk('full', false); });
    if (quick) quick.addEventListener('click', function () { runDesk('quick', false); });
    if (auto) auto.addEventListener('change', function () { if (KT.desk) KT.desk.setAuto(auto.checked); });
  }

  /* =============================================================== RENDER */
  /* ========================================================== SETUP CHECK
     drivers.setup: the direction view (do the inputs agree, how much room)
     and the range view (how quiet the day is likely to be, which is what an
     option seller judges). Conditions, never instructions. */
  var setupTab = (function () { try { return core.store.get('setupTab', 'direction'); } catch (e) { return 'direction'; } })();
  var GRADE_WORD = { strong: 'strong', moderate: 'moderate', mixed: 'mixed', 'no lean': 'no clear lean',
                     favourable: 'favourable', unfavourable: 'unfavourable' };
  function renderSetup(S) {
    var body = $('setup-body');
    if (!body) return;
    var su = S.setup;
    document.querySelectorAll('#setup-tabs .su-tab').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.setup === setupTab)); });
    if (!su) { body.innerHTML = '<p class="fine">Waiting for the forecast.</p>'; return; }
    var html = '';
    if (setupTab === 'range') {
      var r = su.range;
      html += '<div class="su-grade ' + esc(r.grade) + '">Conditions for a quiet day: <b>' + esc(GRADE_WORD[r.grade] || r.grade) + '</b></div>';
      var bits = [];
      if (isNum(r.sigmaPct)) bits.push('One day\'s expected move from India VIX: about ±' + r.sigmaPct.toFixed(2) + '%' + (isNum(r.oneSdPts) ? ' (' + fmt.int(r.oneSdPts) + ' points)' : '') + '.');
      if (isNum(r.low68) && isNum(r.high68)) bits.push('The line\'s likely range at the end of its horizon: ' + px(r.low68) + ' to ' + px(r.high68) + '.');
      html += '<p class="su-line">' + esc(bits.join(' ')) + '</p>';
      if (r.signs.length) {
        html += '<ul class="su-signs">' + r.signs.map(function (x) {
          return '<li class="' + (x.good ? 'good' : 'bad') + '"><span class="su-dot"></span><span>' + esc(x.text) + '</span></li>';
        }).join('') + '</ul>';
      } else {
        html += '<p class="fine">No sign either way yet: the CPR, VIX and option walls have not arrived.</p>';
      }
    } else {
      var d = su.direction;
      var dirWord = d.lean > 0 ? 'an up move' : d.lean < 0 ? 'a down move' : 'either side';
      html += '<div class="su-grade ' + esc(d.grade.replace(' ', '-')) + '">Conditions for ' + dirWord + ': <b>' + esc(GRADE_WORD[d.grade] || d.grade) + '</b></div>';
      var line = [];
      if (isNum(d.pUp)) line.push('Odds the close is higher: ' + d.pUp + '%.');
      if (d.total) line.push(d.lean ? d.agreeN + ' of ' + d.total + ' inputs point the same way.' : d.total + ' inputs with a view, split.');
      html += '<p class="su-line">' + esc(line.join(' ')) + '</p>';
      var li = function (x) { return '<li>' + esc(x.label) + '</li>'; };
      html += '<div class="su-cols"><div><p class="jl-k">' + (d.lean ? 'With it' : 'Up') + '</p><ul class="su-list">' + (d.withIt.map(li).join('') || '<li class="muted">nothing strong</li>') + '</ul></div>' +
              '<div><p class="jl-k">' + (d.lean ? 'Against it' : 'Down') + '</p><ul class="su-list">' + (d.against.map(li).join('') || '<li class="muted">nothing strong</li>') + '</ul></div></div>';
      var room = [];
      if (isNum(d.resistance)) room.push('resistance ' + px(d.resistance) + ' (' + (d.roomUp >= 0 ? '+' : '') + d.roomUp.toFixed(2) + '%)');
      if (isNum(d.support)) room.push('support ' + px(d.support) + ' (-' + d.roomDown.toFixed(2) + '%)');
      if (room.length) html += '<p class="su-line">Room: ' + esc(room.join(', ')) + '.</p>';
      var chk = KT.learn && KT.learn.closeFitCheck ? KT.learn.closeFitCheck(S.symbol) : null;
      var rec = sessionRecord(S.symbol);
      var recBits = [];
      if (rec.n) recBits.push('right on ' + rec.right + ' of ' + rec.n + ' judged sessions');
      if (chk && chk.intradayCalls) recBits.push('its line\'s move after the open went the right way ' + chk.intradayRight + ' of ' + chk.intradayCalls + ' times');
      if (recBits.length) html += '<p class="fine">Its own record: ' + esc(recBits.join('; ')) + '. Weigh the lean with that in mind.</p>';
    }
    html += '<p class="fine su-foot">A reading of the inputs on this page, not advice. Every trade is your own call.</p>';
    body.innerHTML = html;
  }

  /* ======================================================= WHY IT IS MOVING
     drivers.explain: the factors pushing the index down and holding it up,
     each with the points its measured link puts on it. */
  function renderDrivers(S) {
    var ex = S.drivers, mv = $('drivers-move');
    if (!mv) return;
    var meta = C.symbols[S.symbol] || { label: S.symbol };
    if (!ex) { mv.textContent = 'Reading the markets...'; return; }
    var m = ex.move;
    mv.innerHTML = m ? esc(meta.label) + ' <b class="' + (m.pct >= 0 ? 'up' : 'down') + '">' + esc(fmt.pct(m.pct)) + '</b> (' +
      esc((m.pts >= 0 ? '+' : '') + Math.round(m.pts)) + ' points) against the last close' : esc(meta.label);
    var item = function (x) {
      var pts = isNum(x.pts) ? '<span class="dv-pts ' + (x.pts >= 0 ? 'up' : 'down') + '">' + (x.pts > 0 ? '+' : '') + x.pts + ' pts</span>' : '';
      var tip = x.link ? 'Measured link: ' + x.link.beta + ' per unit move, ' + x.link.kind + ', over ' + x.link.n + ' sessions' +
        (isNum(x.link.hit) ? '; same direction ' + x.link.hit + '% of the time on big days' : '') : x.kind === 'member' ? 'Index weight times its move (full market cap weights, approximate)' : '';
      return '<li' + (tip ? ' title="' + esc(tip) + '"' : '') + '><span class="dv-k">' + esc(x.label) + '</span><span class="dv-r">' + esc(x.reading) + '</span>' + pts + '</li>';
    };
    var dn = $('drivers-down'), up = $('drivers-up');
    if (dn) dn.innerHTML = ex.dragging.slice(0, 8).map(item).join('') || '<li class="muted">Nothing notable</li>';
    if (up) up.innerHTML = ex.supporting.slice(0, 8).map(item).join('') || '<li class="muted">Nothing notable</li>';
    var note = [];
    if (ex.world && ex.world.measured && ex.world.explainedPts != null) {
      note.push('By their measured links, markets abroad account for about ' + (ex.world.explainedPts > 0 ? '+' : '') + ex.world.explainedPts + ' points of this move.');
    } else if (ex.world && ex.world.rows.length) {
      note.push('Markets abroad are shown by the way they usually push India; their measured links (twenty years) arrive with the next scheduled run.');
    }
    if (ex.inside) {
      var top = ex.inside.sectors.filter(function (x) { return Math.abs(x.pts) >= 3; }).slice(0, 2)
        .concat(ex.inside.sectors.filter(function (x) { return Math.abs(x.pts) >= 3; }).slice(-2));
      var seen = {}, words = [];
      top.forEach(function (x) { if (seen[x.sector]) return; seen[x.sector] = 1; words.push(x.sector + ' ' + (x.pts > 0 ? '+' : '') + x.pts); });
      if (words.length) note.push('Inside the index: ' + words.join(', ') + ' points (weights approximate).');
    }
    setText('drivers-note', note.join(' '));
    renderWorldBoard(S);
  }

  var GROUP_ORDER = ['india', 'asia', 'us', 'europe', 'commodities', 'currencies and rates', 'risk appetite', 'other'];
  var GROUP_NAME = { india: 'GIFT Nifty', asia: 'Asia', us: 'United States', europe: 'Europe', commodities: 'Commodities',
                     'currencies and rates': 'Currencies and rates', 'risk appetite': 'Risk appetite', other: 'Other' };
  function renderWorldBoard(S) {
    var host = $('cues-list');
    if (!host) return;
    var ex = S.drivers, w = ex && ex.world;
    if (!w || !w.rows.length) return;
    var html = '';
    GROUP_ORDER.forEach(function (gk) {
      var g = w.groups[gk];
      if (!g) return;
      html += '<div class="wb-group"><p class="jl-k">' + esc(GROUP_NAME[gk] || gk) + '</p>';
      g.rows.forEach(function (r) {
        var mv = (r.move > 0 ? '+' : '') + r.move + (r.unit === 'points' ? ' pts' : '%');
        var hr = isNum(r.hour) ? (r.hour > 0 ? '+' : '') + r.hour.toFixed(2) + '% 1h' : '';
        var link = r.link ? 'link ' + r.link.beta : '';
        var push = isNum(r.pushPts) ? (r.pushPts > 0 ? '+' : '') + r.pushPts + ' pts' : '';
        html += '<div class="wb-row" title="' + esc(r.link ? 'Measured over ' + r.link.n + ' sessions (' + r.link.kind + '), correlation ' + r.link.corr : 'No measured link yet') + '">' +
          '<span class="wb-k">' + esc(r.label) + (r.delay ? ' <small>' + r.delay + 'm</small>' : '') + '</span>' +
          '<span class="wb-v ' + (r.move > 0 ? 'up' : r.move < 0 ? 'down' : '') + '">' + esc(mv) + '</span>' +
          '<span class="wb-h">' + esc(hr) + '</span>' +
          '<span class="wb-p ' + (r.pushPts > 0 ? 'up' : r.pushPts < 0 ? 'down' : '') + '">' + esc(push || link) + '</span></div>';
      });
      html += '</div>';
    });
    host.innerHTML = html;
    setText('wb-count', w.rows.length + ' markets');
  }

  /* ============================================================ STUDIES
     The Studies menu under the chart's overlay buttons: each study's toggle,
     the rule of thumb it comes with, where price sits against it now, and
     how often its rules came true (studies.js, the workflow's twenty years
     or this browser's two). */
  var studiesOpen = false;
  function renderStudies(S) {
    var pop = $('studies-pop');
    if (!pop || !studiesOpen || !KT.studies) return;
    var on = KT.chart && KT.chart.overlays ? KT.chart.overlays() : {};
    var tf = C.timeframes[S.timeframe] || {};
    var ms = core.marketState ? core.marketState() : { state: 'live' };
    var pb = S.playbook;
    var rd = KT.studies.readings({ candles: S.candles, options: S.options, playbook: pb, live: ms.state === 'live',
                                   intraday: tf.barSec < 86400, symbol: S.symbol });
    var byStudy = {};
    (pb && pb.rules || []).forEach(function (r) { (byStudy[r.study] = byStudy[r.study] || []).push(r); });
    var src = !pb ? 'Measuring: the rules are counted once two years of daily bars arrive.'
      : pb.source === 'workflow' ? 'Each rule counted on ' + (C.symbols[S.symbol] || { label: S.symbol }).label + '\'s daily record, ' + String(pb.from).slice(0, 4) + ' to ' + String(pb.to).slice(0, 4) + ' (' + fmt.int(pb.days) + ' sessions).'
      : 'Each rule counted on the last ' + fmt.int(pb.days) + ' sessions here; the twenty-year counts arrive with the scheduled run.';
    var act = S.activeRules || [];
    var html = '<div class="sp-head"><b>Studies</b><button class="btn btn-sm" id="studies-close">Close</button></div>' +
      '<p class="fine">' + esc(src) + '</p>';
    if (act.length) {
      html += '<p class="jl-k">In play now</p><ul class="sp-active">' + act.slice(0, 6).map(function (r) {
        return '<li><b>' + esc(r.name) + '</b>' + (r.rate != null ? ': came true ' + r.rate + '% of ' + fmt.int(r.n) + ' times' + (r.base != null ? ' (any day ' + r.base + '%)' : '') : '') + '</li>';
      }).join('') + '</ul>';
    }
    // Which measured rules belong under which study (studies.js RULES `study`).
    var RULES_OF = { cpr: ['cpr'], pivots: ['pivots'], camarilla: ['camarilla'], pdhl: ['pdhl', 'gap'],
                     osc: ['rsi', 'ema', 'range', 'vix'] };
    html += '<ul class="sp-list">' + KT.studies.CATALOGUE.map(function (st) {
      var all = [];
      (RULES_OF[st.id] || []).forEach(function (k) { all = all.concat(byStudy[k] || []); });
      return '<li class="sp-item"><label class="sp-row"><input type="checkbox" data-study="' + esc(st.id) + '"' + (on[st.id] ? ' checked' : '') + '>' +
        '<b>' + esc(st.name) + '</b></label>' +
        (rd[st.id] ? '<p class="sp-read">' + esc(rd[st.id]) + '</p>' : '') +
        '<p class="sp-tip">' + esc(st.tip) + '</p>' +
        (all.length ? '<ul class="sp-rules">' + all.filter(function (r) { return r.n > 0; }).map(function (r) {
          return '<li title="' + esc(r.tip) + '">' + esc(r.name) + ': <b>' + (r.rate != null ? r.rate + '%' : 'n/a') + '</b> of ' + fmt.int(r.n) +
            (r.base != null ? ' <span class="muted">(any day ' + r.base + '%)</span>' : '') + '</li>';
        }).join('') + '</ul>' : '') + '</li>';
    }).join('') + '</ul>';
    if (pb && pb.gapFollow) {
      html += '<p class="fine">Gaps: on average ' + Math.abs(Math.round(pb.gapFollow.beta * 100)) + '% of an opening gap ' + (pb.gapFollow.beta < 0 ? 'was given back' : 'was added to') + ' by the close (' + fmt.int(pb.gapFollow.n) + ' sessions).</p>';
    }
    html += '<p class="fine">Rates are how often the rule came true, not a promise. A rule that only matches its "any day" rate has no edge.</p>';
    pop.innerHTML = html;
  }
  function initStudies() {
    var btn = $('btn-studies'), pop = $('studies-pop');
    if (!btn || !pop) return;
    btn.addEventListener('click', function () {
      studiesOpen = !studiesOpen;
      pop.hidden = !studiesOpen;
      btn.setAttribute('aria-expanded', String(studiesOpen));
      btn.classList.toggle('is-on', studiesOpen);
      if (studiesOpen) renderStudies(KT.app.state);
    });
    pop.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'studies-close') { studiesOpen = false; pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('is-on'); }
    });
    pop.addEventListener('change', function (e) {
      var id = e.target && e.target.dataset && e.target.dataset.study;
      if (!id || !KT.chart) return;
      KT.chart.setOverlay(id, !!e.target.checked);
      try { core.store.set('overlays', KT.chart.overlays()); } catch (err) { /* a convenience */ }
    });
    var tabs = $('setup-tabs');
    if (tabs) tabs.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.su-tab') : null;
      if (!b) return;
      setupTab = b.dataset.setup === 'range' ? 'range' : 'direction';
      try { core.store.set('setupTab', setupTab); } catch (err) { /* a convenience */ }
      renderSetup(KT.app.state);
    });
  }

  /* ===================================================== RISING TOPICS
     What the market is talking about: topics in the last six hours of
     headlines and crowd posts against the eighteen before, with tone. */
  var TOPICS = [
    ['FII flows', /\b(fii|fiis|fpi|fpis|foreign (?:investors|funds|portfolio))\b/i],
    ['Domestic funds', /\b(dii|diis|mutual funds?|sip inflows?)\b/i],
    ['US Fed', /\b(fed|fomc|powell|federal reserve)\b/i],
    ['Crude oil', /\b(crude|brent|oil prices?|opec)\b/i],
    ['Rupee', /\b(rupee|inr)\b/i],
    ['RBI and rates', /\b(rbi|repo rate|monetary policy|bond yields?|g-sec)\b/i],
    ['Results', /\b(q[1-4] results|quarterly results|q[1-4] earnings|net profit|earnings)\b/i],
    ['Tariffs and trade', /\b(tariffs?|trade (?:deal|war|talks)|trump)\b/i],
    ['China', /\b(china|chinese|beijing|yuan)\b/i],
    ['Asian markets', /\b(nikkei|hang seng|kospi|asian (?:markets|stocks|shares))\b/i],
    ['Wall Street', /\b(wall street|s&p 500|nasdaq|dow jones)\b/i],
    ['Banks', /\b(bank nifty|banks|banking|hdfc bank|icici bank|sbi|kotak|axis bank)\b/i],
    ['IT stocks', /\b(infosys|tcs|wipro|hcl ?tech|tech mahindra|it stocks|it sector)\b/i],
    ['Geopolitics', /\b(war|missile|border|attack|sanctions?|ceasefire|israel|iran|russia|ukraine|pakistan)\b/i],
    ['IPOs', /\b(ipo|ipos|listing|gmp)\b/i],
    ['Gold and silver', /\b(gold|silver|bullion)\b/i],
    ['Inflation', /\b(inflation|cpi|wpi)\b/i],
    ['Expiry and options', /\b(expiry|open interest|put call ratio|pcr|options data)\b/i],
  ];
  function renderTopics(S) {
    var host = $('topics-strip');
    if (!host || !KT.data || !KT.data.getNews) return;
    var now = Date.now() / 1000, recent = {}, before = {}, tone = {};
    // Six hours, or twelve when the last six were quiet (a night, a weekend).
    var win = 6 * 3600;
    var texts = KT.data.getNews().map(function (n) { return { ts: n.ts, text: n.headline, s: n.sentiment }; });
    var live = S.crowdLive && S.crowdLive[S.symbol] && S.crowdLive[S.symbol].value;
    if (live && live.crowd && live.crowd.items) live.crowd.items.forEach(function (it) { texts.push({ ts: it.ts, text: it.text, s: it.tag === 'bullish' ? 1 : it.tag === 'bearish' ? -1 : 0, crowd: true }); });
    var soc = S.social && S.social.reddit && S.social.reddit.ok ? S.social.reddit.posts || [] : [];
    soc.forEach(function (p) { texts.push({ ts: p.ts, text: p.title, s: p.s || 0, crowd: true }); });
    if (texts.filter(function (t) { return t.ts && now - t.ts <= win; }).length < 15) win = 12 * 3600;
    texts.forEach(function (t) {
      if (!t.ts || !t.text) return;
      var age = now - t.ts;
      if (age > 24 * 3600 + win || age < -600) return;
      TOPICS.forEach(function (tp) {
        if (!tp[1].test(t.text)) return;
        if (age <= win) { recent[tp[0]] = (recent[tp[0]] || 0) + 1; (tone[tp[0]] = tone[tp[0]] || []).push(isNum(t.s) ? t.s : 0); }
        else before[tp[0]] = (before[tp[0]] || 0) + 1;
      });
    });
    var hrs = win / 3600;
    var list = Object.keys(recent).map(function (k) {
      var rate = recent[k] / hrs, prior = (before[k] || 0) / 24;
      var tn = tone[k].reduce(function (a, b) { return a + b; }, 0) / tone[k].length;
      return { k: k, n: recent[k], rising: rate >= Math.max(0.5, prior * 1.5), falling: prior > 0 && rate <= prior * 0.5, tone: tn };
    }).sort(function (a, b) { return b.n - a.n; }).slice(0, 7);
    host.innerHTML = list.length ? '<span class="tp-k">Talked about now</span>' + list.map(function (t) {
      return '<span class="chip tp ' + (t.tone > 0.4 ? 'up' : t.tone < -0.4 ? 'down' : '') + '" title="' + esc(t.n + ' mentions in the last ' + hrs + ' hours' + (t.rising ? ', rising' : '') + '; tone ' + (t.tone > 0.4 ? 'positive' : t.tone < -0.4 ? 'negative' : 'mixed')) + '">' +
        esc(t.k) + ' ' + t.n + (t.rising ? ' ▲' : t.falling ? ' ▼' : '') + '</span>';
    }).join('') : '';
  }

  /* The gap analytics under said vs did (learn.closeFitCheck). */
  function renderJudgeStats(S) {
    var host = $('judge-stats');
    if (!host || !KT.learn || !KT.learn.closeFitCheck) return;
    var c = KT.learn.closeFitCheck(S.symbol);
    if (!c || !c.n || c.base == null) { host.innerHTML = c && c.n ? '<p class="fine">' + c.n + ' judged sessions so far; the analysis of the gap needs ' + ((KT.learn.MIN_CLOSE_SAMPLE || 10) + 1) + '.</p>' : ''; return; }
    var better = c.learned < c.base;
    host.innerHTML = '<p class="jl-k">The gap, over ' + c.n + ' judged sessions</p><ul class="js-list">' +
      '<li>The close landed <b>' + c.base.toFixed(2) + '%</b> from the line on average; the open was off by ' + c.gapMiss.toFixed(2) + '%.</li>' +
      '<li>The line\'s move after the open went the right way ' + c.intradayRight + ' of ' + c.intradayCalls + ' times.</li>' +
      '<li>With what it has learned from those sessions (each tested with itself left out) the close would have been off by <b>' + c.learned.toFixed(2) + '%</b>' +
        (better ? ', so the line is now drawn with it.' : ', no better, so the correction stays small.') + '</li>' +
      '<li>A line with no move after the open would have been off by ' + c.flat.toFixed(2) + '%.</li></ul>';
  }

  function render(S) {
    if (!state.firstRenderAt) state.firstRenderAt = Date.now();
    var rec = sessionRecord(S.symbol);
    renderCall(S);
    renderSetup(S);
    renderDrivers(S);
    renderJudge(S, rec);
    renderJudgeStats(S);
    renderDesk(S);
    renderLearned(S);
    renderTopics(S);
    renderStudies(S);
    // Keep the address bar on the symbol being shown, so a copied link opens it.
    var hs = symbolFromHash();
    if (hs !== S.symbol && (hs || S.symbol !== C.defaultSymbol)) {
      try { history.replaceState(null, '', S.symbol === C.defaultSymbol ? location.pathname : '#s=' + encodeURIComponent(S.symbol)); } catch (e) {}
    }
    deskWork(S);
  }

  function showLoading(sym) {
    var meta = C.symbols[sym] || { label: sym };
    var leanEl = $('call-lean');
    if (leanEl) { leanEl.textContent = 'Loading ' + meta.label + '…'; leanEl.className = 'call-lean'; }
    setText('call-prob', ''); setText('call-range', 'Pulling its candles and headlines, then building the session call.');
    setText('call-levels', '');
    var v = $('call-views'); if (v) v.innerHTML = '';
  }

  function init() {
    if (!KT.app || !KT.app.onRecompute) return;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initStudies); else initStudies();
    // A link to #s=RELIANCE opens RELIANCE first, not NIFTY and then RELIANCE.
    var start = symbolFromHash();
    if (start && start !== C.defaultSymbol && KT.app.openSymbol(start)) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { showLoading(start); });
      else showLoading(start);
    }
    KT.app.onRecompute(render);
    if (KT.app.onTrail) KT.app.onTrail(function (S) { renderJudge(S, sessionRecord(S.symbol)); });
    if (KT.app.onLoadError) {
      KT.app.onLoadError(function (sym, msg) {
        var S = KT.app.state;
        if (sym !== S.symbol) return;
        var meta = C.symbols[sym] || { label: sym };
        var leanEl = $('call-lean');
        if (leanEl) { leanEl.textContent = 'No prices yet'; leanEl.className = 'call-lean flat'; }
        setText('call-prob', '');
        setText('call-range', 'The price feed for ' + meta.label + ' did not answer just now. The page tries again on its own.');
        var rg = $('call-range'); if (rg) rg.title = msg;
        setText('call-levels', '');
      });
    }
    var wire = function () { wireSearch(); wireLessons(); wireDesk(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
    window.addEventListener('hashchange', function () {
      var s = symbolFromHash();
      if (s && s !== KT.app.state.symbol) openSymbol(s, { fromHash: true });
    });
  }

  KT.panels = {
    answerOf: answerOf, sessionRecord: sessionRecord, sessionRows: sessionRows,
    render: render, openSymbol: openSymbol, runDesk: runDesk,
  };
  init();
})(window.KT);
