/* ============================================================================
   Engine: the seasonal study, the news-driven forecast, and the "why did it
   move here" reason points.

   The forecast is deliberately a *general* directional projection, not a price
   call. It blends four lanes, each normalised to -1..+1, then expresses the
   result as a fraction of a typical move over the horizon - so the projection
   can never run away from what the index actually does.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;

  var IMPACT_W = { high: 3, medium: 2, low: 1 };

  /* ------------------------------------------------------------ news lane
     Recency-weighted, impact-weighted mean sentiment. Half-life 6 hours, so a
     morning headline still counts at the close but a two-day-old one does not. */
  function newsScore(items, opts) {
    opts = opts || {};
    var now = Date.now() / 1000;
    var halfLife = opts.halfLifeSec || 21600;
    var region = opts.region || null;
    var num = 0, den = 0, counted = 0, high = 0, top = null, topW = 0;

    items.forEach(function (n) {
      if (region && n.region !== region) return;
      var age = Math.max(0, now - n.ts);
      if (age > 172800) return;
      var recency = Math.pow(0.5, age / halfLife);
      var w = IMPACT_W[n.impact] * recency;
      if (w <= 0.01) return;
      num += n.sentiment * w;
      den += w;
      counted++;
      if (n.impact === 'high') high++;
      var strength = Math.abs(n.sentiment) * IMPACT_W[n.impact] * recency;
      if (strength > topW) { topW = strength; top = n; }
    });

    if (!den) return { score: 0, n: 0, high: 0, top: null, raw: 0 };
    var raw = num / den;                       // -4..+4
    return { score: core.clamp(raw / 2.5, -1, 1), raw: raw, n: counted, high: high, top: top };
  }

  /* -------------------------------------------------------- seasonal lane
     Uses the real month-of-year table computed from ~19 years of Nifty
     closes, nudged by day-of-week and the expiry-week effect.               */
  function seasonalScore(seasonality, whenIst) {
    if (!seasonality || !seasonality.months) return { score: 0, note: 'no seasonal data', month: null };
    var d = whenIst || core.fmt.ist();
    var month = seasonality.months.filter(function (m) { return m.m === d.getMonth() + 1; })[0];
    if (!month || !month.n) return { score: 0, note: 'no seasonal data', month: null };

    // Average monthly return, normalised: +/-3% is a full-strength signal.
    var byReturn = core.clamp(month.avg / 3, -1, 1);
    // Win rate around a 50% coin flip, normalised: 50%+/-20pts is full strength.
    var byWin = core.clamp((month.win - 50) / 20, -1, 1);
    var s = byReturn * 0.6 + byWin * 0.4;

    var parts = [month.name + ' averages ' + core.fmt.pct(month.avg) + ' over ' + month.n + ' years (' + month.win.toFixed(0) + '% positive)'];

    var dow = (seasonality.days_of_week || []).filter(function (x) { return x.d === (d.getDay() + 6) % 7; })[0];
    if (dow) {
      s += core.clamp(dow.avg / 0.12, -1, 1) * 0.12;
      parts.push(dow.name + ' averages ' + core.fmt.pct(dow.avg, 3));
    }

    var ew = seasonality.expiry_week;
    if (ew && ew.n) {
      var lastThu = lastThursday(d.getFullYear(), d.getMonth());
      if (Math.abs(d.getDate() - lastThu) <= 3) {
        s += core.clamp((ew.avg - ew.other_avg) / 0.1, -1, 1) * 0.1;
        parts.push('expiry week (avg ' + core.fmt.pct(ew.avg, 3) + ' vs ' + core.fmt.pct(ew.other_avg, 3) + ' otherwise)');
      }
    }

    return { score: core.clamp(s, -1, 1), note: parts.join(', '), month: month };
  }

  function lastThursday(year, monthIdx) {
    var last = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
    for (var day = last; day >= 1; day--) {
      if (new Date(Date.UTC(year, monthIdx, day)).getUTCDay() === 4) return day;
    }
    return last;
  }

  /* -------------------------------------------------------- momentum lane */
  function sma(values, n) {
    if (values.length < n) return null;
    var s = 0;
    for (var i = values.length - n; i < values.length; i++) s += values[i];
    return s / n;
  }

  function momentumScore(candles) {
    if (!candles || candles.length < 25) return { score: 0, note: 'not enough history', rsi: null };
    var closes = candles.map(function (c) { return c.close; });
    var last = closes[closes.length - 1];
    var s20 = sma(closes, 20), s50 = sma(closes, Math.min(50, closes.length));

    var vsShort = s20 ? core.clamp((last - s20) / s20 * 100 / 1.5, -1, 1) : 0;
    var vsLong = s50 ? core.clamp((last - s50) / s50 * 100 / 3, -1, 1) : 0;

    // Wilder-style RSI on the last 14 closes.
    var gains = 0, losses = 0, span = Math.min(14, closes.length - 1);
    for (var i = closes.length - span; i < closes.length; i++) {
      var ch = closes[i] - closes[i - 1];
      if (ch >= 0) gains += ch; else losses -= ch;
    }
    var rs = losses === 0 ? 100 : gains / losses;
    var rsi = losses === 0 ? 100 : 100 - 100 / (1 + rs);
    var byRsi = core.clamp((rsi - 50) / 25, -1, 1);

    var score = vsShort * 0.42 + vsLong * 0.3 + byRsi * 0.28;
    var note = 'price ' + (last >= (s20 || last) ? 'above' : 'below') + ' 20-bar average, RSI ' + rsi.toFixed(0);
    return { score: core.clamp(score, -1, 1), note: note, rsi: rsi, sma20: s20, sma50: s50 };
  }

  /* -------------------------------------------------------- volatility */
  function volPerBarPct(candles, lookback) {
    if (!candles || candles.length < 12) return 0.5;
    var n = Math.min(lookback || 60, candles.length - 1), rets = [];
    for (var i = candles.length - n; i < candles.length; i++) {
      var prev = candles[i - 1].close;
      if (prev) rets.push((candles[i].close - prev) / prev * 100);
    }
    var v = core.stdev(rets);
    return v > 0 ? v : 0.5;
  }

  /* ---------------------------------------------------------- the forecast */
  function buildForecast(ctx) {
    var candles = ctx.candles, items = ctx.news, tfKey = ctx.timeframe;
    var tf = C.timeframes[tfKey];
    var W = C.forecast.weights;

    var nAll = newsScore(items);
    var nGlobal = newsScore(items, { region: 'international', halfLifeSec: 43200 });
    var seasonal = seasonalScore(ctx.seasonality);
    var mom = momentumScore(candles);

    var lanes = [
      { id: 'news',     label: 'News flow',  score: nAll.score,     weight: W.news,     note: nAll.n ? (nAll.n + ' scored headlines, ' + nAll.high + ' high impact') : 'no headlines yet' },
      { id: 'seasonal', label: 'Seasonal',   score: seasonal.score, weight: W.seasonal, note: seasonal.note },
      { id: 'momentum', label: 'Momentum',   score: mom.score,      weight: W.momentum, note: mom.note },
      { id: 'global',   label: 'Global cue', score: nGlobal.score,  weight: W.global,   note: nGlobal.n ? (nGlobal.n + ' international headlines') : 'no global headlines yet' },
    ];

    var bias = 0;
    lanes.forEach(function (l) { bias += l.score * l.weight; });
    bias = core.clamp(bias, -1, 1);

    var lastCandle = candles[candles.length - 1];
    var lastClose = lastCandle ? lastCandle.close : null;
    // Prefer the live tick as the anchor so the projection starts from the same
    // number the header shows - but only when the two agree closely. A bigger
    // gap means one feed is stale, and a forecast that floats away from the
    // candles is worse than one anchored to the chart you can see.
    if (ctx.livePrice && lastClose && Math.abs(ctx.livePrice - lastClose) / lastClose < 0.025) {
      lastClose = ctx.livePrice;
      if (lastCandle) {
        lastCandle.close = ctx.livePrice;
        lastCandle.high = Math.max(lastCandle.high, ctx.livePrice);
        lastCandle.low = Math.min(lastCandle.low, ctx.livePrice);
      }
    }
    var forecastBars = Math.max(6, Math.round(tf.visibleBars * tf.forecastRatio));
    var vol = volPerBarPct(candles);

    // Expected move = bias x a typical move over the horizon. Capped so the
    // projection stays inside what the index realistically does.
    var typicalMovePct = vol * Math.sqrt(forecastBars);
    var totalDriftPct = core.clamp(bias * typicalMovePct, -Math.abs(typicalMovePct) * 1.2, Math.abs(typicalMovePct) * 1.2);
    totalDriftPct = core.clamp(totalDriftPct, -C.forecast.maxDriftPctPerBar * forecastBars, C.forecast.maxDriftPctPerBar * forecastBars);

    var path = [], upper = [], lower = [];
    if (lastClose) {
      for (var i = 1; i <= forecastBars; i++) {
        var t = lastCandle.time + i * tf.barSec;
        var progress = i / forecastBars;
        // ease-out: most of the drift lands early, then flattens
        var eased = 1 - Math.pow(1 - progress, 1.6);
        var mid = lastClose * (1 + totalDriftPct / 100 * eased);
        var band = lastClose * (vol / 100) * Math.sqrt(i) * C.forecast.coneVolMultiplier;
        path.push({ time: t, value: round2(mid) });
        upper.push({ time: t, value: round2(mid + band) });
        lower.push({ time: t, value: round2(mid - band) });
      }
    }

    // Confidence: how much the four lanes agree, scaled by how much news we have.
    var scores = lanes.map(function (l) { return l.score; });
    var spread = core.stdev(scores);
    var agreement = core.clamp(1 - spread / 0.9, 0, 1);
    var coverage = core.clamp(nAll.n / 40, 0.25, 1);
    var strength = core.clamp(Math.abs(bias) / 0.5, 0.2, 1);
    var confidence = Math.round(
      C.forecast.minConfidence +
      (C.forecast.maxConfidence - C.forecast.minConfidence) * (agreement * 0.5 + coverage * 0.2 + strength * 0.3)
    );

    var direction = bias > 0.08 ? 'BULLISH' : (bias < -0.08 ? 'BEARISH' : 'RANGE-BOUND');
    var endMid = path.length ? path[path.length - 1].value : lastClose;
    var endLow = lower.length ? lower[lower.length - 1].value : lastClose;
    var endHigh = upper.length ? upper[upper.length - 1].value : lastClose;

    return {
      timeframe: tfKey,
      horizonLabel: horizonLabel(tf, forecastBars),
      bias: Math.round(bias * 1000) / 1000,
      direction: direction,
      confidence: core.clamp(confidence, C.forecast.minConfidence, C.forecast.maxConfidence),
      lastClose: lastClose,
      target: endMid,
      targetPct: lastClose ? (endMid - lastClose) / lastClose * 100 : 0,
      rangeLow: round2(endLow), rangeHigh: round2(endHigh),
      forecastBars: forecastBars,
      volPerBar: Math.round(vol * 1000) / 1000,
      lanes: lanes,
      path: path, upper: upper, lower: lower,
      topNews: nAll.top,
      seasonMonth: seasonal.month,
      rsi: mom.rsi,
      narrative: narrate(direction, lanes, seasonal, nAll, mom, horizonLabel(tf, forecastBars)),
      generatedAt: Date.now(),
    };
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function horizonLabel(tf, bars) {
    var sec = bars * tf.barSec;
    if (sec < 3600) return Math.round(sec / 60) + ' minutes';
    if (sec < 86400) return Math.round(sec / 3600) + ' hours';
    if (sec < 2592000) return Math.round(sec / 86400) + ' trading days';
    return Math.round(sec / 2592000) + ' months';
  }

  /* Plain-English reasoning built from the same numbers the chart draws, so
     the words and the picture can never disagree. */
  function narrate(direction, lanes, seasonal, news, mom, horizon) {
    var sorted = lanes.slice().sort(function (a, b) { return Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight); });
    var lead = sorted[0], second = sorted[1];
    var verb = direction === 'BULLISH' ? 'leans up' : direction === 'BEARISH' ? 'leans down' : 'has no clear lean';

    var s = 'Over the next ' + horizon + ' the balance ' + verb + '. ';
    s += 'The strongest input is ' + lead.label.toLowerCase() + ' (' + lead.note + ')';
    if (second && Math.abs(second.score) > 0.05) {
      var agrees = (second.score > 0) === (lead.score > 0);
      s += (agrees ? ', supported by ' : ', pulled against by ') + second.label.toLowerCase() + ' (' + second.note + ')';
    }
    s += '. ';
    if (news.top) {
      s += 'Loudest headline right now: "' + news.top.headline.slice(0, 120) + '" (' + news.top.source + ').';
    } else {
      s += 'No high-impact headline is dominating the tape yet.';
    }
    return s;
  }

  /* --------------------------------------------------------- reason points
     One point per interval bucket - 10 minutes on the hourly view, 1 hour on
     the daily view, 1 day on the monthly view - but only where something
     actually happened. A quiet bucket gets no marker, which is what keeps the
     chart free of noise.                                                    */
  function buildReasons(candles, items, tfKey) {
    var tf = C.timeframes[tfKey];
    if (!candles || candles.length < 3) return [];
    var bucketSec = tf.reasonBucket;

    // Group candles into buckets and measure each bucket's move.
    var buckets = {};
    candles.forEach(function (c) {
      var b = Math.floor(c.time / bucketSec) * bucketSec;
      if (!buckets[b]) buckets[b] = { t: b, first: c, last: c, high: c.high, low: c.low };
      else {
        buckets[b].last = c;
        buckets[b].high = Math.max(buckets[b].high, c.high);
        buckets[b].low = Math.min(buckets[b].low, c.low);
      }
    });

    var keys = Object.keys(buckets).map(Number).sort(function (a, b) { return a - b; });
    var moves = keys.map(function (k) {
      var b = buckets[k];
      return b.first.open ? (b.last.close - b.first.open) / b.first.open * 100 : 0;
    });
    var typical = core.stdev(moves) || 0.1;

    // Index news by bucket once, rather than scanning per bucket.
    var newsByBucket = {};
    items.forEach(function (n) {
      var b = Math.floor(n.ts / bucketSec) * bucketSec;
      (newsByBucket[b] = newsByBucket[b] || []).push(n);
    });

    // Loudest headline in a window. Items inside the bucket count fully;
    // items in the neighbouring half-bucket count at half weight, so a story
    // that broke just before the candle still gets credit for the move.
    function loudest(bucketStart) {
      var best = null, bestW = 0, inWindow = 0;
      [[bucketStart, 1], [bucketStart - bucketSec, 0.5], [bucketStart + bucketSec, 0.35]].forEach(function (pair) {
        (newsByBucket[pair[0]] || []).forEach(function (n) {
          if (pair[1] === 1) inWindow++;
          var w = Math.abs(n.sentiment) * IMPACT_W[n.impact] * pair[1];
          if (w > bestW) { bestW = w; best = n; }
        });
      });
      return { top: best, weight: bestW, inWindow: inWindow };
    }

    var out = [];
    keys.forEach(function (k, idx) {
      var b = buckets[k], move = moves[idx];
      var found = loudest(k);
      var top = found.top;

      var notable = Math.abs(move) >= typical * 0.75;
      var newsWorthy = top && (top.impact === 'high' || Math.abs(top.sentiment) >= 2);
      if (!notable && !newsWorthy) return;   // quiet bucket - no marker, no noise

      var agrees = top ? ((top.sentiment > 0) === (move > 0)) : null;
      var text;
      if (top) {
        text = top.headline;
      } else if (notable) {
        text = 'No scored headline landed in this window. The move looks technical - ' +
               (move > 0 ? 'buying into ' : 'selling into ') + core.fmt.price(b.last.close) + '.';
      } else return;

      out.push({
        time: b.last.time,
        bucketStart: k,
        move: Math.round(move * 100) / 100,
        close: b.last.close,
        text: text,
        source: top ? top.source : 'price action',
        impact: top ? top.impact : 'low',
        sentiment: top ? top.sentiment : 0,
        url: top ? top.url : '',
        agrees: agrees,
        newsCount: found.inWindow,
        bucketSec: bucketSec,
      });
    });

    return out;
  }

  KT.engine = {
    buildForecast: buildForecast,
    buildReasons: buildReasons,
    newsScore: newsScore,
    seasonalScore: seasonalScore,
    momentumScore: momentumScore,
    volPerBarPct: volPerBarPct,
  };
})(window.KT);
