/* ============================================================================
   Analogue forecasting: "when the chart looked like this before, what happened
   next?"

   A drift formula produces a smooth line because it is a smooth formula. Real
   price paths are not smooth, and a projection that is a clean curve quietly
   tells you the future is orderly. This module answers a different question
   with real data instead.

   Method, which is the standard nearest-neighbour / analogue approach:
     1. Take the last W bars and express them as cumulative % from the start of
        that window, so shape is compared and absolute price level is ignored.
     2. Slide the same window over the whole history. At every offset, measure
        the distance between that segment's shape and today's.
     3. Keep the k closest, forcing them not to overlap each other so eight
        matches means eight separate episodes rather than one episode counted
        eight times.
     4. Look at what each one did over the following H bars. The average of
        those forward paths is the analogue forecast; the spread across them is
        an honest confidence band, and the share that rose is a real base rate.

   What this is not: a guarantee. Similar-looking history is not causation, the
   sample is small by construction, and markets change regime. Everything here
   reports n, the spread and the match quality so it can be read for what it is.
   ========================================================================== */
(function (KT) {
  'use strict';

  /* Cumulative percentage change from the first bar of a window. Comparing
     shape this way makes 2008 at 3,000 points comparable with today at 23,000. */
  function shapeOf(closes, start, len) {
    var base = closes[start];
    if (!base) return null;
    var out = new Array(len);
    for (var i = 0; i < len; i++) out[i] = (closes[start + i] - base) / base * 100;
    return out;
  }

  /* Distance between two shapes. Root mean squared difference, then divided by
     the candidate's own amplitude so a quiet stretch is not judged similar to
     today's simply by virtue of both being near zero. */
  function distance(a, b) {
    var n = a.length, sum = 0, amp = 0;
    for (var i = 0; i < n; i++) {
      var d = a[i] - b[i];
      sum += d * d;
      amp += Math.abs(b[i]);
    }
    var rmse = Math.sqrt(sum / n);
    var scale = Math.max(0.35, amp / n);       // floor stops a flat match winning
    return rmse / scale;
  }

  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }

  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /* ------------------------------------------------------------------ find */
  function find(candles, opts) {
    opts = opts || {};
    var closes = [], times = [];
    for (var i = 0; i < candles.length; i++) {
      if (candles[i] && candles[i].close > 0) { closes.push(candles[i].close); times.push(candles[i].time); }
    }
    var N = closes.length;

    var W = opts.window || Math.max(12, Math.min(40, Math.round(N / 40)));
    var H = opts.horizon || Math.max(4, Math.round(W / 2));
    var K = opts.k || 8;

    // Need room for the query window, at least a few candidate windows, and a
    // forward path after each. Below that there is nothing honest to say.
    if (N < W + H + W * 4) {
      return { ok: false, reason: 'not enough history', have: N, need: W + H + W * 4, window: W, horizon: H };
    }

    var query = shapeOf(closes, N - W, W);
    if (!query) return { ok: false, reason: 'bad series' };

    // Score every candidate window that has a full forward path and does not
    // run into the query window itself.
    var cands = [];
    for (var s = 0; s + W + H <= N - W; s++) {
      var shp = shapeOf(closes, s, W);
      if (!shp) continue;
      cands.push({ start: s, d: distance(query, shp) });
    }
    if (!cands.length) return { ok: false, reason: 'no candidates' };

    cands.sort(function (a, b) { return a.d - b.d; });

    // Non-overlapping selection: once an episode is picked, skip anything that
    // shares bars with it, otherwise the "eight matches" are one match shifted.
    var picked = [], used = [];
    for (var c = 0; c < cands.length && picked.length < K; c++) {
      var st = cands[c].start, clash = false;
      for (var u = 0; u < used.length; u++) {
        if (Math.abs(st - used[u]) < W) { clash = true; break; }
      }
      if (clash) continue;
      used.push(st);
      picked.push(cands[c]);
    }
    if (!picked.length) return { ok: false, reason: 'no separable matches' };

    // Forward path of each match, as % from the end of its own window.
    var forwards = picked.map(function (m) {
      var pivot = closes[m.start + W - 1], fwd = [];
      for (var h = 1; h <= H; h++) {
        var idx = m.start + W - 1 + h;
        fwd.push(idx < N && pivot ? (closes[idx] - pivot) / pivot * 100 : null);
      }
      return {
        start: m.start,
        distance: Math.round(m.d * 1000) / 1000,
        // 0 is an exact shape match; the scaling makes ~1 an average stranger.
        similarity: Math.round(Math.max(0, 1 - m.d) * 1000) / 10,
        startTime: times[m.start],
        endTime: times[m.start + W - 1],
        forward: fwd,
        endChange: fwd[fwd.length - 1],
      };
    });

    // Average, median and spread across the matched futures, bar by bar.
    var meanPath = [], p25 = [], p75 = [], p10 = [], p90 = [];
    for (var h2 = 0; h2 < H; h2++) {
      var col = forwards.map(function (f) { return f.forward[h2]; })
                        .filter(function (v) { return v !== null && !isNaN(v); });
      if (!col.length) { meanPath.push(0); p25.push(0); p75.push(0); p10.push(0); p90.push(0); continue; }
      var sorted = col.slice().sort(function (a, b) { return a - b; });
      meanPath.push(Math.round(mean(col) * 1000) / 1000);
      p25.push(Math.round(quantile(sorted, 0.25) * 1000) / 1000);
      p75.push(Math.round(quantile(sorted, 0.75) * 1000) / 1000);
      p10.push(Math.round(quantile(sorted, 0.10) * 1000) / 1000);
      p90.push(Math.round(quantile(sorted, 0.90) * 1000) / 1000);
    }

    var ends = forwards.map(function (f) { return f.endChange; })
                       .filter(function (v) { return v !== null && !isNaN(v); });
    var ups = ends.filter(function (v) { return v > 0; }).length;
    var sortedEnds = ends.slice().sort(function (a, b) { return a - b; });

    return {
      ok: true,
      window: W, horizon: H, k: picked.length, scanned: cands.length, bars: N,
      matches: forwards,
      meanPath: meanPath, p25: p25, p75: p75, p10: p10, p90: p90,
      upRate: ends.length ? Math.round(ups / ends.length * 1000) / 10 : null,
      ups: ups, downs: ends.length - ups, n: ends.length,
      avgEnd: ends.length ? Math.round(mean(ends) * 100) / 100 : null,
      medianEnd: ends.length ? Math.round(quantile(sortedEnds, 0.5) * 100) / 100 : null,
      bestEnd: ends.length ? Math.round(Math.max.apply(null, ends) * 100) / 100 : null,
      worstEnd: ends.length ? Math.round(Math.min.apply(null, ends) * 100) / 100 : null,
      // Mean similarity of the chosen matches. Low means today's shape is
      // unusual and the whole exercise deserves less weight.
      quality: Math.round(mean(picked.map(function (m) { return Math.max(0, 1 - m.d); })) * 1000) / 10,
    };
  }

  /* --------------------------------------------------------------- shaping
     Bend a smooth model path using the analogue mean, so the projection keeps
     the model's direction and magnitude but carries the texture of what really
     happened after similar setups. Weight is capped by match quality: a weak
     analogue set barely moves the line. */
  function shape(basePath, analog, lastClose, weight) {
    if (!analog || !analog.ok || !basePath || !basePath.length) return basePath;
    var w = Math.min(weight == null ? 0.55 : weight, analog.quality / 100);
    if (!(w > 0.02)) return basePath;

    var H = analog.meanPath.length;
    var out = basePath.map(function (pt, i) {
      // Map the projection onto the analogue's own length, so a 75-bar
      // projection can borrow the shape of a 20-bar analogue.
      var pos = H > 1 ? (i / Math.max(1, basePath.length - 1)) * (H - 1) : 0;
      var lo = Math.floor(pos), hi = Math.min(H - 1, lo + 1);
      var frac = pos - lo;
      var aPct = analog.meanPath[lo] + (analog.meanPath[hi] - analog.meanPath[lo]) * frac;

      // Detrend the analogue: keep its wiggle, let the model keep the drift.
      var aEnd = analog.meanPath[H - 1] || 0;
      var trendAtI = aEnd * (basePath.length > 1 ? i / (basePath.length - 1) : 1);
      var wiggle = aPct - trendAtI;

      var blended = pt.value + lastClose * (wiggle / 100) * w;
      return { time: pt.time, value: Math.round(blended * 100) / 100 };
    });
    return out;
  }

  /* Human-readable window description, for labelling the evidence. */
  function describeMatch(m, barSec) {
    var d = new Date(m.startTime * 1000);
    var e = new Date(m.endTime * 1000);
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (barSec >= 86400) {
      return months[d.getMonth()] + ' ' + d.getFullYear() +
             (d.getFullYear() !== e.getFullYear() || d.getMonth() !== e.getMonth()
               ? ' to ' + months[e.getMonth()] + ' ' + e.getFullYear() : '');
    }
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + String(d.getFullYear()).slice(2);
  }

  KT.analogs = { find: find, shape: shape, describeMatch: describeMatch };
})(window.KT);
