/* ============================================================================
   Why it is moving, and whether the setup is a clean one.

   Two questions the page could not answer before 30 Oct 2026:

     why       NIFTY is down 0.4%: is that Asia, crude, the rupee, the banks,
               or the news? Each factor's live move times its link to NIFTY
               measured over twenty years (scripts/history_model.py,
               world_links), so "the KOSPI fell 3.5%" becomes "about 40
               points of today's move". India's own heavyweights are plain
               arithmetic: weight times move. What is left over is what the
               factors here do not explain, said as such.
     setup     everything the page reads, lined up: where the inputs agree,
               where they fight, how much room there is, and for someone
               selling options, how quiet the day is likely to be. Worded as
               conditions, never as an instruction to trade: the site is
               public, and that is a line SEBI draws.

   Pure functions over the app's state; app.js calls them, panels.js draws.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function r1(n) { return Math.round(n * 10) / 10; }
  function r2(n) { return Math.round(n * 100) / 100; }

  /* Which way each market usually pushes India, for the rows that have no
     measured link yet (before the workflow's first run). Direction only:
     no points are claimed without a measurement. */
  var USUAL = {
    gift_nifty: 1, us_futures: 1, nasdaq_fut: 1, dow_fut: 1, spx: 1, ndx: 1, russell: 1, sox: 1, eem: 1,
    nikkei: 1, hangseng: 1, kospi: 1, taiwan: 1, shanghai: 1, shenzhen: 1, sti: 1,
    ftse: 1, dax: 1, cac: 1, stoxx50: 1,
    crude: -1, wti: -1, natgas: -1, gold: -1, silver: 0, copper: 1,
    usdinr: -1, dxy: -1, us10y: -1, us02y: -1, in10y: -1, jp10y: 0, usdjpy: 1, usdcnh: -1, eurusd: 1,
    cboe_vix: -1, btc: 1,
  };
  var GROUP = {
    gift_nifty: 'india', us_futures: 'us', nasdaq_fut: 'us', dow_fut: 'us', spx: 'us', ndx: 'us', russell: 'us', sox: 'us', eem: 'us', cboe_vix: 'us',
    nikkei: 'asia', hangseng: 'asia', kospi: 'asia', taiwan: 'asia', shanghai: 'asia', shenzhen: 'asia', sti: 'asia',
    ftse: 'europe', dax: 'europe', cac: 'europe', stoxx50: 'europe',
    crude: 'commodities', wti: 'commodities', natgas: 'commodities', gold: 'commodities', silver: 'commodities', copper: 'commodities',
    usdinr: 'currencies and rates', dxy: 'currencies and rates', us10y: 'currencies and rates', us02y: 'currencies and rates',
    in10y: 'currencies and rates', jp10y: 'currencies and rates', usdjpy: 'currencies and rates', usdcnh: 'currencies and rates',
    eurusd: 'currencies and rates', btc: 'risk appetite',
  };
  var POINTS = { us10y: 1, us02y: 1, in10y: 1, jp10y: 1, cboe_vix: 1 };   // moves read in points, not percent

  /* The measured link for one live market, from history_model.json. While
     NSE trades (or after its close) a market that closes before it is read
     on the same day; everything else by its last move before the open. */
  function linkFor(world, key, live) {
    if (!world) return null;
    var row = world.filter(function (w) { return w.live === key; })[0];
    if (!row) return null;
    var use = live && row.sameDay ? row.sameDay : live ? (row.overnight && row.overnight.close) : (row.overnight && row.overnight.gap);
    if (!use || !isNum(use.beta) || !use.n) return null;
    return { beta: use.beta, corr: use.corr, hit: use.hit, n: use.n, kind: live && row.sameDay ? 'same day' : live ? 'overnight, to the close' : 'overnight, to the open',
             unit: row.unit, label: row.label };
  }

  /* World and macro: every live market with its move, hour, measured link
     and the push that link implies. Within a group the strongest single
     link is the group's push, because the S&P, the Nasdaq and their futures
     are one move counted four times otherwise. */
  function world(ctx) {
    var g = ctx.global, items = g && g.items ? g.items : {};
    var models = ctx.historyModel && ctx.historyModel.models;
    var links = models && models[ctx.symbol] ? models[ctx.symbol].world : (models && models.NIFTY ? models.NIFTY.world : null);
    // Points are measured on the last close; the forecast's own close when
    // the quote has not arrived.
    var base = isNum(ctx.prevClose) ? ctx.prevClose : ctx.forecast && isNum(ctx.forecast.lastClose) ? ctx.forecast.lastClose : null;
    var rows = [];
    Object.keys(items).forEach(function (k) {
      if (k === 'vix') return;
      var it = items[k];
      if (!it || !isNum(it.changePct)) return;
      var move = POINTS[k] && isNum(it.price) && isNum(it.prevClose) ? it.price - it.prevClose : it.changePct;
      var link = linkFor(links, k, ctx.live);
      var push = link ? link.beta * move : null;
      rows.push({
        id: k, label: it.label || k, group: GROUP[k] || 'other', move: r2(move), unit: POINTS[k] ? 'points' : 'pct',
        hour: isNum(it.hourPct) ? r2(it.hourPct) : null, price: it.price, delay: it.delay || 0,
        link: link, pushPct: push != null ? r2(push) : null,
        pushPts: push != null && isNum(base) ? Math.round(push / 100 * base) : null,
        dir: push != null ? (push > 0 ? 1 : push < 0 ? -1 : 0) : (USUAL[k] || 0) * (move > 0 ? 1 : move < 0 ? -1 : 0),
        measured: !!link,
      });
    });
    var groups = {};
    rows.forEach(function (r) {
      var gr = groups[r.group] = groups[r.group] || { group: r.group, rows: [], lead: null };
      gr.rows.push(r);
      if (r.pushPts != null && (!gr.lead || Math.abs(r.pushPts) > Math.abs(gr.lead.pushPts))) gr.lead = r;
    });
    var explained = 0, anyMeasured = false;
    Object.keys(groups).forEach(function (k) { if (groups[k].lead && k !== 'india') { explained += groups[k].lead.pushPts; anyMeasured = true; } });
    return { rows: rows, groups: groups, explainedPts: anyMeasured ? explained : null, measured: anyMeasured };
  }

  /* India's own: each index member's weight times its move. NIFTY weighs
     free float and the screener gives full market cap, so the weights are
     approximate and the panel says so; the sum is shown beside the index's
     own move so the gap is visible. */
  function inside(ctx) {
    var live = ctx.indexLive, rows = live && live.rows ? live.rows : [];
    var base = isNum(ctx.prevClose) ? ctx.prevClose : ctx.forecast && isNum(ctx.forecast.lastClose) ? ctx.forecast.lastClose : null;
    // The members fetched are NIFTY's (app.js refreshIndexLive).
    if (ctx.symbol !== 'NIFTY' || !rows.length || !isNum(base)) return null;
    var cap = 0;
    rows.forEach(function (r) { if (isNum(r.marketCapCr) && isNum(r.changePct)) cap += r.marketCapCr; });
    if (!(cap > 0)) return null;
    var members = [], bySector = {};
    rows.forEach(function (r) {
      if (!isNum(r.marketCapCr) || !isNum(r.changePct)) return;
      var w = r.marketCapCr / cap, pts = w * r.changePct / 100 * base;
      var m = { symbol: r.symbol, name: r.name, changePct: r2(r.changePct), weight: r1(w * 100), pts: Math.round(pts * 10) / 10, sector: r.sector || 'Other' };
      members.push(m);
      var s = bySector[m.sector] = bySector[m.sector] || { sector: m.sector, pts: 0, n: 0 };
      s.pts += pts; s.n++;
    });
    members.sort(function (a, b) { return b.pts - a.pts; });
    var sectors = Object.keys(bySector).map(function (k) { var s = bySector[k]; s.pts = Math.round(s.pts); return s; })
      .sort(function (a, b) { return b.pts - a.pts; });
    var total = members.reduce(function (t, m) { return t + m.pts; }, 0);
    return { members: members, sectors: sectors, totalPts: Math.round(total), approx: true };
  }

  /* The rest of what moves the index, from what the page already holds. */
  function others(ctx) {
    var out = [], f = ctx.forecast, lane = function (id) { return f && f.lanes ? f.lanes.filter(function (l) { return l.id === id; })[0] : null; };
    var fl = ctx.flows;
    if (fl && fl.fii && isNum(fl.fii.netCr)) {
      out.push({ id: 'fii', group: 'flows', label: 'FII cash', reading: (fl.fii.netCr >= 0 ? '+' : '') + Math.round(fl.fii.netCr) + ' cr' + (fl.fii.date ? ' (' + fl.fii.date + ')' : ''),
                 dir: fl.fii.netCr > 250 ? 1 : fl.fii.netCr < -250 ? -1 : 0 });
    }
    if (fl && fl.dii && isNum(fl.dii.netCr)) {
      out.push({ id: 'dii', group: 'flows', label: 'DII cash', reading: (fl.dii.netCr >= 0 ? '+' : '') + Math.round(fl.dii.netCr) + ' cr',
                 dir: fl.dii.netCr > 250 ? 1 : fl.dii.netCr < -250 ? -1 : 0 });
    }
    var it = ctx.internals;
    if (it && it.breadth && isNum(it.breadth.advances)) {
      var ratio = it.breadth.ratio;
      out.push({ id: 'breadth', group: 'india', label: 'Breadth', reading: it.breadth.advances + ' up, ' + it.breadth.declines + ' down',
                 dir: ratio > 0.6 ? 1 : ratio < 0.4 ? -1 : 0 });
    }
    var vixChg = it && isNum(it.vixChangePct) ? it.vixChangePct : null;
    if (isNum(ctx.vix)) {
      out.push({ id: 'indiavix', group: 'india', label: 'India VIX', reading: r2(ctx.vix) + (vixChg != null ? ' (' + (vixChg >= 0 ? '+' : '') + r2(vixChg) + '%)' : ''),
                 dir: vixChg != null ? (vixChg > 3 ? -1 : vixChg < -3 ? 1 : 0) : 0 });
    }
    var opt = lane('options'), nw = lane('news'), cr = lane('crowd'), gl = lane('global');
    if (opt && opt.hasData) out.push({ id: 'options', group: 'positioning', label: 'Options positioning', reading: opt.note, dir: opt.score > 0.1 ? 1 : opt.score < -0.1 ? -1 : 0 });
    if (nw && nw.hasData) out.push({ id: 'news', group: 'news', label: 'News tone', reading: nw.note, dir: nw.score > 0.1 ? 1 : nw.score < -0.1 ? -1 : 0 });
    if (cr && cr.hasData) out.push({ id: 'crowd', group: 'crowd', label: 'Crowd mood', reading: cr.note, dir: cr.score > 0.05 ? 1 : cr.score < -0.05 ? -1 : 0 });
    if (gl && gl.hasData && !(ctx.global && ctx.global.items)) out.push({ id: 'global', group: 'world', label: 'Global cue', reading: gl.note, dir: gl.score > 0.1 ? 1 : gl.score < -0.1 ? -1 : 0 });
    return out;
  }

  function explain(ctx) {
    var w = world(ctx), ins = inside(ctx), oth = others(ctx);
    var dragging = [], supporting = [];
    w.rows.forEach(function (r) {
      if (r.group === 'india') return;
      var item = { id: r.id, kind: 'world', label: r.label, reading: (r.move > 0 ? '+' : '') + r.move + (r.unit === 'points' ? ' pts' : '%'),
                   pts: r.pushPts, measured: r.measured, dir: r.dir, link: r.link };
      if (r.measured ? Math.abs(r.pushPts) < 2 : Math.abs(r.move) < (r.unit === 'points' ? 0.03 : 0.4)) return;
      (r.dir < 0 ? dragging : r.dir > 0 ? supporting : []).push(item);
    });
    if (ins) {
      ins.members.slice(0, 4).forEach(function (m) { if (m.pts >= 2) supporting.push({ id: 'm_' + m.symbol, kind: 'member', label: m.name || m.symbol, reading: (m.changePct > 0 ? '+' : '') + m.changePct + '%', pts: Math.round(m.pts), measured: true, dir: 1 }); });
      ins.members.slice(-4).reverse().forEach(function (m) { if (m.pts <= -2) dragging.push({ id: 'm_' + m.symbol, kind: 'member', label: m.name || m.symbol, reading: m.changePct + '%', pts: Math.round(m.pts), measured: true, dir: -1 }); });
    }
    oth.forEach(function (o) { if (o.dir) (o.dir < 0 ? dragging : supporting).push({ id: o.id, kind: o.group, label: o.label, reading: o.reading, pts: null, measured: false, dir: o.dir }); });
    // The biggest measured pushes first, then the factors read without
    // points (flows, breadth, news), so a heavy day abroad cannot push the
    // FII number off the card.
    var order = function (list) {
      var withPts = list.filter(function (x) { return x.pts != null; }).sort(function (a, b) { return Math.abs(b.pts) - Math.abs(a.pts); });
      var plain = list.filter(function (x) { return x.pts == null; });
      return withPts.slice(0, 5).concat(plain.slice(0, 3)).concat(withPts.slice(5)).concat(plain.slice(3));
    };
    dragging = order(dragging); supporting = order(supporting);
    return { move: ctx.move, world: w, inside: ins, others: oth, dragging: dragging, supporting: supporting };
  }

  /* ================================================================ setup

     Direction: how many inputs point which way, the strongest on each side,
     the room to the next wall, and the odds the line gives the close.
     Range: how quiet the day is likely to be, which is what an option
     seller is judging: the expected move from India VIX, the CPR's width,
     events on the calendar, the distance to the option walls. */
  function setup(ctx) {
    var f = ctx.forecast;
    if (!f || !f.lanes) return null;
    var up = [], down = [];
    f.lanes.forEach(function (l) {
      if (!l.hasData || !isNum(l.contribution) || Math.abs(l.contribution) < 0.01) return;
      (l.contribution > 0 ? up : down).push({ label: l.label, c: l.contribution });
    });
    var ex = ctx.drivers;
    if (ex && ex.world && ex.world.explainedPts != null && Math.abs(ex.world.explainedPts) >= 10) {
      (ex.world.explainedPts > 0 ? up : down).push({ label: 'World markets now', c: ex.world.explainedPts / 1000 });
    }
    (ctx.active || []).forEach(function (r) {
      var sign = { open_above_cpr: 1, pdh_break: 1, cam_h4_break: 1, gap_down_bounce: 1, rsi_under: 1, down3: 1, ema_up: 1,
                   open_below_cpr: -1, pdl_break: -1, gap_up_fade: -1, ema_down: -1 }[r.key];
      if (sign && r.rate != null && r.rate >= 55) (sign > 0 ? up : down).push({ label: r.name + ' (' + r.rate + '% in the record)', c: 0.02 });
    });
    up.sort(function (a, b) { return b.c - a.c; }); down.sort(function (a, b) { return a.c - b.c; });
    var pUp = KT.forecast && KT.forecast.closeOdds ? KT.forecast.closeOdds(f) : null;
    var lean = isNum(pUp) ? (pUp >= 55 ? 1 : pUp <= 45 ? -1 : 0) : 0;
    var agreeN = lean > 0 ? up.length : lean < 0 ? down.length : 0, total = up.length + down.length;
    var agree = total ? agreeN / total : 0;
    var price = f.lastClose;
    var lv = ctx.levels || {};
    var res = lv.nearestResistance && isNum(lv.nearestResistance.level) ? lv.nearestResistance.level : null;
    var sup = lv.nearestSupport && isNum(lv.nearestSupport.level) ? lv.nearestSupport.level : null;
    var oi = KT.studies && KT.studies.oiLevels ? KT.studies.oiLevels(ctx.options) : null;
    var roomUp = res != null ? (res - price) / price * 100 : null, roomDown = sup != null ? (price - sup) / price * 100 : null;
    var dirGrade = !lean ? 'no lean' : agree >= 0.7 && Math.abs(pUp - 50) >= 10 ? 'strong' : agree >= 0.6 ? 'moderate' : 'mixed';
    var direction = {
      lean: lean, pUp: pUp, grade: dirGrade, agreeN: agreeN, total: total,
      withIt: (lean >= 0 ? up : down).slice(0, 4), against: (lean >= 0 ? down : up).slice(0, 4),
      roomUp: roomUp != null ? r2(roomUp) : null, roomDown: roomDown != null ? r2(roomDown) : null, resistance: res, support: sup,
    };

    // The range view.
    var vix = ctx.vix, sigma = isNum(vix) ? vix / Math.sqrt(252) : null;        // one day's move, %, from India VIX
    var oneSdPts = sigma != null && isNum(price) ? Math.round(sigma / 100 * price) : null;
    var signs = [], calm = 0, rough = 0;
    var pb = ctx.playbook, prevSess = ctx.prevSession;
    if (prevSess && KT.studies) {
      var cp = KT.studies.cpr(prevSess);
      if (pb && pb.cprP75 != null && cp.widthPct >= pb.cprP75) { calm++; signs.push({ good: true, text: 'Wide CPR (' + cp.widthPct.toFixed(2) + '%): a range day is the usual read' + rateOf(pb, 'cpr_wide') + '.' }); }
      else if (pb && pb.cprP25 != null && cp.widthPct <= pb.cprP25) { rough++; signs.push({ good: false, text: 'Narrow CPR (' + cp.widthPct.toFixed(2) + '%): a trending day is the usual read' + rateOf(pb, 'cpr_narrow') + '.' }); }
    }
    if (isNum(vix)) {
      if (vix >= 20) { rough++; signs.push({ good: false, text: 'India VIX ' + r1(vix) + ': wide swings are normal at this level' + rateOf(pb, 'vix_high') + '.' }); }
      else if (vix <= 13) { calm++; signs.push({ good: true, text: 'India VIX ' + r1(vix) + ': quiet days are the norm at this level' + rateOf(pb, 'vix_low') + '.' }); }
      var vc = ctx.internals && isNum(ctx.internals.vixChangePct) ? ctx.internals.vixChangePct : null;
      if (vc != null && Math.abs(vc) >= 3) { if (vc > 0) rough++; else calm++; signs.push({ good: vc < 0, text: 'India VIX ' + (vc > 0 ? 'up ' : 'down ') + Math.abs(r1(vc)) + '% today.' }); }
    }
    var gap = f.open && f.open.applies && isNum(f.open.gapPct) ? f.open.gapPct : null;
    if (gap != null && Math.abs(gap) >= 0.5) { rough++; signs.push({ good: false, text: 'A ' + (gap > 0 ? 'gap up' : 'gap down') + ' of ' + Math.abs(gap).toFixed(2) + '% is called for the open.' }); }
    (ctx.events || []).forEach(function (e) { rough++; signs.push({ good: false, text: 'On the calendar: ' + e + '.' }); });
    if (oi && oi.expiryDays != null && oi.expiryDays <= 1) { rough++; signs.push({ good: false, text: 'Expiry ' + (oi.expiryDays === 0 ? 'today' : 'tomorrow') + ': moves near the big strikes get sharper.' }); }
    var ex2 = ex && ex.world ? ex.world : null;
    if (ex2 && ex2.explainedPts != null && Math.abs(ex2.explainedPts) >= (oneSdPts || 150) * 0.3) {
      rough++; signs.push({ good: false, text: 'World markets are moving hard: about ' + (ex2.explainedPts > 0 ? '+' : '') + ex2.explainedPts + ' points of pressure on NIFTY by their measured links.' });
    }
    var walls = null;
    if (oi && isNum(price) && ctx.symbol === 'NIFTY') {
      var cw = oi.callWall != null ? (oi.callWall - price) / price * 100 : null, pw = oi.putWall != null ? (price - oi.putWall) / price * 100 : null;
      walls = { callWall: oi.callWall, putWall: oi.putWall, callDist: cw != null ? r2(cw) : null, putDist: pw != null ? r2(pw) : null, maxPain: oi.maxPain };
      if (sigma != null && cw != null && pw != null) {
        var inside1 = cw > sigma && pw > sigma;
        if (inside1) calm++; else rough++;
        signs.push({ good: inside1, text: 'Call wall ' + Math.round(oi.callWall) + ' is ' + r2(cw) + '% away and put wall ' + Math.round(oi.putWall) + ' is ' + r2(pw) + '% away, ' +
                     (inside1 ? 'both outside' : 'not both outside') + ' one day\'s expected move (' + r2(sigma) + '%).' });
      }
    }
    var rangeGrade = rough === 0 && calm >= 2 ? 'favourable' : rough <= 1 && calm >= rough ? 'mixed' : 'unfavourable';
    var range = {
      sigmaPct: sigma != null ? r2(sigma) : null, oneSdPts: oneSdPts,
      low68: f.rangeLow, high68: f.rangeHigh, signs: signs, grade: rangeGrade, calm: calm, rough: rough, walls: walls,
    };
    return { direction: direction, range: range };
  }
  function rateOf(pb, key) {
    var r = pb && pb.rules ? pb.rules.filter(function (x) { return x.key === key; })[0] : null;
    return r && r.rate != null && r.n >= 20 ? ' (came true ' + r.rate + '% of ' + r.n + ' times' + (r.base != null ? ', ' + r.base + '% on any day' : '') + ')' : '';
  }

  KT.drivers = { explain: explain, world: world, inside: inside, setup: setup, linkFor: linkFor, USUAL: USUAL, GROUP: GROUP };
})(window.KT);
