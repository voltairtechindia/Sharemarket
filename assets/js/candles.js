/* ============================================================================
   The candlestick library.

   Every named candlestick pattern in common use, in one table. Sixty-one
   families - the set TA-Lib settled on, which is what every charting site,
   screener and textbook has since converged to - split into explicit bullish
   and bearish entries where the family carries both, plus two gap markers this
   repo already had and TA-Lib does not name.

   Why a table and not sixty-one functions: patterns.js already owns the part
   that matters, which is measuring how each pattern has actually resolved on
   this instrument's own history. A detector that is a row in an array gets
   that scoring for free and cannot be added without it. A pattern with a name
   and no record is decoration, and this repo's position is that decoration
   which looks like evidence is worse than nothing.

   Three rules every row here follows:

     Thresholds are in ATR, never in points. The same rule has to work on a
     1-minute NIFTY bar worth 4 points and a monthly one worth 900.

     Trend context is required where the textbook requires it. A hammer in an
     uptrend is a hanging man; they are the same candle and opposite calls, so
     a detector that ignores the preceding bars is not detecting either of
     them. fell() and rose() are what separate them.

     Rarity is not hidden. Several of these - concealing baby swallow, ladder
     bottom, three stars in the south - fire a handful of times a decade. They
     are in the table because they are in the canon, and the record beside them
     will honestly read n=0 for a long time. That is the right answer, not a
     reason to loosen the rule until something matches.

   TA-Lib is BSD-licensed; this is an independent implementation of the same
   named patterns from their standard published definitions, not a translation
   of its source.
   ========================================================================== */
