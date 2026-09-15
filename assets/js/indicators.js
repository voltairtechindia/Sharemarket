/* ============================================================================
   Indicators.

   A plain, dependency-free technical library. Every function takes the candle
   array the rest of the app already uses - { time, open, high, low, close,
   volume } - and returns an array the same length as its input, with null in
   the warm-up slots so an index in the output always lines up with the same
   index in the input. That alignment is the whole contract: the chart, the
   pattern scanner and the forecast all index into these arrays by bar, and a
   silently shortened array would shift every reading by the warm-up period.

   Nothing here smooths away a warm-up by back-filling. A 200-bar average does
   not exist on bar 12, and pretending otherwise is how a backtest invents an
   edge it never had.
   ========================================================================== */
(function (KT) {
  'use strict';

  function col(c, k) { return c.map(function (b) { return b[k]; }); }
  function nulls(n) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = null; return a; }
  function last(a) { for (var i = a.length - 1; i >= 0; i--) if (a[i] !== null && a[i] !== undefined && !isNaN(a[i])) return a[i]; return null; }

  /* ------------------------------------------------------------- averages */
  function sma(vals, n) {
    var out = nulls(vals.length), sum = 0;
    for (var i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= n) sum -= vals[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function ema(vals, n) {
    var out = nulls(vals.length), k = 2 / (n + 1), prev = null;
    for (var i = 0; i < vals.length; i++) {
      if (i < n - 1) continue;
      if (prev === null) {
        var s = 0; for (var j = i - n + 1; j <= i; j++) s += vals[j];
        prev = s / n;
      } else {
        prev = vals[i] * k + prev * (1 - k);
      }
      out[i] = prev;
    }
    return out;
  }

  /* Wilder's smoothing - the one RSI, ATR and ADX are actually defined with.
     Using a plain EMA here is the single most common reason a hand-rolled RSI
     disagrees with every chart package. */
  function wilder(vals, n) {
    var out = nulls(vals.length), prev = null;
    for (var i = 0; i < vals.length; i++) {
      if (vals[i] === null) continue;
      if (prev === null) {
        var s = 0, cnt = 0;
        for (var j = Math.max(0, i - n + 1); j <= i; j++) { if (vals[j] !== null) { s += vals[j]; cnt++; } }
        if (cnt < n) continue;
        prev = s / n;
      } else {
        prev = (prev * (n - 1) + vals[i]) / n;
      }
      out[i] = prev;
    }
    return out;
  }

  function stdevArr(vals, n) {
    var out = nulls(vals.length);
    for (var i = n - 1; i < vals.length; i++) {
      var m = 0; for (var j = i - n + 1; j <= i; j++) m += vals[j]; m /= n;
      var v = 0; for (var k = i - n + 1; k <= i; k++) v += (vals[k] - m) * (vals[k] - m);
      out[i] = Math.sqrt(v / n);
    }
    return out;
  }

  /* ---------------------------------------------------------------- range */
  function trueRange(c) {
    var out = nulls(c.length);
    for (var i = 1; i < c.length; i++) {
      out[i] = Math.max(c[i].high - c[i].low,
                        Math.abs(c[i].high - c[i - 1].close),
                        Math.abs(c[i].low - c[i - 1].close));
    }
    return out;
  }

  function atr(c, n) { return wilder(trueRange(c), n || 14); }

  /* ------------------------------------------------------------ oscillators */
  function rsi(c, n) {
    n = n || 14;
    var closes = col(c, 'close'), gain = nulls(c.length), loss = nulls(c.length);
    for (var i = 1; i < closes.length; i++) {
      var d = closes[i] - closes[i - 1];
      gain[i] = d > 0 ? d : 0;
      loss[i] = d < 0 ? -d : 0;
    }
    var ag = wilder(gain, n), al = wilder(loss, n), out = nulls(c.length);
    for (var k = 0; k < c.length; k++) {
      if (ag[k] === null || al[k] === null) continue;
      out[k] = al[k] === 0 ? 100 : 100 - 100 / (1 + ag[k] / al[k]);
    }
    return out;
  }

  function macd(c, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    var closes = col(c, 'close');
    var ef = ema(closes, fast), es = ema(closes, slow);
    var line = nulls(c.length);
    for (var i = 0; i < c.length; i++) if (ef[i] !== null && es[i] !== null) line[i] = ef[i] - es[i];
    var compact = line.filter(function (x) { return x !== null; });
    var sig9 = ema(compact, signal);
    var sig = nulls(c.length), hist = nulls(c.length), p = 0;
    for (var k = 0; k < c.length; k++) {
      if (line[k] === null) continue;
      sig[k] = sig9[p];
      if (sig[k] !== null) hist[k] = line[k] - sig[k];
      p++;
    }
    return { line: line, signal: sig, hist: hist };
  }

  function stochastic(c, n, smooth) {
    n = n || 14; smooth = smooth || 3;
    var k = nulls(c.length);
    for (var i = n - 1; i < c.length; i++) {
      var hi = -Infinity, lo = Infinity;
      for (var j = i - n + 1; j <= i; j++) { hi = Math.max(hi, c[j].high); lo = Math.min(lo, c[j].low); }
      k[i] = hi === lo ? 50 : (c[i].close - lo) / (hi - lo) * 100;
    }
    var compact = k.filter(function (x) { return x !== null; });
    var d3 = sma(compact, smooth), d = nulls(c.length), p = 0;
    for (var m = 0; m < c.length; m++) { if (k[m] === null) continue; d[m] = d3[p]; p++; }
    return { k: k, d: d };
  }

  function cci(c, n) {
    n = n || 20;
    var tp = c.map(function (b) { return (b.high + b.low + b.close) / 3; });
    var m = sma(tp, n), out = nulls(c.length);
    for (var i = n - 1; i < c.length; i++) {
      var md = 0;
      for (var j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
      md /= n;
      out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
    }
    return out;
  }

  function williamsR(c, n) {
    n = n || 14;
    var out = nulls(c.length);
    for (var i = n - 1; i < c.length; i++) {
      var hi = -Infinity, lo = Infinity;
      for (var j = i - n + 1; j <= i; j++) { hi = Math.max(hi, c[j].high); lo = Math.min(lo, c[j].low); }
      out[i] = hi === lo ? -50 : (hi - c[i].close) / (hi - lo) * -100;
    }
    return out;
  }

  /* --------------------------------------------------------------- trend */
  function adx(c, n) {
    n = n || 14;
    var plus = nulls(c.length), minus = nulls(c.length);
    for (var i = 1; i < c.length; i++) {
      var up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low;
      plus[i] = (up > dn && up > 0) ? up : 0;
      minus[i] = (dn > up && dn > 0) ? dn : 0;
    }
    var tr = wilder(trueRange(c), n), sp = wilder(plus, n), sm = wilder(minus, n);
    var pdi = nulls(c.length), mdi = nulls(c.length), dx = nulls(c.length);
    for (var k = 0; k < c.length; k++) {
      if (tr[k] === null || !tr[k] || sp[k] === null || sm[k] === null) continue;
      pdi[k] = sp[k] / tr[k] * 100;
      mdi[k] = sm[k] / tr[k] * 100;
      var sum = pdi[k] + mdi[k];
      dx[k] = sum === 0 ? 0 : Math.abs(pdi[k] - mdi[k]) / sum * 100;
    }
    return { adx: wilder(dx, n), plusDI: pdi, minusDI: mdi };
  }

  function supertrend(c, period, mult) {
    period = period || 10; mult = mult || 3;
    var a = atr(c, period), out = nulls(c.length), dir = nulls(c.length);
    var upperPrev = null, lowerPrev = null, trendPrev = 1, stPrev = null;
    for (var i = 0; i < c.length; i++) {
      if (a[i] === null) continue;
      var mid = (c[i].high + c[i].low) / 2;
      var up = mid + mult * a[i], lo = mid - mult * a[i];
      if (upperPrev !== null) {
        up = (up < upperPrev || c[i - 1].close > upperPrev) ? up : upperPrev;
        lo = (lo > lowerPrev || c[i - 1].close < lowerPrev) ? lo : lowerPrev;
      }
      var trend;
      if (stPrev === null) trend = c[i].close > mid ? 1 : -1;
      else if (trendPrev === 1) trend = c[i].close < lowerPrev ? -1 : 1;
      else trend = c[i].close > upperPrev ? 1 : -1;
      out[i] = trend === 1 ? lo : up;
      dir[i] = trend;
      upperPrev = up; lowerPrev = lo; trendPrev = trend; stPrev = out[i];
    }
    return { value: out, dir: dir };
  }

  /* ----------------------------------------------------------- volatility */
  function bollinger(c, n, k) {
    n = n || 20; k = k || 2;
    var closes = col(c, 'close'), mid = sma(closes, n), sd = stdevArr(closes, n);
    var up = nulls(c.length), lo = nulls(c.length), width = nulls(c.length), pctB = nulls(c.length);
    for (var i = 0; i < c.length; i++) {
      if (mid[i] === null || sd[i] === null) continue;
      up[i] = mid[i] + k * sd[i];
      lo[i] = mid[i] - k * sd[i];
      width[i] = mid[i] ? (up[i] - lo[i]) / mid[i] * 100 : null;
      pctB[i] = (up[i] - lo[i]) ? (closes[i] - lo[i]) / (up[i] - lo[i]) : 0.5;
    }
    return { mid: mid, upper: up, lower: lo, width: width, pctB: pctB };
  }

  function keltner(c, n, mult) {
    n = n || 20; mult = mult || 1.5;
    var mid = ema(col(c, 'close'), n), a = atr(c, n);
    var up = nulls(c.length), lo = nulls(c.length);
    for (var i = 0; i < c.length; i++) {
      if (mid[i] === null || a[i] === null) continue;
      up[i] = mid[i] + mult * a[i];
      lo[i] = mid[i] - mult * a[i];
    }
    return { mid: mid, upper: up, lower: lo };
  }

  function donchian(c, n) {
    n = n || 20;
    var up = nulls(c.length), lo = nulls(c.length), mid = nulls(c.length);
    for (var i = n - 1; i < c.length; i++) {
      var hi = -Infinity, low = Infinity;
      for (var j = i - n + 1; j <= i; j++) { hi = Math.max(hi, c[j].high); low = Math.min(low, c[j].low); }
      up[i] = hi; lo[i] = low; mid[i] = (hi + low) / 2;
    }
    return { upper: up, lower: lo, mid: mid };
  }

  /* A squeeze is Bollinger inside Keltner: volatility has compressed and the
     next expansion tends to be the one worth trading. Reported as a boolean
     per bar plus how many bars the squeeze has already lasted. */
  function squeeze(c) {
    var bb = bollinger(c, 20, 2), kc = keltner(c, 20, 1.5);
    var on = nulls(c.length), age = nulls(c.length), run = 0;
    for (var i = 0; i < c.length; i++) {
      if (bb.upper[i] === null || kc.upper[i] === null) continue;
      var inside = bb.upper[i] < kc.upper[i] && bb.lower[i] > kc.lower[i];
      on[i] = inside;
      run = inside ? run + 1 : 0;
      age[i] = run;
    }
    return { on: on, age: age, bb: bb, kc: kc };
  }

  /* --------------------------------------------------------------- volume */
  function obv(c) {
    var out = nulls(c.length), v = 0;
    for (var i = 1; i < c.length; i++) {
      var vol = c[i].volume || 0;
      if (c[i].close > c[i - 1].close) v += vol;
      else if (c[i].close < c[i - 1].close) v -= vol;
      out[i] = v;
    }
    return out;
  }

  function mfi(c, n) {
    n = n || 14;
    var out = nulls(c.length);
    for (var i = n; i < c.length; i++) {
      var pos = 0, neg = 0;
      for (var j = i - n + 1; j <= i; j++) {
        var tp = (c[j].high + c[j].low + c[j].close) / 3;
        var tpPrev = (c[j - 1].high + c[j - 1].low + c[j - 1].close) / 3;
        var flow = tp * (c[j].volume || 0);
        if (tp > tpPrev) pos += flow; else if (tp < tpPrev) neg += flow;
      }
      out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    }
    return out;
  }

  /* VWAP resets at each session boundary, which on an index means each IST
     trading day. A running VWAP that never resets is a different, far less
     useful number, so the session key is passed in rather than assumed. */
  function vwap(c, sessionKey) {
    var out = nulls(c.length), pv = 0, vv = 0, key = null;
    for (var i = 0; i < c.length; i++) {
      var k = sessionKey ? sessionKey(c[i]) : Math.floor(c[i].time / 86400);
      if (k !== key) { key = k; pv = 0; vv = 0; }
      var tp = (c[i].high + c[i].low + c[i].close) / 3;
      var v = c[i].volume || 0;
      pv += tp * v; vv += v;
      out[i] = vv ? pv / vv : c[i].close;
    }
    return out;
  }

  /* ------------------------------------------------------------ Ichimoku */
  function ichimoku(c, a, b, d) {
    a = a || 9; b = b || 26; d = d || 52;
    function mid(n) {
      var o = nulls(c.length);
      for (var i = n - 1; i < c.length; i++) {
        var hi = -Infinity, lo = Infinity;
        for (var j = i - n + 1; j <= i; j++) { hi = Math.max(hi, c[j].high); lo = Math.min(lo, c[j].low); }
        o[i] = (hi + lo) / 2;
      }
      return o;
    }
    var tenkan = mid(a), kijun = mid(b), senkouB = mid(d);
    var senkouA = nulls(c.length);
    for (var i = 0; i < c.length; i++) {
      if (tenkan[i] !== null && kijun[i] !== null) senkouA[i] = (tenkan[i] + kijun[i]) / 2;
    }
    return { tenkan: tenkan, kijun: kijun, senkouA: senkouA, senkouB: senkouB, shift: b };
  }

  /* ----------------------------------------------------------- divergence
     Price makes a higher high while the oscillator makes a lower high (or the
     mirror image at lows). Measured between the last two confirmed swings, so
     a divergence is only reported once both legs exist. */
  function divergence(c, osc, pivotsFn, width) {
    var piv = pivotsFn(c, width || 4);
    function pair(list, hi) {
      if (list.length < 2) return null;
      var b = list[list.length - 1], a = list[list.length - 2];
      if (osc[a] === null || osc[b] === null) return null;
      var pa = hi ? c[a].high : c[a].low, pb = hi ? c[b].high : c[b].low;
      var priceUp = pb > pa, oscUp = osc[b] > osc[a];
      if (priceUp === oscUp) return null;
      return { from: a, to: b, priceFrom: pa, priceTo: pb, oscFrom: osc[a], oscTo: osc[b],
               kind: hi ? (priceUp ? 'bearish' : 'hidden-bullish') : (priceUp ? 'hidden-bearish' : 'bullish') };
    }
    var out = [];
    var top = pair(piv.highs, true); if (top) out.push(top);
    var bot = pair(piv.lows, false); if (bot) out.push(bot);
    return out;
  }

  /* ------------------------------------------------------ one-shot summary
     What the right-hand panel and the forecast both read. Everything is the
     latest resolved value, with the bar index it came from so a caller can
     tell a fresh reading from a stale one. */
  function snapshot(c) {
    if (!c || c.length < 30) return null;
    var closes = col(c, 'close'), n = c.length - 1, price = closes[n];
    var r = rsi(c, 14), m = macd(c), bb = bollinger(c), a = adx(c), st = supertrend(c);
    var sq = squeeze(c), k = stochastic(c), atr14 = atr(c, 14);
    var e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, Math.min(200, Math.floor(c.length / 2)));
    var s50 = sma(closes, Math.min(50, c.length - 1)), s200 = sma(closes, Math.min(200, c.length - 1));
    var hasVol = c.some(function (b) { return (b.volume || 0) > 0; });

    return {
      price: price, bars: c.length,
      rsi: last(r), rsiSeries: r,
      macd: last(m.line), macdSignal: last(m.signal), macdHist: last(m.hist), macdSeries: m,
      adx: last(a.adx), plusDI: last(a.plusDI), minusDI: last(a.minusDI),
      atr: last(atr14), atrPct: last(atr14) ? last(atr14) / price * 100 : null,
      bbUpper: last(bb.upper), bbLower: last(bb.lower), bbMid: last(bb.mid),
      bbWidth: last(bb.width), pctB: last(bb.pctB),
      squeezeOn: sq.on[n] === true, squeezeAge: sq.age[n] || 0,
      stoch: last(k.k), stochD: last(k.d),
      supertrend: last(st.value), supertrendDir: st.dir[n],
      ema20: last(e20), ema50: last(e50), ema200: last(e200),
      sma50: last(s50), sma200: last(s200),
      obv: hasVol ? last(obv(c)) : null,
      mfi: hasVol ? last(mfi(c, 14)) : null,
      vwap: hasVol ? last(vwap(c)) : null,
      cci: last(cci(c)),
      williamsR: last(williamsR(c)),
      hasVolume: hasVol,
    };
  }

  KT.ind = {
    sma: sma, ema: ema, wilder: wilder, stdev: stdevArr,
    trueRange: trueRange, atr: atr,
    rsi: rsi, macd: macd, stochastic: stochastic, cci: cci, williamsR: williamsR,
    adx: adx, supertrend: supertrend,
    bollinger: bollinger, keltner: keltner, donchian: donchian, squeeze: squeeze,
    obv: obv, mfi: mfi, vwap: vwap, ichimoku: ichimoku,
    divergence: divergence, snapshot: snapshot,
    col: col, last: last,
  };
})(window.KT);
