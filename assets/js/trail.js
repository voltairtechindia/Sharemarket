/* ============================================================================
   Prediction trail.

   The forecast line used to vanish the moment its time came. What was drawn
   at 10:00 for 11:00 was recomputed at 10:01, again at 10:02, and by 11:00
   there was no record anywhere on the chart of what the line had said - so
   the one question a reader actually asks of a prediction, "how close did it
   land", could not be answered by looking.

   The trail keeps that line. For a chosen lead L, the trail point at bar t is
   the value the forecast made L bars earlier drew for t. Laid over the
   candles it is a thin line the price either meets or does not, and the gap
   between them at every bar is the error - printed, coloured and averaged.

   Two sources, kept apart because they are not the same evidence:

     replay   rebuilt from history, bar by bar, using only the candles that
              existed at the moment each prediction claims to have been made.
              Available the instant the page loads. It is the same technical
              core calibrate() scores - momentum, room to the next level,
              chart structure and the session's own clock - because news,
              global cues and flows cannot be replayed (nothing archived them
              before 18 Sep 2026). It is a backtest and is labelled as one.

     live     written down in this browser by the full model - every lane,
              the opening gap, the analogue - at the moment it was made, and
              never rewritten. First write wins per bar: a forecast that could
              be updated after the fact would be a model marking its own
              homework, which is the failure ledger.lock() exists to prevent.
              Only this kind is a forward record.

   Everything is joined to the actual close BY TIME, never by index - the rule
   closeAtTime() was written for. A session holds 75 five-minute bars across
   74 intervals, so "L indices later" and "L bars later on the clock" are not
   the same bar across the overnight gap.

   Honest about what this shows. On a short lead a predicted line hugs the
   price whatever the model does, because it starts from the last price - a
   "no change" guess hugs it too. So the number that means something is not
   how close the line looks but how it compares with that flat guess, and the
   panel prints that comparison next to every average.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;

  /* ---------------------------------------------------------------- leads */
  function leads(tfKey) {
    return ((C.trail && C.trail.leads[tfKey]) || [{ bars: 1, label: '1 bar' }]).slice();
  }
  function defaultLead(tfKey) {
    var d = C.trail && C.trail.defaultLead[tfKey];
    return d || leads(tfKey)[0].bars;
  }
  function leadLabel(tfKey, bars) {
    var hit = leads(tfKey).filter(function (l) { return l.bars === bars; })[0];
    return hit ? hit.label : bars + ' bars';
  }

  /* The horizon the replayed forecast is drawn over. Same formula calibrate()
     uses, so the trail and the accuracy panel are scoring one model. */
  function horizonBars(tf, lead) {
    var bars = Math.max(6, Math.round(tf.visibleBars * tf.forecastRatio));
    if (tf.maxForecastBars) bars = Math.min(bars, tf.maxForecastBars);
    return Math.max(bars, lead || 1);
  }

  function r2(n) { return Math.round(n * 100) / 100; }
  function r3(n) { return Math.round(n * 1000) / 1000; }

  /* ------------------------------------------------------ causal series
     Every momentum input is a recursive indicator - EMA, Wilder RSI, MACD,
     ADX, supertrend, ATR - whose value at bar i depends only on bars 0..i.
     Computing them once over the whole series and reading index i is
     therefore exactly what snapshot(candles.slice(0, i + 1)) returns, at a
     fraction of the cost: one pass instead of one per replayed bar.
     selftest.js asserts the two agree, because "exactly" is a claim. */
  function seriesFor(candles) {
    var closes = candles.map(function (c) { return c.close; });
    var m = KT.ind.macd(candles), a = KT.ind.adx(candles), st = KT.ind.supertrend(candles);
    return {
      rsi: KT.ind.rsi(candles, 14), macdHist: m.hist, adx: a.adx, stDir: st.dir,
      atr: KT.ind.atr(candles, 14), ema20: KT.ind.ema(closes, 20), ema50: KT.ind.ema(closes, 50),
    };
  }
  function snapAt(ser, i, price) {
    return {
      price: price, ema20: ser.ema20[i], ema50: ser.ema50[i], rsi: ser.rsi[i],
      macdHist: ser.macdHist[i], atr: ser.atr[i], supertrendDir: ser.stDir[i], adx: ser.adx[i],
    };
  }

  /* Nearest wall each side, the only part of levels.build() the levels lane
     and temper() read. zones() is the clustering; the pivots, Fibonacci and
     volume profile build() also computes are not inputs to the drift. */
  function levelsFrom(hist, price) {
    var z = [];
    try { z = KT.levels.zones(hist) || []; } catch (e) { z = []; }
    var above = null, below = null;
    for (var q = 0; q < z.length; q++) {
      var x = z[q];
      if (x.level > price && (!above || x.level < above.level)) above = x;
      if (x.level < price && (!below || x.level > below.level)) below = x;
    }
    return { nearestResistance: above, nearestSupport: below };
  }

  /* -------------------------------------------------- one replayed call
     What the technical core of the model would have drawn from bar i, using
     candles[0..i] and nothing else. Mirrors calibrate()'s runWindow line for
     line, with one difference stated plainly: the drift scale uses realised
     volatility over the last 120 bars rather than a refitted GARCH, because a
     fit costs ~500 ms and the trail needs hundreds of these. The level of the
     band is what that changes; its shape across the clock still comes from
     the session's own volatility profile. */
  function predictFrom(candles, ser, i, ctx) {
    var last = candles[i], price = last.close;
    if (!(price > 0)) return null;
    var snap = snapAt(ser, i, price);
    var hist = candles.slice(0, i + 1);

    var mom = KT.forecast.momentumLane(snap, null);
    var lv = levelsFrom(hist, price);
    var lvl = KT.forecast.levelsLane(lv, price, snap.atr);
    var structs = [];
    try { structs = KT.structures.detect(hist) || []; } catch (e) { structs = []; }
    var struct = KT.structures.impliedBias(structs, price, null);

    var W = C.forecast.weights, liveW = 0, lanes = 0;
    if (mom.hasData) { liveW += W.momentum; lanes++; }
    if (lvl.hasData) { liveW += W.levels; lanes++; }
    if (struct.hasData) { liveW += W.structure; lanes++; }
    var evenPart = 0, structPart = 0;
    if (liveW) {
      evenPart = ((mom.hasData ? mom.score * W.momentum : 0) +
                  (lvl.hasData ? lvl.score * W.levels : 0)) / liveW;
      structPart = (struct.hasData ? struct.score * W.structure : 0) / liveW;
    }

    var rets = [];
    for (var k = Math.max(1, i - 119); k <= i; k++) {
      var pv = candles[k - 1].close;
      if (pv) rets.push((candles[k].close - pv) / pv);
    }
    var sigma = KT.forecast.stdev(rets) * 100;
    if (!(sigma > 0)) sigma = 0.05;
    var persistence = core.clamp(1 + KT.forecast.autocorr(rets, 1) * 1.6, 0.45, 1.5);

    return {
      i: i, t0: last.time, price: price,
      evenPart: evenPart, structPart: structPart, lanes: lanes,
      bias: core.clamp(evenPart + structPart, -1, 1),
      sigma: sigma, scale: sigma * Math.sqrt(ctx.bars) * 1.1 * persistence,
      capPct: C.forecast.maxDriftPctPerBar * ctx.bars,
      lv: lv, vp: ctx.vp, shape: ctx.shape,
    };
  }

  /* The value the replayed line drew k bars ahead, plus its 68% half-width
     in percent, walking the same market clock bandPath() walks. */
  function valueAt(P, k, bars, barSec) {
    var t = P.t0, cumVar = 0;
    var useProfile = P.vp && P.vp.intraday;
    for (var s = 1; s <= k; s++) {
      t = KT.forecast.advance(t, barSec);
      cumVar += P.sigma * P.sigma * (useProfile ? P.vp.mult(t) : 1);
    }
    var frac = k / bars;
    var d = (P.evenPart * frac + P.structPart * Math.pow(frac, 1.4)) * P.scale;
    if (P.shape) {
      var sv = P.shape.at(t), s0 = P.shape.at(P.t0);
      if (sv !== null && s0 !== null) d += (sv - s0) * 0.35 * core.clamp(P.shape.sessions / 15, 0.15, 1);
    }
    d = core.clamp(d, -P.capPct, P.capPct);
    var mid = KT.forecast.temper(P.price * (1 + d / 100), P.price, P.lv);
    return { time: t, value: mid, sdPct: Math.sqrt(cumVar) };
  }

  /* Exact time lookup. A trail point is only drawn on a bar that exists:
     Lightweight Charts gives every distinct time its own slot, so a point at
     a time no candle carries would push a gap into the candles. */
  function indexAtTime(candles, t) {
    var lo = 0, hi = candles.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, mt = candles[mid].time;
      if (mt === t) return mid;
      if (mt < t) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  /* Grade one point against what printed. "On target" means inside the 68%
     range the line carried - the model's own statement of how close it
     expected to be - not a tolerance picked afterwards to look good. */
  function grade(pt, actual) {
    pt.a = actual;
    pt.e = r2(actual - pt.p);
    pt.ep = r3((actual - pt.p) / pt.b * 100);
    var half = pt.b * pt.sd / 100;
    pt.inside = Math.abs(actual - pt.p) <= half;
    pt.side = pt.inside ? 'on' : (actual > pt.p ? 'above' : 'below');
    var called = Math.abs(pt.p - pt.b) / pt.b * 100 > 0.02;
    pt.dir = called ? ((actual > pt.b) === (pt.p > pt.b)) : null;
    return pt;
  }

  /* ============================================================== replay */
  var cache = {};   // symbol:tf:lead -> { byMade: { madeTime: point }, fp: {} }

  function cacheKey(symbol, tfKey, lead) { return symbol + ':' + tfKey + ':' + lead; }

  function replay(candles, tfKey, opts, onDone) {
    opts = opts || {};
    var tf = C.timeframes[tfKey];
    var out = { lead: opts.lead || defaultLead(tfKey), points: [], ready: false, src: 'replay' };
    if (!tf || !candles || candles.length < (C.trail.warmBars + 10)) {
      out.ready = true; out.note = 'not enough history to replay';
      if (onDone) onDone(out);
      return out;
    }
    var L = out.lead, barSec = tf.barSec, bars = horizonBars(tf, L);
    var key = cacheKey(opts.symbol || 'NIFTY', tfKey, L);
    var store = cache[key] || (cache[key] = { byMade: {} });

    var n = candles.length;
    /* Which bars are closed. Yahoo appends the live quote as an extra point
       off the bar grid, and while the market is open the last on-grid bar is
       still forming; neither is a finished bar, so neither starts a
       prediction or settles one. Daily bars are stamped 09:15 IST, which is
       not a multiple of a day, so the grid test is intraday only. */
    var lastClosed = n - 1;
    if (barSec < 86400) {
      while (lastClosed > 0 && candles[lastClosed].time % barSec !== 0) lastClosed--;
    }
    if (opts.marketLive) lastClosed--;
    var span = Math.min(opts.span || 480, lastClosed - C.trail.warmBars);
    if (span < 5) {
      out.ready = true; out.note = 'not enough history to replay';
      if (onDone) onDone(out);
      return out;
    }
    var firstMade = Math.max(C.trail.warmBars, lastClosed - span - L);
    var ser = seriesFor(candles);
    var ctxCache = { at: -999, vp: null, shape: null };
    var longBars = barSec >= 604800;

    var i = firstMade;
    var t0 = Date.now();

    /* The cache holds predictions, never grades. A prediction made from a
       closed bar cannot change; the bar it is scored against can, while it is
       still forming, so every call grades afresh against the candles as they
       stand. Keyed on the made-at bar's time and close, so a provider that
       revises a bar invalidates exactly the prediction that read it. */
    function step(i2) {
      var made = candles[i2];
      var fp = made.time + ':' + made.close;
      var have = store.byMade[made.time];
      if (have && have.fp === fp) return;
      // The volatility profile and the session's average shape move slowly;
      // refitting them every ten bars rather than every bar is what keeps a
      // 480-point replay inside a couple of seconds of sliced work.
      if (i2 - ctxCache.at >= 10 || !ctxCache.vp) {
        var h = candles.slice(0, i2 + 1);
        ctxCache.vp = KT.forecast.volProfile(h, barSec);
        ctxCache.shape = KT.forecast.dayShape(h, barSec);
        ctxCache.at = i2;
      }
      var P = predictFrom(candles, ser, i2, { bars: bars, vp: ctxCache.vp, shape: ctxCache.shape });
      if (!P) return;

      var tgtTime, v = valueAt(P, L, bars, barSec);
      if (longBars) {
        // Weekly and monthly bars do not sit on a fixed clock - months run 28
        // to 31 days - so the target is the bar L places along, which for
        // these is the same bar the calendar would name.
        if (i2 + L >= n) return;
        tgtTime = candles[i2 + L].time;
      } else {
        tgtTime = v.time;
      }
      store.byMade[made.time] = {
        m: made.time, t: tgtTime, p: r2(v.value), b: made.close, sd: r3(v.sdPct),
        lanes: P.lanes, bias: r3(P.bias), src: 'replay', fp: fp,
      };
    }

    function finish() {
      var pts = [];
      var lo = candles[firstMade].time, hi = candles[lastClosed].time;
      Object.keys(store.byMade).forEach(function (k) {
        var raw = store.byMade[k];
        if (raw.m < lo || raw.m > hi) return;
        var p = { m: raw.m, t: raw.t, p: raw.p, b: raw.b, sd: raw.sd, lanes: raw.lanes,
                  bias: raw.bias, src: 'replay' };
        var idx = indexAtTime(candles, p.t);
        if (idx >= 0 && idx <= lastClosed) grade(p, candles[idx].close);
        else if (idx > lastClosed) p.pending = true;            // its bar is still forming
        else if (p.t <= candles[n - 1].time) return;             // a bar the feed skipped
        else p.future = true;                                     // lands after the last bar
        pts.push(p);
      });
      pts.sort(function (a, b) { return a.t - b.t; });
      out.points = pts;
      out.ready = true;
      out.ms = Date.now() - t0;
      out.method = 'walk-forward replay of the technical core (momentum, room to the next level, ' +
                   'chart structure, the session clock) using only candles that existed at each point';
      return out;
    }

    if (typeof onDone !== 'function') {
      for (; i <= lastClosed; i++) step(i);
      return finish();
    }
    var SLICE = opts.slice || 12;
    (function chunk() {
      var budget = SLICE;
      while (budget-- > 0 && i <= lastClosed) { step(i); i++; }
      if (i <= lastClosed) { setTimeout(chunk, 0); return; }
      onDone(finish());
    })();
    return out;
  }

  /* ================================================================ live
     The forward record. Written from the full live forecast at the moment it
     exists, keyed by the bar it was made in, and never overwritten - the
     first forecast of a bar is the one that counts, because "the last
     forecast before the bar closed" is a forecast that has already seen most
     of the bar. */
  function liveKey(symbol, tfKey, lead) { return 'trailLive:' + symbol + ':' + tfKey + ':' + lead; }

  function liveLoad(symbol, tfKey, lead) {
    var rows = core.store.get(liveKey(symbol, tfKey, lead), []);
    return Object.prototype.toString.call(rows) === '[object Array]' ? rows : [];
  }

  function slotOf(t, barSec) {
    // Intraday bars are stamped on a grid aligned to the epoch (09:15 IST is
    // 03:45 UTC, a multiple of five minutes), and a forming bar or a projected
    // point is read as the bar whose slot contains it.
    return barSec < 86400 ? Math.floor(t / barSec) * barSec : t;
  }

  function recordLive(f, ctx) {
    if (!f || !f.path || !f.path.length || !ctx || !ctx.lastTime) return 0;
    var tf = C.timeframes[f.timeframe];
    if (!tf) return 0;
    var made = slotOf(ctx.lastTime, tf.barSec);
    var wrote = 0;
    (ctx.leads || leads(f.timeframe).map(function (l) { return l.bars; })).forEach(function (L) {
      if (f.path.length < L) return;
      var pt = f.path[L - 1], lo = f.lower && f.lower[L - 1];
      if (!pt || !isFinite(pt.value)) return;
      var rows = liveLoad(ctx.symbol, f.timeframe, L);
      for (var q = rows.length - 1; q >= 0 && q >= rows.length - 5; q--) {
        if (rows[q].m === made) return;                 // first write wins
      }
      // The 68% half-width the live band carried at this lead, in percent -
      // the same quantity grade() compares the miss against for replay rows.
      var half = lo && lo.value != null ? Math.abs(pt.value - lo.value) / f.lastClose * 100 : null;
      rows.push({
        m: made, t: slotOf(pt.time, tf.barSec), p: r2(pt.value), b: f.lastClose,
        sd: half == null ? null : r3(half),
        dir: f.direction, at: Date.now(),
      });
      core.store.set(liveKey(ctx.symbol, f.timeframe, L), rows.slice(-C.trail.liveMax));
      wrote++;
    });
    return wrote;
  }

  /* Live rows joined to what printed. A row whose bar has not closed yet is
     returned as pending, so the chart can show where the line says price
     should be now. */
  function liveScored(symbol, tfKey, lead, candles, marketLive) {
    var rows = liveLoad(symbol, tfKey, lead);
    if (!rows.length || !candles || !candles.length) return [];
    var n = candles.length, last = candles[n - 1];
    var out = [];
    rows.forEach(function (r) {
      var idx = indexAtTime(candles, r.t);
      var pt = { m: r.m, t: r.t, p: r.p, b: r.b, sd: r.sd == null ? 0.1 : r.sd, src: 'live', at: r.at };
      if (idx < 0) {
        if (r.t > last.time) { pt.pending = true; pt.future = true; out.push(pt); }
        return;
      }
      var settled = idx < n - 1 || !marketLive;
      if (settled) grade(pt, candles[idx].close); else pt.pending = true;
      out.push(pt);
    });
    return out;
  }

  function clearLive(symbol) {
    var n = 0;
    try {
      var prefix = C.storage.prefix + 'trailLive:' + (symbol ? symbol + ':' : '');
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) keys.push(k);
      }
      keys.forEach(function (k) { localStorage.removeItem(k); n++; });
    } catch (e) { /* storage unavailable */ }
    return n;
  }

  function liveCount(symbol) {
    var n = 0;
    try {
      var prefix = C.storage.prefix + 'trailLive:' + (symbol ? symbol + ':' : '');
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) {
          var v = JSON.parse(localStorage.getItem(k) || '{}');
          n += (v && v.__v && v.__v.length) || 0;
        }
      }
    } catch (e) { /* storage unavailable */ }
    return n;
  }

  /* =============================================================== merge
     One line for the chart. Where this browser recorded a live point for a
     bar, that point is drawn - it is the stronger evidence - and the replay
     fills in everywhere else. The two are coloured apart and counted apart;
     merging them silently would let a backtest pass for a forward record. */
  function merge(replayPts, livePts) {
    var byT = {};
    (replayPts || []).forEach(function (p) { byT[p.t] = p; });
    (livePts || []).forEach(function (p) { if (!p.future) byT[p.t] = p; });
    return Object.keys(byT).map(function (k) { return byT[k]; })
      .sort(function (a, b) { return a.t - b.t; });
  }

  /* =============================================================== stats */
  function stats(points, lead) {
    var s = (points || []).filter(function (p) { return p.a != null; });
    var n = s.length;
    if (!n) return { n: 0 };
    var abs = 0, absPct = 0, naivePct = 0, signed = 0, inside = 0, above = 0, below = 0;
    var dirCalls = 0, dirRight = 0, worst = null, pcts = [];
    s.forEach(function (p) {
      abs += Math.abs(p.e);
      var ap = Math.abs(p.ep);
      absPct += ap; pcts.push(ap);
      signed += p.ep;
      naivePct += Math.abs(p.a - p.b) / p.b * 100;
      if (p.inside) inside++;
      else if (p.side === 'above') above++;
      else below++;
      if (p.dir != null) { dirCalls++; if (p.dir) dirRight++; }
      if (!worst || Math.abs(p.e) > Math.abs(worst.e)) worst = p;
    });
    pcts.sort(function (a, b) { return a - b; });
    var median = pcts[Math.floor(n / 2)];

    /* Consecutive trail points overlap: a one-hour lead on five-minute bars
       means each point shares eleven twelfths of its window with the next.
       The averages use every point; the interval on the direction rate uses
       the number of genuinely independent horizons, for the same reason
       calibrate() uses nEff. */
    var L = Math.max(1, lead || 1);
    var dirEff = Math.max(1, Math.round(dirCalls / L));
    var ci = null;
    if (dirCalls && dirEff >= 5) {
      var ph = dirRight / dirCalls, z = 1.96, den = 1 + z * z / dirEff;
      var centre = ph + z * z / (2 * dirEff);
      var margin = z * Math.sqrt(ph * (1 - ph) / dirEff + z * z / (4 * dirEff * dirEff));
      ci = [Math.round((centre - margin) / den * 1000) / 10, Math.round((centre + margin) / den * 1000) / 10];
    }
    return {
      n: n, nEff: Math.max(1, Math.round(n / L)),
      maePts: r2(abs / n), maePct: r3(absPct / n), medianPct: r3(median),
      biasPct: r3(signed / n),
      insideRate: Math.round(inside / n * 1000) / 10,
      above: above, below: below, inside: inside,
      dirCalls: dirCalls, dirRight: dirRight,
      dirRate: dirCalls ? Math.round(dirRight / dirCalls * 1000) / 10 : null,
      dirCi: ci, dirSignificant: !!(ci && ci[0] > 50),
      naivePct: r3(naivePct / n),
      // Below 1 the line beat "price stays where it was"; above 1 it did not.
      skill: naivePct ? r3(absPct / naivePct) : null,
      worst: worst ? { t: worst.t, e: worst.e, ep: worst.ep, src: worst.src } : null,
      first: s[0].t, last: s[n - 1].t,
    };
  }

  /* A plain sentence an investor can read without the panel's vocabulary.
     It says the unflattering parts in the same breath as the flattering
     ones, because a summary that only reports the average miss is reporting
     the one number a flat line also scores well on. */
  function verdict(st, leadText) {
    if (!st || !st.n) return 'Nothing to score yet on this lead.';
    var bits = [];
    bits.push('Drawn ' + leadText + ' ahead, the line has landed on average ' +
              core.fmt.price(st.maePts) + ' points (' + st.maePct.toFixed(2) + '%) from where price actually was, across ' +
              core.fmt.count(st.n) + ' bars.');
    bits.push(st.insideRate.toFixed(0) + '% of the time price finished inside the range the line carried (target 68%).');
    if (st.skill != null) {
      if (st.skill < 0.995) {
        bits.push('That is ' + Math.round((1 - st.skill) * 100) + '% closer than simply assuming no change.');
      } else if (st.skill > 1.005) {
        bits.push('That is ' + Math.round((st.skill - 1) * 100) + '% further off than simply assuming no change, ' +
                  'so on this lead a flat line would have done better.');
      } else {
        bits.push('That is no better or worse than assuming no change.');
      }
    }
    if (st.dirRate != null) {
      bits.push('Direction right ' + st.dirRate.toFixed(0) + '% of the time' +
                (st.dirCi ? ' (95% interval ' + st.dirCi[0].toFixed(0) + '–' + st.dirCi[1].toFixed(0) + '%' +
                            (st.dirSignificant ? ', clear of a coin)' : ', which still contains a coin)') : '') + '.');
    }
    return bits.join(' ');
  }

  KT.trail = {
    leads: leads, defaultLead: defaultLead, leadLabel: leadLabel, horizonBars: horizonBars,
    replay: replay, recordLive: recordLive, liveScored: liveScored, liveLoad: liveLoad,
    clearLive: clearLive, liveCount: liveCount,
    merge: merge, stats: stats, verdict: verdict,
    // exposed for selftest.js
    seriesFor: seriesFor, snapAt: snapAt, predictFrom: predictFrom, valueAt: valueAt,
    indexAtTime: indexAtTime, grade: grade, slotOf: slotOf,
    _cache: cache,
  };
})(window.KT);