(function (KT) {
  'use strict';

  /* ----------------------------------------------------------------- shape */
  function body(b) { return Math.abs(b.close - b.open); }
  function upper(b) { return b.high - Math.max(b.open, b.close); }
  function lower(b) { return Math.min(b.open, b.close) - b.low; }
  function range(b) { return (b.high - b.low) || 1e-9; }
  function isUp(b) { return b.close > b.open; }
  function isDn(b) { return b.close < b.open; }
  function mid(b) { return (b.open + b.close) / 2; }
  function top(b) { return Math.max(b.open, b.close); }
  function bot(b) { return Math.min(b.open, b.close); }

  /* Body size, judged against the local ATR rather than against the bar's own
     range. Judging a body against its own range calls a 2-point bar with no
     wicks a marubozu, which is true and useless - on an index that bar is
     noise. */
  function longB(b, a) { return body(b) > 0.6 * a; }
  function shortB(b, a) { return body(b) < 0.3 * a; }
  function realish(b, a) { return range(b) > 0.35 * a; }
  function doji(b) { return body(b) <= range(b) * 0.08; }

  /* Trend context. Five bars, because the patterns that need it are reversal
     patterns and five bars is the shortest run a reader would call a move. */
  function fell(c, i, n) { n = n || 5; return !!c[i - n] && c[i - n].close > c[i - 1].close; }
  function rose(c, i, n) { n = n || 5; return !!c[i - n] && c[i - n].close < c[i - 1].close; }

  /* A true gap: no overlap at all between the two bars' full ranges. A body
     gap is a different and much weaker thing, and several patterns below turn
     on which one it is, so they are never conflated here. */
  function gapUp(p, b, a) { return b.low > p.high + 0.05 * a; }
  function gapDn(p, b, a) { return b.high < p.low - 0.05 * a; }
  function bodyGapUp(p, b) { return bot(b) > top(p); }
  function bodyGapDn(p, b) { return top(b) < bot(p); }

  /* Marubozu: a body with effectively no wick. 5% of the range either end. */
  function noUpper(b) { return upper(b) <= range(b) * 0.05; }
  function noLower(b) { return lower(b) <= range(b) * 0.05; }

  var SET = [
    /* ------------------------------------------------------ single bar --- */
    { key: 'doji', name: 'Doji', dir: 0, need: 2,
      why: 'Open and close almost equal: neither side finished in control.',
      test: function (c, i, a) { return doji(c[i]) && realish(c[i], a); } },

    { key: 'doji_long_legged', name: 'Long-legged doji', dir: 0, need: 2,
      why: 'A doji with long wicks both ways: a wide fight that settled nowhere.',
      test: function (c, i, a) {
        var b = c[i];
        return doji(b) && upper(b) > range(b) * 0.3 && lower(b) > range(b) * 0.3 && realish(b, a);
      } },

    { key: 'doji_dragonfly', name: 'Dragonfly doji', dir: 1, need: 2,
      why: 'Opened, sold off hard, closed back at the high. Sellers tried and failed.',
      test: function (c, i, a) {
        var b = c[i];
        return doji(b) && lower(b) > range(b) * 0.7 && upper(b) < range(b) * 0.1 && realish(b, a);
      } },

    { key: 'doji_gravestone', name: 'Gravestone doji', dir: -1, need: 2,
      why: 'Opened, rallied hard, gave it all back by the close. Buyers tried and failed.',
      test: function (c, i, a) {
        var b = c[i];
        return doji(b) && upper(b) > range(b) * 0.7 && lower(b) < range(b) * 0.1 && realish(b, a);
      } },

    /* Takuri is a dragonfly whose lower shadow is not merely long but extreme.
       TA-Lib keeps it separate from the dragonfly for exactly that reason. */
    { key: 'takuri', name: 'Takuri line', dir: 1, need: 6,
      why: 'A dragonfly doji with an unusually deep spike below, after a fall.',
      test: function (c, i, a) {
        var b = c[i];
        return doji(b) && lower(b) > range(b) * 0.82 && upper(b) < range(b) * 0.06 &&
               range(b) > 0.8 * a && fell(c, i);
      } },

    { key: 'rickshaw_man', name: 'Rickshaw man', dir: 0, need: 2,
      why: 'A long-legged doji whose body sits in the middle of the range: perfect indecision.',
      test: function (c, i, a) {
        var b = c[i];
        if (!doji(b) || !realish(b, a)) return false;
        var m = (b.high + b.low) / 2;
        return Math.abs(mid(b) - m) < range(b) * 0.1 &&
               upper(b) > range(b) * 0.3 && lower(b) > range(b) * 0.3;
      } },

    { key: 'hammer', name: 'Hammer', dir: 1, need: 6,
      why: 'Long lower wick after a decline: sellers pushed down and lost it.',
      test: function (c, i, a) {
        var b = c[i];
        return lower(b) > body(b) * 2 && upper(b) < body(b) * 0.8 &&
               !doji(b) && range(b) > 0.5 * a && fell(c, i);
      } },

    /* Same candle as the hammer. Opposite call, because it appears after a
       rise rather than a fall. Two rows rather than one, because a reader
       looking at the record wants to know which of the two situations it is. */
    { key: 'hanging_man', name: 'Hanging man', dir: -1, need: 6,
      why: 'A hammer-shaped bar after a rally: the same long lower wick, now a warning.',
      test: function (c, i, a) {
        var b = c[i];
        return lower(b) > body(b) * 2 && upper(b) < body(b) * 0.8 &&
               !doji(b) && range(b) > 0.5 * a && rose(c, i);
      } },

    { key: 'inverted_hammer', name: 'Inverted hammer', dir: 1, need: 6,
      why: 'Long upper wick after a decline: buyers showed up, even if they did not hold it.',
      test: function (c, i, a) {
        var b = c[i];
        return upper(b) > body(b) * 2 && lower(b) < body(b) * 0.8 &&
               !doji(b) && range(b) > 0.5 * a && fell(c, i);
      } },

    { key: 'shooting_star', name: 'Shooting star', dir: -1, need: 6,
      why: 'Long upper wick after a rise: buyers pushed up and lost it.',
      test: function (c, i, a) {
        var b = c[i];
        return upper(b) > body(b) * 2 && lower(b) < body(b) * 0.8 &&
               !doji(b) && range(b) > 0.5 * a && rose(c, i);
      } },

    { key: 'marubozu_bull', name: 'Bullish marubozu', dir: 1, need: 2,
      why: 'A long up bar with no wicks: bought from the first tick to the last.',
      test: function (c, i, a) {
        var b = c[i];
        return isUp(b) && longB(b, a) && noUpper(b) && noLower(b);
      } },

    { key: 'marubozu_bear', name: 'Bearish marubozu', dir: -1, need: 2,
      why: 'A long down bar with no wicks: sold from the first tick to the last.',
      test: function (c, i, a) {
        var b = c[i];
        return isDn(b) && longB(b, a) && noUpper(b) && noLower(b);
      } },

    { key: 'marubozu_close_bull', name: 'Bullish closing marubozu', dir: 1, need: 2,
      why: 'A long up bar that closed on its high. It may have dipped, but it finished at the top.',
      test: function (c, i, a) {
        var b = c[i];
        return isUp(b) && longB(b, a) && noUpper(b) && !noLower(b);
      } },

    { key: 'marubozu_close_bear', name: 'Bearish closing marubozu', dir: -1, need: 2,
      why: 'A long down bar that closed on its low. Whatever bounce there was did not survive.',
      test: function (c, i, a) {
        var b = c[i];
        return isDn(b) && longB(b, a) && noLower(b) && !noUpper(b);
      } },

    { key: 'belthold_bull', name: 'Bullish belt hold', dir: 1, need: 6,
      why: 'Opened at the low after a fall and never went back: a shift in who is in charge.',
      test: function (c, i, a) {
        var b = c[i];
        return isUp(b) && longB(b, a) && noLower(b) && fell(c, i);
      } },

    { key: 'belthold_bear', name: 'Bearish belt hold', dir: -1, need: 6,
      why: 'Opened at the high after a rally and never recovered it.',
      test: function (c, i, a) {
        var b = c[i];
        return isDn(b) && longB(b, a) && noUpper(b) && rose(c, i);
      } },

    { key: 'long_line', name: 'Long line', dir: 0, need: 2,
      why: 'An unusually long body with small wicks. Direction is whatever the body says; the point is the size.',
      test: function (c, i, a) {
        var b = c[i];
        return longB(b, a) && upper(b) < range(b) * 0.2 && lower(b) < range(b) * 0.2;
      } },

    { key: 'short_line', name: 'Short line', dir: 0, need: 2,
      why: 'A short body with short wicks: the bar barely happened.',
      test: function (c, i, a) {
        var b = c[i];
        return shortB(b, a) && !doji(b) && upper(b) < range(b) * 0.25 && lower(b) < range(b) * 0.25;
      } },

    { key: 'spinning_top', name: 'Spinning top', dir: 0, need: 2,
      why: 'Small body between two real wicks: the bar moved both ways and resolved nothing.',
      test: function (c, i, a) {
        var b = c[i];
        return !doji(b) && body(b) < range(b) * 0.3 &&
               upper(b) > body(b) && lower(b) > body(b) && realish(b, a);
      } },

    { key: 'high_wave', name: 'High wave', dir: 0, need: 2,
      why: 'A tiny body with very long wicks both ways: a violent bar that went nowhere.',
      test: function (c, i, a) {
        var b = c[i];
        return !doji(b) && body(b) < range(b) * 0.2 &&
               upper(b) > range(b) * 0.35 && lower(b) > range(b) * 0.35 && range(b) > 0.9 * a;
      } },

    /* ---------------------------------------------------------- two bar --- */
    { key: 'engulf_bull', name: 'Bullish engulfing', dir: 1, need: 3,
      why: 'A down bar fully swallowed by the next up bar.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isDn(p) && isUp(b) && body(p) > 0.1 * a &&
               b.close >= p.open && b.open <= p.close && body(b) > body(p) * 1.1;
      } },

    { key: 'engulf_bear', name: 'Bearish engulfing', dir: -1, need: 3,
      why: 'An up bar fully swallowed by the next down bar.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isUp(p) && isDn(b) && body(p) > 0.1 * a &&
               b.close <= p.open && b.open >= p.close && body(b) > body(p) * 1.1;
      } },

    { key: 'harami_bull', name: 'Bullish harami', dir: 1, need: 6,
      why: 'A long down bar, then a small up bar entirely inside it: the selling stopped.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isDn(p) && longB(p, a) && isUp(b) &&
               top(b) < top(p) && bot(b) > bot(p) && body(b) < body(p) * 0.6 && fell(c, i);
      } },

    { key: 'harami_bear', name: 'Bearish harami', dir: -1, need: 6,
      why: 'A long up bar, then a small down bar entirely inside it: the buying stopped.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isUp(p) && longB(p, a) && isDn(b) &&
               top(b) < top(p) && bot(b) > bot(p) && body(b) < body(p) * 0.6 && rose(c, i);
      } },

    { key: 'harami_cross_bull', name: 'Bullish harami cross', dir: 1, need: 6,
      why: 'A harami whose inside bar is a doji: the same stall, stated more strongly.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isDn(p) && longB(p, a) && doji(b) &&
               b.high < top(p) && b.low > bot(p) && fell(c, i);
      } },

    { key: 'harami_cross_bear', name: 'Bearish harami cross', dir: -1, need: 6,
      why: 'A bearish harami whose inside bar is a doji.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isUp(p) && longB(p, a) && doji(b) &&
               b.high < top(p) && b.low > bot(p) && rose(c, i);
      } },

    { key: 'piercing', name: 'Piercing line', dir: 1, need: 6,
      why: 'Opened below the last bar’s low, then closed back above its midpoint.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isDn(p) && longB(p, a) && isUp(b) &&
               b.open < p.low && b.close > mid(p) && b.close < p.open && fell(c, i);
      } },

    { key: 'dark_cloud', name: 'Dark cloud cover', dir: -1, need: 6,
      why: 'Opened above the last bar’s high, then closed back below its midpoint.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isUp(p) && longB(p, a) && isDn(b) &&
               b.open > p.high && b.close < mid(p) && b.close > p.open && rose(c, i);
      } },

    { key: 'tweezer_bottom', name: 'Tweezer bottom', dir: 1, need: 6,
      why: 'Two bars rejecting the same low. The second failure is the one that counts.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return Math.abs(p.low - b.low) < 0.08 * a && isDn(p) && isUp(b) && fell(c, i);
      } },

    { key: 'tweezer_top', name: 'Tweezer top', dir: -1, need: 6,
      why: 'Two bars rejecting the same high.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return Math.abs(p.high - b.high) < 0.08 * a && isUp(p) && isDn(b) && rose(c, i);
      } },

    { key: 'matching_low', name: 'Matching low', dir: 1, need: 6,
      why: 'Two down bars closing at the same price: a floor being tested and held.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isDn(p) && isDn(b) && Math.abs(p.close - b.close) < 0.04 * a && fell(c, i);
      } },

    { key: 'homing_pigeon', name: 'Homing pigeon', dir: 1, need: 6,
      why: 'A long down bar, then a smaller down bar inside it: still falling, with less conviction.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isDn(p) && isDn(b) && longB(p, a) &&
               b.open < p.open && b.close > p.close && body(b) < body(p) * 0.7 && fell(c, i);
      } },

    { key: 'on_neck', name: 'On-neck line', dir: -1, need: 6,
      why: 'A weak bounce that only reached the previous close. The downtrend is intact.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isDn(p) && longB(p, a) && isUp(b) &&
               b.open < p.low && Math.abs(b.close - p.close) < 0.08 * a && fell(c, i);
      } },

    { key: 'in_neck', name: 'In-neck line', dir: -1, need: 6,
      why: 'A bounce that closed barely inside the previous body. Weaker than it looks.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isDn(p) && longB(p, a) && isUp(b) && b.open < p.low &&
               b.close >= p.close && b.close < p.close + 0.2 * a && b.close < mid(p) && fell(c, i);
      } },

    { key: 'thrusting', name: 'Thrusting line', dir: -1, need: 6,
      why: 'A bounce that got into the previous body but stopped short of its middle.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isDn(p) && longB(p, a) && isUp(b) && b.open < p.low &&
               b.close > p.close && b.close < mid(p) && fell(c, i);
      } },

    { key: 'counterattack_bull', name: 'Bullish counterattack', dir: 1, need: 6,
      why: 'Gapped down and closed right back at the previous close. The gap was rejected in one bar.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isDn(p) && isUp(b) && b.open < p.low &&
               Math.abs(b.close - p.close) < 0.08 * a && fell(c, i);
      } },

    { key: 'counterattack_bear', name: 'Bearish counterattack', dir: -1, need: 6,
      why: 'Gapped up and closed right back at the previous close.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isUp(p) && isDn(b) && b.open > p.high &&
               Math.abs(b.close - p.close) < 0.08 * a && rose(c, i);
      } },

    { key: 'separating_bull', name: 'Bullish separating lines', dir: 1, need: 7,
      why: 'A down bar in an uptrend, then an up bar opening at the same price. The interruption is over.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isDn(p) && isUp(b) && longB(b, a) &&
               Math.abs(b.open - p.open) < 0.08 * a && noLower(b) && rose(c, i, 6);
      } },

    { key: 'separating_bear', name: 'Bearish separating lines', dir: -1, need: 7,
      why: 'An up bar in a downtrend, then a down bar opening at the same price.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isUp(p) && isDn(b) && longB(b, a) &&
               Math.abs(b.open - p.open) < 0.08 * a && noUpper(b) && fell(c, i, 6);
      } },

    { key: 'kicking_bull', name: 'Bullish kicking', dir: 1, need: 3,
      why: 'A bearish marubozu, then a bullish one gapping clear above it. No overlap at all.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isDn(p) && noUpper(p) && noLower(p) && longB(p, a) &&
               isUp(b) && noUpper(b) && noLower(b) && longB(b, a) && gapUp(p, b, a);
      } },

    { key: 'kicking_bear', name: 'Bearish kicking', dir: -1, need: 3,
      why: 'A bullish marubozu, then a bearish one gapping clear below it.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isUp(p) && noUpper(p) && noLower(p) && longB(p, a) &&
               isDn(b) && noUpper(b) && noLower(b) && longB(b, a) && gapDn(p, b, a);
      } },

    { key: 'doji_star_bull', name: 'Bullish doji star', dir: 1, need: 6,
      why: 'A long down bar, then a doji gapping below it. The fall has run out of sellers.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isDn(p) && longB(p, a) && doji(b) && bodyGapDn(p, b) && fell(c, i);
      } },

    { key: 'doji_star_bear', name: 'Bearish doji star', dir: -1, need: 6,
      why: 'A long up bar, then a doji gapping above it. The rally has run out of buyers.',
      test: function (c, i, a) {
        var p = c[i - 1], b = c[i];
        return isUp(p) && longB(p, a) && doji(b) && bodyGapUp(p, b) && rose(c, i);
      } },

    /* -------------------------------------------------------- three bar --- */
    { key: 'morning_star', name: 'Morning star', dir: 1, need: 6,
      why: 'Heavy down bar, a small pause, then a strong recovery.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(x) && longB(x, a) && shortB(m, a) && bodyGapDn(x, m) &&
               isUp(z) && z.close > mid(x) && fell(c, i);
      } },

    { key: 'evening_star', name: 'Evening star', dir: -1, need: 6,
      why: 'Strong up bar, a small pause, then a heavy reversal.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(x) && longB(x, a) && shortB(m, a) && bodyGapUp(x, m) &&
               isDn(z) && z.close < mid(x) && rose(c, i);
      } },

    { key: 'morning_doji_star', name: 'Morning doji star', dir: 1, need: 6,
      why: 'A morning star whose middle bar is a doji: the pause was a dead stop.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(x) && longB(x, a) && doji(m) && bodyGapDn(x, m) &&
               isUp(z) && z.close > mid(x) && fell(c, i);
      } },

    { key: 'evening_doji_star', name: 'Evening doji star', dir: -1, need: 6,
      why: 'An evening star whose middle bar is a doji.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(x) && longB(x, a) && doji(m) && bodyGapUp(x, m) &&
               isDn(z) && z.close < mid(x) && rose(c, i);
      } },

    /* The abandoned baby is the strict version: the middle doji must gap on
       BOTH sides on the full range, not just the body. That is what makes it
       rare, and loosening it would turn it into the doji star above. */
    { key: 'abandoned_baby_bull', name: 'Bullish abandoned baby', dir: 1, need: 6,
      why: 'A doji islanded below by gaps on both sides. Rare, and the cleanest bottom signal there is.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(x) && doji(m) && gapDn(x, m, a) && isUp(z) && gapUp(m, z, a) && fell(c, i);
      } },

    { key: 'abandoned_baby_bear', name: 'Bearish abandoned baby', dir: -1, need: 6,
      why: 'A doji islanded above by gaps on both sides.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(x) && doji(m) && gapUp(x, m, a) && isDn(z) && gapDn(m, z, a) && rose(c, i);
      } },

    { key: 'tristar_bull', name: 'Bullish tristar', dir: 1, need: 6,
      why: 'Three dojis in a row, the middle one lowest. Total exhaustion at a low.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return doji(x) && doji(m) && doji(z) && mid(m) < mid(x) && mid(m) < mid(z) && fell(c, i);
      } },

    { key: 'tristar_bear', name: 'Bearish tristar', dir: -1, need: 6,
      why: 'Three dojis in a row, the middle one highest.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return doji(x) && doji(m) && doji(z) && mid(m) > mid(x) && mid(m) > mid(z) && rose(c, i);
      } },

    { key: 'three_inside_up', name: 'Three inside up', dir: 1, need: 6,
      why: 'A bullish harami, confirmed by a third bar closing above it.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(x) && longB(x, a) && isUp(m) && top(m) < top(x) && bot(m) > bot(x) &&
               isUp(z) && z.close > x.open && fell(c, i);
      } },

    { key: 'three_inside_down', name: 'Three inside down', dir: -1, need: 6,
      why: 'A bearish harami, confirmed by a third bar closing below it.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(x) && longB(x, a) && isDn(m) && top(m) < top(x) && bot(m) > bot(x) &&
               isDn(z) && z.close < x.open && rose(c, i);
      } },

    { key: 'three_outside_up', name: 'Three outside up', dir: 1, need: 6,
      why: 'A bullish engulfing, confirmed by a third bar closing higher still.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(x) && isUp(m) && m.close >= x.open && m.open <= x.close &&
               isUp(z) && z.close > m.close && fell(c, i);
      } },

    { key: 'three_outside_down', name: 'Three outside down', dir: -1, need: 6,
      why: 'A bearish engulfing, confirmed by a third bar closing lower still.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(x) && isDn(m) && m.close <= x.open && m.open >= x.close &&
               isDn(z) && z.close < m.close && rose(c, i);
      } },

    { key: 'three_soldiers', name: 'Three white soldiers', dir: 1, need: 4,
      why: 'Three strong up bars in a row, each opening inside the last and closing higher.',
      test: function (c, i, a) {
        for (var k = i - 2; k <= i; k++) {
          if (!isUp(c[k]) || body(c[k]) < 0.4 * a) return false;
          if (upper(c[k]) > body(c[k]) * 0.5) return false;
          if (k > i - 2 && (c[k].close <= c[k - 1].close || c[k].open > c[k - 1].close)) return false;
        }
        return true;
      } },

    { key: 'three_crows', name: 'Three black crows', dir: -1, need: 4,
      why: 'Three strong down bars in a row, each opening inside the last and closing lower.',
      test: function (c, i, a) {
        for (var k = i - 2; k <= i; k++) {
          if (!isDn(c[k]) || body(c[k]) < 0.4 * a) return false;
          if (lower(c[k]) > body(c[k]) * 0.5) return false;
          if (k > i - 2 && (c[k].close >= c[k - 1].close || c[k].open < c[k - 1].close)) return false;
        }
        return true;
      } },

    { key: 'identical_three_crows', name: 'Identical three crows', dir: -1, need: 4,
      why: 'Three black crows where each opens at the previous close. No bounce at all between them.',
      test: function (c, i, a) {
        for (var k = i - 2; k <= i; k++) {
          if (!isDn(c[k]) || body(c[k]) < 0.4 * a) return false;
          if (k > i - 2 && Math.abs(c[k].open - c[k - 1].close) > 0.06 * a) return false;
          if (k > i - 2 && c[k].close >= c[k - 1].close) return false;
        }
        return true;
      } },

    { key: 'advance_block', name: 'Advance block', dir: -1, need: 5,
      why: 'Three up bars, each smaller than the last with growing upper wicks. The rally is tiring.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(x) && isUp(m) && isUp(z) && longB(x, a) &&
               m.close > x.close && z.close > m.close &&
               body(m) < body(x) && body(z) < body(m) &&
               upper(z) > body(z) * 0.5 && upper(m) > upper(x);
      } },

    { key: 'stalled', name: 'Stalled pattern', dir: -1, need: 5,
      why: 'Three up bars where the third is a small body riding on the second. The push has stopped.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(x) && isUp(m) && isUp(z) && longB(x, a) && longB(m, a) &&
               m.close > x.close && shortB(z, a) && z.open >= m.close - 0.1 * a &&
               z.close > m.close;
      } },

    { key: 'two_crows', name: 'Two crows', dir: -1, need: 6,
      why: 'A long up bar, a gap up that failed, then a bar closing back inside the first.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(x) && longB(x, a) && isDn(m) && bodyGapUp(x, m) &&
               isDn(z) && z.open < m.open && z.open > m.close &&
               z.close > x.open && z.close < x.close && rose(c, i);
      } },

    { key: 'upside_gap_two_crows', name: 'Upside gap two crows', dir: -1, need: 6,
      why: 'A gap up, then two down bars eating it, the second swallowing the first.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(x) && longB(x, a) && isDn(m) && bodyGapUp(x, m) &&
               isDn(z) && z.open > m.open && z.close < m.close && z.close > x.close && rose(c, i);
      } },

    { key: 'unique_3_river', name: 'Unique three river', dir: 1, need: 6,
      why: 'A long down bar, a harami making a new low, then a tiny up bar holding above it.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(x) && longB(x, a) && isDn(m) &&
               m.open <= x.open && m.close >= x.close && m.low < x.low &&
               isUp(z) && shortB(z, a) && z.close < m.close && z.open >= m.low && fell(c, i);
      } },

    { key: 'three_stars_south', name: 'Three stars in the south', dir: 1, need: 6,
      why: 'Three down bars, each smaller with a shallower low. Selling exhausting itself. Very rare.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(x) && longB(x, a) && lower(x) > body(x) * 0.3 &&
               isDn(m) && m.open < x.open && m.open > x.close && m.low > x.low && body(m) < body(x) &&
               isDn(z) && body(z) < body(m) && noUpper(z) && noLower(z) &&
               z.low >= m.low && z.high <= m.high && fell(c, i);
      } },

    { key: 'stick_sandwich', name: 'Stick sandwich', dir: 1, need: 6,
      why: 'Two down bars closing at the same price with an up bar between them: a floor found twice.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(x) && isUp(m) && isDn(z) &&
               Math.abs(z.close - x.close) < 0.06 * a && m.low > x.close && fell(c, i);
      } },

    { key: 'gap_side_white_up', name: 'Up-gap side-by-side white lines', dir: 1, need: 6,
      why: 'A gap up, then two up bars of the same size opening together. The gap is being defended.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(m) && isUp(z) && gapUp(x, m, a) &&
               Math.abs(m.open - z.open) < 0.1 * a &&
               Math.abs(body(m) - body(z)) < Math.max(body(m), body(z)) * 0.35;
      } },

    { key: 'gap_side_white_dn', name: 'Down-gap side-by-side white lines', dir: -1, need: 6,
      why: 'A gap down, then two up bars of the same size that fail to close it.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(m) && isUp(z) && gapDn(x, m, a) &&
               Math.abs(m.open - z.open) < 0.1 * a &&
               Math.abs(body(m) - body(z)) < Math.max(body(m), body(z)) * 0.35;
      } },

    { key: 'tasuki_up', name: 'Upside Tasuki gap', dir: 1, need: 6,
      why: 'A gap up, then a down bar that pushes into the gap without closing it.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(x) && isUp(m) && gapUp(x, m, a) && isDn(z) &&
               z.open > bot(m) && z.open < top(m) && z.close < m.open && z.close > x.close;
      } },

    { key: 'tasuki_dn', name: 'Downside Tasuki gap', dir: -1, need: 6,
      why: 'A gap down, then an up bar that pushes into the gap without closing it.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(x) && isDn(m) && gapDn(x, m, a) && isUp(z) &&
               z.open > bot(m) && z.open < top(m) && z.close > m.open && z.close < x.close;
      } },

    /* -------------------------------------------------- four and five --- */
    { key: 'three_line_strike_bull', name: 'Bullish three-line strike', dir: 1, need: 6,
      why: 'Three rising bars, then one down bar swallowing all three. Usually a continuation, not a reversal.',
      test: function (c, i, a) {
        var w = c[i - 3], x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(w) && isUp(x) && isUp(m) &&
               x.close > w.close && m.close > x.close &&
               isDn(z) && z.open > m.close && z.close < w.open;
      } },

    { key: 'three_line_strike_bear', name: 'Bearish three-line strike', dir: -1, need: 6,
      why: 'Three falling bars, then one up bar swallowing all three.',
      test: function (c, i, a) {
        var w = c[i - 3], x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(w) && isDn(x) && isDn(m) &&
               x.close < w.close && m.close < x.close &&
               isUp(z) && z.open < m.close && z.close > w.open;
      } },

    { key: 'conceal_baby_swallow', name: 'Concealing baby swallow', dir: 1, need: 6,
      why: 'Four black bars ending with one entirely inside the last. Almost never fires.',
      test: function (c, i, a) {
        var w = c[i - 3], x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(w) && noUpper(w) && noLower(w) && isDn(x) && noUpper(x) && noLower(x) &&
               isDn(m) && m.open < x.close && m.high > x.close &&
               isDn(z) && z.high <= m.high && z.low >= m.low && fell(c, i);
      } },

    { key: 'ladder_bottom', name: 'Ladder bottom', dir: 1, need: 7,
      why: 'Three falling bars, one with an upper wick, then a gap-up reversal. Rare.',
      test: function (c, i, a) {
        var v = c[i - 4], w = c[i - 3], x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(v) && isDn(w) && isDn(x) &&
               w.open < v.open && w.close < v.close && x.open < w.open && x.close < w.close &&
               isDn(m) && upper(m) > body(m) * 0.5 &&
               isUp(z) && z.open > top(m) && fell(c, i);
      } },

    { key: 'breakaway_bull', name: 'Bullish breakaway', dir: 1, need: 7,
      why: 'A gap down, three bars drifting lower, then one bar closing back into the gap.',
      test: function (c, i, a) {
        var v = c[i - 4], w = c[i - 3], x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(v) && longB(v, a) && gapDn(v, w, a) && isDn(w) &&
               x.close < w.close && isDn(m) && m.close < x.close &&
               isUp(z) && longB(z, a) && z.close > bot(w) && z.close < bot(v);
      } },

    { key: 'breakaway_bear', name: 'Bearish breakaway', dir: -1, need: 7,
      why: 'A gap up, three bars drifting higher, then one bar closing back into the gap.',
      test: function (c, i, a) {
        var v = c[i - 4], w = c[i - 3], x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(v) && longB(v, a) && gapUp(v, w, a) && isUp(w) &&
               x.close > w.close && isUp(m) && m.close > x.close &&
               isDn(z) && longB(z, a) && z.close < top(w) && z.close > top(v);
      } },

    { key: 'rising_three', name: 'Rising three methods', dir: 1, need: 7,
      why: 'A long up bar, three small bars drifting back inside it, then a new high. A pause, not a top.',
      test: function (c, i, a) {
        var v = c[i - 4], w = c[i - 3], x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(v) && longB(v, a) &&
               shortB(w, a) && shortB(x, a) && shortB(m, a) &&
               Math.max(w.high, x.high, m.high) < v.high &&
               Math.min(w.low, x.low, m.low) > v.low &&
               isUp(z) && z.close > v.close;
      } },

    { key: 'falling_three', name: 'Falling three methods', dir: -1, need: 7,
      why: 'A long down bar, three small bars drifting back inside it, then a new low.',
      test: function (c, i, a) {
        var v = c[i - 4], w = c[i - 3], x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(v) && longB(v, a) &&
               shortB(w, a) && shortB(x, a) && shortB(m, a) &&
               Math.max(w.high, x.high, m.high) < v.high &&
               Math.min(w.low, x.low, m.low) > v.low &&
               isDn(z) && z.close < v.close;
      } },

    { key: 'mat_hold', name: 'Mat hold', dir: 1, need: 7,
      why: 'Rising three methods that gaps up first. The strongest continuation shape in the set.',
      test: function (c, i, a) {
        var v = c[i - 4], w = c[i - 3], x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(v) && longB(v, a) && bodyGapUp(v, w) &&
               shortB(w, a) && shortB(x, a) && shortB(m, a) &&
               Math.min(w.low, x.low, m.low) > bot(v) &&
               isUp(z) && z.close > Math.max(v.high, w.high, x.high, m.high);
      } },

    { key: 'gap3_up', name: 'Upside gap three methods', dir: 1, need: 6,
      why: 'Two up bars with a gap between them, then a bar that fills the gap and stops. Continuation.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isUp(x) && isUp(m) && gapUp(x, m, a) &&
               isDn(z) && z.open > bot(m) && z.open < top(m) && z.close > bot(x) && z.close < top(x);
      } },

    { key: 'gap3_dn', name: 'Downside gap three methods', dir: -1, need: 6,
      why: 'Two down bars with a gap between them, then a bar that fills the gap and stops.',
      test: function (c, i, a) {
        var x = c[i - 2], m = c[i - 1], z = c[i];
        return isDn(x) && isDn(m) && gapDn(x, m, a) &&
               isUp(z) && z.open > bot(m) && z.open < top(m) && z.close > bot(x) && z.close < top(x);
      } },

    /* Hikkake is a failed inside bar: the break of the inside bar is itself
       reversed. It is the only shape here whose signal fires on a LATER bar
       than the shape, which is why its window runs back to i-3. */
    { key: 'hikkake_bull', name: 'Bullish hikkake', dir: 1, need: 6,
      why: 'An inside bar broke downward and the break failed. The trap is the signal.',
      test: function (c, i, a) {
        var w = c[i - 3], x = c[i - 2], m = c[i - 1];
        if (!(x.high < w.high && x.low > w.low)) return false;     // inside bar
        if (!(m.high < x.high && m.low < x.low)) return false;      // broke down
        return c[i].close > x.high;                                 // and failed
      } },

    { key: 'hikkake_bear', name: 'Bearish hikkake', dir: -1, need: 6,
      why: 'An inside bar broke upward and the break failed.',
      test: function (c, i, a) {
        var w = c[i - 3], x = c[i - 2], m = c[i - 1];
        if (!(x.high < w.high && x.low > w.low)) return false;
        if (!(m.high > x.high && m.low > x.low)) return false;
        return c[i].close < x.low;
      } },

    { key: 'hikkake_mod_bull', name: 'Modified bullish hikkake', dir: 1, need: 7,
      why: 'A bullish hikkake whose inside bar also made the lowest close of the run.',
      test: function (c, i, a) {
        var v = c[i - 4], w = c[i - 3], x = c[i - 2], m = c[i - 1];
        if (!(x.high < w.high && x.low > w.low)) return false;
        if (!(x.close <= v.close && x.close <= w.close)) return false;
        if (!(m.high < x.high && m.low < x.low)) return false;
        return c[i].close > x.high;
      } },

    { key: 'hikkake_mod_bear', name: 'Modified bearish hikkake', dir: -1, need: 7,
      why: 'A bearish hikkake whose inside bar also made the highest close of the run.',
      test: function (c, i, a) {
        var v = c[i - 4], w = c[i - 3], x = c[i - 2], m = c[i - 1];
        if (!(x.high < w.high && x.low > w.low)) return false;
        if (!(x.close >= v.close && x.close >= w.close)) return false;
        if (!(m.high > x.high && m.low > x.low)) return false;
        return c[i].close < x.low;
      } },

    /* ------------------------------------------------------------ gaps --- */
    /* Not in TA-Lib's list. Kept because on an index that shuts overnight the
       plain gap is the most-watched candle event of the day, and the
       forecast's own opening-gap lane is built on it. */
    { key: 'gap_up', name: 'Gap up', dir: 1, need: 2,
      why: 'Opened clear of the previous bar’s high.',
      test: function (c, i, a) { return c[i].low > c[i - 1].high + 0.15 * a; } },

    { key: 'gap_down', name: 'Gap down', dir: -1, need: 2,
      why: 'Opened clear below the previous bar’s low.',
      test: function (c, i, a) { return c[i].high < c[i - 1].low - 0.15 * a; } },
  ];

  /* Families, for counting. The bull and bear halves of engulfing, harami and
     the rest are one family, which is how a textbook counts them and therefore
     how the page should. */
  function familyOf(key) {
    return key.replace(/_(bull|bear|up|dn|down)$/, '');
  }

  var familyCount = (function () {
    var seen = {}, n = 0;
    for (var i = 0; i < SET.length; i++) {
      var f = familyOf(SET[i].key);
      if (!seen[f]) { seen[f] = 1; n++; }
    }
    return n;
  })();

  KT.candles = {
    SET: SET,
    familyOf: familyOf,
    families: familyCount,
    /* Exported so patterns.js and the self-test read the same shape maths.
       Two implementations of "is this a doji" is precisely this repo's
       recurring bug in its smallest form. */
    shape: { body: body, upper: upper, lower: lower, range: range, isUp: isUp, isDn: isDn,
             mid: mid, top: top, bot: bot, doji: doji, longB: longB, shortB: shortB,
             realish: realish, fell: fell, rose: rose,
             gapUp: gapUp, gapDn: gapDn, noUpper: noUpper, noLower: noLower },
  };
})(window.KT);
