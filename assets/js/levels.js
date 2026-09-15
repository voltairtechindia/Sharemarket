/* ============================================================================
   Levels: where the price has actually stopped before.

   A support or resistance line is only worth drawing if the market respected
   it more than once, so nothing here is derived from a formula alone. Swing
   pivots are clustered by proximity, and a cluster is scored by how many
   separate touches it holds, how recent they are, and how hard price was
   rejected from it. A level touched once last Tuesday is not a level.

   The formula-derived sets - classic pivots and Fibonacci retracements - are
   still produced, because traders watch them and that self-fulfilling part is
   real, but they are labelled as such and scored lower than a level the tape
   actually defended.
   ========================================================================== */
(function (KT) {
  'use strict';

  function pivots(c, w) {
    w = w || 5;
    var hi = [], lo = [];
    for (var i = w; i < c.length - w; i++) {
      var isHi = true, isLo = true;
      for (var k = i - w; k <= i + w; k++) {
        if (k === i) continue;
        if (c[k].high >= c[i].high) isHi = false;
        if (c[k].low <= c[i].low) isLo = false;
        if (!isHi && !isLo) break;
      }
      if (isHi) hi.push(i);
      if (isLo) lo.push(i);
    }
    return { highs: hi, lows: lo };
  }

  /* --------------------------------------------------- clustered S/R zones */
  function zones(c, opts) {
    opts = opts || {};
    if (!c || c.length < 40) return [];
    var w = opts.pivotWidth || Math.max(3, Math.round(c.length / 80));
    var p = pivots(c, w);
    var price = c[c.length - 1].close;

    // Tolerance scales with the instrument's own noise, so the same code works
    // on a 23,000-point index and a 95-rupee stock.
    var a = KT.ind.atr(c, 14);
    var atrNow = KT.ind.last(a) || price * 0.005;
    var tol = opts.tolerance || Math.max(atrNow * 0.75, price * 0.0012);

    var raw = [];
    p.highs.forEach(function (i) { raw.push({ i: i, v: c[i].high, kind: 'res' }); });
    p.lows.forEach(function (i) { raw.push({ i: i, v: c[i].low, kind: 'sup' }); });
    raw.sort(function (x, y) { return x.v - y.v; });

    var clusters = [], cur = null;
    raw.forEach(function (r) {
      if (cur && Math.abs(r.v - cur.sum / cur.n) <= tol) {
        cur.sum += r.v; cur.n++; cur.members.push(r);
        cur.lastIndex = Math.max(cur.lastIndex, r.i);
      } else {
        if (cur) clusters.push(cur);
        cur = { sum: r.v, n: 1, members: [r], lastIndex: r.i };
      }
    });
    if (cur) clusters.push(cur);

    var out = clusters.filter(function (g) { return g.n >= 2; }).map(function (g) {
      var level = g.sum / g.n;
      var recency = g.lastIndex / Math.max(1, c.length - 1);           // 0..1
      // How far price travelled away after each touch, in ATR. A level that
      // sent price 3 ATR the other way matters more than one it drifted off.
      var rejection = 0;
      g.members.forEach(function (m) {
        var end = Math.min(c.length - 1, m.i + 10);
        rejection += Math.abs(c[end].close - m.v) / (atrNow || 1);
      });
      rejection /= g.n;
      var touches = g.n;
      var score = touches * 1.0 + recency * 2.0 + Math.min(rejection, 4) * 0.6;
      return {
        level: Math.round(level * 100) / 100,
        touches: touches,
        lastIndex: g.lastIndex,
        lastTime: c[g.lastIndex].time,
        rejection: Math.round(rejection * 100) / 100,
        score: Math.round(score * 100) / 100,
        side: level > price ? 'resistance' : 'support',
        distPct: Math.round((level - price) / price * 10000) / 100,
        source: 'touches',
      };
    });

    out.sort(function (x, y) { return y.score - x.score; });
    return out.slice(0, opts.limit || 10);
  }

  /* -------------------------------------------------------- classic pivots
     Computed from the previous completed session, which is what the desks
     that watch them use. `sessionOf` groups bars into sessions. */
  function classicPivots(c, sessionOf) {
    if (!c || c.length < 5) return null;
    sessionOf = sessionOf || function (b) { return Math.floor(b.time / 86400); };
    var cur = sessionOf(c[c.length - 1]), prevKey = null;
    for (var i = c.length - 1; i >= 0; i--) {
      var k = sessionOf(c[i]);
      if (k !== cur) { prevKey = k; break; }
    }
    if (prevKey === null) return null;
    var hi = -Infinity, lo = Infinity, close = null, open = null;
    for (var j = 0; j < c.length; j++) {
      if (sessionOf(c[j]) !== prevKey) continue;
      if (open === null) open = c[j].open;
      hi = Math.max(hi, c[j].high); lo = Math.min(lo, c[j].low); close = c[j].close;
    }
    if (close === null || hi === -Infinity) return null;
    var pp = (hi + lo + close) / 3, range = hi - lo;
    function r(n) { return Math.round(n * 100) / 100; }
    return {
      basis: { high: r(hi), low: r(lo), close: r(close) },
      pp: r(pp),
      r1: r(2 * pp - lo), s1: r(2 * pp - hi),
      r2: r(pp + range), s2: r(pp - range),
      r3: r(hi + 2 * (pp - lo)), s3: r(lo - 2 * (hi - pp)),
      // Camarilla - tighter, and the set intraday traders use for fade levels.
      h3: r(close + range * 1.1 / 4), l3: r(close - range * 1.1 / 4),
      h4: r(close + range * 1.1 / 2), l4: r(close - range * 1.1 / 2),
    };
  }

  /* ----------------------------------------------------------- Fibonacci
     Anchored to the largest clean swing in the visible window, not to the
     absolute high and low, which on a long series is usually two unrelated
     points years apart. */
  function fibonacci(c, lookback) {
    if (!c || c.length < 20) return null;
    var start = Math.max(0, c.length - (lookback || 120));
    var hiI = start, loI = start;
    for (var i = start; i < c.length; i++) {
      if (c[i].high > c[hiI].high) hiI = i;
      if (c[i].low < c[loI].low) loI = i;
    }
    var up = loI < hiI;                       // swing direction
    var hi = c[hiI].high, lo = c[loI].low, range = hi - lo;
    if (!range) return null;
    function lvl(f) { return Math.round((up ? hi - range * f : lo + range * f) * 100) / 100; }
    return {
      direction: up ? 'up' : 'down',
      high: Math.round(hi * 100) / 100, low: Math.round(lo * 100) / 100,
      highTime: c[hiI].time, lowTime: c[loI].time,
      retrace: [
        { f: 0.236, v: lvl(0.236) }, { f: 0.382, v: lvl(0.382) },
        { f: 0.5, v: lvl(0.5) }, { f: 0.618, v: lvl(0.618) },
        { f: 0.786, v: lvl(0.786) },
      ],
      extend: [
        { f: 1.272, v: Math.round((up ? hi + range * 0.272 : lo - range * 0.272) * 100) / 100 },
        { f: 1.618, v: Math.round((up ? hi + range * 0.618 : lo - range * 0.618) * 100) / 100 },
      ],
    };
  }

  /* ------------------------------------------------------- volume profile
     Where the most business was done. On an index feed volume is often zero,
     in which case time-at-price is used instead, which is a fair proxy and is
     labelled honestly in the return value. */
  function volumeProfile(c, buckets) {
    if (!c || c.length < 20) return null;
    buckets = buckets || 40;
    var hi = -Infinity, lo = Infinity;
    c.forEach(function (b) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); });
    if (!(hi > lo)) return null;
    var step = (hi - lo) / buckets, bins = new Array(buckets);
    for (var i = 0; i < buckets; i++) bins[i] = 0;
    var usesVolume = c.some(function (b) { return (b.volume || 0) > 0; });

    c.forEach(function (b) {
      var from = Math.max(0, Math.floor((b.low - lo) / step));
      var to = Math.min(buckets - 1, Math.floor((b.high - lo) / step));
      var span = to - from + 1;
      var w = (usesVolume ? (b.volume || 0) : 1) / span;
      for (var k = from; k <= to; k++) bins[k] += w;
    });

    var pocIdx = 0;
    for (var j = 1; j < buckets; j++) if (bins[j] > bins[pocIdx]) pocIdx = j;
    var total = bins.reduce(function (s, x) { return s + x; }, 0);

    // Value area: grow out from the POC until 70% of the activity is inside.
    var lower = pocIdx, upper = pocIdx, acc = bins[pocIdx];
    while (acc < total * 0.7 && (lower > 0 || upper < buckets - 1)) {
      var takeDown = lower > 0 ? bins[lower - 1] : -1;
      var takeUp = upper < buckets - 1 ? bins[upper + 1] : -1;
      if (takeUp >= takeDown) { upper++; acc += bins[upper]; }
      else { lower--; acc += bins[lower]; }
    }
    function mid(i) { return Math.round((lo + step * (i + 0.5)) * 100) / 100; }
    return {
      poc: mid(pocIdx), vaHigh: mid(upper), vaLow: mid(lower),
      basis: usesVolume ? 'volume' : 'time at price',
      bins: bins.map(function (v, i) { return { price: mid(i), weight: Math.round(v * 100) / 100 }; }),
    };
  }

  /* --------------------------------------------------------------- gaps
     Unfilled gaps act as magnets, and an index gaps often on global news. */
  function gaps(c, minAtr) {
    if (!c || c.length < 20) return [];
    var a = KT.ind.atr(c, 14), out = [];
    for (var i = 1; i < c.length; i++) {
      if (a[i] === null) continue;
      var up = c[i].low > c[i - 1].high, dn = c[i].high < c[i - 1].low;
      if (!up && !dn) continue;
      var size = up ? c[i].low - c[i - 1].high : c[i - 1].low - c[i].high;
      if (size < (minAtr || 0.35) * a[i]) continue;
      var from = up ? c[i - 1].high : c[i].high;
      var to = up ? c[i].low : c[i - 1].low;
      var filled = false;
      for (var k = i + 1; k < c.length; k++) {
        if (up ? c[k].low <= from : c[k].high >= to) { filled = true; break; }
      }
      out.push({
        index: i, time: c[i].time, dir: up ? 'up' : 'down',
        from: Math.round(Math.min(from, to) * 100) / 100,
        to: Math.round(Math.max(from, to) * 100) / 100,
        sizePct: Math.round(size / c[i - 1].close * 10000) / 100,
        filled: filled,
      });
    }
    return out.filter(function (g) { return !g.filled; }).slice(-6);
  }

  /* Round numbers pull price. On the Nifty the 100s and 500s are the ones the
     order book actually thickens at. */
  function roundNumbers(price, count) {
    // A "round number" is relative: 100 matters on the Nifty, 0.50 matters on a
    // ninety-rupee stock. Take roughly 0.4% of price and snap it to the nearest
    // number a human would actually quote.
    var rough = price * 0.004;
    var pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
    var norm = rough / pow10;
    var step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * pow10;
    var base = Math.round(price / step) * step, out = [];
    for (var i = -(count || 3); i <= (count || 3); i++) {
      var v = base + i * step;
      if (v > 0) out.push({ level: Math.round(v * 100) / 100, major: (v / (step * 5)) % 1 === 0 });
    }
    return out;
  }

  /* Everything a caller needs in one object, with the nearest level on each
     side pulled out because that is what the forecast and the chart both use. */
  function build(c, sessionOf) {
    if (!c || c.length < 40) return null;
    var price = c[c.length - 1].close;
    var z = zones(c);
    var above = z.filter(function (x) { return x.level > price; }).sort(function (a2, b) { return a2.level - b.level; });
    var below = z.filter(function (x) { return x.level < price; }).sort(function (a2, b) { return b.level - a2.level; });
    return {
      price: price,
      zones: z,
      nearestResistance: above[0] || null,
      nearestSupport: below[0] || null,
      pivots: classicPivots(c, sessionOf),
      fib: fibonacci(c),
      profile: volumeProfile(c),
      gaps: gaps(c),
      rounds: roundNumbers(price),
    };
  }

  KT.levels = {
    build: build, zones: zones, classicPivots: classicPivots,
    fibonacci: fibonacci, volumeProfile: volumeProfile, gaps: gaps,
    roundNumbers: roundNumbers, pivots: pivots,
  };
})(window.KT);
