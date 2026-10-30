/* ============================================================================
   The studies traders here actually watch, and how often each one worked.

   Every Indian intraday desk draws the same handful of lines before the open:
   the CPR, the floor pivots, Camarilla, yesterday's high and low, the first
   fifteen minutes' range, the round numbers, the option chain's walls and max
   pain. Each comes with a rule of thumb ("open above the CPR is a bullish
   day", "a gap fills"). This file draws them and, for every rule that can be
   checked on daily bars, measures it on the index's own record: the same
   function runs over twenty years in the workflow (scripts/history_study.js,
   data/study.json) and over whatever daily history this browser has, so a
   tip on the page always carries how often it actually came true and the
   rate it has to beat.

   Nothing here votes in the forecast. These are what a reader checks the
   forecast against; the setup check (drivers.js) reads them.
   ========================================================================== */
(function (KT) {
  'use strict';
  var core = KT.core;

  function r2(n) { return Math.round(n * 100) / 100; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* ------------------------------------------------------------ sessions
     Intraday bars folded into one OHLC row per IST trading date. */
  function istKey(sec) { return new Date((sec + 19800) * 1000).toISOString().slice(0, 10); }

  function sessionsOf(candles) {
    var out = [], cur = null;
    (candles || []).forEach(function (b) {
      if (!b || !isNum(b.close)) return;
      var k = istKey(b.time);
      if (!cur || cur.key !== k) {
        cur = { key: k, time: b.time, open: isNum(b.open) ? b.open : b.close, high: b.high, low: b.low, close: b.close, first: b.time, last: b.time, bars: 0 };
        out.push(cur);
      }
      cur.high = Math.max(cur.high, isNum(b.high) ? b.high : b.close);
      cur.low = Math.min(cur.low, isNum(b.low) ? b.low : b.close);
      cur.close = b.close; cur.last = b.time; cur.bars++;
    });
    return out;
  }

  /* ---------------------------------------------------------- the levels
     All from the previous session's high, low and close. */
  function cpr(p) {
    if (!p) return null;
    var P = (p.high + p.low + p.close) / 3, BC = (p.high + p.low) / 2, TC = 2 * P - BC;
    var hi = Math.max(TC, BC), lo = Math.min(TC, BC);
    return { P: r2(P), TC: r2(hi), BC: r2(lo), widthPct: Math.round((hi - lo) / P * 10000) / 100 };
  }
  function floorPivots(p) {
    if (!p) return null;
    var P = (p.high + p.low + p.close) / 3, rg = p.high - p.low;
    return { P: r2(P), R1: r2(2 * P - p.low), S1: r2(2 * P - p.high), R2: r2(P + rg), S2: r2(P - rg),
             R3: r2(p.high + 2 * (P - p.low)), S3: r2(p.low - 2 * (p.high - P)) };
  }
  function camarilla(p) {
    if (!p) return null;
    var rg = (p.high - p.low) * 1.1;
    return { H3: r2(p.close + rg / 4), L3: r2(p.close - rg / 4), H4: r2(p.close + rg / 2), L4: r2(p.close - rg / 2) };
  }

  /* The first `minutes` of the session in progress (or the last one). */
  function openingRange(candles, minutes) {
    minutes = minutes || 15;
    var s = sessionsOf(candles);
    if (!s.length) return null;
    var day = s[s.length - 1], start = day.first, hi = -Infinity, lo = Infinity, n = 0;
    (candles || []).forEach(function (b) {
      if (b.time < start || b.time >= start + minutes * 60 || istKey(b.time) !== day.key) return;
      hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); n++;
    });
    if (!n) return null;
    return { high: r2(hi), low: r2(lo), session: day.key, complete: day.last >= start + minutes * 60 };
  }

  /* The last swing on screen: the highest high and the lowest low of the
     window, in the order they came, and the retracements between them. */
  var FIB = [0.236, 0.382, 0.5, 0.618, 0.786];
  function fibonacci(candles, lookback) {
    var c = (candles || []).slice(-(lookback || 200));
    if (c.length < 20) return null;
    var hi = -Infinity, lo = Infinity, hiT = 0, loT = 0;
    c.forEach(function (b) {
      if (b.high > hi) { hi = b.high; hiT = b.time; }
      if (b.low < lo) { lo = b.low; loT = b.time; }
    });
    var up = loT < hiT;                      // the swing ran up into the high
    return {
      from: up ? lo : hi, to: up ? hi : lo, dir: up ? 1 : -1,
      levels: FIB.map(function (f) { return { f: f, price: r2(up ? hi - (hi - lo) * f : lo + (hi - lo) * f) }; }),
    };
  }

  // NIFTY reacts at every 100 and more at every 500; BANK NIFTY at 500/1000.
  function roundLevels(price, symbol) {
    if (!isNum(price) || price <= 0) return [];
    var step = price > 40000 ? 500 : price > 8000 ? 100 : price > 2000 ? 50 : price > 500 ? 10 : 5;
    var big = step * 5, base = Math.round(price / step) * step, out = [];
    for (var k = -3; k <= 3; k++) {
      var v = base + k * step;
      if (v > 0) out.push({ price: v, strong: v % big === 0 });
    }
    return out;
  }

  /* The option chain's ceiling, floor and max pain, from the same payload
     forecast.optionsLane reads (data/options.json, or the live chain):
     `resistance` and `support` are the strikes with the most call and put
     open interest, biggest first. */
  function oiLevels(opt) {
    if (!opt || !opt.ok) return null;
    var strike = function (x) { return x == null ? null : isNum(x) ? x : isNum(x.strike) ? x.strike : null; };
    var callWall = strike((opt.resistance || [])[0]), putWall = strike((opt.support || [])[0]);
    var maxPain = isNum(opt.maxPain) ? opt.maxPain : null;
    if (callWall == null && putWall == null && maxPain == null) return null;
    return { callWall: callWall, putWall: putWall, maxPain: maxPain, pcr: isNum(opt.pcrOi) ? opt.pcrOi : null,
             expiry: opt.expiry || null, expiryDays: isNum(opt.expiryDays) ? opt.expiryDays : null,
             atmIv: isNum(opt.atmIv) ? opt.atmIv : null };
  }

  /* ============================================================ the rules
     Each rule: when it applies on day i (with day i-1 before it), and what
     counts as it coming true. `d` is an array of daily rows {open, high,
     low, close} with derived fields filled in by prepare(). */
  function ema(vals, n) { return KT.ind && KT.ind.ema ? KT.ind.ema(vals, n) : vals.map(function () { return null; }); }

  function prepare(daily, vixByDay) {
    var d = daily.map(function (r) { return { key: r.key || istKey(r.time), open: r.open, high: r.high, low: r.low, close: r.close }; });
    var closes = d.map(function (r) { return r.close; });
    var e20 = ema(closes, 20), e50 = ema(closes, 50);
    var rsi = KT.ind && KT.ind.rsi ? KT.ind.rsi(d.map(function (r) { return { close: r.close }; }), 14) : [];
    for (var i = 0; i < d.length; i++) {
      var r = d[i];
      r.range = r.open > 0 ? (r.high - r.low) / r.open * 100 : null;
      r.trend = r.high > r.low ? Math.abs(r.close - r.open) / (r.high - r.low) >= 0.6 : false;
      r.e20 = e20[i]; r.e50 = e50[i]; r.rsi = rsi[i];
      r.vix = vixByDay ? vixByDay[r.key] : null;
      if (i > 0) {
        var p = d[i - 1];
        r.gap = (r.open - p.close) / p.close * 100;
        r.cpr = cpr(p); r.piv = floorPivots(p); r.cam = camarilla(p);
        r.prev = p;
      }
      if (i >= 6) {
        var narrow = true;
        for (var j = i - 6; j < i; j++) if ((d[j].high - d[j].low) <= (r.high - r.low)) { narrow = false; break; }
        r.nr7 = narrow;
      }
      if (i >= 20) {
        var s = 0; for (var q = i - 20; q < i; q++) s += d[q].range || 0;
        r.avgRange = s / 20;
      }
    }
    return d;
  }

  var RULES = [
    { key: 'cpr_narrow', study: 'cpr', name: 'Narrow CPR, trending day',
      tip: 'A narrow CPR is read as a trending day ahead: price tends to leave the band and keep going.',
      applies: function (d, i, ctx) { return d[i].cpr && ctx.cprP25 != null && d[i].cpr.widthPct <= ctx.cprP25; },
      came: function (d, i) { return d[i].trend; }, baseOf: 'trendDay' },
    { key: 'cpr_wide', study: 'cpr', name: 'Wide CPR, range day',
      tip: 'A wide CPR is read as a sideways day: price tends to stay inside yesterday\'s range.',
      applies: function (d, i, ctx) { return d[i].cpr && ctx.cprP75 != null && d[i].cpr.widthPct >= ctx.cprP75; },
      came: function (d, i) { return !d[i].trend; }, baseOf: 'rangeDay' },
    { key: 'open_above_cpr', study: 'cpr', name: 'Open above the CPR, closes above it',
      tip: 'Opening above the CPR is the classic bullish start: buyers are in control while price holds above the band.',
      applies: function (d, i) { return d[i].cpr && d[i].open > d[i].cpr.TC; },
      came: function (d, i) { return d[i].close > d[i].cpr.TC; } },
    { key: 'open_below_cpr', study: 'cpr', name: 'Open below the CPR, closes below it',
      tip: 'Opening below the CPR is the bearish start: sellers are in control while price stays under the band.',
      applies: function (d, i) { return d[i].cpr && d[i].open < d[i].cpr.BC; },
      came: function (d, i) { return d[i].close < d[i].cpr.BC; } },
    { key: 'pdh_break', study: 'pdhl', name: 'Above yesterday\'s high, holds there',
      tip: 'A break of yesterday\'s high that holds into the close is a continuation day; a failed one often falls back.',
      applies: function (d, i) { return d[i].prev && d[i].high > d[i].prev.high; },
      came: function (d, i) { return d[i].close > d[i].prev.high; } },
    { key: 'pdl_break', study: 'pdhl', name: 'Below yesterday\'s low, holds there',
      tip: 'A break of yesterday\'s low that holds into the close is a weak day; a failed one often recovers.',
      applies: function (d, i) { return d[i].prev && d[i].low < d[i].prev.low; },
      came: function (d, i) { return d[i].close < d[i].prev.low; } },
    { key: 'r1_reject', study: 'pivots', name: 'Touches R1, closes back under it',
      tip: 'R1 is where a rally often pauses; a close above it opens R2.',
      applies: function (d, i) { return d[i].piv && d[i].high >= d[i].piv.R1; },
      came: function (d, i) { return d[i].close < d[i].piv.R1; } },
    { key: 's1_hold', study: 'pivots', name: 'Touches S1, closes back above it',
      tip: 'S1 is where a fall often pauses; a close below it opens S2.',
      applies: function (d, i) { return d[i].piv && d[i].low <= d[i].piv.S1; },
      came: function (d, i) { return d[i].close > d[i].piv.S1; } },
    { key: 'cam_h3_fade', study: 'camarilla', name: 'Camarilla H3 touched, faded',
      tip: 'Camarilla traders fade H3 and L3 (back toward the middle) and follow a break of H4 or L4.',
      applies: function (d, i) { return d[i].cam && d[i].high >= d[i].cam.H3 && d[i].high < d[i].cam.H4; },
      came: function (d, i) { return d[i].close < d[i].cam.H3; } },
    { key: 'cam_h4_break', study: 'camarilla', name: 'Camarilla H4 broken, held',
      tip: 'A break of H4 is the Camarilla breakout signal for the day.',
      applies: function (d, i) { return d[i].cam && d[i].high >= d[i].cam.H4; },
      came: function (d, i) { return d[i].close >= d[i].cam.H4; } },
    { key: 'gap_up_fill', study: 'gap', name: 'Gap up of 0.3% or more fills',
      tip: 'Gaps often fill the same day: price trades back to yesterday\'s close.',
      applies: function (d, i) { return isNum(d[i].gap) && d[i].gap >= 0.3; },
      came: function (d, i) { return d[i].low <= d[i].prev.close; } },
    { key: 'gap_down_fill', study: 'gap', name: 'Gap down of 0.3% or more fills',
      tip: 'A gap down often trades back up to yesterday\'s close during the day.',
      applies: function (d, i) { return isNum(d[i].gap) && d[i].gap <= -0.3; },
      came: function (d, i) { return d[i].high >= d[i].prev.close; } },
    { key: 'gap_up_fade', study: 'gap', name: 'Gap up, closes below its open',
      tip: 'Opening gaps are often sold into: the close ends below the opening print.',
      applies: function (d, i) { return isNum(d[i].gap) && d[i].gap >= 0.3; },
      came: function (d, i) { return d[i].close < d[i].open; } },
    { key: 'gap_down_bounce', study: 'gap', name: 'Gap down, closes above its open',
      tip: 'Gap downs are often bought: the close ends above the opening print.',
      applies: function (d, i) { return isNum(d[i].gap) && d[i].gap <= -0.3; },
      came: function (d, i) { return d[i].close > d[i].open; } },
    { key: 'rsi_over', study: 'rsi', name: 'RSI above 70, next day up',
      tip: 'Above 70 is called overbought, but in a strong trend it is usually strength, not a top.',
      applies: function (d, i) { return isNum(d[i - 1] && d[i - 1].rsi) && d[i - 1].rsi > 70; },
      came: function (d, i) { return d[i].close > d[i - 1].close; }, baseOf: 'upDay' },
    { key: 'rsi_under', study: 'rsi', name: 'RSI below 30, next day up',
      tip: 'Below 30 is called oversold: the bounce traders wait for.',
      applies: function (d, i) { return isNum(d[i - 1] && d[i - 1].rsi) && d[i - 1].rsi < 30; },
      came: function (d, i) { return d[i].close > d[i - 1].close; }, baseOf: 'upDay' },
    { key: 'ema_up', study: 'ema', name: 'Price over 20 EMA over 50 EMA, next day up',
      tip: 'Stacked averages (price over 20 over 50) are the simplest uptrend test.',
      applies: function (d, i) { var p = d[i - 1]; return p && isNum(p.e20) && isNum(p.e50) && p.close > p.e20 && p.e20 > p.e50; },
      came: function (d, i) { return d[i].close > d[i - 1].close; }, baseOf: 'upDay' },
    { key: 'ema_down', study: 'ema', name: 'Price under 20 EMA under 50 EMA, next day down',
      tip: 'Stacked the other way it is the simplest downtrend test.',
      applies: function (d, i) { var p = d[i - 1]; return p && isNum(p.e20) && isNum(p.e50) && p.close < p.e20 && p.e20 < p.e50; },
      came: function (d, i) { return d[i].close < d[i - 1].close; }, baseOf: 'downDay' },
    { key: 'nr7', study: 'range', name: 'After the narrowest day in seven, a wider day',
      tip: 'NR7: a squeeze day is usually followed by a bigger move. It says nothing about the direction.',
      applies: function (d, i) { return d[i - 1] && d[i - 1].nr7 && isNum(d[i].avgRange); },
      came: function (d, i) { return d[i].range > d[i].avgRange; }, baseOf: 'wideDay' },
    { key: 'down3', study: 'range', name: 'After three down closes, an up day',
      tip: 'Three red days in a row is where dip buyers usually step in.',
      applies: function (d, i) { return i >= 4 && d[i - 1].close < d[i - 2].close && d[i - 2].close < d[i - 3].close && d[i - 3].close < d[i - 4].close; },
      came: function (d, i) { return d[i].close > d[i - 1].close; }, baseOf: 'upDay' },
    { key: 'vix_high', study: 'vix', name: 'India VIX over 20, a range over 1.5%',
      tip: 'High VIX means wide days: option premiums are rich, and so are the swings.',
      applies: function (d, i) { return isNum(d[i - 1] && d[i - 1].vix) && d[i - 1].vix > 20; },
      came: function (d, i) { return d[i].range > 1.5; }, baseOf: 'bigRange' },
    { key: 'vix_low', study: 'vix', name: 'India VIX under 13, a range under 0.8%',
      tip: 'Low VIX means quiet days: the kind option sellers want.',
      applies: function (d, i) { return isNum(d[i - 1] && d[i - 1].vix) && d[i - 1].vix < 13; },
      came: function (d, i) { return d[i].range < 0.8; }, baseOf: 'smallRange' },
  ];

  function wilson(k, n) {
    if (!n) return null;
    var p = k / n, z = 1.96, den = 1 + z * z / n, centre = p + z * z / (2 * n);
    var half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [Math.round((centre - half) / den * 1000) / 10, Math.round((centre + half) / den * 1000) / 10];
  }
  function pctl(arr, q) {
    var a = arr.filter(isNum).slice().sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
  }

  /* Every rule over a daily record. `base` is how often the same outcome
     happened on any day, which is what the rule has to beat. */
  function measureRules(daily, vixByDay) {
    var d = prepare(daily, vixByDay);
    if (d.length < 60) return null;
    var widths = d.map(function (r) { return r.cpr ? r.cpr.widthPct : null; });
    var ctx = { cprP25: pctl(widths, 0.25), cprP75: pctl(widths, 0.75) };
    var base = { trendDay: [0, 0], rangeDay: [0, 0], upDay: [0, 0], downDay: [0, 0], wideDay: [0, 0], bigRange: [0, 0], smallRange: [0, 0] };
    for (var i = 21; i < d.length; i++) {
      var r = d[i];
      base.trendDay[1]++; if (r.trend) base.trendDay[0]++;
      base.rangeDay[1]++; if (!r.trend) base.rangeDay[0]++;
      base.upDay[1]++; if (r.close > d[i - 1].close) base.upDay[0]++;
      base.downDay[1]++; if (r.close < d[i - 1].close) base.downDay[0]++;
      if (isNum(r.avgRange)) { base.wideDay[1]++; if (r.range > r.avgRange) base.wideDay[0]++; }
      base.bigRange[1]++; if (r.range > 1.5) base.bigRange[0]++;
      base.smallRange[1]++; if (r.range < 0.8) base.smallRange[0]++;
    }
    var rate = function (b) { return b[1] ? Math.round(b[0] / b[1] * 1000) / 10 : null; };
    var rules = RULES.map(function (R) {
      var n = 0, k = 0, last = null;
      for (var i = 21; i < d.length; i++) {
        if (!R.applies(d, i, ctx)) continue;
        n++; if (R.came(d, i)) k++; last = d[i].key;
      }
      return { key: R.key, study: R.study, name: R.name, tip: R.tip, n: n, k: k,
               rate: n ? Math.round(k / n * 1000) / 10 : null, ci: wilson(k, n),
               base: R.baseOf ? rate(base[R.baseOf]) : null, last: last };
    });
    // How much of an opening gap carries into the close, on average (the
    // slope of the day's open-to-close move on its gap).
    var sxy = 0, sxx = 0, gn = 0;
    for (var g = 1; g < d.length; g++) {
      if (!isNum(d[g].gap)) continue;
      var y = (d[g].close - d[g].open) / d[g - 1].close * 100;
      sxy += d[g].gap * y; sxx += d[g].gap * d[g].gap; gn++;
    }
    return {
      from: d[0].key, to: d[d.length - 1].key, days: d.length,
      cprP25: ctx.cprP25, cprP75: ctx.cprP75,
      base: { trendDay: rate(base.trendDay), upDay: rate(base.upDay), bigRange: rate(base.bigRange), smallRange: rate(base.smallRange) },
      gapFollow: gn > 100 && sxx > 0 ? { beta: Math.round(sxy / sxx * 1000) / 1000, n: gn } : null,
      rules: rules,
    };
  }

  /* Which rules apply to the session in progress (or the next one): the
     previous session's levels against today's open and price. */
  function activeRules(daily, today, measured, vixNow) {
    if (!daily || daily.length < 2 || !today) return [];
    var rows = daily.slice(-60).concat([{ key: today.key, open: today.open, high: today.high, low: today.low, close: today.close }]);
    var d = prepare(rows, null);
    var i = d.length - 1;
    if (isNum(vixNow) && d[i - 1]) d[i - 1].vix = vixNow;
    var ctx = { cprP25: measured && measured.cprP25, cprP75: measured && measured.cprP75 };
    var byKey = {};
    (measured && measured.rules || []).forEach(function (r) { byKey[r.key] = r; });
    var out = [];
    RULES.forEach(function (R) {
      // Rules decided by the close (holds, fills, fades) are shown as live
      // conditions once their trigger has happened today.
      var on = false;
      try { on = !!R.applies(d, i, ctx); } catch (e) { on = false; }
      if (!on) return;
      var m = byKey[R.key] || {};
      out.push({ key: R.key, study: R.study, name: R.name, tip: R.tip, rate: m.rate != null ? m.rate : null,
                 n: m.n || 0, base: m.base != null ? m.base : null, ci: m.ci || null });
    });
    return out;
  }

  /* The studies the chart can draw, with the rule of thumb each one comes
     with. `rules` names the measured rules that belong to it. */
  var CATALOGUE = [
    { id: 'cpr', name: 'CPR', tip: 'Central pivot range from yesterday\'s high, low and close. Above it buyers are in control, below it sellers; a narrow band often means a trending day.' },
    { id: 'pivots', name: 'Pivots', tip: 'Floor pivots: R1 to R3 above, S1 to S3 below. Intraday moves often pause at R1 and S1.' },
    { id: 'camarilla', name: 'Camarilla', tip: 'H3 and L3 are fade levels, H4 and L4 are breakout levels.' },
    { id: 'pdhl', name: 'Yesterday\'s high and low', tip: 'The most watched levels of the day: a break that holds is a continuation, a failed break a reversal.' },
    { id: 'orb', name: 'Opening range', tip: 'The first 15 minutes\' high and low. A break of either side that holds is the opening range breakout.' },
    { id: 'fib', name: 'Fibonacci', tip: 'Retracements of the last swing on screen. Pullbacks often stall between 38.2% and 61.8%.' },
    { id: 'oi', name: 'OI walls and max pain', tip: 'The strike with the most call open interest acts as a ceiling, the most put open interest as a floor. Near expiry price is pulled toward max pain.' },
    { id: 'round', name: 'Round numbers', tip: 'NIFTY reacts at every 100 and more at every 500, where option writers cluster.' },
    { id: 'ichimoku', name: 'Ichimoku', tip: 'Price above the cloud with the fast line over the slow line is an uptrend by this measure; inside the cloud is no trend.' },
    { id: 'osc', name: 'RSI and MACD panel', tip: 'RSI over 70 or under 30 is stretched; MACD crossing its signal line marks a change of momentum.' },
  ];

  /* ------------------------------------------------------------ readings
     One plain sentence a study, for the session on screen: where price sits
     against each set of lines right now. `ctx`: { candles (intraday or
     daily), options, playbook, live (market open) }. */
  function fmtPx(v) { return core && core.fmt ? core.fmt.price(Math.round(v)).replace(/\.00$/, '') : String(Math.round(v)); }
  function pct(a, b) { return (a - b) / b * 100; }

  function readings(ctx) {
    var out = {}, c = ctx.candles || [];
    if (c.length < 2) return out;
    var ss = sessionsOf(c);
    var prev = ctx.live ? ss[ss.length - 2] : ss[ss.length - 1];
    var px = c[c.length - 1].close;
    var pb = ctx.playbook || null;
    if (prev) {
      var cp = cpr(prev);
      var w = cp.widthPct;
      var size = pb && pb.cprP25 != null && w <= pb.cprP25 ? 'narrow (in the narrowest quarter of days)'
        : pb && pb.cprP75 != null && w >= pb.cprP75 ? 'wide (in the widest quarter of days)' : 'of normal width';
      out.cpr = (ctx.live ? 'Today\'s' : 'Next session\'s') + ' CPR is ' + w.toFixed(2) + '% wide, ' + size + '. Price ' +
        (px > cp.TC ? 'is above it' : px < cp.BC ? 'is below it' : 'is inside it') + ' (' + fmtPx(cp.BC) + ' to ' + fmtPx(cp.TC) + ').';
      var pv = floorPivots(prev);
      var lv = [['S2', pv.S2], ['S1', pv.S1], ['P', pv.P], ['R1', pv.R1], ['R2', pv.R2]];
      var below = null, above = null;
      lv.forEach(function (x) { if (x[1] <= px) below = x; else if (!above) above = x; });
      out.pivots = 'Price is ' + (below && above ? 'between ' + below[0] + ' (' + fmtPx(below[1]) + ') and ' + above[0] + ' (' + fmtPx(above[1]) + ')'
        : below ? 'above R2 (' + fmtPx(pv.R2) + ')' : 'below S2 (' + fmtPx(pv.S2) + ')') + '.';
      var cm = camarilla(prev);
      out.camarilla = px >= cm.H4 ? 'Above H4 (' + fmtPx(cm.H4) + '): the breakout side.'
        : px >= cm.H3 ? 'Between H3 and H4: the fade zone on the upside.'
        : px <= cm.L4 ? 'Below L4 (' + fmtPx(cm.L4) + '): the breakdown side.'
        : px <= cm.L3 ? 'Between L3 and L4: the fade zone on the downside.'
        : 'Inside H3 to L3 (' + fmtPx(cm.L3) + ' to ' + fmtPx(cm.H3) + '): no signal.';
      out.pdhl = 'Yesterday ' + fmtPx(prev.low) + ' to ' + fmtPx(prev.high) + '. Price is ' +
        (px > prev.high ? 'above its high' : px < prev.low ? 'below its low' : 'inside its range') + '.';
    }
    var orr = openingRange(c, 15);
    if (orr && ctx.intraday) {
      out.orb = 'First 15 minutes ' + fmtPx(orr.low) + ' to ' + fmtPx(orr.high) + '. Price is ' +
        (px > orr.high ? 'above it: an upside break' : px < orr.low ? 'below it: a downside break' : 'still inside it') + '.';
    }
    var fb = fibonacci(c, 200);
    if (fb) {
      var near = fb.levels.slice().sort(function (a, b) { return Math.abs(a.price - px) - Math.abs(b.price - px); })[0];
      out.fib = 'Last swing ' + (fb.dir > 0 ? 'up' : 'down') + ' from ' + fmtPx(fb.from) + ' to ' + fmtPx(fb.to) +
        '. Nearest retracement: ' + (near.f * 100).toFixed(1) + '% at ' + fmtPx(near.price) + '.';
    }
    var oi = oiLevels(ctx.options);
    if (oi && ctx.symbol === 'NIFTY') {
      out.oi = [oi.callWall != null ? 'call wall ' + fmtPx(oi.callWall) + ' (' + pct(oi.callWall, px).toFixed(1) + '%)' : null,
                oi.putWall != null ? 'put wall ' + fmtPx(oi.putWall) + ' (' + pct(oi.putWall, px).toFixed(1) + '%)' : null,
                oi.maxPain != null ? 'max pain ' + fmtPx(oi.maxPain) + (oi.expiryDays != null ? ', ' + oi.expiryDays + ' days to expiry' : '') : null,
                oi.pcr != null ? 'PCR ' + oi.pcr : null].filter(Boolean).join('; ') + '.';
      out.oi = out.oi.charAt(0).toUpperCase() + out.oi.slice(1);
    }
    var rl = roundLevels(px, ctx.symbol);
    if (rl.length) {
      var r0 = rl.slice().sort(function (a, b) { return Math.abs(a.price - px) - Math.abs(b.price - px); })[0];
      out.round = 'Nearest round number ' + fmtPx(r0.price) + (r0.strong ? ' (a big one)' : '') + ', ' + Math.abs(px - r0.price).toFixed(0) + ' points away.';
    }
    if (KT.ind && KT.ind.ichimoku && c.length > 60) {
      var ich = KT.ind.ichimoku(c), k = c.length - 1 - ich.shift;
      var a = k >= 0 ? ich.senkouA[k] : null, b = k >= 0 ? ich.senkouB[k] : null;
      if (a != null && b != null) {
        var top = Math.max(a, b), bot = Math.min(a, b), tk = ich.tenkan[c.length - 1], kj = ich.kijun[c.length - 1];
        out.ichimoku = 'Price is ' + (px > top ? 'above the cloud' : px < bot ? 'below the cloud' : 'inside the cloud') +
          (tk != null && kj != null ? ', fast line ' + (tk >= kj ? 'over' : 'under') + ' the slow line' : '') + '.';
      }
    }
    if (KT.ind && KT.ind.rsi && c.length > 30) {
      var rs = KT.ind.rsi(c, 14), rv = rs[rs.length - 1];
      var md = KT.ind.macd ? KT.ind.macd(c) : null;
      var lastOf = function (a) { if (!a) return null; for (var q = a.length - 1; q >= 0; q--) if (a[q] != null && !isNaN(a[q])) return a[q]; return null; };
      var mLine = md ? lastOf(md.line) : null, mSig = md ? lastOf(md.signal) : null;
      out.osc = (rv != null ? 'RSI ' + rv.toFixed(0) + (rv > 70 ? ', stretched up' : rv < 30 ? ', stretched down' : '') : '') +
        (mLine != null && mSig != null ? '; MACD ' + (mLine >= mSig ? 'above' : 'below') + ' its signal line' : '') + '.';
    }
    return out;
  }

  KT.studies = {
    sessionsOf: sessionsOf, cpr: cpr, floorPivots: floorPivots, camarilla: camarilla,
    openingRange: openingRange, fibonacci: fibonacci, roundLevels: roundLevels, oiLevels: oiLevels,
    measureRules: measureRules, activeRules: activeRules, prepare: prepare,
    RULES: RULES, CATALOGUE: CATALOGUE, istKey: istKey, readings: readings,
  };
})(window.KT);
