/* ============================================================================
   Forecast.

   The old engine produced one number for the end of the horizon. This produces
   a path with a time axis, because "where will it be" is a different question
   at 10:30 and at 15:15, and the honest answer to both is a range with a
   probability attached rather than a price.

   Seven lanes feed a directional bias, each normalised to -1..+1:

     news         recency and impact weighted sentiment from the RSS stream
     seasonal     month, weekday and expiry-week effects from ~19 years
     momentum     trend and RSI position against the moving averages
     global       overnight cues: US futures, crude, dollar, rupee, US 10y
     structure    measured moves from triangles, flags, double tops
     levels       how much room there is to the nearest wall on each side
     flow         breadth and FII/DII when the workflow has them

   The average shape of the session is an eighth input but not an eighth lane:
   it enters as a drift term through dayShape(), carries no weight in CONFIG,
   and cannot swing the bias on its own.

   Three things make the band trustworthy rather than decorative:

   1. Volatility is a term structure, not one number. An index is far noisier
      in the first thirty minutes than at lunch, so variance is accumulated
      bucket by bucket across the clock. A flat sigma*sqrt(t) band is too wide
      at noon and far too narrow at the open.

   2. Drift is not linear. News decays, so its push lands early; seasonality is
      a whole-session effect, so it accrues evenly. The path is shaped by that
      rather than by an arbitrary easing curve.

   3. The band is scored against what actually happened. calibrate() walks the
      series and reports how often price really finished inside the 68% band.
      If that number is not near 68, the band is wrong, and the panel says so
      instead of hiding it.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;

  var IMPACT_W = { high: 3, medium: 2, low: 1 };

  /* Normal CDF - Abramowitz and Stegun 7.1.26, plenty for a probability we
     round to whole percent. */
  function ncdf(z) {
    var t = 1 / (1 + 0.2316419 * Math.abs(z));
    var d = 0.3989423 * Math.exp(-z * z / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  function istMinutes(epochSec) {
    var d = core.fmt.ist(epochSec);
    return d.getHours() * 60 + d.getMinutes();
  }
  function istDayKey(epochSec) {
    var d = core.fmt.ist(epochSec);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  /* ------------------------------------------------------- session clock
     A projection has to walk market time, not wall-clock time. Adding one bar
     width repeatedly puts a 5-minute forecast at 16:13 on a market that shut
     at 15:30, and puts a daily forecast on Sunday. Both make the "where will
     it be at X" answer meaningless, which is the one thing the panel exists
     for. So the step function skips the overnight gap and the weekend.

     Exchange holidays are not modelled - there is no free holiday feed in the
     repo, and being one session out in a month-ahead projection is a smaller
     error than being fourteen hours out in an intraday one. */
  var OPEN_MIN = C.market.regular.from, CLOSE_MIN = C.market.regular.to;

  function isWeekend(d) { return C.market.weekdays.indexOf(d.getDay()) === -1; }

  function nextSessionOpen(epochSec) {
    var d = core.fmt.ist(epochSec);
    var day = epochSec;
    do {
      day += 86400;
      d = core.fmt.ist(day);
    } while (isWeekend(d));
    var mins = d.getHours() * 60 + d.getMinutes();
    return day + (OPEN_MIN - mins) * 60;
  }

  function advance(epochSec, barSec) {
    if (barSec >= 604800) return epochSec + barSec;
    if (barSec >= 86400) {
      var t = epochSec;
      do { t += 86400; } while (isWeekend(core.fmt.ist(t)));
      return t;
    }
    var next = epochSec + barSec;
    var nd = core.fmt.ist(next);
    var m = nd.getHours() * 60 + nd.getMinutes();
    if (isWeekend(nd) || m > CLOSE_MIN) {
      var over = Math.max(0, (m - CLOSE_MIN) * 60);
      if (isWeekend(nd)) over = 0;
      return nextSessionOpen(epochSec) + over;
    }
    if (m < OPEN_MIN) {
      // A bar stamped before the open belongs to this session's first slot.
      return next + (OPEN_MIN - m) * 60;
    }
    return next;
  }

  /* ==================================================== volatility profile
     Per-bar variance bucketed by time of day. Returns a lookup from clock
     minute to a multiplier on the average bar variance, so the band can widen
     at the open and tighten into the lunch lull. Falls back to a flat profile
     when the series is daily or there is too little intraday history. */
  function volProfile(candles, barSec) {
    var flat = { intraday: false, mult: function () { return 1; }, base: 0 };
    if (!candles || candles.length < 60 || barSec >= 86400) return flat;

    var bucketMin = barSec >= 3600 ? 60 : 30;
    var sums = {}, counts = {}, all = [];
    for (var i = 1; i < candles.length; i++) {
      var prev = candles[i - 1].close;
      if (!prev) continue;
      var r = (candles[i].close - prev) / prev * 100;
      if (!isFinite(r)) continue;
      var b = Math.floor(istMinutes(candles[i].time) / bucketMin);
      sums[b] = (sums[b] || 0) + r * r;
      counts[b] = (counts[b] || 0) + 1;
      all.push(r * r);
    }
    if (all.length < 40) return flat;
    var base = all.reduce(function (s, x) { return s + x; }, 0) / all.length;
    if (!base) return flat;

    /* The upper bound used to be 4. Measured on the live NIFTY 5-minute series
       the 09:15-09:29 bucket runs at 13.196x the average bar variance - the
       overnight gap lands in that first bar - so clamping to 4 made the band
       sqrt(13.196/4) = 1.8x too narrow at the open, every session, which is
       the single worst-calibrated moment of the day. The lower bound hit too:
       the 12:30 bucket's true multiplier is 0.257 against a floor of 0.3.

       The clamp exists to stop one freak session defining a bucket, and that
       job is done by the counts[b] < 5 guard above and by the median-style
       trim below. So the bounds widen to what the data actually shows, and a
       bucket that lands outside them is recorded rather than flattened. */
    var mult = {};
    Object.keys(sums).forEach(function (b) {
      if (counts[b] < 5) return;                       // too thin to trust
      mult[b] = core.clamp((sums[b] / counts[b]) / base, 0.15, 20);
    });
    if (Object.keys(mult).length < 3) return flat;

    return {
      intraday: true, bucketMin: bucketMin, base: base, table: mult,
      mult: function (epochSec) {
        var b = Math.floor(istMinutes(epochSec) / bucketMin);
        return mult[b] === undefined ? 1 : mult[b];
      },
    };
  }

  /* ================================================= time-of-day drift
     The average path the session actually walks. Computed as the mean
     cumulative return from the open, by clock minute, across complete
     sessions. This is the part that answers "as per time" directly. */
  function dayShape(candles, barSec) {
    if (!candles || barSec >= 86400 || candles.length < 120) return null;
    var bucketMin = barSec >= 3600 ? 60 : 30;
    var sessions = {}, order = [];
    candles.forEach(function (c) {
      var k = istDayKey(c.time);
      if (!sessions[k]) { sessions[k] = []; order.push(k); }
      sessions[k].push(c);
    });
    var usable = order.filter(function (k) { return sessions[k].length >= 6; });
    if (usable.length < 3) return null;

    var sums = {}, counts = {};
    usable.forEach(function (k) {
      var day = sessions[k], open = day[0].open || day[0].close;
      if (!open) return;
      day.forEach(function (c) {
        var b = Math.floor(istMinutes(c.time) / bucketMin);
        var cum = (c.close - open) / open * 100;
        sums[b] = (sums[b] || 0) + cum;
        counts[b] = (counts[b] || 0) + 1;
      });
    });
    var table = {};
    Object.keys(sums).forEach(function (b) {
      if (counts[b] >= Math.max(3, usable.length * 0.4)) table[b] = sums[b] / counts[b];
    });
    if (Object.keys(table).length < 4) return null;
    return {
      bucketMin: bucketMin, sessions: usable.length, table: table,
      at: function (epochSec) {
        var b = Math.floor(istMinutes(epochSec) / bucketMin);
        return table[b] === undefined ? null : table[b];
      },
    };
  }

  /* ========================================================== the lanes */
  function newsLane(items, opts) {
    opts = opts || {};
    var now = Date.now() / 1000, halfLife = opts.halfLifeSec || 21600;
    var region = opts.region || null;
    var num = 0, den = 0, counted = 0, high = 0, top = null, topW = 0;
    (items || []).forEach(function (n) {
      if (region && n.region !== region) return;
      var age = Math.max(0, now - n.ts);
      if (age > 172800) return;
      var w = IMPACT_W[n.impact] * Math.pow(0.5, age / halfLife);
      if (w <= 0.01) return;
      num += n.sentiment * w; den += w; counted++;
      if (n.impact === 'high') high++;
      var strength = Math.abs(n.sentiment) * IMPACT_W[n.impact] * Math.pow(0.5, age / halfLife);
      if (strength > topW) { topW = strength; top = n; }
    });
    if (!den) return { score: 0, n: 0, high: 0, top: null, raw: 0, hasData: false };
    var raw = num / den;
    return { score: core.clamp(raw / 2.5, -1, 1), raw: raw, n: counted, high: high, top: top, hasData: true };
  }

  function lastThursday(year, monthIdx) {
    var last = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
    for (var d = last; d >= 1; d--) if (new Date(Date.UTC(year, monthIdx, d)).getUTCDay() === 4) return d;
    return last;
  }

  function seasonalLane(seasonality, whenIst) {
    if (!seasonality || !seasonality.months) return { score: 0, note: 'no seasonal data', month: null, hasData: false };
    var d = whenIst || core.fmt.ist();
    var month = seasonality.months.filter(function (m) { return m.m === d.getMonth() + 1; })[0];
    if (!month || !month.n) return { score: 0, note: 'no seasonal data', month: null, hasData: false };
    var byReturn = core.clamp(month.avg / 3, -1, 1);
    var byWin = core.clamp((month.win - 50) / 20, -1, 1);
    var s = byReturn * 0.6 + byWin * 0.4;
    var parts = [month.name + ' averages ' + core.fmt.pct(month.avg) + ' over ' + month.n +
                 ' years (' + month.win.toFixed(0) + '% positive)'];
    var dow = (seasonality.days_of_week || []).filter(function (x) { return x.d === (d.getDay() + 6) % 7; })[0];
    if (dow) { s += core.clamp(dow.avg / 0.12, -1, 1) * 0.12; parts.push(dow.name + ' averages ' + core.fmt.pct(dow.avg, 3)); }
    var ew = seasonality.expiry_week;
    if (ew && ew.n && Math.abs(d.getDate() - lastThursday(d.getFullYear(), d.getMonth())) <= 3) {
      s += core.clamp((ew.avg - ew.other_avg) / 0.1, -1, 1) * 0.1;
      parts.push('expiry week (avg ' + core.fmt.pct(ew.avg, 3) + ' vs ' + core.fmt.pct(ew.other_avg, 3) + ')');
    }
    return { score: core.clamp(s, -1, 1), note: parts.join(', '), month: month, hasData: true };
  }

  function momentumLane(snap, candles) {
    if (!snap) return { score: 0, note: 'not enough history', hasData: false };
    var price = snap.price, bits = [];
    var s = 0, w = 0;
    if (snap.ema20) { s += core.clamp((price - snap.ema20) / snap.ema20 * 100 / 1.2, -1, 1) * 0.28; w += 0.28;
                      bits.push('price ' + (price >= snap.ema20 ? 'above' : 'below') + ' 20 EMA'); }
    if (snap.ema50) { s += core.clamp((price - snap.ema50) / snap.ema50 * 100 / 2.5, -1, 1) * 0.18; w += 0.18; }
    if (snap.rsi != null) { s += core.clamp((snap.rsi - 50) / 25, -1, 1) * 0.22; w += 0.22;
                            bits.push('RSI ' + snap.rsi.toFixed(0)); }
    if (snap.macdHist != null && snap.atr) { s += core.clamp(snap.macdHist / (snap.atr * 0.5), -1, 1) * 0.16; w += 0.16;
                            bits.push('MACD ' + (snap.macdHist >= 0 ? 'above' : 'below') + ' signal'); }
    if (snap.supertrendDir) { s += snap.supertrendDir * 0.16; w += 0.16;
                            bits.push('supertrend ' + (snap.supertrendDir > 0 ? 'long' : 'short')); }
    // ADX does not pick a side; it says how much to believe the side already
    // chosen. A trendless tape gets its momentum vote cut.
    var conviction = snap.adx == null ? 0.75 : core.clamp(snap.adx / 30, 0.35, 1.25);
    if (snap.adx != null) bits.push('ADX ' + snap.adx.toFixed(0));
    return { score: core.clamp((w ? s / w : 0) * conviction, -1, 1), note: bits.join(', '), adx: snap.adx, hasData: w > 0 };
  }

  /* Global cues, read from data/global.json when the workflow has produced it.
     Each instrument votes with a sign that reflects how it maps onto Indian
     equities: crude up and dollar up are headwinds, US futures up is a
     tailwind. Falls back to international news sentiment when absent. */
  var GLOBAL_MAP = {
    us_futures: { w: 0.26, sign: 1, label: 'US futures' },
    sgx_nifty: { w: 0.24, sign: 1, label: 'GIFT / SGX Nifty' },
    crude: { w: 0.14, sign: -1, label: 'Crude' },
    usdinr: { w: 0.14, sign: -1, label: 'USD/INR' },
    dxy: { w: 0.10, sign: -1, label: 'Dollar index' },
    us10y: { w: 0.06, sign: -1, label: 'US 10y' },
    gold: { w: 0.06, sign: -1, label: 'Gold' },
  };

  function globalLane(cues, newsGlobal) {
    if (!cues || !cues.items) {
      return { score: newsGlobal ? newsGlobal.score : 0,
               note: newsGlobal && newsGlobal.n ? (newsGlobal.n + ' international headlines') : 'no global data',
               parts: [], hasData: !!(newsGlobal && newsGlobal.n) };
    }
    var s = 0, w = 0, parts = [];
    Object.keys(GLOBAL_MAP).forEach(function (k) {
      var row = cues.items[k];
      if (!row || row.changePct == null) return;
      var m = GLOBAL_MAP[k];
      // A 1% move in a cue is a full-strength vote from that cue.
      var v = core.clamp(row.changePct / 1.0, -1.5, 1.5) * m.sign;
      s += v * m.w; w += m.w;
      parts.push({ label: m.label, changePct: row.changePct, contribution: Math.round(v * m.w * 1000) / 1000 });
    });
    if (!w) return { score: newsGlobal ? newsGlobal.score : 0, note: 'no global data', parts: [], hasData: !!(newsGlobal && newsGlobal.n) };
    var blended = core.clamp(s / w, -1, 1);
    // Overnight prices are hard evidence; global headlines are colour. Weight
    // accordingly rather than averaging them as equals.
    if (newsGlobal && newsGlobal.n > 4) blended = blended * 0.78 + newsGlobal.score * 0.22;
    parts.sort(function (a, b) { return Math.abs(b.contribution) - Math.abs(a.contribution); });
    var lead = parts[0];
    return {
      score: blended, parts: parts, hasData: true,
      note: lead ? (lead.label + ' ' + core.fmt.pct(lead.changePct) +
                    (parts[1] ? ', ' + parts[1].label + ' ' + core.fmt.pct(parts[1].changePct) : '')) : 'global cues flat',
    };
  }

  /* Room to run. Price pinned under a wall it has failed at four times is not
     the same setup as price in clear air, whatever the momentum says. */
  function levelsLane(lv, price, atr) {
    if (!lv || !price) return { score: 0, note: 'no levels', hasData: false };
    var up = lv.nearestResistance, dn = lv.nearestSupport;
    if (!up && !dn) return { score: 0, note: 'no level nearby', hasData: false };
    var a = atr || price * 0.004;
    var dUp = up ? (up.level - price) / a : 8;
    var dDn = dn ? (price - dn.level) / a : 8;
    // More headroom than floor-room leans up, and vice versa.
    var s = core.clamp((dUp - dDn) / 6, -1, 1);
    // With only one side found, the comparison is against a guess. Halve the
    // vote rather than letting an absent level read as a maximum signal.
    if (!up || !dn) s *= 0.5;
    var note = [];
    if (up) note.push('resistance ' + core.fmt.price(up.level) + ' (' + up.touches + ' touches, ' + core.fmt.pct(up.distPct, 1) + ')');
    if (dn) note.push('support ' + core.fmt.price(dn.level) + ' (' + dn.touches + ' touches, ' + core.fmt.pct(dn.distPct, 1) + ')');
    return { score: s, note: note.join(', '), up: up, down: dn, atrToUp: dUp, atrToDown: dDn, hasData: true };
  }

  function flowLane(flows) {
    if (!flows) return { score: 0, note: 'no flow data', hasData: false };
    var s = 0, w = 0, bits = [];
    if (flows.breadth && (flows.breadth.advances + flows.breadth.declines) > 0) {
      var b = flows.breadth, tot = b.advances + b.declines;
      s += core.clamp((b.advances - b.declines) / tot / 0.5, -1, 1) * 0.5; w += 0.5;
      bits.push(b.advances + ' advancing vs ' + b.declines + ' declining');
    }
    if (flows.fii && flows.fii.netCr != null) {
      s += core.clamp(flows.fii.netCr / 3000, -1, 1) * 0.3; w += 0.3;
      bits.push('FII net ' + core.fmt.signed(flows.fii.netCr, 0) + ' cr');
    }
    if (flows.dii && flows.dii.netCr != null) {
      s += core.clamp(flows.dii.netCr / 3000, -1, 1) * 0.2; w += 0.2;
      bits.push('DII net ' + core.fmt.signed(flows.dii.netCr, 0) + ' cr');
    }
    if (!w) return { score: 0, note: 'no flow data', hasData: false };
    return { score: core.clamp(s / w, -1, 1), note: bits.join(', '), hasData: true };
  }

  /* ====================================================== the band, once

     build() and calibrate() used to draw this twice, and they drifted: the
     chart showed a band built from a GARCH term structure, the intraday
     volatility profile and a calibrated multiplier, while the accuracy panel
     scored a flat stdev(rets)*sqrt(t) band with a fixed 1.15 on it. The panel
     was therefore reporting the coverage of a model nobody could see, and the
     number it printed said nothing about the band on screen.

     One function now, called by both. The only thing a caller varies is where
     the drift comes from - which is the part that genuinely differs, because
     the news, global and flow lanes cannot be replayed historically. The
     variance, the profile, the multiplier and the level tempering are shared
     by construction and cannot diverge again. */
  function bandPath(cfg) {
    var path = [], upper = [], lower = [], upper2 = [], lower2 = [];
    var cumVar = 0, t = cfg.lastCandle.time;
    var useProfile = cfg.vp && cfg.vp.intraday;
    for (var k = 1; k <= cfg.bars; k++) {
      t = advance(t, cfg.barSec);
      var frac = k / cfg.bars;

      // accumulated variance with the intraday profile applied bar by bar
      cumVar += (cfg.varPath ? cfg.varPath[k - 1] : Math.pow(cfg.sigmaBlend, 2)) *
                (useProfile ? cfg.vp.mult(t) : 1);
      var sd = Math.sqrt(cumVar);

      var driftPct = core.clamp(cfg.drift(k, frac, t), -cfg.capPct, cfg.capPct);
      // A wall does not stop price, it slows it. Beyond a level with a real
      // record, the remaining drift is halved rather than cut off, which keeps
      // the path continuous and still reflects the resistance.
      var mid = temper(cfg.lastClose * (1 + driftPct / 100), cfg.lastClose, cfg.lv);

      var band1 = cfg.lastClose * sd / 100 * cfg.z68;
      var band2 = cfg.lastClose * sd / 100 * cfg.z95;
      path.push({ time: t, value: r2(mid) });
      upper.push({ time: t, value: r2(mid + band1) });
      lower.push({ time: t, value: r2(mid - band1) });
      upper2.push({ time: t, value: r2(mid + band2) });
      lower2.push({ time: t, value: r2(mid - band2) });
    }
    return { path: path, upper: upper, lower: lower, upper2: upper2, lower2: lower2 };
  }

  /* Everything the band needs that is not the drift: the profile, the fitted
     variance model, its forward path and its calibrated multipliers. Built the
     same way for a live forecast and for a replay, from whatever history it is
     handed - so a replay cannot accidentally see the future through a profile
     fitted on the whole series. */
  /* One slot, because build() is the only caller that repeats. The page polls
     once a second while the market is open and every one of those ticks used
     to refit the whole variance model - measured at 462ms on a 600-bar window,
     which is half a second of blocked main thread per second of market. The
     fit only changes when a new bar closes, so that is exactly what the key
     is. calibrate() walks distinct histories and misses on purpose. */
  var volCache = { key: null, value: null };

  function volContext(hist, barSec, bars, vix, opts) {
    opts = opts || {};
    var lastBar = hist.length ? hist[hist.length - 1] : null;
    var cacheKey = lastBar ? [barSec, bars, hist.length, lastBar.time, lastBar.close,
                              vix || 0, opts.conformal ? opts.conformal.z68 : 0].join(':') : null;
    if (cacheKey && volCache.key === cacheKey) return volCache.value;
    /* Fitting on every bar ever loaded is not more accurate, only slower, and
       on a 1651-bar series it measured 1292ms against 16ms on 300 - the
       optimiser needs far more iterations to satisfy a longer likelihood, so
       the cost is worse than linear. A GARCH's memory is short by construction
       (persistence 0.988 on this series has a half-life of about 57 bars), so
       history beyond a few hundred bars contributes almost nothing to the
       current variance and a great deal to the wait. */
    var MAX_FIT_BARS = opts.maxFitBars || 600;
    if (hist.length > MAX_FIT_BARS) hist = hist.slice(hist.length - MAX_FIT_BARS);
    var vp = volProfile(hist, barSec);
    var rets = [];
    for (var i = Math.max(1, hist.length - 120); i < hist.length; i++) {
      var pv = hist[i - 1].close;
      if (pv) rets.push((hist[i].close - pv) / pv);
    }
    var sigmaBar = stdev(rets) * 100;

    var volModel = null;
    try {
      if (KT.vol) volModel = KT.vol.model(hist, { profile: vp.intraday ? vp.mult : null, minBars: 80 });
    } catch (e) { volModel = null; }
    if (volModel && !(volModel.sigma2 && volModel.sigma2.length)) volModel = null;
    if (volModel) {
      var fitted = Math.sqrt(volModel.sigma2[volModel.sigma2.length - 1]);
      if (fitted > 0 && isFinite(fitted)) sigmaBar = fitted;
    }
    if (!(sigmaBar > 0)) sigmaBar = 0.25;

    var vixBar = null;
    if (vix && vix > 3) {
      var barsPerYear = 365.25 * 24 * 3600 / barSec;
      if (barSec < 86400) barsPerYear = 252 * (6.25 * 3600 / barSec);
      vixBar = vix / Math.sqrt(barsPerYear);
    }
    var vixWeight = volModel && volModel.kind !== 'ewma' ? 0.25 : 0.4;
    var sigmaBlend = vixBar ? (sigmaBar * (1 - vixWeight) + vixBar * vixWeight) : sigmaBar;

    var varPath = null;
    if (volModel) {
      try {
        var fwd = KT.vol.forecastPath(volModel, bars,
          volModel.rv[volModel.rv.length - 1], volModel.rets[volModel.rets.length - 1]);
        if (fwd && fwd.length === bars && fwd[0] > 0) {
          var k0 = Math.pow(sigmaBlend, 2) / fwd[0];
          varPath = fwd.map(function (v) { return v * k0; });
        }
      } catch (e) { varPath = null; }
    }

    var z68 = C.forecast.coneVolMultiplier, z95 = C.forecast.coneVolMultiplier * 1.96;
    var zBasis = 'fixed multiplier (no fitted model)';
    if (volModel && volModel.z68 && volModel.z68.z > 0) {
      z68 = volModel.z68.z;
      z95 = volModel.z95 && volModel.z95.z > 0 ? volModel.z95.z : z68 * 1.96;
      zBasis = volModel.z68.basis + ', ' + volModel.z68.n + ' one-bar residuals';
    }

    /* The multiplier above is calibrated on ONE-BAR standardised residuals,
       and the band it is used for spans seventy-five. Those are different
       distributions: a horizon error accumulates drift error and model error
       on top of the variance, so the one-bar quantile is systematically too
       small. Replayed properly the first version of this covered 45% against
       a nominal 68% - Kupiec p=0.034, a real failure, not noise.

       So the horizon multiplier is calibrated at the horizon, by split
       conformal prediction: score every past replay by |actual - forecast|
       divided by the band's own sigma, and take the quantile of those scores.
       That is distribution-free and needs no assumption about the shape of
       the horizon error at all. calibrate() produces it; this uses it as soon
       as it exists, and falls back to the one-bar number before then while
       saying which it used. */
    if (opts.conformal && opts.conformal.z68 > 0) {
      z68 = opts.conformal.z68;
      z95 = opts.conformal.z95 > 0 ? opts.conformal.z95 : z68 * 1.96;
      zBasis = 'split conformal at the ' + bars + '-bar horizon, ' +
               opts.conformal.n + ' replays';
    }
    var out = {
      vp: vp, volModel: volModel, sigmaBar: sigmaBar, sigmaBlend: sigmaBlend,
      vixBar: vixBar, varPath: varPath, z68: z68, z95: z95, zBasis: zBasis,
      rets: rets,
    };
    if (cacheKey) { volCache.key = cacheKey; volCache.value = out; }
    return out;
  }

  /* ============================================================ the build */
  function build(ctx) {
    var candles = ctx.candles || [], items = ctx.news || [], tfKey = ctx.timeframe;
    var tf = C.timeframes[tfKey];
    if (!candles.length || !tf) return null;

    var lastCandle = candles[candles.length - 1];
    var lastClose = lastCandle.close;
    if (ctx.livePrice && lastClose && Math.abs(ctx.livePrice - lastClose) / lastClose < 0.025) {
      lastClose = ctx.livePrice;
      lastCandle.close = ctx.livePrice;
      lastCandle.high = Math.max(lastCandle.high, ctx.livePrice);
      lastCandle.low = Math.min(lastCandle.low, ctx.livePrice);
    }

    var snap = ctx.indicators || KT.ind.snapshot(candles);
    var lv = ctx.levels || null;
    var structs = ctx.structures || [];
    var atr = (snap && snap.atr) || lastClose * 0.004;

    var nAll = newsLane(items);
    var nGlobal = newsLane(items, { region: 'international', halfLifeSec: 43200 });
    var seasonal = seasonalLane(ctx.seasonality);
    var mom = momentumLane(snap, candles);
    var glob = globalLane(ctx.global, nGlobal);
    var struct = KT.structures.impliedBias(structs, lastClose, ctx.structureStats);
    var lvl = levelsLane(lv, lastClose, atr);
    var flow = flowLane(ctx.flows);

    var shape = dayShape(candles, tf.barSec);

    var W = C.forecast.weights;
    var lanes = [
      { id: 'news', label: 'News flow', score: nAll.score, weight: W.news, hasData: nAll.hasData,
        note: nAll.n ? (nAll.n + ' scored headlines, ' + nAll.high + ' high impact') : 'no headlines yet' },
      { id: 'seasonal', label: 'Seasonal', score: seasonal.score, weight: W.seasonal, note: seasonal.note, hasData: seasonal.hasData },
      { id: 'momentum', label: 'Momentum', score: mom.score, weight: W.momentum, note: mom.note, hasData: mom.hasData },
      { id: 'global', label: 'Global cue', score: glob.score, weight: W.global, note: glob.note, hasData: glob.hasData },
      { id: 'structure', label: 'Chart structure', score: struct.score, weight: W.structure, hasData: struct.hasData,
        note: struct.note || 'no structure in play' },
      { id: 'levels', label: 'Room to run', score: lvl.score, weight: W.levels, note: lvl.note, hasData: lvl.hasData },
      { id: 'flow', label: 'Flows and breadth', score: flow.score, weight: W.flow, note: flow.note, hasData: flow.hasData },
    ];

    /* Lanes with no data must not drag the bias toward zero. Renormalise over
       the lanes that actually reported. hasData means the lane received input,
       not that it formed an opinion - a lane that read forty headlines and
       concluded neutral is live and belongs in the denominator.

       This was a regex over each lane's own English note until 18 Sep 2026, so
       rewording a note silently changed the bias. It also read the news lane as
       live when it was dark, because the fallback string "no headlines yet"
       contains "headlines" and matched the pattern meant to detect the opposite.
       The heaviest lane in CONFIG (0.24) therefore voted a hard zero whenever
       the RSS sweep came back empty, instead of dropping out. */
    var live = lanes.filter(function (l) { return l.hasData; });
    var wsum = live.reduce(function (s, l) { return s + l.weight; }, 0) || 1;
    var bias = core.clamp(live.reduce(function (s, l) { return s + l.score * l.weight; }, 0) / wsum, -1, 1);
    lanes.forEach(function (l) { l.contribution = Math.round(l.score * l.weight / wsum * 1000) / 1000; });

    /* ---------------------------------------------------- regime -------- */
    var rets = [];
    for (var i = Math.max(1, candles.length - 120); i < candles.length; i++) {
      var pv = candles[i - 1].close;
      if (pv) rets.push((candles[i].close - pv) / pv);
    }
    var ac1 = autocorr(rets, 1);
    // Negative lag-1 autocorrelation means the tape is fading its own moves,
    // so a drift projection should be trimmed. Positive means it follows on.
    var persistence = core.clamp(1 + ac1 * 1.6, 0.45, 1.5);


    var bars = Math.max(6, Math.round(tf.visibleBars * tf.forecastRatio));
    if (tf.maxForecastBars) bars = Math.min(bars, tf.maxForecastBars);

    /* ---------------------------------------------------- volatility -----
       The intraday profile, the fitted model, the VIX blend, the forward
       variance and the calibrated multipliers all come from one place that
       calibrate() also calls. That is the point: the band scored in the
       accuracy panel is now the band drawn on the chart, by construction
       rather than by two pieces of code agreeing to stay in step. */
    var vc = volContext(candles, tf.barSec, bars, ctx.vix, { conformal: ctx.conformal || null });
    var vp = vc.vp, volModel = vc.volModel;
    var sigmaBar = vc.sigmaBar, sigmaBlend = vc.sigmaBlend, vixBar = vc.vixBar;
    var varPath = vc.varPath, z68 = vc.z68, z95 = vc.z95, zBasis = vc.zBasis;

    /* ---------------------------------------------------- drift shape ----
       News pushes early and fades; seasonality accrues evenly; structure
       pulls toward its measured target late, once the break has had time to
       happen. Splitting them means the path bends the way the inputs actually
       behave instead of following one arbitrary curve. */
    var newsPart = (nAll.score * W.news + glob.score * W.global) / wsum;
    var evenPart = (seasonal.score * W.seasonal + mom.score * W.momentum +
                    lvl.score * W.levels + flow.score * W.flow) / wsum;
    var structPart = (struct.score * W.structure) / wsum;

    var horizonSigma = sigmaBlend * Math.sqrt(bars);
    var scale = horizonSigma * 1.1 * persistence;
    var capPct = C.forecast.maxDriftPctPerBar * bars;

    /* Adaptive conformal inference over what the ledger has actually settled.
       Inert until there are rows, and it says so rather than pretending. */
    var aciState = null;
    try {
      if (KT.vol && KT.ledger && KT.ledger.missRecord) {
        aciState = KT.vol.aci(0.68, KT.ledger.missRecord(ctx.symbol, tfKey, 68));
        if (aciState && aciState.active) {
          // Widen or tighten to the coverage the record says is honest.
          var zTarget = KT.vol.tquantile((1 + aciState.coverageAdapted) / 2, volModel ? volModel.df : 6);
          var zNominal = KT.vol.tquantile(0.84, volModel ? volModel.df : 6);
          if (zNominal > 0) { z68 *= zTarget / zNominal; z95 *= zTarget / zNominal; }
        }
      }
    } catch (e) { aciState = null; }

    var checkpoints = [];
    var newsHalfBars = Math.max(2, bars * 0.35);

    var drawn = bandPath({
      lastCandle: lastCandle, lastClose: lastClose, bars: bars, barSec: tf.barSec,
      sigmaBlend: sigmaBlend, varPath: varPath, vp: vp, z68: z68, z95: z95,
      lv: lv, capPct: capPct,
      drift: function (k, frac, t) {
        var newsDecay = 1 - Math.pow(0.5, k / newsHalfBars);   // front-loaded
        var structRamp = Math.pow(frac, 1.4);                  // back-loaded
        var d = (newsPart * newsDecay + evenPart * frac + structPart * structRamp) * scale;
        // The clock's own average path, where there is enough history for it.
        // Four sessions of shape is an anecdote and twenty is a pattern, so the
        // contribution is scaled by how many sessions went into it rather than
        // trusted flat.
        if (shape) {
          var sv = shape.at(t), s0 = shape.at(lastCandle.time);
          if (sv !== null && s0 !== null) {
            d += (sv - s0) * 0.35 * core.clamp(shape.sessions / 15, 0.15, 1);
          }
        }
        return d;
      },
    });
    var path = drawn.path, upper = drawn.upper, lower = drawn.lower,
        upper2 = drawn.upper2, lower2 = drawn.lower2;

    /* ------------------------------------------------- historical analogue
       A drift formula draws a smooth line because it is a smooth formula. Here
       we ask the series itself: when did the chart last look like it looks now,
       and what happened next? The average of those real forward paths carries
       the texture that a formula cannot, so the projection gains genuine ups
       and downs rather than a clean curve.

       The model keeps the direction and the magnitude. The analogue only lends
       its wiggle, and only in proportion to how well it actually matches - a
       weak match barely moves the line. */
    var analog = null;
    try {
      if (KT.analogs && candles.length > bars * 3) {
        analog = KT.analogs.find(candles, {
          window: Math.max(10, Math.round(bars * 0.6)),
          horizon: bars,
          k: 8,
        });
        if (analog && analog.ok && analog.quality > 5) {
          var shaped = KT.analogs.shape(path, analog, lastClose, 0.55);
          // The bands travel with the path, otherwise the cone detaches from
          // the line it is supposed to be describing.
          for (var sIdx = 0; sIdx < shaped.length; sIdx++) {
            var delta = shaped[sIdx].value - path[sIdx].value;
            upper[sIdx].value = r2(upper[sIdx].value + delta);
            lower[sIdx].value = r2(lower[sIdx].value + delta);
            upper2[sIdx].value = r2(upper2[sIdx].value + delta);
            lower2[sIdx].value = r2(lower2[sIdx].value + delta);
          }
          path = shaped;
        }
      }
    } catch (e) {
      analog = null;
    }

    /* -------------------------------------------- component projections
       The blended path above answers "where does everything, together, point".
       It does not answer the two questions actually worth asking separately:
       what does the news alone imply, and what does the chart's own history
       alone imply. When those two disagree, that disagreement is the signal -
       a bullish tape into bearish headlines is a different situation from both
       pointing the same way, and one line cannot show it.

       Same machinery, same volatility, same level tempering. Only the drift
       source changes, so the three are directly comparable. */
    function component(parts) {
      var out = [], tc = lastCandle.time, cv = 0;
      for (var j = 1; j <= bars; j++) {
        tc = advance(tc, tf.barSec);
        var fr = j / bars;
        cv += (varPath ? varPath[j - 1] : Math.pow(sigmaBlend, 2)) * (vp.intraday ? vp.mult(tc) : 1);
        var nd = 1 - Math.pow(0.5, j / newsHalfBars);
        var sr = Math.pow(fr, 1.4);
        var d = ((parts.news || 0) * nd + (parts.even || 0) * fr + (parts.struct || 0) * sr) * scale;
        d = core.clamp(d, -capPct, capPct);
        out.push({ time: tc, value: r2(temper(lastClose * (1 + d / 100), lastClose, lv)) });
      }
      return out;
    }

    // News and the global cue: what the flow of information implies on its own.
    var newsOnly = (nAll.score * W.news + glob.score * W.global) / wsum;
    // Chart structure, momentum and room to the next level: what the price
    // record implies on its own, with no headline input at all.
    var patternOnly = (struct.score * W.structure + mom.score * W.momentum +
                       lvl.score * W.levels) / wsum;

    var pathNews = component({ news: newsOnly });
    var pathPattern = component({ struct: (struct.score * W.structure) / wsum,
                                  even: (mom.score * W.momentum + lvl.score * W.levels) / wsum });

    var endNews = pathNews.length ? pathNews[pathNews.length - 1].value : lastClose;
    var endPat = pathPattern.length ? pathPattern[pathPattern.length - 1].value : lastClose;
    var agreeSign = (endNews - lastClose) * (endPat - lastClose);
    var componentSummary = {
      news: {
        bias: r2(newsOnly), end: endNews,
        changePct: r2((endNews - lastClose) / lastClose * 100),
        note: nAll.n ? nAll.n + ' scored headlines, ' + nAll.high + ' high impact'
                     : 'no headlines scored yet',
      },
      pattern: {
        bias: r2(patternOnly), end: endPat,
        changePct: r2((endPat - lastClose) / lastClose * 100),
        note: [struct.note, mom.note].filter(Boolean).join('; ') || 'no structure read',
      },
      // The honest headline: do the two stories agree, and by how much do they
      // differ at the end of the horizon.
      agree: agreeSign > 0 ? 'agree' : (agreeSign < 0 ? 'conflict' : 'flat'),
      gapPct: r2(Math.abs(endNews - endPat) / lastClose * 100),
    };

    /* ------------------------------------------------------ checkpoints
       The answer to "where will it be at X". Five points across the horizon,
       each with the expected level, the 68% range and the probability of
       finishing above the current price. */
    var marks = pickCheckpoints(bars);
    marks.forEach(function (k2) {
      var idx = k2 - 1;
      if (idx < 0 || idx >= path.length) return;
      var mid = path[idx].value, band = mid - lower[idx].value;
      var sd = band / z68;
      var z = sd > 0 ? (mid - lastClose) / sd : 0;
      checkpoints.push({
        time: path[idx].time,
        label: timeLabel(path[idx].time, tf.barSec),
        value: mid,
        low: lower[idx].value, high: upper[idx].value,
        low95: lower2[idx].value, high95: upper2[idx].value,
        changePct: r2((mid - lastClose) / lastClose * 100),
        pUp: Math.round(ncdf(z) * 100),
        bars: k2,
      });
    });

    /* ------------------------------------------------------- confidence */
    var scores = live.map(function (l) { return l.score; });
    var agreement = core.clamp(1 - stdevOf(scores) / 0.9, 0, 1);
    var coverage = core.clamp(nAll.n / 40, 0.25, 1);
    var strength = core.clamp(Math.abs(bias) / 0.5, 0.2, 1);
    var trendiness = snap && snap.adx != null ? core.clamp(snap.adx / 35, 0.3, 1) : 0.6;
    var confidence = Math.round(
      C.forecast.minConfidence + (C.forecast.maxConfidence - C.forecast.minConfidence) *
      (agreement * 0.38 + coverage * 0.16 + strength * 0.26 + trendiness * 0.20)
    );

    var endMid = path.length ? path[path.length - 1].value : lastClose;
    var direction = bias > 0.08 ? 'BULLISH' : bias < -0.08 ? 'BEARISH' : 'RANGE-BOUND';

    return {
      timeframe: tfKey,
      horizonLabel: horizonLabel(tf, bars),
      bias: Math.round(bias * 1000) / 1000,
      direction: direction,
      confidence: core.clamp(confidence, C.forecast.minConfidence, C.forecast.maxConfidence),
      lastClose: r2(lastClose),
      target: endMid,
      targetPct: r2((endMid - lastClose) / lastClose * 100),
      rangeLow: lower.length ? lower[lower.length - 1].value : lastClose,
      rangeHigh: upper.length ? upper[upper.length - 1].value : lastClose,
      forecastBars: bars,
      volPerBar: Math.round(sigmaBlend * 1000) / 1000,
      volRealised: Math.round(sigmaBar * 1000) / 1000,
      volImplied: vixBar ? Math.round(vixBar * 1000) / 1000 : null,
      /* What produced the band, so the panel can show its working rather than
         asserting a width. Null volModel means vol.js could not fit and the
         old realised-vol path ran - which is a fact worth displaying, not
         hiding behind a number that looks the same either way. */
      volModel: volModel ? {
        kind: volModel.kind,
        omega: r2(volModel.omega * 10000) / 10000,
        alpha: Math.round(volModel.alpha * 1000) / 1000,
        beta: Math.round(volModel.beta * 1000) / 1000,
        gamma: Math.round((volModel.gamma || 0) * 1000) / 1000,
        df: Math.round(volModel.df * 10) / 10,
        persistence: Math.round((volModel.effectivePersistence != null ? volModel.effectivePersistence : volModel.persistence) * 1000) / 1000,
        qlike: Math.round(volModel.qlike * 10000) / 10000,
        deseasonalised: !!volModel.deseasonalised,
        rangeBars: volModel.used ? volModel.used.range : null,
        fallbackBars: volModel.used ? volModel.used.fallback : null,
        candidates: volModel.candidates || null,
        reason: volModel.reason || null,
      } : null,
      z68: Math.round(z68 * 1000) / 1000,
      z95: Math.round(z95 * 1000) / 1000,
      zBasis: zBasis,
      aci: aciState,
      persistence: Math.round(persistence * 100) / 100,
      autocorr: Math.round(ac1 * 1000) / 1000,
      intradayProfile: vp.intraday,
      dayShapeSessions: shape ? shape.sessions : 0,
      lanes: lanes,
      path: path, upper: upper, lower: lower, upper2: upper2, lower2: lower2,
      pathNews: pathNews, pathPattern: pathPattern, components: componentSummary,
      analog: analog,
      checkpoints: checkpoints,
      topNews: nAll.top,
      seasonMonth: seasonal.month,
      rsi: snap ? snap.rsi : null,
      structure: struct.target || null,
      globalParts: glob.parts || [],
      narrative: narrate(direction, lanes, nAll, checkpoints, lastClose),
      generatedAt: Date.now(),
    };
  }

  function temper(mid, from, lv) {
    if (!lv) return mid;
    var wall = mid > from ? lv.nearestResistance : lv.nearestSupport;
    if (!wall || wall.touches < 2) return mid;
    var beyond = mid > from ? mid - wall.level : wall.level - mid;
    if (beyond <= 0) return mid;
    var damp = core.clamp(1 - wall.touches * 0.12, 0.3, 0.7);
    return mid > from ? wall.level + beyond * damp : wall.level - beyond * damp;
  }

  /* The close at or immediately before a time.

     calibrate() used to read its outcome from candles[at + bars], on the
     assumption that advancing the clock by `bars` bar-widths lands on the bar
     `bars` indices later. It does not. A NIFTY session holds 75 five-minute
     bars but spans 74 intervals, so on the 1D view the band ended at 15:30 on
     the day it was drawn while index at+75 was the *next* day's 09:15 open.
     Measured over the loaded series, 19 of 20 replay endpoints disagreed, by a
     median of 213 bars.

     That mattered more than an off-by-one usually does, because the gap being
     skipped over is the overnight one - the 09:15 bucket runs at 13.2x the
     average bar variance. Coverage was being scored against a price one
     overnight jump beyond where the band actually ended, which made the band
     look far too narrow and would have had the conformal step widening it to
     cover an error the model never made.

     The band's time axis is what the chart draws and what horizonLabel
     describes, so the time axis is authoritative and the outcome is read at
     the time the band ends. */
  function closeAtTime(candles, t) {
    if (!candles || !candles.length || candles[0].time > t) return null;
    var lo = 0, hi = candles.length - 1, best = null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (candles[mid].time <= t) { best = candles[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best ? best.close : null;
  }

  function pickCheckpoints(bars) {
    var want = [Math.round(bars * 0.15), Math.round(bars * 0.3), Math.round(bars * 0.5),
                Math.round(bars * 0.75), bars];
    var seen = {}, out = [];
    want.forEach(function (k) { k = Math.max(1, k); if (!seen[k]) { seen[k] = 1; out.push(k); } });
    return out;
  }

  function timeLabel(epochSec, barSec) {
    var d = core.fmt.ist(epochSec);
    var hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (barSec < 86400) {
      var today = core.fmt.ist();
      var sameDay = d.getDate() === today.getDate() && d.getMonth() === today.getMonth();
      return sameDay ? hhmm : core.fmt.dayShort(epochSec) + ' ' + hhmm;
    }
    if (barSec < 604800) return core.fmt.dayShort(epochSec);
    return core.fmt.stamp(epochSec, barSec);
  }

  function horizonLabel(tf, bars) {
    // Counted in market time, so a 32-bar daily projection reads as 32 trading
    // sessions rather than the calendar month those sessions happen to span.
    // barSec is the measured spacing, not the declared one, so a series the
    // provider quietly downgraded is still described correctly.
    if (tf.barSec >= 2419200) {                       // monthly bars
      return bars < 18 ? bars + ' months' : Math.round(bars / 12 * 10) / 10 + ' years';
    }
    if (tf.barSec >= 604800) {                        // weekly bars
      return bars < 9 ? bars + ' weeks' : Math.round(bars / 4.3) + ' months';
    }
    if (tf.barSec >= 86400) {
      return bars < 45 ? bars + ' trading days' : Math.round(bars / 21) + ' months';
    }
    var mins = bars * tf.barSec / 60;
    if (mins < 75) return Math.round(mins) + ' minutes';
    var sessionMins = CLOSE_MIN - OPEN_MIN;
    if (mins <= sessionMins) return (Math.round(mins / 30) / 2) + ' hours';
    return Math.round(mins / sessionMins * 10) / 10 + ' sessions';
  }

  function narrate(direction, lanes, news, checkpoints, price) {
    var ranked = lanes.slice().filter(function (l) { return Math.abs(l.contribution) > 0.001; })
      .sort(function (a, b) { return Math.abs(b.contribution) - Math.abs(a.contribution); });
    var lead = ranked[0], second = ranked[1];
    var verb = direction === 'BULLISH' ? 'leans up' : direction === 'BEARISH' ? 'leans down' : 'has no clear lean';
    var s = 'The balance ' + verb + '. ';
    if (lead) {
      s += 'Strongest input is ' + lead.label.toLowerCase() + ' (' + lead.note + ')';
      if (second) {
        var agrees = (second.score > 0) === (lead.score > 0);
        s += (agrees ? ', supported by ' : ', pulled against by ') + second.label.toLowerCase() +
             ' (' + second.note + ')';
      }
      s += '. ';
    }
    var lastCp = checkpoints[checkpoints.length - 1];
    if (lastCp) {
      s += 'By ' + lastCp.label + ' the centre of the range is ' + core.fmt.price(lastCp.value) +
           ' (' + core.fmt.pct(lastCp.changePct) + '), with about a ' + lastCp.pUp +
           '% chance of trading above ' + core.fmt.price(price) + '. ';
    }
    if (news.top) s += 'Loudest headline: "' + news.top.headline.slice(0, 110) + '" (' + news.top.source + ').';
    return s;
  }

  /* ========================================================= calibration

     Walk the series, rebuild the band from data available at that bar, and
     check whether the future actually landed inside it.

     Two things were wrong with the version this replaces, and both flattered
     the model.

     First, it scored a band nobody could see. It built a flat
     stdev(rets)*sqrt(t) cone with a fixed 1.15 multiplier, while the chart drew
     a band shaped by the intraday volatility profile, a fitted variance model
     and a calibrated multiplier. The coverage number therefore described a
     model that does not exist. It now calls volContext() and bandPath() - the
     same two functions build() calls - so the thing scored is the thing drawn.

     Second, it counted the same evidence several times. The step was a third
     of the horizon, so consecutive replays shared two thirds of their window
     and their outcomes were strongly correlated. Measured on the 1D timeframe
     that turned about 15 independent observations into a reported 45, and the
     confidence interval that follows from 45 is roughly half as wide as the
     truth. Windows are now non-overlapping by default, and the overlapping
     count is reported alongside so the difference is visible rather than
     silently absorbed.

     Only the lanes that exist historically are used. There is no archive of
     the RSS stream, so news, global and flow cannot be replayed - together
     that is 47% of the model's weight, and the result is labelled as the
     technical core rather than the full model. Reporting a number that peeked
     at today's news would defeat the point. */
  function calibrate(candles, tfKey, opts, onDone) {
    opts = opts || {};
    var tf = C.timeframes[tfKey];
    if (!candles || candles.length < 200 || !tf) return null;
    var bars = Math.max(6, Math.round(tf.visibleBars * tf.forecastRatio));
    if (tf.maxForecastBars) bars = Math.min(bars, tf.maxForecastBars);

    /* Overlapping windows for the estimate, deflated sample size for the
       interval. This is the fix for the thing that made every number on this
       panel meaningless.

       Non-overlapping windows gave an honest n but only about twenty of them,
       and twenty is not enough: shifting the replay grid by five bars on the
       same series moved the direction rate from 33.3% to 92.3% and the
       conformal band multiplier from 0.738 to 1.642. The panel was reporting
       where the grid happened to start.

       Overlapping windows do not bias the estimate - every window is a valid
       replay - they only make it look more precise than it is. So all of them
       feed the point estimates and the conformal quantile, and every interval
       and significance test is computed on the effective sample size instead:

           nEff = nWindows * step / bars

       which is how many genuinely independent horizons the evidence covers.
       The panel shows both, because a reader who sees only the large number
       will over-read it, and a reader who sees only the small one will think
       the estimate is noisier than it is. */
    var step = opts.step || Math.max(1, Math.round(bars / 5));
    var warm = Math.max(150, bars * 2);
    if (candles.length < warm + bars + 1) return null;

    var W = C.forecast.weights;
    var wsum = W.momentum + W.levels + W.structure + W.seasonal;
    var capPct = C.forecast.maxDriftPctPerBar * bars;

    var in68 = 0, in95 = 0, n = 0, dirRight = 0, dirCalls = 0, scores = [];
    var absErr = 0, naiveErr = 0, crpsSum = 0, crpsN = 0;
    var missRecord = [], fits = 0, budgetMs = 0, laneUsed = {};
    var windowIdx = 0, lastVc = null, VOL_REFIT_EVERY = opts.volRefitEvery || 5;
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    /* The loop still steps by index because that is how the history is
       walked, but a window is only usable if its *time* endpoint is loaded.
       The margin is generous: one session of daily bars spans fewer indices
       than bar-widths, never more. */
    function runWindow(at) {
      var hist = candles.slice(0, at + 1);
      var last = hist[hist.length - 1];
      var price = last.close;
      if (!(price > 0)) return;

      var snap = KT.ind.snapshot(hist);
      if (!snap) return;

      /* Everything below is built from hist only. A profile or a variance model
         fitted on the whole series would be reading the future through the back
         door, and would be the single easiest way to make this number look
         good while meaning nothing. */
      /* The variance fit is almost all of the cost here - measured at 216ms a
         window against about 2ms for everything else - and conditional
         volatility does not turn over in fifteen bars. Refitting every fifth
         window keeps the five-fold increase in sample size roughly free. The
         reused model is still re-anchored to each window's own last bar
         through forecastPath(), so what carries over is the shape of the
         variance process, not a stale level. */
      var vc;
      if (windowIdx % VOL_REFIT_EVERY === 0 || !lastVc) {
        vc = volContext(hist, tf.barSec, bars, null,
          { conformal: opts.conformal || null, maxFitBars: opts.maxFitBars || 300 });
        fits++;
        lastVc = vc;
      } else {
        vc = lastVc;
      }
      windowIdx++;

      var ac = autocorr(vc.rets, 1);
      var persistence = core.clamp(1 + ac * 1.6, 0.45, 1.5);
      var shape = dayShape(hist, tf.barSec);

      var lv = KT.levels.build(hist);
      var mom = momentumLane(snap, hist);
      var lvl = levelsLane(lv, price, snap.atr);
      var seasonal = seasonalLane(opts.seasonality, core.fmt.ist(last.time));
      var structs = [];
      try { structs = KT.structures.detect(hist) || []; } catch (e) { structs = []; }
      var struct = KT.structures.impliedBias(structs, price, opts.structureStats);

      var liveW = 0;
      if (mom.hasData) { liveW += W.momentum; laneUsed.momentum = 1; }
      if (lvl.hasData) { liveW += W.levels; laneUsed.levels = 1; }
      if (struct.hasData) { liveW += W.structure; laneUsed.structure = 1; }
      if (seasonal.hasData) { liveW += W.seasonal; laneUsed.seasonal = 1; }
      if (!liveW) return;

      var evenPart = ((mom.hasData ? mom.score * W.momentum : 0) +
                      (lvl.hasData ? lvl.score * W.levels : 0) +
                      (seasonal.hasData ? seasonal.score * W.seasonal : 0)) / liveW;
      var structPart = (struct.hasData ? struct.score * W.structure : 0) / liveW;
      var bias = core.clamp(evenPart + structPart, -1, 1);

      var scale = vc.sigmaBlend * Math.sqrt(bars) * 1.1 * persistence;

      var drawn = bandPath({
        lastCandle: last, lastClose: price, bars: bars, barSec: tf.barSec,
        sigmaBlend: vc.sigmaBlend, varPath: vc.varPath, vp: vc.vp,
        z68: vc.z68, z95: vc.z95, lv: lv, capPct: capPct,
        drift: function (k, frac, t) {
          var d = (evenPart * frac + structPart * Math.pow(frac, 1.4)) * scale;
          if (shape) {
            var sv = shape.at(t), s0 = shape.at(last.time);
            if (sv !== null && s0 !== null) {
              d += (sv - s0) * 0.35 * core.clamp(shape.sessions / 15, 0.15, 1);
            }
          }
          return d;
        },
      });

      var idx = drawn.path.length - 1;
      var mid = drawn.path[idx].value;
      var lo68 = drawn.lower[idx].value, hi68 = drawn.upper[idx].value;
      var lo95 = drawn.lower2[idx].value, hi95 = drawn.upper2[idx].value;
      /* Read the outcome at the time the band ends, not at an index offset.
         See closeAtTime(). A replay whose endpoint falls past the last loaded
         candle is dropped rather than scored against the nearest thing to
         hand. */
      var endTime = drawn.path[idx].time;
      if (endTime > candles[candles.length - 1].time) return;
      var actual = closeAtTime(candles, endTime);
      if (!(actual > 0)) return;

      var inside68 = actual >= lo68 && actual <= hi68;
      if (inside68) in68++;
      if (actual >= lo95 && actual <= hi95) in95++;
      missRecord.push(inside68 ? 0 : 1);

      absErr += Math.abs(actual - mid) / price * 100;
      naiveErr += Math.abs(actual - price) / price * 100;

      /* Split-conformal nonconformity score: how many band-sigmas away the
         outcome actually landed. The quantile of these is the multiplier that
         would have given exactly the coverage asked for. */
      var sdBand = (mid - lo68) / (vc.z68 || 1);
      if (sdBand > 0) scores.push(Math.abs(actual - mid) / sdBand);

      // CRPS scores the whole band, which a hit rate cannot: it rewards a
      // sharp forecast that was right and refuses to reward a wide one that
      // merely failed to be wrong.
      if (KT.vol && KT.vol.crpsGaussian) {
        var sdPrice = (mid - lo68) / (vc.z68 || 1);
        var sc = KT.vol.crpsGaussian(actual, mid, sdPrice);
        if (sc != null && isFinite(sc)) { crpsSum += sc / price * 100; crpsN++; }
      }

      if (Math.abs(bias) > 0.08) {
        dirCalls++;
        if ((actual > price) === (bias > 0)) dirRight++;
      }
      n++;
    }

    /* Straight through when no callback is given - that is the path the tests
       take and it keeps the function easy to reason about. With a callback,
       the same windows run in slices with a yield between them.

       The yield is not a nicety. Ninety-six windows measured just under five
       seconds, all of it inside one macrotask, and the page polls the live
       price every second: without slicing, the chart stops repainting and the
       price stops ticking for five seconds every time this runs. */

    /* Everything after the walk, as a closure over the counters above, so the
       straight-through driver and the sliced one cannot produce two different
       summaries. Same reason bandPath() exists. */
    function finish() {
    budgetMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;

    if (n < 8) return null;

    /* How many independent horizons this evidence really covers. Every
       interval below is computed on this, not on n. */
    var nEff = Math.max(1, Math.round(n * step / bars));
    var effHits68 = Math.round(in68 / n * nEff);
    var effHits95 = Math.round(in95 / n * nEff);

    var k68 = KT.vol ? KT.vol.kupiec(effHits68, nEff, 0.68) : null;
    var k95 = KT.vol ? KT.vol.kupiec(effHits95, nEff, 0.95) : null;

    /* Conformal quantile with the finite-sample correction: the k-th smallest
       score where k = ceil((n+1) * coverage). When k exceeds n the sample
       cannot certify that coverage at all, and the honest answer is null
       rather than the largest score pretending to be a 95% quantile. */
    function conformalQ(coverage) {
      if (!scores.length) return null;
      var s = scores.slice().sort(function (a, b) { return a - b; });
      var k = Math.ceil((s.length + 1) * coverage);
      return k > s.length ? null : s[k - 1];
    }
    var cz68 = conformalQ(0.68), cz95 = conformalQ(0.95);

    /* Wilson interval on the direction rate. The point estimate on its own has
       been the most over-read number on this panel: 57.8% of 45 reads like an
       edge and its interval runs from 43.3% to 71.0%, which contains a coin. */
    var dirCallsEff = Math.max(1, Math.round(dirCalls * step / bars));
    var dirCi = null;
    if (dirCallsEff >= 5) {
      var ph = dirRight / dirCalls, z = 1.96, den = 1 + z * z / dirCallsEff;
      var centre = ph + z * z / (2 * dirCallsEff);
      var margin = z * Math.sqrt(ph * (1 - ph) / dirCallsEff + z * z / (4 * dirCallsEff * dirCallsEff));
      dirCi = [Math.round((centre - margin) / den * 1000) / 10,
               Math.round((centre + margin) / den * 1000) / 10];
    }

    return {
      /* n is how many replays ran; nEff is how many independent horizons they
         cover. Every interval on this object uses nEff. Showing only n would
         overstate the evidence by exactly the factor the windows overlap. */
      n: n, nEff: nEff, bars: bars, step: step,
      overlapFraction: Math.round((1 - step / bars) * 100),
      directionCallsEff: dirCallsEff,
      coverage68: Math.round(in68 / n * 1000) / 10,
      coverage95: Math.round(in95 / n * 1000) / 10,
      kupiec68: k68, kupiec95: k95,
      mae: Math.round(absErr / n * 1000) / 1000,
      naiveMae: Math.round(naiveErr / n * 1000) / 1000,
      // Below 1 the model beats "tomorrow equals today", which is a much
      // harder benchmark than it sounds on a near random walk.
      skill: Math.round(absErr / (naiveErr || 1) * 1000) / 1000,
      crps: crpsN ? Math.round(crpsSum / crpsN * 1000) / 1000 : null,
      directionCalls: dirCalls,
      directionRight: dirRight,
      directionRate: dirCalls ? Math.round(dirRight / dirCalls * 1000) / 10 : null,
      directionCi: dirCi,
      /* The direction rate is only worth acting on if its interval clears the
         break-even after costs, not merely 50%. This says whether it clears
         50% at all, which is the weaker of the two tests and still usually
         fails at these sample sizes. */
      directionSignificant: !!(dirCi && dirCi[0] > 50),
      /* The conformal quantile is the one number that genuinely benefits from
         every window: it is a quantile, not a rate, so overlap costs it
         precision but not validity, and averaging over five times as many
         windows is what stops the band width swinging by a factor of two on a
         five-bar shift of the grid. */
      conformalWindows: scores.length,
      missRecord: missRecord,
      /* Feed this straight back into the next build(): it is the multiplier
         that would have delivered the coverage the band claims. */
      conformal: (cz68 > 0) ? {
        z68: Math.round(cz68 * 1000) / 1000,
        z95: cz95 > 0 ? Math.round(cz95 * 1000) / 1000 : null,
        n: n,
        certifies95: cz95 != null,
      } : null,
      fits: fits, elapsedMs: Math.round(budgetMs),
      volModel: null,
      /* Name the lanes that actually voted, not the ones that could have.
         seasonality and the pattern hit-rate table are only passed in when the
         caller supplies them, and describing a lane as scored when it sat out
         is the same class of error as the regex that used to decide liveness. */
      lanesUsed: Object.keys(laneUsed),
      basis: (function () {
        var used = Object.keys(laneUsed);
        var usedW = used.reduce(function (t, k) { return t + (W[k] || 0); }, 0);
        var missing = ['news', 'momentum', 'global', 'structure', 'seasonal', 'levels', 'flow']
          .filter(function (k) { return !laneUsed[k]; });
        return 'replayed with ' + (used.join(', ') || 'no lanes') + ' - ' +
               Math.round(usedW * 100) + '% of the model weight. ' +
               'Unscored here: ' + missing.join(', ') + '. ' +
               'News, global and flow cannot be replayed at all because no archive of the feed ' +
               'exists yet; the rest sit out when the caller does not supply their inputs. ' +
               'Pattern hit rates and seasonal averages are deliberately not passed in, because ' +
               'both are computed over the whole series and would let the replay see its own future';
      })(),
    };
    }

    var at = warm;
    if (typeof onDone !== 'function') {
      for (; at + bars < candles.length; at += step) runWindow(at);
      return finish();
    }
    var SLICE = opts.slice || 6;
    (function chunk() {
      var budget = SLICE;
      while (budget-- > 0 && at + bars < candles.length) { runWindow(at); at += step; }
      if (at + bars < candles.length) { setTimeout(chunk, 0); return; }
      onDone(finish());
    })();
    return null;
  }
  /* ------------------------------------------------------------- helpers */
  function r2(n) { return Math.round(n * 100) / 100; }
  function stdev(a) {
    if (!a || a.length < 2) return 0;
    var m = a.reduce(function (s, x) { return s + x; }, 0) / a.length;
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / a.length);
  }
  function stdevOf(a) { return stdev(a); }
  function autocorr(a, lag) {
    if (!a || a.length < lag + 8) return 0;
    var m = a.reduce(function (s, x) { return s + x; }, 0) / a.length;
    var num = 0, den = 0;
    for (var i = 0; i < a.length; i++) {
      den += (a[i] - m) * (a[i] - m);
      if (i >= lag) num += (a[i] - m) * (a[i - lag] - m);
    }
    return den ? num / den : 0;
  }

  KT.forecast = {
    build: build, calibrate: calibrate,
    newsLane: newsLane, seasonalLane: seasonalLane, momentumLane: momentumLane,
    globalLane: globalLane, levelsLane: levelsLane, flowLane: flowLane,
    volProfile: volProfile, dayShape: dayShape, ncdf: ncdf,
    bandPath: bandPath, volContext: volContext, advance: advance,
  };
})(window.KT);
