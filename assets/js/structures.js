/* ============================================================================
   Chart structures: the patterns people draw with a pencil.

   patterns.js handles bar-level candlestick shapes. This file handles the
   multi-bar geometry - triangles, wedges, flags, double tops, head and
   shoulders, channels, cups - and, unlike a marker, each detection carries the
   actual lines, so the chart draws the thing rather than just naming it.

   Every structure returns:
     lines    the segments to draw, as { time, value } points
     trigger  the price that confirms it (a breakout level, a neckline)
     target   the measured move, projected from the structure's own height
     stop     where the idea is wrong
     quality  0..1 from fit error, touch count and symmetry

   The gates matter more than the detectors. Geometry will find a head and
   shoulders in pure noise if you let it, so:

     - a trendline needs at least three separate swing pivots, because a line
       through two points always fits perfectly and proves nothing;
     - the structure's height must be a real share of the window's own range,
       so a wiggle is not promoted to a formation;
     - peaks that are supposed to match must match inside half an ATR;
     - tolerances are in ATR, so one rule set covers a 1-minute candle and a
       weekly one.

   Tuned against random-walk input until it stops inventing structures there.
   `outcomes()` then measures what each pattern actually did on this
   instrument's own history, which is the number worth reading.
   ========================================================================== */
(function (KT) {
  'use strict';

  function atrAt(c, i, n) {
    n = n || 14;
    var start = Math.max(1, i - n + 1), sum = 0, k = 0;
    for (var j = start; j <= i; j++) {
      sum += Math.max(c[j].high - c[j].low,
                      Math.abs(c[j].high - c[j - 1].close),
                      Math.abs(c[j].low - c[j - 1].close));
      k++;
    }
    return k ? sum / k : (c[i].high - c[i].low) || 1;
  }

  function windowRange(c, from, to) {
    var hi = -Infinity, lo = Infinity;
    for (var i = from; i <= to; i++) { hi = Math.max(hi, c[i].high); lo = Math.min(lo, c[i].low); }
    return hi - lo;
  }

  /* Least-squares line through (index, price) pairs. */
  function fit(points) {
    var n = points.length;
    if (n < 2) return null;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    points.forEach(function (p) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; });
    var den = n * sxx - sx * sx;
    if (!den) return null;
    var m = (n * sxy - sx * sy) / den, b = (sy - m * sx) / n;
    var err = 0;
    points.forEach(function (p) { var d = p.y - (m * p.x + b); err += d * d; });
    return { m: m, b: b, rms: Math.sqrt(err / n), n: n, at: function (x) { return m * x + b; } };
  }

  function seg(c, i1, v1, i2, v2) {
    return [{ time: c[i1].time, value: r2(v1) }, { time: c[i2].time, value: r2(v2) }];
  }
  function r2(n) { return Math.round(n * 100) / 100; }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function touches(c, line, from, to, tol, useHigh) {
    var n = 0;
    for (var i = from; i <= to; i++) {
      var v = useHigh ? c[i].high : c[i].low;
      if (Math.abs(v - line.at(i)) <= tol) n++;
    }
    return n;
  }

  /* ===================================================== trendline pairs */
  function trendPair(c, from, to, w) {
    var p = KT.levels.pivots(c, w);
    var hs = [], ls = [];
    p.highs.forEach(function (i) { if (i >= from && i <= to) hs.push(i); });
    p.lows.forEach(function (i) { if (i >= from && i <= to) ls.push(i); });
    // Three pivots minimum per rail. Two points define a line whatever the
    // data does, so a two-pivot "trendline" is a drawing, not a finding.
    if (hs.length < 3 || ls.length < 3) return null;

    var top = fit(hs.map(function (i) { return { x: i, y: c[i].high }; }));
    var bot = fit(ls.map(function (i) { return { x: i, y: c[i].low }; }));
    if (!top || !bot) return null;

    var a = atrAt(c, to), tol = a * 0.5;
    if (top.rms > a * 0.8 || bot.rms > a * 0.8) return null;
    var tTouch = touches(c, top, from, to, tol, true);
    var bTouch = touches(c, bot, from, to, tol, false);
    if (tTouch < 3 || bTouch < 3) return null;

    var startGap = top.at(from) - bot.at(from);
    var endGap = top.at(to) - bot.at(to);
    if (endGap <= a * 0.5 || startGap <= a * 0.5) return null;
    // The rails must contain the price action, not slice through it.
    var outside = 0;
    for (var i = from; i <= to; i++) {
      if (c[i].high > top.at(i) + a * 0.9 || c[i].low < bot.at(i) - a * 0.9) outside++;
    }
    if (outside > (to - from) * 0.12) return null;

    return {
      from: from, to: to, top: top, bot: bot, atr: a,
      topTouch: tTouch, botTouch: bTouch, pivots: hs.length + ls.length,
      startGap: startGap, endGap: endGap,
      converging: endGap < startGap * 0.7,
      diverging: endGap > startGap * 1.4,
      height: Math.max(startGap, endGap),
    };
  }

  function classifyPair(tp) {
    // "Flat" has to be judged against the structure, not against one bar. A
    // slope of two points per bar is nothing on a single candle and a 240
    // point climb across a 120 bar triangle, which is the whole difference
    // between an ascending triangle and a symmetrical one. So the test is how
    // far each rail travels over the structure's own span, relative to the
    // structure's own height.
    var span = Math.max(1, tp.to - tp.from);
    var st = tp.top.m, sb = tp.bot.m;
    var riseTop = st * span, riseBot = sb * span;
    var flatRise = tp.height * 0.25;
    var topFlat = Math.abs(riseTop) < flatRise, botFlat = Math.abs(riseBot) < flatRise;
    var flat = flatRise / span;

    if (tp.converging) {
      if (topFlat && riseBot > flatRise) return { key: 'asc_triangle', name: 'Ascending triangle', dir: 1 };
      if (botFlat && riseTop < -flatRise) return { key: 'desc_triangle', name: 'Descending triangle', dir: -1 };
      if (riseTop > flatRise && riseBot > flatRise) return { key: 'rising_wedge', name: 'Rising wedge', dir: -1 };
      if (riseTop < -flatRise && riseBot < -flatRise) return { key: 'falling_wedge', name: 'Falling wedge', dir: 1 };
      if (riseTop < -flatRise && riseBot > flatRise) return { key: 'sym_triangle', name: 'Symmetrical triangle', dir: 0 };
      return null;
    }
    if (!tp.diverging) {
      // A channel needs the two rails roughly parallel, not merely non-converging.
      var parallel = Math.abs(st - sb) < Math.max(flat, Math.abs(st) * 0.4);
      if (!parallel) return null;
      if (riseTop > flatRise && riseBot > flatRise) return { key: 'rising_channel', name: 'Rising channel', dir: 1 };
      if (riseTop < -flatRise && riseBot < -flatRise) return { key: 'falling_channel', name: 'Falling channel', dir: -1 };
      if (topFlat && botFlat) return { key: 'range', name: 'Sideways range', dir: 0 };
      return null;
    }
    return { key: 'broadening', name: 'Broadening formation', dir: 0 };
  }

  function buildPair(c, tp, cls) {
    var lastIdx = c.length - 1;
    var endIdx = Math.min(lastIdx, tp.to + Math.round((tp.to - tp.from) * 0.25));
    var price = c[lastIdx].close;
    var topEnd = tp.top.at(endIdx), botEnd = tp.bot.at(endIdx);
    var height = tp.height, dir = cls.dir;

    var upTrigger = r2(topEnd), downTrigger = r2(botEnd);
    var trigger = dir > 0 ? upTrigger : dir < 0 ? downTrigger
                : (price > (topEnd + botEnd) / 2 ? upTrigger : downTrigger);
    var target = trigger === upTrigger ? trigger + height : trigger - height;
    var stop = trigger === upTrigger ? downTrigger : upTrigger;

    var quality = clamp01(
      0.30 * Math.min(1, (tp.topTouch + tp.botTouch) / 10) +
      0.30 * Math.max(0, 1 - (tp.top.rms + tp.bot.rms) / (1.6 * tp.atr)) +
      0.20 * Math.min(1, (tp.pivots - 6) / 6 + 0.35) +
      0.20 * Math.min(1, (tp.to - tp.from) / 80)
    );

    return {
      key: cls.key, name: cls.name, dir: dir, kind: 'structure',
      from: tp.from, to: tp.to, index: tp.to, time: c[tp.to].time,
      lines: [
        { points: seg(c, tp.from, tp.top.at(tp.from), endIdx, topEnd), role: 'upper' },
        { points: seg(c, tp.from, tp.bot.at(tp.from), endIdx, botEnd), role: 'lower' },
      ],
      trigger: r2(trigger), target: r2(target), stop: r2(stop),
      height: r2(height), quality: Math.round(quality * 100) / 100,
      why: describe(cls.key), bars: tp.to - tp.from,
    };
  }

  function describe(k) {
    return ({
      asc_triangle: 'Flat ceiling, rising floor: buyers keep paying up into the same supply.',
      desc_triangle: 'Flat floor, falling ceiling: sellers keep hitting the same bid.',
      sym_triangle: 'Both rails compressing. Direction comes from the break, not the shape.',
      rising_wedge: 'Rising but narrowing: each push up is weaker than the last.',
      falling_wedge: 'Falling but narrowing: each push down is weaker than the last.',
      rising_channel: 'An orderly uptrend between parallel rails.',
      falling_channel: 'An orderly downtrend between parallel rails.',
      range: 'Price is rotating between a fixed floor and ceiling.',
      broadening: 'Widening swings: volatility expanding with no agreed direction.',
      double_top: 'Two failures at the same ceiling; the floor between them is the trigger.',
      double_bottom: 'Two holds at the same floor; the ceiling between them is the trigger.',
      head_shoulders: 'A failed higher high flanked by two lower ones; the neckline is the trigger.',
      inv_head_shoulders: 'A failed lower low flanked by two higher ones; the neckline is the trigger.',
      bull_flag: 'A fast rally, then a shallow drift down on quieter range.',
      bear_flag: 'A fast drop, then a shallow drift up on quieter range.',
      cup_handle: 'A rounded base back to the old high, then a shallow handle before the retest.',
    })[k] || '';
  }

  /* ===================================================== double top/bottom */
  function doubles(c, w, fromIdx) {
    var p = KT.levels.pivots(c, w), out = [];
    function scan(list, isTop) {
      for (var k = 1; k < list.length; k++) {
        var i1 = list[k - 1], i2 = list[k];
        if (i2 < (fromIdx || 0)) continue;
        if (i2 - i1 < w * 2 || i2 - i1 > 140) continue;
        var a = atrAt(c, i2);
        var v1 = isTop ? c[i1].high : c[i1].low, v2 = isTop ? c[i2].high : c[i2].low;
        if (Math.abs(v1 - v2) > a * 0.5) continue;

        var mid = i1, midV = isTop ? Infinity : -Infinity;
        for (var j = i1; j <= i2; j++) {
          var v = isTop ? c[j].low : c[j].high;
          if (isTop ? v < midV : v > midV) { midV = v; mid = j; }
        }
        var depth = isTop ? (v1 + v2) / 2 - midV : midV - (v1 + v2) / 2;
        if (depth < a * 2) continue;
        // Must be the dominant feature of its own window, not a ripple in a trend.
        var span = windowRange(c, i1, i2);
        if (depth < span * 0.45) continue;

        out.push({
          key: isTop ? 'double_top' : 'double_bottom',
          name: isTop ? 'Double top' : 'Double bottom',
          dir: isTop ? -1 : 1, kind: 'structure',
          from: i1, to: i2, index: i2, time: c[i2].time,
          lines: [
            { points: seg(c, i1, v1, i2, v2), role: isTop ? 'upper' : 'lower' },
            { points: seg(c, Math.max(0, i1 - w), midV, Math.min(c.length - 1, i2 + w), midV), role: 'neckline' },
          ],
          trigger: r2(midV),
          target: r2(isTop ? midV - depth : midV + depth),
          stop: r2((v1 + v2) / 2),
          height: r2(depth),
          quality: Math.round(clamp01(
            0.45 * (1 - Math.abs(v1 - v2) / (a * 0.5)) +
            0.30 * Math.min(1, depth / (a * 5)) +
            0.25 * Math.min(1, depth / span / 0.7)) * 100) / 100,
          why: describe(isTop ? 'double_top' : 'double_bottom'),
          bars: i2 - i1,
        });
      }
    }
    scan(p.highs, true); scan(p.lows, false);
    return out;
  }

  /* ================================================ head and shoulders */
  function headShoulders(c, w, fromIdx) {
    var p = KT.levels.pivots(c, w), out = [];
    function scan(list, isTop) {
      for (var k = 2; k < list.length; k++) {
        var l = list[k - 2], h = list[k - 1], r = list[k];
        if (r < (fromIdx || 0)) continue;
        if (r - l > 200 || r - l < w * 4) continue;
        var a = atrAt(c, r);
        var vl = isTop ? c[l].high : c[l].low;
        var vh = isTop ? c[h].high : c[h].low;
        var vr = isTop ? c[r].high : c[r].low;
        if (isTop ? !(vh > vl + a && vh > vr + a) : !(vh < vl - a && vh < vr - a)) continue;
        if (Math.abs(vl - vr) > a * 0.7) continue;

        function pit(i, j) {
          var bi = i, bv = isTop ? Infinity : -Infinity;
          for (var q = i; q <= j; q++) {
            var v = isTop ? c[q].low : c[q].high;
            if (isTop ? v < bv : v > bv) { bv = v; bi = q; }
          }
          return { i: bi, v: bv };
        }
        var t1 = pit(l, h), t2 = pit(h, r);
        // A neckline that tilts steeply is usually two unrelated troughs.
        if (Math.abs(t1.v - t2.v) > a * 1.4) continue;
        var neck = fit([{ x: t1.i, y: t1.v }, { x: t2.i, y: t2.v }]);
        if (!neck) continue;

        var depth = Math.abs(vh - (t1.v + t2.v) / 2);
        if (depth < a * 2.5) continue;
        var span = windowRange(c, l, r);
        if (depth < span * 0.5) continue;

        var endIdx = Math.min(c.length - 1, r + w * 2);
        var neckNow = neck.at(endIdx);
        out.push({
          key: isTop ? 'head_shoulders' : 'inv_head_shoulders',
          name: isTop ? 'Head and shoulders' : 'Inverse head and shoulders',
          dir: isTop ? -1 : 1, kind: 'structure',
          from: l, to: r, index: r, time: c[r].time,
          lines: [
            { points: [{ time: c[l].time, value: r2(vl) },
                       { time: c[h].time, value: r2(vh) },
                       { time: c[r].time, value: r2(vr) }], role: isTop ? 'upper' : 'lower' },
            { points: seg(c, t1.i, t1.v, endIdx, neckNow), role: 'neckline' },
          ],
          trigger: r2(neckNow),
          target: r2(isTop ? neckNow - depth : neckNow + depth),
          stop: r2(vh), height: r2(depth),
          quality: Math.round(clamp01(
            0.40 * (1 - Math.abs(vl - vr) / (a * 0.7)) +
            0.35 * Math.min(1, depth / (a * 6)) +
            0.25 * Math.min(1, depth / span / 0.75)) * 100) / 100,
          why: describe(isTop ? 'head_shoulders' : 'inv_head_shoulders'),
          bars: r - l,
        });
      }
    }
    scan(p.highs, true); scan(p.lows, false);
    return out;
  }

  /* ============================================================== flags */
  function flags(c, endAt) {
    var n = (endAt === undefined ? c.length - 1 : endAt);
    if (n < 45) return [];
    for (var fl = 5; fl <= 22; fl += 1) {
      var flagStart = n - fl;
      if (flagStart < 25) break;
      var a = atrAt(c, n);
      for (var pl = 8; pl <= 28; pl += 2) {
        var poleStart = flagStart - pl;
        if (poleStart < 1) break;
        var poleMove = c[flagStart].close - c[poleStart].close;
        if (Math.abs(poleMove) < a * 4) continue;
        // The pole has to be a clean run, not a round trip.
        var poleRange = windowRange(c, poleStart, flagStart);
        if (Math.abs(poleMove) < poleRange * 0.6) continue;

        var hi = -Infinity, lo = Infinity;
        for (var i = flagStart; i <= n; i++) { hi = Math.max(hi, c[i].high); lo = Math.min(lo, c[i].low); }
        var flagRange = hi - lo;
        if (flagRange > Math.abs(poleMove) * 0.45) continue;
        var drift = c[n].close - c[flagStart].close;
        if (poleMove > 0 && drift > a * 0.3) continue;
        if (poleMove < 0 && drift < -a * 0.3) continue;

        var up = poleMove > 0, trigger = up ? hi : lo;
        return [{
          key: up ? 'bull_flag' : 'bear_flag',
          name: up ? 'Bull flag' : 'Bear flag',
          dir: up ? 1 : -1, kind: 'structure',
          from: poleStart, to: n, index: n, time: c[n].time,
          lines: [
            { points: seg(c, poleStart, c[poleStart].close, flagStart, c[flagStart].close), role: 'pole' },
            { points: seg(c, flagStart, hi, n, hi), role: 'upper' },
            { points: seg(c, flagStart, lo, n, lo), role: 'lower' },
          ],
          trigger: r2(trigger), target: r2(trigger + poleMove),
          stop: r2(up ? lo : hi), height: r2(Math.abs(poleMove)),
          quality: Math.round(clamp01(
            0.5 * Math.min(1, Math.abs(poleMove) / (a * 9)) +
            0.5 * (1 - flagRange / (Math.abs(poleMove) * 0.45))) * 100) / 100,
          why: describe(up ? 'bull_flag' : 'bear_flag'),
          bars: n - poleStart,
        }];
      }
    }
    return [];
  }

  /* ======================================================= cup and handle */
  function cupHandle(c, w) {
    var p = KT.levels.pivots(c, w), out = [], highs = p.highs;
    for (var k = 1; k < highs.length; k++) {
      var l = highs[k - 1], r = highs[k];
      if (r - l < 30 || r - l > 220) continue;
      var a = atrAt(c, r);
      if (Math.abs(c[l].high - c[r].high) > a) continue;

      var bottom = l, bv = Infinity;
      for (var j = l; j <= r; j++) if (c[j].low < bv) { bv = c[j].low; bottom = j; }
      var depth = (c[l].high + c[r].high) / 2 - bv;
      if (depth < a * 3) continue;
      var centre = (bottom - l) / (r - l);
      if (centre < 0.32 || centre > 0.68) continue;

      var hEnd = Math.min(c.length - 1, r + Math.round((r - l) * 0.35));
      if (hEnd <= r + 4) continue;
      var hLo = Infinity;
      for (var q = r; q <= hEnd; q++) hLo = Math.min(hLo, c[q].low);
      var handleDepth = c[r].high - hLo;
      if (handleDepth > depth * 0.45 || handleDepth < a * 0.6) continue;

      var rim = Math.max(c[l].high, c[r].high);
      out.push({
        key: 'cup_handle', name: 'Cup and handle', dir: 1, kind: 'structure',
        from: l, to: hEnd, index: hEnd, time: c[hEnd].time,
        lines: [
          { points: seg(c, l, rim, hEnd, rim), role: 'neckline' },
          { points: [{ time: c[l].time, value: r2(c[l].high) },
                     { time: c[bottom].time, value: r2(bv) },
                     { time: c[r].time, value: r2(c[r].high) },
                     { time: c[hEnd].time, value: r2(hLo) }], role: 'lower' },
        ],
        trigger: r2(rim), target: r2(rim + depth), stop: r2(hLo), height: r2(depth),
        quality: Math.round(clamp01(0.5 * (1 - Math.abs(centre - 0.5) / 0.2) +
                                    0.5 * Math.min(1, depth / (a * 7))) * 100) / 100,
        why: describe('cup_handle'), bars: hEnd - l,
      });
    }
    return out.slice(-1);
  }

  /* ============================================================= scanner */
  function detect(candles, opts) {
    opts = opts || {};
    var c = candles;
    if (!c || c.length < 70) return [];
    var w = opts.pivotWidth || Math.max(3, Math.round(c.length / 90));
    var last = c.length - 1, out = [];

    [0.25, 0.4, 0.6].forEach(function (frac) {
      var span = Math.round(c.length * frac);
      if (span < 40) return;
      var tp = trendPair(c, Math.max(0, last - span), last, w);
      if (!tp) return;
      var cls = classifyPair(tp);
      if (!cls) return;
      out.push(buildPair(c, tp, cls));
    });

    var fresh = last - Math.round(c.length * 0.3);
    out = out
      .concat(doubles(c, w, fresh))
      .concat(headShoulders(c, w, fresh))
      .concat(flags(c))
      .concat(cupHandle(c, w));

    var minQ = opts.minQuality === undefined ? 0.45 : opts.minQuality;
    var best = {};
    out.forEach(function (s) {
      if (s.to < fresh) return;
      if (s.quality < minQ) return;
      if (!best[s.key] || s.quality > best[s.key].quality) best[s.key] = s;
    });

    var live = Object.keys(best).map(function (k) { return best[k]; });

    // A flat ceiling touched twice is a double top and also the upper rail of
    // an ascending triangle. Both readings are true; drawing both is clutter,
    // and the rail version carries the extra information about the lows. So a
    // two-peak pattern mostly inside an accepted rail structure is dropped.
    var RAIL = { asc_triangle: 1, desc_triangle: 1, sym_triangle: 1, rising_wedge: 1,
                 falling_wedge: 1, rising_channel: 1, falling_channel: 1, range: 1 };
    var TWO_PEAK = { double_top: 1, double_bottom: 1, head_shoulders: 1, inv_head_shoulders: 1 };
    var kept = [];
    // Rail structures are judged first so a two-peak reading of the same bars
    // can be recognised as a duplicate of one, whichever scored higher.
    var order = live.slice().sort(function (x, y) {
      var rx = RAIL[x.key] ? 1 : 0, ry = RAIL[y.key] ? 1 : 0;
      if (rx !== ry) return ry - rx;
      return y.quality - x.quality;
    });
    order.forEach(function (s) {
      if (TWO_PEAK[s.key]) {
        var buried = kept.some(function (k) {
          if (!RAIL[k.key]) return false;
          var overlap = Math.min(s.to, k.to) - Math.max(s.from, k.from);
          return overlap > (s.to - s.from) * 0.7;
        });
        if (buried) return;
      }
      kept.push(s);
    });
    live = kept;

    var price = c[last].close;
    live.forEach(function (s) {
      s.distToTrigger = r2((s.trigger - price) / price * 100);
      s.targetPct = r2((s.target - price) / price * 100);
      s.status = s.dir > 0 ? (price >= s.trigger ? 'triggered' : 'forming')
               : s.dir < 0 ? (price <= s.trigger ? 'triggered' : 'forming') : 'forming';
    });
    live.sort(function (x, y) { return y.quality - x.quality; });
    return live.slice(0, opts.limit || 5);
  }

  /* ========================================================== outcomes
     Every structure the same rules would have found across this instrument's
     own history, and what price actually did afterwards. A pattern counts as
     resolved only once its trigger was hit; until then it is still an idea,
     not a trade, and folding unresolved ones into the rate would flatter it.

     `hit` means price reached the measured target before the stop. That is a
     stricter and more useful question than "did it close higher". */
  function outcomes(candles, opts) {
    opts = opts || {};
    var c = candles;
    if (!c || c.length < 150) return {};
    var w = Math.max(3, Math.round(c.length / 90));
    var found = doubles(c, w, 0).concat(headShoulders(c, w, 0)).concat(cupHandle(c, w));

    // Triangles and channels on a rolling window, stepped so the same shape is
    // not counted a dozen times.
    var span = Math.min(120, Math.round(c.length / 4));
    for (var end = span + 20; end < c.length; end += Math.max(6, Math.round(span / 6))) {
      var tp = trendPair(c, end - span, end, w);
      if (!tp) continue;
      var cls = classifyPair(tp);
      if (!cls || !cls.dir) continue;
      var sub = c.slice(0, end + 1);
      var built = buildPair(sub, tp, cls);
      if (built.quality >= 0.45) found.push(built);
      var fg = flags(c, end);
      if (fg.length && fg[0].quality >= 0.45) found.push(fg[0]);
    }

    var byKey = {};
    var maxWait = opts.maxWait || 40;
    found.forEach(function (s) {
      if (!s.dir) return;
      var g = byKey[s.key] || (byKey[s.key] = {
        key: s.key, name: s.name, dir: s.dir, why: s.why,
        seen: 0, triggered: 0, hits: 0, stops: 0, open: 0, moves: [],
      });
      g.seen++;
      // Walk forward: first the trigger, then target vs stop.
      var t = -1;
      for (var i = s.to + 1; i < Math.min(c.length, s.to + 1 + maxWait); i++) {
        if (s.dir > 0 ? c[i].high >= s.trigger : c[i].low <= s.trigger) { t = i; break; }
      }
      if (t < 0) return;
      g.triggered++;
      var done = false;
      for (var j = t; j < Math.min(c.length, t + maxWait * 2); j++) {
        var hitTarget = s.dir > 0 ? c[j].high >= s.target : c[j].low <= s.target;
        var hitStop = s.dir > 0 ? c[j].low <= s.stop : c[j].high >= s.stop;
        if (hitTarget && hitStop) { g.stops++; done = true; break; }   // same bar: assume the worse
        if (hitTarget) { g.hits++; done = true; g.moves.push((s.target - s.trigger) / s.trigger * 100); break; }
        if (hitStop) { g.stops++; done = true; g.moves.push((s.stop - s.trigger) / s.trigger * 100); break; }
      }
      if (!done) {
        g.open++;
        var endI = Math.min(c.length - 1, t + maxWait * 2);
        g.moves.push((c[endI].close - s.trigger) / s.trigger * 100);
      }
    });

    Object.keys(byKey).forEach(function (k) {
      var g = byKey[k], resolved = g.hits + g.stops;
      g.resolved = resolved;
      g.hitRate = resolved ? Math.round(g.hits / resolved * 1000) / 10 : null;
      g.triggerRate = g.seen ? Math.round(g.triggered / g.seen * 1000) / 10 : null;
      g.avgMove = g.moves.length
        ? Math.round(g.moves.reduce(function (s2, x) { return s2 + x; }, 0) / g.moves.length * 100) / 100 : null;
      // Under eight resolved cases a rate is noise, and saying so is the point.
      g.reliable = resolved >= 8;
    });
    return byKey;
  }

  /* -------------------------------------------------- measured-move blend */
  function impliedBias(structures, price, stats) {
    if (!structures || !structures.length || !price) return { score: 0, note: 'no structure', target: null };
    var num = 0, den = 0, bestTarget = null, bestW = 0;
    structures.forEach(function (s) {
      if (!s.dir) return;
      var st = stats && stats[s.key];
      // A pattern with a measured record is trusted in proportion to it. One
      // without is allowed only half a vote.
      var evidence = (st && st.reliable && st.hitRate != null)
        ? Math.max(0.15, Math.min(1.4, st.hitRate / 50))
        : 0.5;
      var proximity = 1 / (1 + Math.abs(s.distToTrigger) / 0.8);
      var confirmed = s.status === 'triggered' ? 1.6 : 1;
      var w = s.quality * proximity * confirmed * evidence;
      var move = (s.target - price) / price * 100;
      num += Math.sign(move) * Math.min(1, Math.abs(move) / 2.5) * w;
      den += w;
      if (w > bestW) { bestW = w; bestTarget = s; }
    });
    if (!den) return { score: 0, note: 'no directional structure', target: null };
    return {
      score: Math.max(-1, Math.min(1, num / den)),
      note: bestTarget ? (bestTarget.name + ' ' + bestTarget.status + ', target ' + bestTarget.target) : '',
      target: bestTarget,
    };
  }

  KT.structures = { detect: detect, outcomes: outcomes, impliedBias: impliedBias, fit: fit };
})(window.KT);
