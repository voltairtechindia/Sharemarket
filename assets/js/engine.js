/* ============================================================================
   Engine: the "why did it move here" reason points.

   This file used to hold the forecast too. The modelling now lives in
   forecast.js, which produces a path with a time axis, two calibrated bands
   and per-checkpoint probabilities instead of one number for the end of the
   horizon. Everything here that duplicated it has been removed rather than
   left to rot into a second, quietly different model - the lane helpers are
   re-exported from forecast.js so there is exactly one implementation of each.

   What remains is genuinely this file's own job: taking the candles and the
   scored headlines and deciding, per interval bucket, whether anything
   happened worth putting a marker on.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;

  var IMPACT_W = { high: 3, medium: 2, low: 1 };

  /* ---------------------------------------------------------- the forecast
     The modelling moved to forecast.js, which produces a path with a time axis
     and a calibrated band instead of one number for the end of the horizon.
     This wrapper stays so nothing that called engine.buildForecast has to
     change, and so the lane helpers above keep a single home.

     forecast.js is loaded before this file; if it somehow is not, the caller
     gets null rather than a silently different model.                       */
  function buildForecast(ctx) {
    if (!KT.forecast || !KT.forecast.build) return null;
    return KT.forecast.build(ctx);
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

  var F = KT.forecast || {};
  KT.engine = {
    buildForecast: buildForecast,
    buildReasons: buildReasons,
    /* Re-exported so older call sites keep working and there is one
       implementation of each lane, in forecast.js. */
    newsScore: F.newsLane, seasonalScore: F.seasonalLane,
    momentumScore: F.momentumLane, calibrate: F.calibrate,
  };
})(window.KT);
