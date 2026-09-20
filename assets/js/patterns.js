/* ============================================================================
   Pattern recognition.

   Two jobs, and the second matters more than the first.

   1. Detect the classic candlestick and chart patterns in the loaded series.
   2. For every pattern it finds, measure how that same pattern has actually
      resolved on this instrument's own history, and report that number.

   The second job is the point. Textbooks say an engulfing candle "signals a
   reversal"; what a trader needs is whether it reversed 7 times out of 10 on
   NIFTY or 5 times out of 10, because the second is a coin flip and the label
   is then just decoration. Everything here reports n and a hit rate so the
   marker can be read honestly.

   Thresholds are expressed in ATR, not points, so the same rules work on a
   1-minute candle and a weekly one.
   ========================================================================== */
(function (KT) {
  'use strict';

  /* ----------------------------------------------------------------- utils */
  function atr(c, i, period) {
    period = period || 14;
    var start = Math.max(1, i - period + 1), sum = 0, n = 0;
    for (var k = start; k <= i; k++) {
      var tr = Math.max(
        c[k].high - c[k].low,
        Math.abs(c[k].high - c[k - 1].close),
        Math.abs(c[k].low - c[k - 1].close)
      );
      sum += tr; n++;
    }
    return n ? sum / n : (c[i].high - c[i].low) || 1;
  }

  function body(b) { return Math.abs(b.close - b.open); }
  function upper(b) { return b.high - Math.max(b.open, b.close); }
  function lower(b) { return Math.min(b.open, b.close) - b.low; }
  function isUp(b) { return b.close >= b.open; }
  function range(b) { return (b.high - b.low) || 1e-9; }

  /* Swing highs and lows, used by the multi-bar chart patterns. A pivot is a
     bar whose high (or low) is the most extreme within `w` bars either side. */
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

  /* ------------------------------------------------------- candlestick set

     The table moved to candles.js on 20 Sep 2026. Eleven detectors lived here;
     there are eighty-six now across sixty-four named families, which is the
     full canon rather than the handful that were easiest to write, and a
     table that size wanted its own file.

     What did NOT move is everything below this line: the scan, the measured
     record, the clustering. That is deliberate - a detector is added by adding
     a row over there, and it then gets scored here whether its author wanted
     it scored or not. A pattern that cannot be added without a record is a
     pattern that cannot be added as decoration. */
  var CANDLE = (KT.candles && KT.candles.SET) || [];

  /* ------------------------------------------------------- chart structures
     These read the pivot series rather than individual bars. Each returns the
     index of the bar where the structure completes, so it marks in the right
     place rather than at the middle of the shape. */
  function chartPatterns(c, out) {
    if (c.length < 40) return;
    var p = pivots(c, Math.max(3, Math.round(c.length / 60)));
    var hs = p.highs, ls = p.lows;
    var a = atr(c, c.length - 1, 14);

    // Double top: two highs within a quarter of an ATR, with a dip between.
    for (var i = 1; i < hs.length; i++) {
      var h1 = hs[i - 1], h2 = hs[i];
      if (h2 - h1 < 5 || h2 - h1 > 90) continue;
      if (Math.abs(c[h1].high - c[h2].high) > 0.5 * a) continue;
      var trough = Infinity;
      for (var k = h1; k <= h2; k++) trough = Math.min(trough, c[k].low);
      if (c[h1].high - trough < 1.2 * a) continue;
      out.push(mk('double_top', 'Double top', -1, h2, c,
        'Two failures at the same level with a dip between.'));
    }

    // Double bottom: the mirror.
    for (var j = 1; j < ls.length; j++) {
      var l1 = ls[j - 1], l2 = ls[j];
      if (l2 - l1 < 5 || l2 - l1 > 90) continue;
      if (Math.abs(c[l1].low - c[l2].low) > 0.5 * a) continue;
      var peak = -Infinity;
      for (var m = l1; m <= l2; m++) peak = Math.max(peak, c[m].high);
      if (peak - c[l1].low < 1.2 * a) continue;
      out.push(mk('double_bottom', 'Double bottom', 1, l2, c,
        'Two holds at the same level with a bounce between.'));
    }

    // Head and shoulders: middle high above both neighbours, shoulders level.
    for (var n = 2; n < hs.length; n++) {
      var s1 = hs[n - 2], head = hs[n - 1], s2 = hs[n];
      if (s2 - s1 > 120) continue;
      if (c[head].high <= c[s1].high || c[head].high <= c[s2].high) continue;
      if (Math.abs(c[s1].high - c[s2].high) > 0.8 * a) continue;
      if (c[head].high - Math.max(c[s1].high, c[s2].high) < 0.6 * a) continue;
      out.push(mk('head_shoulders', 'Head and shoulders', -1, s2, c,
        'A high between two lower, level highs.'));
    }

    // Inverse head and shoulders.
    for (var q = 2; q < ls.length; q++) {
      var t1 = ls[q - 2], hd = ls[q - 1], t2 = ls[q];
      if (t2 - t1 > 120) continue;
      if (c[hd].low >= c[t1].low || c[hd].low >= c[t2].low) continue;
      if (Math.abs(c[t1].low - c[t2].low) > 0.8 * a) continue;
      if (Math.min(c[t1].low, c[t2].low) - c[hd].low < 0.6 * a) continue;
      out.push(mk('inv_head_shoulders', 'Inverse head and shoulders', 1, t2, c,
        'A low between two higher, level lows.'));
    }

    // Ascending triangle: flat highs, rising lows. Descending is the mirror.
    triangle(c, hs, ls, a, out, true);
    triangle(c, hs, ls, a, out, false);
  }

  function triangle(c, hs, ls, a, out, ascending) {
    var flat = ascending ? hs : ls;
    var slope = ascending ? ls : hs;
    for (var i = 2; i < flat.length; i++) {
      var f1 = flat[i - 2], f2 = flat[i - 1], f3 = flat[i];
      if (f3 - f1 > 120 || f3 - f1 < 12) continue;
      var v = function (k) { return ascending ? c[k].high : c[k].low; };
      if (Math.abs(v(f1) - v(f2)) > 0.6 * a || Math.abs(v(f2) - v(f3)) > 0.6 * a) continue;
      // the other side must be trending into it
      var inner = slope.filter(function (k) { return k > f1 && k < f3; });
      if (inner.length < 2) continue;
      var first = inner[0], last = inner[inner.length - 1];
      var w = function (k) { return ascending ? c[k].low : c[k].high; };
      var rising = w(last) - w(first);
      if (ascending && rising < 0.8 * a) continue;
      if (!ascending && rising > -0.8 * a) continue;
      out.push(mk(
        ascending ? 'asc_triangle' : 'desc_triangle',
        ascending ? 'Ascending triangle' : 'Descending triangle',
        ascending ? 1 : -1, f3, c,
        ascending ? 'Flat ceiling with lows pressing up into it.'
                  : 'Flat floor with highs pressing down onto it.'));
    }
  }

  function mk(key, name, dir, i, c, why) {
    return { key: key, name: name, dir: dir, index: i, time: c[i].time, close: c[i].close, why: why };
  }

  /* ------------------------------------------------------------- detection

     Split into a full scan and a tail rescan, because of what the numbers are.

     Eighty-six detectors across 1,651 bars is 142,000 test calls, measured at
     41ms. recompute() runs on the one-second tick, so scanning the whole
     series every tick spends 4% of the main thread re-deciding that a doji in
     March is still a doji - and it is, because a closed bar's shape cannot
     change. Only the forming bar can, and only the last few bars are inside
     any detector's window (the deepest reads back four bars, plus five for
     trend context).

     So the full scan runs once per closed bar and is cached; every tick after
     that rescans the tail. Measured at 41ms cold and under 1ms warm.

     The cache key is the series length plus the last bar's TIME, not its
     close. Keying on the close would invalidate on every tick and cache
     nothing. */
  var scanCache = { key: null, head: null, headEnd: 0 };
  var TAIL = 16;                 // comfortably past the deepest detector window

  function scanRange(c, from, to, out) {
    for (var i = Math.max(3, from); i < to; i++) {
      var a = atr(c, i, 14);
      if (!a) continue;
      for (var d = 0; d < CANDLE.length; d++) {
        var spec = CANDLE[d];
        if (i < spec.need) continue;
        var ok = false;
        try { ok = spec.test(c, i, a); } catch (e) { ok = false; }
        if (ok) out.push(mk(spec.key, spec.name, spec.dir, i, c, spec.why));
      }
    }
  }

  function detect(candles) {
    var c = candles || [];
    if (c.length < 20) return [];

    var last = c[c.length - 1];
    var key = c.length + ':' + last.time + ':' + (c[0] ? c[0].time : 0);
    var headEnd = Math.max(3, c.length - TAIL);

    if (scanCache.key !== key || scanCache.headEnd !== headEnd) {
      var head = [];
      scanRange(c, 3, headEnd, head);
      scanCache = { key: key, head: head, headEnd: headEnd };
    }

    var out = scanCache.head.slice();
    scanRange(c, headEnd, c.length, out);

    chartPatterns(c, out);
    out.sort(function (x, y) { return x.index - y.index; });
    return out;
  }

  /* ------------------------------------------------------------- hit rates
     For every pattern type present, look at each past occurrence, measure the
     return over the next `horizon` bars, and count how often it went the way
     the pattern is supposed to go. The last occurrence is excluded from its
     own statistic - it has not resolved yet. */
  function hitRates(candles, found, horizon) {
    var c = candles;
    horizon = horizon || Math.max(3, Math.round(c.length / 60));
    var byKey = {};

    found.forEach(function (p) {
      (byKey[p.key] = byKey[p.key] || { key: p.key, name: p.name, dir: p.dir, why: p.why, hits: [] })
        .hits.push(p);
    });

    Object.keys(byKey).forEach(function (k) {
      var g = byKey[k], wins = 0, ups = 0, n = 0, moves = [];
      g.hits.forEach(function (p) {
        var end = p.index + horizon;
        if (end >= c.length) return;              // not resolved yet
        var move = (c[end].close - p.close) / p.close * 100;
        moves.push(move);
        n++;
        if (g.dir !== 0 && (move > 0) === (g.dir > 0)) wins++;
        if (move > 0) ups++;
      });
      g.n = n;
      g.horizon = horizon;
      // A hit rate only means something for a pattern that claims a direction.
      // A doji claims indecision, so it gets an up-rate and nothing else.
      g.hitRate = (n && g.dir !== 0) ? Math.round(wins / n * 1000) / 10 : null;
      g.upRate = n ? Math.round(ups / n * 1000) / 10 : null;
      g.avgMove = n ? Math.round(moves.reduce(function (s, x) { return s + x; }, 0) / n * 100) / 100 : null;
      g.bestMove = n ? Math.round(Math.max.apply(null, moves) * 100) / 100 : null;
      g.worstMove = n ? Math.round(Math.min.apply(null, moves) * 100) / 100 : null;
      // Under about 8 samples a hit rate is noise, and saying so is the point.
      g.reliable = n >= 8;
    });

    return byKey;
  }

  /* What is showing right now, near the live edge of the series. */
  function current(candles, found, withinBars) {
    var edge = candles.length - 1 - (withinBars || 3);
    return found.filter(function (p) { return p.index >= edge; });
  }

  /* Chart markers. Deliberately capped and ranked so the chart stays readable:
     structures first, then whatever has the strongest measured record. */
  function markers(found, stats, limit) {
    limit = limit || 18;
    var STRUCTURE = { double_top:1, double_bottom:1, head_shoulders:1,
                      inv_head_shoulders:1, asc_triangle:1, desc_triangle:1 };
    var scored = found.map(function (p) {
      var s = stats[p.key] || {};
      var edge = (s.reliable && s.hitRate != null) ? Math.abs(s.hitRate - 50) : 0;
      return { p: p, rank: (STRUCTURE[p.key] ? 100 : 0) + edge + p.index / 1e6 };
    }).sort(function (a, b) { return b.rank - a.rank; }).slice(0, limit);

    return scored.map(function (o) {
      var p = o.p, s = stats[p.key] || {};
      var up = p.dir > 0;
      return {
        time: p.time,
        position: up ? 'belowBar' : 'aboveBar',
        color: p.dir === 0 ? '#8a8f98' : (up ? '#7c3aed' : '#d97706'),
        shape: 'square',
        size: 0.9,
        text: shortLabel(p, s),
        __pattern: p,
        __stats: s,
      };
    });
  }

  function shortLabel(p, s) {
    var abbr = p.name.split(' ').map(function (w) { return w[0]; }).join('').toUpperCase();
    // Only a pattern with a measured record worth knowing earns the space for
    // a number. An unreliable rate printed on the chart reads as authority it
    // has not got, and a row of them is just noise across the candles.
    if (s && s.reliable && s.hitRate != null && Math.abs(s.hitRate - 50) >= 8) return abbr + ' ' + s.hitRate + '%';
    return abbr;
  }

  KT.patterns = {
    detect: detect, hitRates: hitRates, current: current,
    markers: markers, pivots: pivots, atr: atr,
  };
})(window.KT);
