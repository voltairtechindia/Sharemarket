/* ============================================================================
   The AI desk.

   A research desk laid out the way TradingAgents (TauricResearch, Apache 2.0)
   lays one out, cut down to what the free tier pays for and pointed at India:

     four analysts   technical, news, flows and macro, and either the company
                     (for a stock) or market internals (for an index), plus a
                     sentiment analyst when the crowd's numbers answer (the
                     mood index and the StockTwits stream, data.getSentiment).
                     Each sees only its own slice of the evidence and answers
                     on its own, one after another.
     one debate      the strongest honest case up and the strongest case down,
                     argued from the four reports.
     one final call  the portfolio manager and the risk check in one. Reads the
                     reports, the debate and the lessons the desk wrote after
                     past calls in similar situations, and makes a five-step
                     call with what would prove it wrong.

   Six requests a run, seven with the sentiment analyst. TradingAgents runs more: a separate trader, three risk
   analysts and several debate rounds. On fifty free requests a day that would
   be two runs a day, so the trader and risk roles fold into the final call and
   the debate is one round. A one-request "quick read" exists for the days the
   budget is nearly spent.

   Three rules from the rest of this codebase, kept here:

     It never sees the engine's verdict. No direction, no confidence, no
     target, no probability, no checkpoint. Shown the answer, a desk agrees
     with it and adds nothing, and the model lane then reads as independent
     confirmation while being an echo. selftest checks the prompts for leaks.

     It votes and does nothing else. The final score enters the forecast as
     the model lane: bounded, renormalised with every other lane, and turned
     down by the learner if its record is poor. It never writes a price.

     It is settled. Every run is stored with the price it was made at and the
     time its horizon ends. When the candles reach that time the run is scored
     and a lesson is written (lessons.js), and the next run in a similar
     situation reads it.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core, fmt = core.fmt;

  var RUNS_KEY = 'deskRuns';
  var RUNS_VERSION = 1;
  var MAX_RUNS = 120;
  var CALLS = { full: 7, quick: 1, reflect: 1 };
  var VOTE_MIN_TTL = 20 * 60000, VOTE_MAX_TTL = 3 * 3600000;
  var AUTO_GAP_MS = 75 * 60000;     // two automatic runs never closer than this

  var RATINGS = {
    strong_up:   { score: 0.7,   label: 'Strong up',   tone: 'up' },
    lean_up:     { score: 0.35,  label: 'Lean up',     tone: 'up' },
    neutral:     { score: 0,     label: 'No clear edge', tone: 'flat' },
    lean_down:   { score: -0.35, label: 'Lean down',   tone: 'down' },
    strong_down: { score: -0.7,  label: 'Strong down', tone: 'down' },
  };
  var ORDER = ['strong_down', 'lean_down', 'neutral', 'lean_up', 'strong_up'];

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function r2(n) { return Math.round(n * 100) / 100; }
  function r3(n) { return Math.round(n * 1000) / 1000; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function pct(v, d) { return isNum(v) ? fmt.pct(v, d == null ? 2 : d) : 'n/a'; }
  function px(v) { return isNum(v) ? fmt.price(v) : 'n/a'; }

  /* ============================================================ storage */
  /* The page reads the runs several times a render, and a hundred runs is a
     few hundred kilobytes of JSON, so the parsed copy is kept until the next
     write. Another tab writing in between is picked up on that write. */
  var runsCache = null;
  function loadRuns() {
    if (runsCache) return runsCache;
    var st = core.store.get(RUNS_KEY, null);
    runsCache = (!st || st.version !== RUNS_VERSION || !Array.isArray(st.items)) ? [] : st.items;
    return runsCache;
  }
  function saveRuns(items) {
    var trimmed = items.slice(-MAX_RUNS);
    runsCache = null;
    if (core.store.set(RUNS_KEY, { version: RUNS_VERSION, items: trimmed })) return true;
    return core.store.set(RUNS_KEY, { version: RUNS_VERSION, items: trimmed.slice(-Math.floor(MAX_RUNS / 2)) });
  }
  function latest(symbol) {
    var items = loadRuns();
    for (var i = items.length - 1; i >= 0; i--) if (!symbol || items[i].symbol === symbol) return items[i];
    return null;
  }
  function runs(symbol, n) {
    return loadRuns().filter(function (r) { return !symbol || r.symbol === symbol; })
      .slice(-(n || 20)).reverse();
  }
  function clear() { runsCache = null; core.store.remove(RUNS_KEY); }

  /* ============================================================= budget
     data.js counts every request it sends; this only reads the count. */
  function budget() {
    if (KT.data && KT.data.aiBudget) return KT.data.aiBudget();
    return { used: 0, limit: 0, left: 0, blocked: false };
  }
  function canAfford(mode, reserve) {
    var b = budget();
    return b.left >= (CALLS[mode] || 1) + (reserve || 0);
  }

  /* ============================================================ helpers */
  function istNow() { return fmt.ist(); }
  function hhmm(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function dayName(d) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]; }
  function stampIst(epochSec) {
    var d = fmt.ist(epochSec);
    return dayName(d) + ' ' + fmt.dayShort(epochSec) + ' ' + hhmm(d);
  }

  // The close at or before t. Nearest-bar, never interpolated.
  function barAtOrBefore(candles, t) {
    if (!candles || !candles.length || candles[0].time > t) return null;
    var lo = 0, hi = candles.length - 1, best = null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (candles[mid].time <= t) { best = candles[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }
  function changeSince(candles, t, price) {
    var b = barAtOrBefore(candles, t);
    if (!b || !b.close || !isNum(price)) return null;
    return (price - b.close) / b.close * 100;
  }
  function sessionStartOf(candles) {
    if (!candles || !candles.length) return null;
    var last = fmt.ist(candles[candles.length - 1].time);
    for (var i = candles.length - 1; i >= 0; i--) {
      var d = fmt.ist(candles[i].time);
      if (d.getDate() !== last.getDate() || d.getMonth() !== last.getMonth()) return candles[i + 1] || null;
    }
    return candles[0];
  }

  /* ================================================================ gather

     Everything the analysts are allowed to see, as plain data. Read from the
     page's state object, and deliberately blind to S.forecast's verdict: the
     only thing taken from the forecast is when its horizon ends, which is the
     question being asked, not an answer to it. */
  function gather(S, extras) {
    extras = extras || {};
    S = S || {};
    var meta = C.symbols[S.symbol] || { label: S.symbol || 'NIFTY', exchange: 'NSE' };
    var stock = !!meta.stock;
    var candles = S.candles || [];
    var last = candles.length ? candles[candles.length - 1] : null;
    var q = S.quote || {};
    var price = isNum(q.price) ? q.price : (last ? last.close : null);
    var ind = S.indicators || {};
    var lv = S.levels || {};
    var tf = C.timeframes[S.timeframe] || {};
    var barSec = tf.barSec || 60;
    var fund = extras.fundamentals || null;

    // The horizon is the question. Its end time is taken from the drawn path;
    // nothing about where the path goes is.
    var f = S.forecast || null;
    var endTime = f && f.path && f.path.length ? f.path[f.path.length - 1].time : null;
    var horizonLabel = f && f.horizonLabel ? f.horizonLabel : (tf.label || 'the next session');
    var horizon = {
      label: horizonLabel,
      endTime: endTime,
      text: endTime ? (horizonLabel + ', to ' + stampIst(endTime) + ' IST') : horizonLabel,
    };

    var ms = core.marketState ? core.marketState() : { state: 'closed', label: '' };
    var now = istNow();

    /* ------------------------------------------------------- technical */
    var lastT = last ? last.time : Math.floor(Date.now() / 1000);
    var ret = {};
    if (barSec < 86400) {
      ret.hour = changeSince(candles, lastT - 3600, price);
      var ss = sessionStartOf(candles);
      ret.session = ss && ss.open ? (price - ss.open) / ss.open * 100 : null;
      ret.series = candles.length && candles[0].close ? (price - candles[0].close) / candles[0].close * 100 : null;
    } else {
      ret.bars5 = candles.length > 6 ? (price - candles[candles.length - 6].close) / candles[candles.length - 6].close * 100 : null;
      ret.bars20 = candles.length > 21 ? (price - candles[candles.length - 21].close) / candles[candles.length - 21].close * 100 : null;
    }
    var structs = (S.structures || []).slice(0, 4).map(function (s) {
      var stat = S.structureStats && S.structureStats[s.key];
      return {
        name: s.name || s.key || 'pattern',
        status: s.status || null,
        bias: s.dir > 0 ? 'bullish shape' : s.dir < 0 ? 'bearish shape' : 'no directional bias',
        trigger: s.trigger, target: s.target, stop: s.stop,
        record: stat && stat.resolved
          ? (stat.reliable ? 'reached its target ' + stat.hitRate + '% of ' + stat.resolved + ' resolved times on this chart'
                           : 'only ' + stat.resolved + ' resolved cases on this chart, too few to rate')
          : null,
      };
    });
    var tech = {
      price: price, barSec: barSec, tfLabel: tf.label || S.timeframe, bars: candles.length,
      dayOpen: q.open, dayHigh: isNum(q.high) ? q.high : q.dayHigh, dayLow: isNum(q.low) ? q.low : q.dayLow,
      prevClose: q.prevClose, dayChangePct: q.changePct,
      ret: ret,
      rsi: ind.rsi, adx: ind.adx, plusDI: ind.plusDI, minusDI: ind.minusDI,
      atr: ind.atr, atrPct: ind.atrPct, macdHist: ind.macdHist,
      ema20: ind.ema20, ema50: ind.ema50, ema200: ind.ema200,
      supertrendDir: ind.supertrendDir, stoch: ind.stoch, pctB: ind.pctB, squeezeOn: ind.squeezeOn,
      vwap: ind.vwap,
      support: lv.nearestSupport ? { level: lv.nearestSupport.level, touches: lv.nearestSupport.touches } : null,
      resistance: lv.nearestResistance ? { level: lv.nearestResistance.level, touches: lv.nearestResistance.touches } : null,
      pivots: lv.pivots ? { pp: lv.pivots.pp, r1: lv.pivots.r1, s1: lv.pivots.s1 } : null,
      structures: structs,
    };

    /* ------------------------------------------------------------ news */
    var pool = (extras.news || (KT.data && KT.data.getNews ? KT.data.getNews() : []) || []).slice();
    var nowSec = Date.now() / 1000;
    pool = pool.filter(function (n) { return n && n.headline && n.ts && nowSec - n.ts <= 172800; });
    var companyNews = [];
    if (stock && KT.stocks && KT.stocks.newsFor) companyNews = KT.stocks.newsFor(S.symbol, pool);
    var IMP = { high: 3, medium: 2, low: 1 };
    function rank(list) {
      var seen = {};
      return list.filter(function (n) {
        var k = n.key || n.headline;
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      }).sort(function (a, b) {
        var ia = IMP[a.impact] || 1, ib = IMP[b.impact] || 1;
        var fa = ia * Math.pow(0.5, (nowSec - a.ts) / 21600), fb = ib * Math.pow(0.5, (nowSec - b.ts) / 21600);
        return fb - fa;
      });
    }
    var marketNews = rank(pool.filter(function (n) { return n.region !== 'international' || n.impact === 'high'; }));
    var newsOut = {
      company: rank(companyNews).slice(0, 10),
      market: marketNews.slice(0, stock ? 6 : 15),
      world: rank(pool.filter(function (n) { return n.region === 'international'; })).slice(0, 4),
      total: pool.length, companyTotal: companyNews.length,
    };

    /* ----------------------------------------------------------- macro */
    var cues = [], giftRow = null;
    if (S.global && S.global.items) {
      Object.keys(S.global.items).forEach(function (k) {
        var r = S.global.items[k];
        if (!r || !isNum(r.changePct)) return;
        if (k === 'gift_nifty') { giftRow = r; return; }
        cues.push({ key: k, label: r.label || k, changePct: r.changePct });
      });
    }
    if (!giftRow && S.globalLive && S.globalLive.items && S.globalLive.items.gift_nifty) giftRow = S.globalLive.items.gift_nifty;
    var fl = S.flows || {};
    var opt = S.options && S.options.ok ? S.options : null;
    var macro = {
      cues: cues,
      gift: giftRow && isNum(giftRow.price) ? { price: giftRow.price, changePct: giftRow.changePct } : null,
      vix: isNum(S.vix) ? S.vix : null,
      fii: fl.fii && isNum(fl.fii.netCr) ? { netCr: fl.fii.netCr, date: fl.fii.date || null } : null,
      dii: fl.dii && isNum(fl.dii.netCr) ? { netCr: fl.dii.netCr, date: fl.dii.date || null } : null,
      fiiFut: fl.fiiFutIdx && isNum(fl.fiiFutIdx.longPct) ? { longPct: fl.fiiFutIdx.longPct, chg: fl.fiiFutIdx.longPctChg } : null,
      options: opt ? {
        pcrOi: opt.pcrOi, pcrChgOi: opt.pcrChgOi, maxPain: opt.maxPain, expiryDays: opt.expiryDays,
        callWall: opt.resistance && opt.resistance[0] ? opt.resistance[0].strike : null,
        putWall: opt.support && opt.support[0] ? opt.support[0].strike : null,
      } : null,
    };

    /* -------------------------------------------- company or internals */
    var company = null, internals = null;
    if (stock) {
      var calls = [];
      if (KT.streetcalls && KT.streetcalls.extract && companyNews.length) {
        try {
          calls = KT.streetcalls.extract(companyNews, { limit: 6 }).filter(function (c) {
            return c.stocks && c.stocks.indexOf(S.symbol) !== -1;
          });
        } catch (e) { calls = []; }
      }
      company = {
        name: meta.name || (fund && fund.name) || S.symbol,
        sector: (fund && fund.sector) || meta.sector || null,
        fundamentals: fund,
        events: (extras.events || []).slice(0, 4),
        filings: (extras.filings || []).slice(0, 4),
        deals: (extras.deals || []).slice(0, 4),
        calls: calls,
      };
    } else {
      var br = (S.internals && S.internals.breadth) || (fl.breadth || null);
      var sectors = ((S.internals && S.internals.sectors) || []).filter(function (r) { return !r.broad; })
        .map(function (r) { return { label: r.label, changePct: r.changePct }; });
      var quotes = (KT.portfolio && KT.portfolio.quotes && KT.portfolio.quotes()) || {};
      var members = (S.constituents && S.constituents.members) || [];
      var movers = [];
      members.forEach(function (m) {
        if (!m.symbol || (m.tiers || []).indexOf('nifty50') === -1) return;
        var mq = quotes[m.symbol];
        if (mq && isNum(mq.changePct)) movers.push({ symbol: m.symbol, changePct: mq.changePct });
      });
      movers.sort(function (a, b) { return b.changePct - a.changePct; });
      var up = movers.filter(function (m) { return m.changePct > 0; }).length;
      var mid = ((S.internals && S.internals.sectors) || []).filter(function (r) { return /MIDCAP/.test(r.index || ''); })[0];
      internals = {
        breadth: br && isNum(br.advances) ? { adv: br.advances, dec: br.declines, unch: br.unchanged,
                                              scope: S.internals && S.internals.breadth ? 'NIFTY 50 members' : 'NSE' } : null,
        members: movers.length ? { up: up, down: movers.length - up, n: movers.length } : null,
        leaders: movers.slice(0, 4), laggards: movers.slice(-4).reverse(),
        sectors: sectors.slice(0, 12),
        midcap: mid && isNum(mid.changePct) ? { changePct: mid.changePct } : null,
        divergence: isNum(fl.breadthDivergence) ? fl.breadthDivergence : null,
      };
    }

    /* The situation, for the memory. Raw numbers in, buckets out (lessons.js). */
    var newsTone = null;
    var toneList = stock ? newsOut.company : newsOut.market;
    if (toneList.length >= 3) {
      var tn = 0, td = 0;
      toneList.forEach(function (n) { if (isNum(n.sentiment)) { tn += clamp(n.sentiment / 3, -1, 1); td++; } });
      newsTone = td ? tn / td : null;
    }
    var fpInput = {
      kind: stock ? 'stock' : 'index', symbol: S.symbol, sector: company ? company.sector : null,
      timeframe: S.timeframe, session: ms.state,
      price: price, ema50: ind.ema50, adx: ind.adx, rsi: ind.rsi, vix: macro.vix,
      gapPct: (ms.state !== 'live' && macro.gift && isNum(macro.gift.changePct)) ? macro.gift.changePct : null,
      newsTone: newsTone, fiiNetCr: macro.fii ? macro.fii.netCr : null,
    };

    return {
      symbol: S.symbol, label: meta.label || S.symbol, name: meta.name || null,
      kind: stock ? 'stock' : 'index', exchange: stock ? 'NSE' : (meta.exchange || 'NSE'),
      timeframe: S.timeframe, horizon: horizon, price: price,
      nowText: dayName(now) + ' ' + now.getDate() + ' ' +
               ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][now.getMonth()] +
               ' ' + now.getFullYear() + ', ' + hhmm(now) + ' IST',
      marketState: ms.state, marketLabel: ms.label,
      tech: tech, news: newsOut, macro: macro, company: company, internals: internals,
      sentiment: sentimentOf(extras.sentiment),
      fpInput: fpInput,
    };
  }

  // The crowd's numbers as the analyst may see them, or null when neither
  // source answered (and the analyst is not asked at all).
  function sentimentOf(x) {
    if (!x || (!x.mood && !x.crowd && !x.reddit)) return null;
    var c = x.crowd, rd = x.reddit;
    return {
      mood: x.mood && isNum(x.mood.now) ? x.mood : null,
      crowd: c && c.n ? { symbol: c.symbol, n: c.n, bull: c.bull || 0, bear: c.bear || 0, promo: c.promo || 0,
                          from: c.from, to: c.to, items: (c.items || []).slice(0, 10) } : null,
      // Reddit, when the workflow's fetch got through (scripts/fetch_social.py).
      reddit: rd && rd.ok && rd.posts && rd.posts.length
        ? { n: rd.n || rd.posts.length, bull: rd.bull || 0, bear: rd.bear || 0, subs: rd.subs || [], posts: rd.posts.slice(0, 8) } : null,
    };
  }

  /* ================================================================ briefs
     The evidence as text, one brief per analyst. Numbers are rounded to what
     a person would say out loud; nothing here is an opinion. */
  function headlineLine(n, i) {
    var age = Math.max(0, Date.now() / 1000 - n.ts);
    var ageTxt = age < 3600 ? Math.round(age / 60) + 'm' : age < 86400 ? Math.round(age / 3600) + 'h' : Math.round(age / 86400) + 'd';
    return (i + 1) + '. [' + ageTxt + ' ago, ' + (n.source || 'feed') + (n.impact === 'high' ? ', high impact' : '') +
           '] ' + String(n.headline).replace(/\s+/g, ' ').slice(0, 170);
  }

  function techBrief(F) {
    var t = F.tech, L = [];
    var bar = t.barSec >= 86400 ? 'daily' : t.barSec >= 3600 ? 'hourly' : Math.round(t.barSec / 60) + '-minute';
    L.push('Chart: ' + bar + ' bars, ' + t.bars + ' of them. Last price ' + px(t.price) +
           (isNum(t.dayChangePct) ? ' (' + pct(t.dayChangePct) + ' on the day' : '') +
           (isNum(t.dayLow) && isNum(t.dayHigh) ? ', day range ' + px(t.dayLow) + ' to ' + px(t.dayHigh) : '') +
           (isNum(t.dayChangePct) ? ')' : '') + '.');
    var r = t.ret, rb = [];
    if (isNum(r.hour)) rb.push('last hour ' + pct(r.hour));
    if (isNum(r.session)) rb.push('since this session opened ' + pct(r.session));
    if (isNum(r.series)) rb.push('across the loaded series ' + pct(r.series));
    if (isNum(r.bars5)) rb.push('last 5 bars ' + pct(r.bars5));
    if (isNum(r.bars20)) rb.push('last 20 bars ' + pct(r.bars20));
    if (rb.length) L.push('Returns: ' + rb.join(', ') + '.');
    var tr = [];
    function vs(name, v) {
      if (!isNum(v) || !isNum(t.price)) return;
      tr.push('price ' + pct((t.price - v) / v * 100, 2) + ' vs ' + name);
    }
    vs('20 EMA', t.ema20); vs('50 EMA', t.ema50); vs('200 EMA', t.ema200);
    if (isNum(t.adx)) tr.push('ADX ' + Math.round(t.adx) + (isNum(t.plusDI) && isNum(t.minusDI) ? ' (+DI ' + Math.round(t.plusDI) + ', -DI ' + Math.round(t.minusDI) + ')' : ''));
    if (t.supertrendDir) tr.push('supertrend ' + (t.supertrendDir > 0 ? 'long' : 'short'));
    if (tr.length) L.push('Trend: ' + tr.join(', ') + '.');
    var mo = [];
    if (isNum(t.rsi)) mo.push('RSI ' + Math.round(t.rsi));
    if (isNum(t.macdHist)) mo.push('MACD histogram ' + (t.macdHist >= 0 ? 'above' : 'below') + ' zero');
    if (isNum(t.stoch)) mo.push('stochastic ' + Math.round(t.stoch));
    if (isNum(t.pctB)) mo.push('Bollinger %B ' + r2(t.pctB));
    if (t.squeezeOn) mo.push('volatility squeeze on');
    if (mo.length) L.push('Momentum: ' + mo.join(', ') + '.');
    if (isNum(t.atr)) L.push('Volatility: ATR ' + r2(t.atr) + (isNum(t.atrPct) ? ' (' + r2(t.atrPct) + '% a bar)' : '') + '.');
    var lv = [];
    if (t.resistance) lv.push('resistance ' + px(t.resistance.level) + ' (' + t.resistance.touches + ' touches)');
    if (t.support) lv.push('support ' + px(t.support.level) + ' (' + t.support.touches + ' touches)');
    if (t.pivots) lv.push('pivot ' + px(t.pivots.pp) + ', R1 ' + px(t.pivots.r1) + ', S1 ' + px(t.pivots.s1));
    if (isNum(t.vwap)) lv.push('VWAP ' + px(t.vwap));
    if (lv.length) L.push('Levels: ' + lv.join('; ') + '.');
    if (t.structures.length) {
      L.push('Chart patterns on screen: ' + t.structures.map(function (s) {
        return s.name + ' (' + [s.status, s.bias].filter(Boolean).join(', ') + ')' +
               (isNum(s.trigger) ? ', trigger ' + px(s.trigger) : '') +
               (isNum(s.target) ? ', measured target ' + px(s.target) : '') +
               (isNum(s.stop) ? ', invalid at ' + px(s.stop) : '') +
               (s.record ? '; it ' + s.record : '');
      }).join('. ') + '.');
    }
    return L.join('\n');
  }

  function newsBrief(F) {
    var n = F.news, L = [];
    if (F.kind === 'stock') {
      if (n.company.length) {
        L.push('Headlines that name ' + F.label + ', newest and loudest first:');
        n.company.forEach(function (x, i) { L.push(headlineLine(x, i)); });
      } else {
        L.push('No headline in the last 48 hours names ' + F.label + '.');
      }
      if (n.market.length) {
        L.push('Market headlines for context:');
        n.market.forEach(function (x, i) { L.push(headlineLine(x, i)); });
      }
    } else {
      if (n.market.length) {
        L.push('Indian market headlines from the last 48 hours, loudest and newest first:');
        n.market.forEach(function (x, i) { L.push(headlineLine(x, i)); });
      } else {
        L.push('No Indian market headlines in the last 48 hours.');
      }
    }
    if (n.world.length) {
      L.push('Global headlines:');
      n.world.forEach(function (x, i) { L.push(headlineLine(x, i)); });
    }
    L.push('In all, ' + n.total + ' headlines were read in the last 48 hours' +
           (F.kind === 'stock' ? ', ' + n.companyTotal + ' of them about this company.' : '.'));
    return L.join('\n');
  }

  function macroBrief(F) {
    var m = F.macro, L = [];
    if (m.cues.length) {
      L.push('Global cues, change against the previous close: ' + m.cues.map(function (c) {
        return c.label + ' ' + pct(c.changePct);
      }).join(', ') + '.');
    } else {
      L.push('Global cues are not available right now.');
    }
    if (m.gift) L.push('GIFT Nifty (NSE IX future) ' + px(m.gift.price) + ' (' + pct(m.gift.changePct) + ').');
    if (isNum(m.vix)) L.push('India VIX ' + r2(m.vix) + '.');
    if (m.fii || m.dii) {
      L.push('Institutional cash flows' + ((m.fii && m.fii.date) ? ' for ' + m.fii.date : '') + ': ' +
             (m.fii ? 'FII net ' + fmt.croreSigned(m.fii.netCr) : 'FII not reported') + ', ' +
             (m.dii ? 'DII net ' + fmt.croreSigned(m.dii.netCr) : 'DII not reported') + '.');
    }
    if (m.fiiFut) {
      L.push('FII index futures book: ' + r2(m.fiiFut.longPct) + '% long' +
             (isNum(m.fiiFut.chg) ? ' (' + (m.fiiFut.chg >= 0 ? '+' : '') + r2(m.fiiFut.chg) + ' points on the session)' : '') + '.');
    }
    if (m.options) {
      var o = m.options;
      L.push((F.kind === 'stock' ? 'NIFTY options backdrop' : 'NIFTY options') +
             (isNum(o.expiryDays) ? ' (' + o.expiryDays + ' days to expiry)' : '') + ': put-call ratio ' +
             (isNum(o.pcrOi) ? o.pcrOi : 'n/a') + ' on open interest, ' + (isNum(o.pcrChgOi) ? o.pcrChgOi : 'n/a') +
             ' on today\'s change; max pain ' + px(o.maxPain) +
             (o.callWall ? '; largest call wall ' + px(o.callWall) : '') + (o.putWall ? ', put wall ' + px(o.putWall) : '') + '.');
    }
    if (F.kind === 'stock') L.push('These are market-wide numbers. Judge how much they matter for this one stock.');
    return L.join('\n');
  }

  function companyBrief(F) {
    var c = F.company, L = [], fd = c.fundamentals;
    L.push('Company: ' + c.name + ' (' + F.label + ', NSE)' + (c.sector ? ', sector ' + c.sector : '') + '.');
    if (fd) {
      var v = [];
      if (isNum(fd.marketCapCr)) v.push('market cap ' + fmt.crore(fd.marketCapCr).replace(/ Cr$/, ' crore'));
      if (isNum(fd.pe)) v.push('P/E ' + r2(fd.pe));
      if (v.length) L.push('Valuation: ' + v.join(', ') + '.');
      if (isNum(fd.analysts) && fd.analysts > 0) {
        L.push('Street view: ' + fd.analysts + ' analysts, consensus ' + (isNum(fd.analystMark) ? r2(fd.analystMark) : 'n/a') +
               ' on a scale of 1 (strong buy) to 5 (strong sell)' +
               (isNum(fd.targetAvg) ? '; average target ' + px(fd.targetAvg) + (isNum(fd.upsidePct) ? ' (' + pct(fd.upsidePct, 1) + ' from here)' : '') : '') +
               (isNum(fd.targetLow) && isNum(fd.targetHigh) ? ', range ' + px(fd.targetLow) + ' to ' + px(fd.targetHigh) : '') + '.');
      }
      var p = [];
      if (isNum(fd.perfW)) p.push('1 week ' + pct(fd.perfW, 1));
      if (isNum(fd.perf1M)) p.push('1 month ' + pct(fd.perf1M, 1));
      if (isNum(fd.perfYtd)) p.push('year to date ' + pct(fd.perfYtd, 1));
      if (p.length) L.push('Performance: ' + p.join(', ') + '.');
      if (isNum(fd.week52Low) && isNum(fd.week52High)) L.push('52-week range ' + px(fd.week52Low) + ' to ' + px(fd.week52High) + '.');
      if (isNum(fd.nextEarnings)) L.push('Next results date on the screener: ' + fmt.dayShort(fd.nextEarnings) + '.');
    } else {
      L.push('Valuation and street data are not available right now.');
    }
    if (c.calls.length) {
      L.push('Published broker calls in the news:');
      c.calls.forEach(function (k, i) {
        L.push((i + 1) + '. ' + (k.broker || 'unattributed') + ': ' + k.rating +
               (k.target ? ', target ' + px(k.target) : '') + ' (' + String(k.headline).slice(0, 120) + ')');
      });
    }
    if (c.events.length) L.push('Scheduled: ' + c.events.map(function (e) { return (e.purpose || e.desc || 'event') + (e.date ? ' on ' + e.date : ''); }).join('; ') + '.');
    if (c.filings.length) L.push('Recent filings: ' + c.filings.map(function (e) { return String(e.headline || e.what || e.kind || '').slice(0, 90); }).join('; ') + '.');
    if (c.deals.length) L.push('Bulk and block deals: ' + c.deals.map(function (d) { return (d.client || 'a client') + ' ' + (d.side === 'SELL' ? 'sold' : 'bought') + (isNum(d.valueCr) ? ' Rs ' + r2(d.valueCr) + ' crore' : ''); }).join('; ') + '.');
    return L.join('\n');
  }

  function internalsBrief(F) {
    var t = F.internals, L = [];
    if (t.breadth) L.push('Breadth (' + t.breadth.scope + '): ' + t.breadth.adv + ' advancing, ' + t.breadth.dec + ' declining' + (isNum(t.breadth.unch) ? ', ' + t.breadth.unch + ' unchanged' : '') + '.');
    if (t.members) L.push('NIFTY 50 members priced: ' + t.members.up + ' up, ' + t.members.down + ' down.');
    if (t.leaders.length) L.push('Leading: ' + t.leaders.map(function (m) { return m.symbol + ' ' + pct(m.changePct, 1); }).join(', ') + '.');
    if (t.laggards.length) L.push('Lagging: ' + t.laggards.map(function (m) { return m.symbol + ' ' + pct(m.changePct, 1); }).join(', ') + '.');
    if (t.sectors.length) L.push('Sector indices today: ' + t.sectors.map(function (s) { return s.label + ' ' + pct(s.changePct, 1); }).join(', ') + '.');
    if (t.midcap) L.push('NIFTY Midcap 100 ' + pct(t.midcap.changePct, 2) + ' on the day.');
    if (isNum(t.divergence)) L.push('Midcap breadth minus large-cap breadth: ' + r2(t.divergence) + '.');
    if (!L.length) L.push('Breadth and sector data are not available right now.');
    return L.join('\n');
  }

  function sentimentBrief(F) {
    var s = F.sentiment, L = [];
    if (s.mood) {
      var m = s.mood, then = [];
      if (isNum(m.day)) then.push('yesterday ' + m.day);
      if (isNum(m.week)) then.push('a week ago ' + m.week);
      if (isNum(m.month)) then.push('a month ago ' + m.month);
      L.push('Market Mood Index (Tickertape, 0 extreme fear to 100 extreme greed, built from FII flows, volatility, ' +
             'momentum and breadth): ' + m.now + ', ' + m.zone + (then.length ? '; ' + then.join(', ') : '') + '.');
    } else {
      L.push('The market mood index did not answer.');
    }
    if (s.crowd) {
      var c = s.crowd;
      var span = isNum(c.to) && isNum(c.from) ? Math.max(1, Math.round((c.to - c.from) / 3600)) : null;
      L.push('StockTwits stream for ' + c.symbol + ': ' + c.n + ' messages' + (span ? ' over the last ' + span + ' hours' : '') +
             '; authors tagged ' + c.bull + ' bullish and ' + c.bear + ' bearish' +
             (c.promo ? '; ' + c.promo + ' promotional post' + (c.promo === 1 ? '' : 's') + ' left out' : '') + '. Newest first:');
      c.items.forEach(function (it, i) {
        var age = Math.max(0, Date.now() / 1000 - it.ts);
        var ageTxt = age < 3600 ? Math.round(age / 60) + 'm' : age < 86400 ? Math.round(age / 3600) + 'h' : Math.round(age / 86400) + 'd';
        L.push((i + 1) + '. [' + ageTxt + ' ago' + (it.tag ? ', tagged ' + it.tag : '') + '] ' + it.text);
      });
    } else {
      L.push(F.kind === 'index' && F.symbol === 'SENSEX' ? 'StockTwits has no SENSEX stream.' : 'The StockTwits stream did not answer.');
    }
    if (s.reddit) {
      var rd = s.reddit;
      L.push('Reddit (' + (rd.subs.length ? rd.subs.map(function (x) { return 'r/' + x; }).join(', ') : 'Indian market subreddits') + '): ' +
             rd.n + ' recent posts about the market; by the headline word list ' + rd.bull + ' read bullish and ' + rd.bear + ' bearish. Newest first:');
      rd.posts.forEach(function (it, i) {
        var age = Math.max(0, Date.now() / 1000 - (it.ts || 0));
        var ageTxt = age < 3600 ? Math.round(age / 60) + 'm' : age < 86400 ? Math.round(age / 3600) + 'h' : Math.round(age / 86400) + 'd';
        L.push((i + 1) + '. [' + ageTxt + ' ago, r/' + (it.sub || '?') + '] ' + String(it.title || '').slice(0, 160));
      });
    }
    return L.join('\n');
  }

  /* ================================================================ prompts */
  var JSON_ANALYST =
    'Answer with this JSON and nothing else:\n' +
    '{"score": <number from -1 to 1: -1 strongly down, 0 no edge, 1 strongly up>, ' +
    '"why": "<one or two sentences naming the specific evidence>", ' +
    '"points": ["<short fact>", "<short fact>", "<short fact>"]}\n' +
    'Keep the score near 0 when your evidence is thin or mixed. 0 is a valid answer.';

  function header(F) {
    return 'Now: ' + F.nowText + ', market ' + (F.marketLabel || F.marketState) + '.\n' +
           'Instrument: ' + F.label + (F.name && F.name !== F.label ? ' (' + F.name + ')' : '') +
           ', ' + (F.kind === 'stock' ? 'NSE-listed stock' : F.exchange) + '. Last price ' + px(F.price) + '.\n' +
           'Question: which way does it move over ' + F.horizon.text + '?';
  }

  function roleList(F) {
    return [
      { id: 'technical', label: 'Technical analyst',
        system: 'You are the technical analyst on an Indian equities research desk. You read price action only: trend, momentum, volatility, levels and chart patterns. Ignore news and fundamentals; other analysts cover those. Reply with JSON only.',
        brief: techBrief(F) },
      { id: 'news', label: 'News analyst',
        system: 'You are the news analyst on an Indian equities research desk. You read headlines and judge which stories are material, which are noise or already priced in, and which way the material ones push the instrument over the horizon. Ignore charts and indicators. Reply with JSON only.',
        brief: newsBrief(F) },
      { id: 'macro', label: 'Flows and macro analyst',
        system: 'You are the flows and macro analyst on an Indian equities research desk. You read global cues, the rupee, crude, institutional flows, derivatives positioning and volatility, and judge which way they push the instrument over the horizon. Reply with JSON only.',
        brief: macroBrief(F) },
      F.kind === 'stock'
        ? { id: 'company', label: 'Company analyst',
            system: 'You are the company analyst on an Indian equities research desk. You read valuation, the street\'s published view, filings and scheduled events, and judge which way they push the stock over the horizon. Fundamentals rarely move a stock within one session, so keep the score near 0 unless an event, a filing or a fresh broker call bears on it. Reply with JSON only.',
            brief: companyBrief(F) }
        : { id: 'internals', label: 'Market internals analyst',
            system: 'You are the market internals analyst on an Indian equities research desk. You read breadth, sector rotation and which heavyweights are moving the index, and judge whether the move is broad or narrow and which way internals push the index over the horizon. Reply with JSON only.',
            brief: internalsBrief(F) },
    ].concat(F.sentiment ? [
      { id: 'sentiment', label: 'Sentiment analyst',
        system: 'You are the sentiment analyst on an Indian equities research desk. You read the market mood index and what traders are posting, and judge which way the crowd leans and whether it is stretched. A crowd at an extreme often marks a turn rather than a continuation, and a handful of posts is thin evidence: keep the score near 0 unless the mood is clearly one-sided or moving fast. Reply with JSON only.',
        brief: sentimentBrief(F) },
    ] : []);
  }

  function analystPrompt(F, role) {
    return { system: role.system, user: header(F) + '\n\n' + role.brief + '\n\n' + JSON_ANALYST };
  }

  function reportsText(analysts) {
    return analysts.map(function (a) {
      if (!a || a.failed) return '- ' + (a ? a.label : 'Analyst') + ': no report.';
      return '- ' + a.label + ' (score ' + (a.score >= 0 ? '+' : '') + r2(a.score) + '): ' + a.why +
             (a.points && a.points.length ? ' Points: ' + a.points.join('; ') + '.' : '');
    }).join('\n');
  }

  function levelsText(F) {
    var t = F.tech, bits = [];
    if (t.support) bits.push('support ' + px(t.support.level));
    if (t.resistance) bits.push('resistance ' + px(t.resistance.level));
    if (t.pivots) bits.push('pivot ' + px(t.pivots.pp));
    return bits.length ? 'Key levels: ' + bits.join(', ') + '.' : 'Key levels: none identified.';
  }

  function debatePrompt(F, analysts) {
    return {
      system: 'You run the bull and bear debate on an Indian equities research desk. Two researchers argue opposite sides from the same analyst reports. Make each case as strong as the evidence honestly allows, then say which one the evidence favours. Reply with JSON only.',
      user: header(F) + '\n\nAnalyst reports:\n' + reportsText(analysts) + '\n' + levelsText(F) + '\n\n' +
            'Answer with this JSON and nothing else:\n' +
            '{"bull": "<the strongest case for higher, at most two sentences>", ' +
            '"bear": "<the strongest case for lower, at most two sentences>", ' +
            '"stronger": "bull" or "bear" or "even", ' +
            '"why": "<one sentence on which case the evidence favours and why>"}',
    };
  }

  var NO_ADVICE = 'You never tell anyone to buy, sell, hold, enter or exit a position, and you never mention position size. ' +
                  'You say which way the evidence leans, how strongly, and what would prove the call wrong.';

  /* The desk's own record, said against did (30 Oct 2026): the last judged
     session calls for this symbol, each with where the frozen line said the
     session would close, where it closed and the first reason it missed. The
     lessons are filed by situation; this is the plain recent record, so the
     final call is made knowing which way the line has been going wrong. The
     published record's call where it has the session (ledger.locks). */
  function recordText(symbol) {
    if (!KT.ledger || !KT.ledger.locks) return '';
    var rank = function (x) { return (x.timeframe === '1S' ? 2 : 0) + (x.stage === 'open' ? 1 : 0); };
    var by = {};
    KT.ledger.locks(symbol, 400).forEach(function (r) {
      if (!r || !r.postmortem || !r.postmortem.did) return;
      var cur = by[r.session];
      if (!cur || rank(r) > rank(cur)) by[r.session] = r;
    });
    var rows = Object.keys(by).sort().reverse().slice(0, 8).map(function (k) { return by[k]; });
    if (!rows.length) return '';
    var right = 0, wrong = 0, absErr = 0, net = 0, m = 0;
    var lines = rows.map(function (r) {
      var p = r.postmortem;
      if (p.verdict === 'right') right++; else if (p.verdict === 'wrong') wrong++;
      if (isNum(p.errPct)) { absErr += Math.abs(p.errPct); net += p.errPct; m++; }
      var said = p.callDir > 0 ? 'up' : p.callDir < 0 ? 'down' : 'no lean';
      var odds = p.said && isNum(p.said.pUpClose) ? ' (' + p.said.pUpClose + '% for up)' : '';
      var why = p.verdict !== 'right' && p.reasons && p.reasons[0] ? ' ' + String(p.reasons[0].text || '').slice(0, 140) : '';
      var verdict = p.verdict === 'right' ? 'Right.' : p.verdict === 'wrong' ? 'Wrong.' : p.verdict === 'flat' ? 'The market went nowhere.' : 'No lean called.';
      return '- ' + r.session + ': said ' + said + odds + ', the line ended at ' + px(p.said && p.said.target) +
             '; it closed at ' + px(p.did.close) + ' (' + pct(p.did.pct) + '), ' +
             (isNum(p.errPts) ? (p.errPts >= 0 ? '+' : '') + Math.round(p.errPts) + ' points from the line. ' : '') + verdict + why;
    });
    var head = 'Right ' + right + ', wrong ' + wrong + ' of the last ' + rows.length + ' judged sessions';
    if (m) {
      head += '; the close landed ' + r2(absErr / m) + '% from the line on average, ' +
              (Math.abs(net / m) < 0.05 ? 'with no lean either way' : (net > 0 ? 'above' : 'below') + ' it by ' + r2(Math.abs(net / m)) + '% net');
    }
    return head + '.\n' + lines.join('\n');
  }

  function finalPrompt(F, analysts, debate, lessonsTxt, fpWords, recordTxt) {
    var deb = debate
      ? 'Debate: bull case: ' + debate.bull + ' Bear case: ' + debate.bear + ' The debate found the ' +
        (debate.stronger === 'even' ? 'two cases even' : debate.stronger + ' case stronger') + (debate.why ? ': ' + debate.why : '.')
      : 'Debate: not available this run.';
    return {
      system: 'You are the portfolio manager on an Indian equities research desk, and you also run its risk check. You make the desk\'s final directional call from the analyst reports, the debate, the desk\'s own recent record and the lessons it wrote after past calls in similar situations. ' + NO_ADVICE + ' Reply with JSON only.',
      user: header(F) + '\n\nAnalyst reports:\n' + reportsText(analysts) + '\n\n' + deb + '\n' + levelsText(F) + '\n\n' +
            'Lessons from past calls in similar situations' + (fpWords ? ' (' + fpWords + ')' : '') + ':\n' +
            (lessonsTxt || 'None yet. This desk has no settled calls in a situation like this one.') + '\n\n' +
            'The desk\'s own recent record on ' + F.label + ', what its frozen line said against what the market did:\n' +
            (recordTxt || 'None judged yet.') + '\n' +
            'Where the record shows the same kind of miss again and again, say so in "why" and let it weigh on the call.\n\n' +
            'Answer with this JSON and nothing else:\n' +
            '{"rating": "strong_up" or "lean_up" or "neutral" or "lean_down" or "strong_down", ' +
            '"score": <number from -1 to 1 that matches the rating>, ' +
            '"confidence": <whole number from 0 to 100>, ' +
            '"why": "<two or three sentences: the evidence that decided it>", ' +
            '"risk": "<one sentence: what would make this call wrong>", ' +
            '"watch": "<one sentence: the one level or event to watch next>"}\n' +
            'Use "neutral" when the case is balanced. A strong rating needs most of the analysts and the debate pointing the same way.',
    };
  }

  function quickPrompt(F, lessonsTxt, fpWords, recordTxt) {
    var roles = roleList(F);
    var briefs = roles.map(function (r) { return '## ' + r.label + ' evidence\n' + r.brief; }).join('\n\n');
    var names = roles.map(function (r) { return 'a ' + r.label.toLowerCase(); });
    return {
      system: 'You are an Indian equities research desk compressed into one reply: ' + names.slice(0, -1).join(', ') + ' and ' +
              names[names.length - 1] + ' each score their own evidence, then a portfolio manager makes the final call. ' +
              NO_ADVICE + ' Reply with JSON only.',
      user: header(F) + '\n\n' + briefs + '\n\nLessons from past calls in similar situations' + (fpWords ? ' (' + fpWords + ')' : '') + ':\n' +
            (lessonsTxt || 'None yet.') + '\n\n' +
            'The desk\'s own recent record on ' + F.label + ', what its frozen line said against what the market did:\n' +
            (recordTxt || 'None judged yet.') + '\n\n' +
            'Answer with this JSON and nothing else:\n' +
            '{"analysts": {' + roles.map(function (r, i) { return '"' + r.id + '": <score' + (i ? '' : ' -1 to 1') + '>'; }).join(', ') + '}, ' +
            '"rating": "strong_up" or "lean_up" or "neutral" or "lean_down" or "strong_down", ' +
            '"score": <number from -1 to 1>, "confidence": <whole number from 0 to 100>, ' +
            '"why": "<two or three sentences>", "risk": "<one sentence>", "watch": "<one sentence>"}',
    };
  }

  function reflectPrompt(run) {
    var o = run.outcome || {};
    var verdict = o.right === true ? 'right' : o.right === false ? 'wrong' : 'not scored (no lean, or price barely moved)';
    var an = (run.analysts || []).filter(function (a) { return a && !a.failed; }).map(function (a) {
      return a.label + ' ' + (a.score >= 0 ? '+' : '') + r2(a.score);
    }).join(', ');
    var fpWords = KT.lessons ? KT.lessons.describe(run.fp) : '';
    return {
      system: 'You review an Indian equities research desk\'s past call once the outcome is known, and write the one lesson the desk should remember the next time it is in a similar situation. Be specific about the situation and about what to weigh differently. Reply with JSON only.',
      user: 'Call made ' + stampIst(Math.floor(run.at / 1000)) + ' IST on ' + run.label + ' at ' + px(run.price) +
            ', for ' + (run.horizon ? run.horizon.text : 'the horizon') + '.\n' +
            'Situation: ' + (fpWords || 'not recorded') + '.\n' +
            'Desk call: ' + (run.final ? run.final.label + ' (score ' + r2(run.final.score) + '). Reason given: ' + run.final.why : 'none') + '\n' +
            (an ? 'Analyst scores: ' + an + '.\n' : '') +
            'Outcome: price moved ' + pct(o.movePct) + ' to ' + px(o.endPrice) + '. The call was ' + verdict + '.\n\n' +
            'Answer with this JSON and nothing else:\n' +
            '{"lesson": "<one sentence of at most 30 words that starts with the situation, for example: When FII selling meets a gap-up open, ...>"}',
    };
  }

  /* ================================================================ parsing

     Free-tier replies are parsed defensively and rejected rather than coerced.
     A fenced block is unwrapped, smart quotes and trailing commas are
     repaired, and a score outside -1..1 is thrown away: a model that answered
     on the wrong scale has not given an opinion worth counting. */
  function parseJson(txt) {
    var raw = String(txt || '').replace(/```(?:json)?/gi, '').trim();
    var a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    var body = raw.slice(a, b + 1);
    var tries = [body,
      body.replace(/[“”]/g, '"').replace(/[‘’]/g, '\'').replace(/,\s*([}\]])/g, '$1')];
    for (var i = 0; i < tries.length; i++) {
      try {
        var o = JSON.parse(tries[i]);
        if (o && typeof o === 'object') return o;
      } catch (e) { /* next repair */ }
    }
    return null;
  }
  function num(v) {
    if (typeof v === 'string') v = v.replace(/[^0-9eE+.\-]/g, '');
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function textOf(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 400); }

  /* The public page makes no buy or sell calls (SEBI research analyst rules).
     The prompts say so; this is the belt to that brace. Any sentence that
     reads as an instruction to trade is dropped from what the AI wrote. */
  var ADVICE_RX = /\b(you should|we recommend|i recommend|recommend(?:ed|s)? (?:to )?(?:buy|sell|hold)|(?:buy|sell|short)(?:ing)? (?:now|here|on dips|on rises?|at|above|below|the stock|it)|go (?:long|short)|book (?:profits?|losses)|accumulate|exit (?:the|your)|enter (?:a|the|long|short)|stop[- ]loss)\b/i;
  /* A sentence ends at . ! or ? followed by a space. Splitting on the mark
     alone cut "GIFT Nifty +1.17%" at its decimal point and joined it back as
     "+1. 17%", in every analyst's words on the first live run (29 Oct 2026). */
  function noAdvice(s) {
    var parts = String(s || '').replace(/([.!?])\s+/g, '$1\u0000').split('\u0000');
    return parts.filter(function (p) { return p && !ADVICE_RX.test(p); }).join(' ').replace(/\s+/g, ' ').trim();
  }

  function parseAnalyst(txt) {
    var o = parseJson(txt);
    if (!o) return null;
    var s = num(o.score);
    if (s == null || s < -1.001 || s > 1.001) return null;
    var why = noAdvice(textOf(o.why, 360));
    if (why.length < 25) return null;
    var pts = Array.isArray(o.points) ? o.points.map(function (p) { return noAdvice(textOf(p, 150)); })
      .filter(function (p) { return p.length >= 6; }).slice(0, 4) : [];
    return { score: r3(clamp(s, -1, 1)), why: why, points: pts };
  }

  function parseDebate(txt) {
    var o = parseJson(txt);
    if (!o) return null;
    var bull = noAdvice(textOf(o.bull, 420)), bear = noAdvice(textOf(o.bear, 420));
    if (bull.length < 25 || bear.length < 25) return null;
    var st = String(o.stronger || '').toLowerCase();
    st = /bull/.test(st) ? 'bull' : /bear/.test(st) ? 'bear' : 'even';
    return { bull: bull, bear: bear, stronger: st, why: noAdvice(textOf(o.why, 280)) };
  }

  var RATING_WORDS = [
    [/strong[\s_-]*(up|buy|bull|positive|long)/, 'strong_up'],
    [/strong[\s_-]*(down|sell|bear|negative|short)/, 'strong_down'],
    [/(lean|mild|slight|moderate)?[\s_-]*(up|buy|bull|positive|overweight|outperform|long)/, 'lean_up'],
    [/(lean|mild|slight|moderate)?[\s_-]*(down|sell|bear|negative|underweight|underperform|short)/, 'lean_down'],
    [/(neutral|hold|flat|none|no[\s_-]*edge|balanced|sideways|range)/, 'neutral'],
  ];
  function normRating(v) {
    var s = String(v || '').toLowerCase().trim();
    if (RATINGS[s]) return s;
    for (var i = 0; i < RATING_WORDS.length; i++) if (RATING_WORDS[i][0].test(s)) return RATING_WORDS[i][1];
    return null;
  }

  function finalFrom(o) {
    if (!o) return null;
    var rating = normRating(o.rating);
    var s = num(o.score);
    if (s != null && (s < -1.001 || s > 1.001)) s = null;
    if (!rating && s != null) rating = s >= 0.5 ? 'strong_up' : s >= 0.12 ? 'lean_up' : s <= -0.5 ? 'strong_down' : s <= -0.12 ? 'lean_down' : 'neutral';
    if (!rating) return null;
    var tone = RATINGS[rating].tone;
    // A score that contradicts its own rating is a model that lost track of
    // the scale. The rating is the deliberate answer; the score is re-derived.
    if (s == null || (tone === 'up' && s <= 0) || (tone === 'down' && s >= 0) || (tone === 'flat' && Math.abs(s) > 0.2)) {
      s = RATINGS[rating].score;
    }
    var why = noAdvice(textOf(o.why, 520));
    if (why.length < 30) return null;
    var conf = num(o.confidence);
    if (conf != null && conf > 0 && conf <= 1) conf = conf * 100;
    return {
      rating: rating, label: RATINGS[rating].label, tone: tone,
      score: r3(clamp(s, -1, 1)),
      confidence: conf == null ? 50 : Math.round(clamp(conf, 5, 95)),
      why: why,
      risk: noAdvice(textOf(o.risk, 260)),
      watch: noAdvice(textOf(o.watch, 260)),
      source: 'ai',
    };
  }
  function parseFinal(txt) { return finalFrom(parseJson(txt)); }

  function parseQuick(txt, F) {
    var o = parseJson(txt);
    if (!o) return null;
    var fin = finalFrom(o);
    if (!fin) return null;
    var roles = roleList(F), an = o.analysts || {};
    var analysts = roles.map(function (r) {
      var s = num(an[r.id]);
      if (s == null || s < -1.001 || s > 1.001) return { id: r.id, label: r.label, failed: true };
      return { id: r.id, label: r.label, score: r3(clamp(s, -1, 1)), why: '', points: [], quick: true };
    });
    return { final: fin, analysts: analysts };
  }

  function parseLesson(txt) {
    var o = parseJson(txt);
    var t = o ? textOf(o.lesson, 260) : textOf(txt, 260);
    t = noAdvice(t.replace(/^["'\s]+|["'\s]+$/g, ''));
    return t.length >= 20 ? t : null;
  }

  /* When the final call fails to parse, the desk still has four scored
     reports. Averaging them is a worse call than the model's, and it is
     labelled as arithmetic so nobody mistakes it for the AI's judgement. */
  function ruleFinal(analysts, debate, failWhy) {
    var ok = analysts.filter(function (a) { return a && !a.failed; });
    if (!ok.length) return null;
    var s = ok.reduce(function (t, a) { return t + a.score; }, 0) / ok.length;
    if (debate && debate.stronger === 'bull') s += 0.05;
    if (debate && debate.stronger === 'bear') s -= 0.05;
    s = clamp(s, -1, 1);
    var rating = s >= 0.5 ? 'strong_up' : s >= 0.12 ? 'lean_up' : s <= -0.5 ? 'strong_down' : s <= -0.12 ? 'lean_down' : 'neutral';
    var agree = ok.filter(function (a) { return (a.score > 0) === (s > 0) && Math.abs(a.score) > 0.05; }).length;
    return {
      rating: rating, label: RATINGS[rating].label, tone: RATINGS[rating].tone,
      score: r3(s), confidence: Math.round(clamp(35 + agree * 8, 5, 80)),
      why: 'The final step did not answer' + (failWhy ? ' (' + failText(failWhy) + ')' : '') +
           ', so this is the average of ' + ok.length + ' analyst scores: ' +
           ok.map(function (a) { return a.label.toLowerCase() + ' ' + (a.score >= 0 ? '+' : '') + r2(a.score); }).join(', ') + '.',
      risk: '', watch: '', source: 'rule',
    };
  }

  /* ================================================================== run */
  var inFlight = null;

  function ask(S, prompt, opts) {
    return KT.data.askModel(S.settings.key, S.settings.model, prompt.system, prompt.user, opts);
  }

  /* Free models are shared, and the one a person picks is often held to about
     one request at a time upstream ("temporarily rate-limited upstream",
     429). Four analysts at once drew 429s on the first live run (29 Oct 2026):
     the technical analyst and the final call never answered and the final
     call fell back to arithmetic. So the steps go one after another, a breath
     apart, and a step that failed for a reason that passes is asked once
     more. Busy or down: a few seconds later, with the free pool named behind
     the chosen model so the router can hand it on. Empty or unreadable: that
     reply came back as a success, which the router does not retry, so the
     second ask goes to the pool itself. A retry is a request like any other:
     counted, and skipped once the day is down to the reserve. */
  // config.js can shorten both (the selftest does); these are the defaults.
  function gapMs() { return C.ai && C.ai.deskGapMs != null ? C.ai.deskGapMs : 800; }
  function retryWaitMs() { return C.ai && C.ai.deskRetryWaitMs != null ? C.ai.deskRetryWaitMs : 4000; }
  var FAIL_WORDS = {
    busy: 'the model was busy', slow: 'no reply in time', empty: 'an empty reply',
    unreadable: 'a reply that could not be read', down: 'the service was down', error: 'an error',
  };
  function failKind(e) {
    var m = String(e && e.message || e || '');
    if (/429/.test(m)) return 'busy';
    if (/abort/i.test(m) || (e && e.name === 'AbortError')) return 'slow';
    if (/empty|unusable/i.test(m)) return 'empty';
    if (/could not be read/.test(m)) return 'unreadable';
    if (/HTTP 5\d\d/.test(m)) return 'down';
    return 'error';
  }
  function failText(kind) { return FAIL_WORDS[kind] || FAIL_WORDS.error; }
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function withOpts(o, extra) {
    var out = {}, k;
    for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    return out;
  }
  // counter.n counts every request this run made, retries included.
  function attempt(S, prompt, opts, parse, counter) {
    function once(o) {
      counter.n++;
      return ask(S, prompt, o).then(function (txt) {
        var v = parse(txt);
        if (!v) throw new Error('the reply could not be read');
        return v;
      });
    }
    return once(opts).catch(function (e) {
      var kind = failKind(e), b = budget();
      var reserve = (C.ai && C.ai.deskReserve != null) ? C.ai.deskReserve : 8;
      // A spent day or a missing key does not pass in two seconds.
      if (/daily AI limit|no key/.test(String(e && e.message)) || b.blocked || b.left <= reserve) {
        e.kind = kind;
        throw e;
      }
      var pool = C.defaultModel && C.defaultModel !== S.settings.model ? C.defaultModel : null;
      var busy = kind === 'busy' || kind === 'down';
      return wait(busy ? retryWaitMs() : Math.min(1500, retryWaitMs()))
        .then(function () { return once(withOpts(opts, busy ? { fallbackModel: pool } : { modelOverride: pool })); })
        .catch(function (e2) { e2.kind = failKind(e2); throw e2; });
    });
  }

  function run(S, opts) {
    opts = opts || {};
    if (inFlight) return Promise.reject(new Error('the desk is already running'));
    if (!S || !S.settings || !S.settings.key) return Promise.reject(new Error('no key'));
    if (!KT.data || !KT.data.askModel) return Promise.reject(new Error('no model client'));
    var mode = opts.mode === 'quick' ? 'quick' : 'full';
    if (!canAfford(mode, 0)) return Promise.reject(new Error('budget'));
    var progress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};

    var F = gather(S, opts.extras);
    if (!isNum(F.price)) return Promise.reject(new Error('no price yet'));
    var fp = KT.lessons ? KT.lessons.fingerprint(F.fpInput) : null;
    var fpWords = KT.lessons && fp ? KT.lessons.describe(fp) : '';
    var picked = KT.lessons && fp ? KT.lessons.relevant(fp, { k: 4 }) : [];
    var lessonsTxt = KT.lessons ? KT.lessons.forPrompt(picked) : '';
    var recordTxt = '';
    try { recordTxt = recordText(F.symbol); } catch (e) { recordTxt = ''; }
    var counter = { n: 0 };

    function done(analysts, debate, fin) {
      var at = Date.now();
      var row = {
        id: 'D' + at.toString(36) + Math.random().toString(36).slice(2, 5),
        symbol: F.symbol, label: F.label, kind: F.kind, at: at, mode: mode,
        slot: slotKey(at), price: r2(F.price), timeframe: F.timeframe,
        horizon: { label: F.horizon.label, endTime: F.horizon.endTime, text: F.horizon.text },
        fp: fp, fpWords: fpWords,
        analysts: analysts, debate: debate || null, final: fin,
        lessonsUsed: picked.map(function (p) { return p.lesson.id; }),
        recordUsed: !!recordTxt,
        calls: counter.n, outcome: null,
      };
      var items = loadRuns();
      items.push(row);
      saveRuns(items);
      return row;
    }

    var p;
    if (mode === 'quick') {
      progress({ stage: 'quick', text: 'One-call read' });
      p = attempt(S, quickPrompt(F, lessonsTxt, fpWords, recordTxt), { maxTokens: 520, temperature: 0.2, purpose: 'desk:quick' },
                  function (txt) { return parseQuick(txt, F); }, counter)
        .then(function (q) { return done(q.analysts, null, q.final); });
    } else {
      var roles = roleList(F), analysts = [];
      progress({ stage: 'analysts', text: (roles.length === 5 ? 'Five' : 'Four') + ' analysts reading the evidence' });
      p = roles.reduce(function (chain, role, i) {
        return chain.then(function () {
          return wait(i ? gapMs() : 0).then(function () {
            return attempt(S, analystPrompt(F, role), { maxTokens: 320, temperature: 0.2, purpose: 'desk:' + role.id },
                           parseAnalyst, counter);
          }).then(function (a) {
            a.id = role.id; a.label = role.label;
            progress({ stage: 'analyst', id: role.id, analyst: a });
            analysts.push(a);
          }, function (e) {
            analysts.push({ id: role.id, label: role.label, failed: true, failWhy: e && e.kind || failKind(e) });
          });
        });
      }, Promise.resolve()).then(function () {
        var ok = analysts.filter(function (a) { return !a.failed; });
        if (ok.length < 2) throw new Error('only ' + ok.length + ' of ' + roles.length + ' analysts answered');
        progress({ stage: 'debate', text: 'Bull and bear arguing it out' });
        return wait(gapMs()).then(function () {
          return attempt(S, debatePrompt(F, analysts), { maxTokens: 380, temperature: 0.3, purpose: 'desk:debate' },
                         parseDebate, counter);
        })
          .catch(function () { return null; })
          .then(function (debate) {
            progress({ stage: 'final', text: 'Final call and risk check' });
            return wait(gapMs()).then(function () {
              return attempt(S, finalPrompt(F, analysts, debate, lessonsTxt, fpWords, recordTxt),
                             { maxTokens: 400, temperature: 0.2, purpose: 'desk:final' }, parseFinal, counter);
            })
              .then(function (fin) { return done(analysts, debate, fin); },
                    function (e) {
                      return done(analysts, debate, ruleFinal(analysts, debate, e && e.kind || failKind(e)));
                    });
          });
      });
    }

    inFlight = p;
    return p.then(function (row) { inFlight = null; return row; },
                  function (e) { inFlight = null; throw e; });
  }
  function busy() { return !!inFlight; }

  /* ================================================================= vote

     What the forecast's model lane receives. Valid until the horizon ends or
     three hours pass, whichever is first: a desk call is a read of the whole
     session, not of the last headline, so the twenty minutes the single-call
     vote lived for would leave the lane dark most of the day. */
  function voteFor(symbol, nowMs) {
    var r = latest(symbol);
    if (!r || !r.final) return null;
    nowMs = nowMs || Date.now();
    var untilEnd = r.horizon && r.horizon.endTime ? r.horizon.endTime * 1000 - r.at : VOTE_MAX_TTL;
    var ttl = clamp(untilEnd, VOTE_MIN_TTL, VOTE_MAX_TTL);
    if (nowMs - r.at > ttl) return null;
    return { score: r.final.score, why: r.final.why, model: 'desk', at: r.at, ttlMs: ttl,
             source: 'desk', runId: r.id, rating: r.final.rating };
  }

  /* =============================================================== settle */
  function settle(symbol, candles, barSec) {
    if (!candles || candles.length < 2 || !symbol) return [];
    if (barSec && barSec > 86400) return [];      // a monthly bar cannot place a 15:30 close
    var items = loadRuns(), lastT = candles[candles.length - 1].time, changed = [];
    items.forEach(function (r) {
      if (r.outcome || r.symbol !== symbol || !r.horizon || !r.horizon.endTime || !r.final) return;
      if (lastT < r.horizon.endTime) return;
      var bar = barAtOrBefore(candles, r.horizon.endTime);
      if (!bar) return;
      // The bar has to be near the end of the horizon. A series with a hole
      // where that session should be is not evidence about it.
      if (r.horizon.endTime - bar.time > Math.max((barSec || 60) * 3, 6 * 3600)) return;
      var move = (bar.close - r.price) / r.price * 100;
      var dir = r.final.score > 0.05 ? 1 : r.final.score < -0.05 ? -1 : 0;
      var right = dir === 0 || Math.abs(move) < 0.02 ? null : (move * dir > 0);
      r.outcome = { endPrice: r2(bar.close), movePct: r3(move), right: right, settledAt: Date.now() };
      changed.push(r);
    });
    if (changed.length) saveRuns(items);
    return changed;
  }

  /* The lesson. AI-written when the budget allows; arithmetic otherwise, and
     labelled as such. */
  function reflect(S, r, opts) {
    opts = opts || {};
    if (!r || !r.outcome || !KT.lessons) return Promise.resolve(null);
    var base = {
      runId: r.id, symbol: r.symbol, kind: r.kind, fp: r.fp,
      call: { rating: r.final.rating, label: r.final.label, score: r.final.score, price: r.price,
              horizon: r.horizon ? r.horizon.text : null, why: r.final.why },
      outcome: r.outcome, at: Date.now(),
    };
    function fallback() {
      var t = KT.lessons.ruleText(base.call, r.outcome, r.fp);
      return t ? KT.lessons.add(Object.assign({}, base, { text: t, source: 'rule' })) : null;
    }
    var key = S && S.settings && S.settings.key;
    if (!key || opts.ruleOnly || !canAfford('reflect', opts.reserve == null ? 2 : opts.reserve)) {
      return Promise.resolve(fallback());
    }
    return ask(S, reflectPrompt(r), { maxTokens: 140, temperature: 0.2, purpose: 'desk:reflect', minChars: 20 })
      .then(function (txt) {
        var t = parseLesson(txt);
        return t ? KT.lessons.add(Object.assign({}, base, { text: t, source: 'ai' })) : fallback();
      })
      .catch(fallback);
  }

  /* ================================================================ record */
  function record(symbol) {
    var scored = loadRuns().filter(function (r) {
      return (!symbol || r.symbol === symbol) && r.outcome && r.outcome.right != null;
    });
    var n = scored.length, k = scored.filter(function (r) { return r.outcome.right; }).length;
    var settled = loadRuns().filter(function (r) { return (!symbol || r.symbol === symbol) && r.outcome; }).length;
    return {
      n: n, right: k, settled: settled,
      rate: n ? Math.round(k / n * 1000) / 10 : null,
      ci: n && KT.ledger && KT.ledger.wilson ? KT.ledger.wilson(k, n) : null,
    };
  }

  /* ============================================================ automation

     Automatic runs are for the index only, one per part of the day, and only
     while the budget keeps a reserve for the stocks someone opens by hand.
     Four slots at six requests is twenty-four of the fifty. */
  function slotKey(ms) {
    var d = fmt.ist(Math.floor((ms || Date.now()) / 1000));
    var mins = d.getHours() * 60 + d.getMinutes();
    var slot = mins < C.market.regular.from ? 'pre' : mins < 12 * 60 ? 'am' : mins <= C.market.regular.to ? 'pm' : 'post';
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ':' + slot;
  }
  function autoEnabled() { return core.store.get('deskAuto', true) !== false; }
  function setAuto(on) { core.store.set('deskAuto', !!on); }

  function shouldAuto(S, nowMs) {
    if (!S || !S.settings || !S.settings.key || inFlight) return false;
    if (!autoEnabled()) return false;
    var meta = C.symbols[S.symbol];
    if (!meta || meta.stock || S.symbol !== 'NIFTY') return false;
    if (!S.forecast || !S.candles || !S.candles.length) return false;
    nowMs = nowMs || Date.now();
    var last = latest(S.symbol);
    if (last && last.slot === slotKey(nowMs)) return false;
    if (last && nowMs - last.at < AUTO_GAP_MS) return false;
    var reserve = (C.ai && C.ai.deskReserve != null) ? C.ai.deskReserve : 8;
    return canAfford('full', reserve);
  }

  KT.desk = {
    RATINGS: RATINGS, ORDER: ORDER, CALLS: CALLS,
    gather: gather, roleList: roleList,
    prompts: {
      analyst: analystPrompt, debate: debatePrompt, final: finalPrompt,
      quick: quickPrompt, reflect: reflectPrompt,
    },
    parse: { json: parseJson, analyst: parseAnalyst, debate: parseDebate, final: parseFinal,
             quick: parseQuick, lesson: parseLesson, rating: normRating },
    noAdvice: noAdvice, ruleFinal: ruleFinal, failKind: failKind, failText: failText,
    run: run, busy: busy, latest: latest, runs: runs, clear: clear,
    voteFor: voteFor, settle: settle, reflect: reflect, record: record, recordText: recordText,
    budget: budget, canAfford: canAfford,
    shouldAuto: shouldAuto, autoEnabled: autoEnabled, setAuto: setAuto, slotKey: slotKey,
  };
})(window.KT);
