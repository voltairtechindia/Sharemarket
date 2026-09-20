/* ============================================================================
   Forecast ledger.

   Until this file existed the forecast was recomputed on every page load and
   thrown away. calibrate() walked the series and rebuilt a smaller model at
   past bars, which answers "would this kind of model have worked" but never
   "did the forecast you were shown at 11:08 actually happen". There was no
   record, so there was nothing to explain afterwards.

   That gap is why the accuracy numbers could not be trusted enough to act on.
   A backtest scores a model against history it was tuned on; a ledger scores
   the model against futures it had not seen. Only the second kind of evidence
   accumulates into something worth money, and it accumulates at one row per
   horizon - roughly a year of sessions before a daily direction rate can be
   told apart from a coin. There is no way to hurry that, and a panel that
   implies otherwise is lying.

   Four jobs:

     record    write down what was forecast, and what each lane asked for
     settle    when the horizon elapses, join it to what price actually did
     explain   which lane was right, which was wrong, what nothing called
     aggregate the running record, with intervals rather than point estimates

   Rows live in this browser. The workflow keeps its own copy on the live-data
   branch; the panel labels which is which, because they are not the same
   evidence and merging them silently would overstate the sample.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;

  var KEY = 'fcLedger';
  var MAX_ROWS = 400;
  var MAX_AGE_MS = 1000 * 60 * 60 * 24 * 400;          // a little over a year

  function load() {
    var rows = core.store.get(KEY, []);
    return Object.prototype.toString.call(rows) === '[object Array]' ? rows : [];
  }
  function save(rows) {
    // localStorage throws when full and the throw is the only warning. Trim
    // oldest first, and if the write still fails, halve and retry rather than
    // losing the whole record.
    var trimmed = rows.slice(-MAX_ROWS);
    if (core.store.set(KEY, trimmed)) return true;
    return core.store.set(KEY, trimmed.slice(-Math.floor(MAX_ROWS / 2)));
  }

  function idOf(symbol, timeframe, ts) { return symbol + ':' + timeframe + ':' + ts; }

  /* ================================================================ record

     One row per symbol, timeframe and reason bucket. The bucket is what stops
     a page left open all afternoon from writing a row every second and turning
     one observation into three thousand - which would be the fastest possible
     way to make the sample look large and mean nothing. */
  function record(f, ctx) {
    if (!f || !f.checkpoints || !f.checkpoints.length) return null;
    var tf = C.timeframes[f.timeframe];
    if (!tf) return null;

    var symbol = (ctx && ctx.symbol) || 'NIFTY';
    var bucket = tf.reasonBucket * 1000;
    var stamp = Math.floor(f.generatedAt / bucket) * bucket;
    var id = idOf(symbol, f.timeframe, stamp);

    var rows = load();
    for (var i = rows.length - 1; i >= 0; i--) if (rows[i].id === id) return rows[i];

    var row = {
      id: id, origin: 'browser',
      symbol: symbol, timeframe: f.timeframe,
      generatedAt: stamp, recordedAt: Date.now(),
      horizonLabel: f.horizonLabel, bars: f.forecastBars,
      lastClose: f.lastClose,
      direction: f.direction, bias: f.bias, confidence: f.confidence,
      target: f.target, targetPct: f.targetPct,
      rangeLow: f.rangeLow, rangeHigh: f.rangeHigh,

      /* Each lane's weighted contribution is what it asked the price to do.
         Storing the note as well means the post-mortem can quote the reason
         the lane gave at the time, rather than a reason reconstructed later
         from data that has since changed. */
      lanes: (f.lanes || []).map(function (l) {
        return { id: l.id, label: l.label, score: l.score, weight: l.weight,
                 contribution: l.contribution, note: l.note, hasData: !!l.hasData };
      }),

      checkpoints: f.checkpoints.map(function (c) {
        return { time: c.time, label: c.label, value: c.value,
                 low: c.low, high: c.high, low95: c.low95, high95: c.high95,
                 pUp: c.pUp, bars: c.bars };
      }),

      newsEnd: f.components ? f.components.news.end : null,
      patternEnd: f.components ? f.components.pattern.end : null,
      agree: f.components ? f.components.agree : null,
      gapPct: f.components ? f.components.gapPct : null,

      vix: (ctx && ctx.vix) || null,
      sigmaPerBar: f.volPerBar,
      volModel: f.volModel ? f.volModel.kind : null,
      volPersistence: f.volModel ? f.volModel.persistence : null,
      z68: f.z68, z95: f.z95, zBasis: f.zBasis,

      topHeadline: f.topNews ? {
        headline: String(f.topNews.headline || '').slice(0, 180),
        source: f.topNews.source, ts: f.topNews.ts,
        impact: f.topNews.impact, sentiment: f.topNews.sentiment,
      } : null,

      status: 'pending',
    };

    rows.push(row);
    rows = rows.filter(function (r) { return Date.now() - r.generatedAt < MAX_AGE_MS; });
    save(rows);
    return row;
  }

  /* ================================================================ settle

     Join every elapsed checkpoint to the close that actually printed. A row
     whose window is not covered by the loaded candle series stays pending -
     scoring it against the nearest bar we happen to have would invent an
     outcome, which is the one thing this whole feature exists to stop. */
  function settle(candles, symbol, timeframe) {
    if (!candles || candles.length < 2) return { settled: 0, pending: 0 };
    var rows = load(), changed = 0, pending = 0;
    var first = candles[0].time, last = candles[candles.length - 1].time;

    rows.forEach(function (row) {
      if (row.status === 'settled') return;
      if (symbol && row.symbol !== symbol) return;
      if (timeframe && row.timeframe !== timeframe) return;
      if (!(row.lastClose > 0)) return;

      var done = 0;
      row.checkpoints.forEach(function (cp) {
        if (cp.actual != null) { done++; return; }
        if (cp.time > last || cp.time < first) return;

        var actual = closeAt(candles, cp.time);
        if (actual == null) return;

        cp.actual = actual;
        cp.errorPct = round(( actual - cp.value) / row.lastClose * 100, 3);
        cp.movePct = round((actual - row.lastClose) / row.lastClose * 100, 3);
        cp.inside68 = actual >= cp.low && actual <= cp.high;
        cp.inside95 = actual >= cp.low95 && actual <= cp.high95;
        // A checkpoint whose forecast change rounds to nothing is not a
        // direction call and must not be scored as one.
        var called = Math.abs(cp.value - row.lastClose) / row.lastClose * 100 > 0.02;
        cp.directionRight = called ? ((actual > row.lastClose) === (cp.value > row.lastClose)) : null;
        done++;
        changed++;
      });

      if (done === row.checkpoints.length) {
        row.status = 'settled';
        row.settledAt = Date.now();
        row.explain = explain(row);
      } else if (done > 0) {
        row.status = 'partial';
      }
      if (row.status !== 'settled') pending++;
    });

    if (changed) save(rows);
    return { settled: changed, pending: pending };
  }

  /* The close at or immediately before a time. Nearest-bar, not interpolated:
     a price that never traded is not an outcome. */
  function closeAt(candles, t) {
    var lo = 0, hi = candles.length - 1, best = null;
    if (candles[lo].time > t) return null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (candles[mid].time <= t) { best = candles[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best ? best.close : null;
  }

  /* =============================================================== explain

     The part that answers "why did it, or why didn't it". Four questions, in
     the order they are worth asking. */
  function explain(row) {
    var final = row.checkpoints[row.checkpoints.length - 1];
    if (!final || final.actual == null) return null;

    var realised = (final.actual - row.lastClose) / row.lastClose * 100;
    var forecast = (final.value - row.lastClose) / row.lastClose * 100;

    /* 1. What each lane asked for, and whether the market went that way.

       This is a directional verdict on the lane, not a claim that the lane
       caused anything. A lane whose contribution rounds to zero called
       nothing and is recorded as such rather than being scored as a coin
       flip it never took part in. */
    var scale = Math.abs(forecast) > 1e-9 && Math.abs(row.bias) > 1e-9
      ? forecast / row.bias : 0;
    var laneVerdicts = row.lanes.map(function (l) {
      var asked = round(l.contribution * scale, 3);
      var verdict;
      if (!l.hasData) verdict = 'no data';
      else if (Math.abs(asked) < 0.005) verdict = 'called nothing';
      else if (Math.abs(realised) < 0.02) verdict = 'nothing to call';
      else verdict = (asked > 0) === (realised > 0) ? 'right' : 'wrong';
      return { id: l.id, label: l.label, askedPct: asked, note: l.note, verdict: verdict };
    });

    /* 2. The residual: the part of the move that no lane called. A large one
          says the model was not merely wrong about direction, it was blind -
          which is a different and more useful thing to know. */
    var askedTotal = laneVerdicts.reduce(function (s, l) {
      return s + (l.verdict === 'no data' ? 0 : l.askedPct);
    }, 0);
    var residual = round(realised - askedTotal, 3);

    /* 3. The failure mode. The single most useful line on the panel, because
          "the lean was wrong but the range held" and "price left the band
          entirely" are different failures with different fixes, and the old
          panel could not tell them apart. */
    var mode, modeText;
    if (!final.inside95) {
      mode = 'vol-surprise';
      modeText = 'Price finished outside the 95% band. This was a volatility failure, not a direction one: ' +
                 'the range itself was too narrow, so the size of the move was the surprise.';
    } else if (final.inside68 && final.directionRight === false) {
      mode = 'lean-wrong-range-held';
      modeText = 'The lean was wrong but the range held. The band was honest; the direction call inside it was not, ' +
                 'which at this horizon is the common case rather than a malfunction.';
    } else if (final.inside68 && final.directionRight) {
      mode = 'hit';
      modeText = 'Direction right and price finished inside the 68% band.';
    } else if (final.directionRight) {
      mode = 'direction-right-range-narrow';
      modeText = 'Direction was right but price finished outside the 68% band - it went further than the range allowed.';
    } else {
      mode = 'miss';
      modeText = 'Direction wrong and price finished outside the 68% band.';
    }

    /* 4. What arrived after the forecast was made. Descriptive only. Naming
          the loudest headline inside the window is checkable; asserting it
          caused the move is not, and this project's position is that an
          invented cause is the same sin in prose as an invented number. */
    var arrivals = arrivalsIn(row.generatedAt / 1000, final.time, row.lastClose);

    return {
      realisedPct: round(realised, 3),
      forecastPct: round(forecast, 3),
      errorPct: round(realised - forecast, 3),
      residualPct: residual,
      askedTotalPct: round(askedTotal, 3),
      lanes: laneVerdicts,
      mode: mode, modeText: modeText,
      inside68: final.inside68, inside95: final.inside95,
      directionRight: final.directionRight,
      arrivals: arrivals,
      // Did the news story or the chart story turn out to be the right one.
      componentWinner: componentWinner(row, final.actual),
    };
  }

  /* News that landed strictly inside the forecast window, loudest first. The
     news array is whatever the fast lane currently holds, so an item that has
     aged out of the sweep cannot be recovered - which is exactly why the
     workflow archives news.json per run. Until that archive has depth this
     returns only what is still in memory, and says how many it looked at. */
  var IMPACT_W = { high: 3, medium: 2, low: 1 };
  function arrivalsIn(fromSec, toSec, price) {
    var items = (KT.ledger.newsSource && KT.ledger.newsSource()) || [];
    var out = [];
    items.forEach(function (n) {
      if (!n || !n.ts) return;
      if (n.ts <= fromSec || n.ts > toSec) return;
      var strength = Math.abs(n.sentiment || 0) * (IMPACT_W[n.impact] || 1);
      if (strength <= 0) return;
      out.push({ headline: String(n.headline || '').slice(0, 180), source: n.source,
                 ts: n.ts, impact: n.impact, sentiment: n.sentiment,
                 strength: Math.round(strength * 100) / 100 });
    });
    out.sort(function (a, b) { return b.strength - a.strength; });
    return { scanned: items.length, top: out.slice(0, 3) };
  }

  function componentWinner(row, actual) {
    if (row.newsEnd == null || row.patternEnd == null) return null;
    var dn = Math.abs(actual - row.newsEnd), dp = Math.abs(actual - row.patternEnd);
    if (!isFinite(dn) || !isFinite(dp)) return null;
    // Within a tenth of a percent of each other, neither won.
    if (Math.abs(dn - dp) / row.lastClose * 100 < 0.1) return 'neither';
    return dn < dp ? 'news' : 'pattern';
  }

  /* ============================================================= aggregate

     The running record. Every rate comes with a Wilson interval, because a
     point estimate at these sample sizes is the number most likely to be
     misread: 58% of 12 and 58% of 1200 are the same headline and completely
     different evidence. */
  function wilson(k, n) {
    if (!n) return null;
    var p = k / n, z = 1.96, den = 1 + z * z / n;
    var centre = p + z * z / (2 * n);
    var margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [round((centre - margin) / den * 100, 1), round((centre + margin) / den * 100, 1)];
  }

  function aggregate(symbol, timeframe) {
    var settled = load().filter(function (r) {
      return r.status === 'settled' &&
             (!symbol || r.symbol === symbol) &&
             (!timeframe || r.timeframe === timeframe);
    });
    /* Seeded rows are rebuilt from history to exercise the machinery. They are
       a backtest wearing a ledger's clothes, and counting them here would
       reproduce exactly the overstatement this file exists to end: the whole
       point of the forward record is that the model had not seen the outcome.
       They are counted separately so the panel can say how many there are. */
    var seeded = settled.filter(function (r) { return r.origin === 'seeded'; }).length;
    var rows = settled.filter(function (r) { return r.origin !== 'seeded'; });
    if (!rows.length) {
      return { n: 0, seeded: seeded, lanes: [],
               message: 'No forecast written down in this browser has reached the end of its horizon yet.' };
    }

    var in68 = 0, in95 = 0, dirRight = 0, dirCalls = 0, absErr = 0, naiveErr = 0;
    var modes = {}, laneTally = {};

    rows.forEach(function (r) {
      var e = r.explain;
      if (!e) return;
      if (e.inside68) in68++;
      if (e.inside95) in95++;
      if (e.directionRight != null) { dirCalls++; if (e.directionRight) dirRight++; }
      absErr += Math.abs(e.errorPct);
      naiveErr += Math.abs(e.realisedPct);
      modes[e.mode] = (modes[e.mode] || 0) + 1;
      (e.lanes || []).forEach(function (l) {
        if (l.verdict !== 'right' && l.verdict !== 'wrong') return;
        if (!laneTally[l.id]) laneTally[l.id] = { id: l.id, label: l.label, right: 0, n: 0 };
        laneTally[l.id].n++;
        if (l.verdict === 'right') laneTally[l.id].right++;
      });
    });

    var lanes = Object.keys(laneTally).map(function (k) {
      var t = laneTally[k];
      return { id: t.id, label: t.label, right: t.right, n: t.n,
               rate: round(t.right / t.n * 100, 1), ci: wilson(t.right, t.n),
               // A lane only earns its weight if its interval clears 50%.
               significant: (function () { var c = wilson(t.right, t.n); return !!(c && c[0] > 50); })() };
    }).sort(function (a, b) { return b.n - a.n; });

    var n = rows.length;
    return {
      n: n, seeded: seeded,
      coverage68: round(in68 / n * 100, 1), coverage68Ci: wilson(in68, n),
      coverage95: round(in95 / n * 100, 1), coverage95Ci: wilson(in95, n),
      kupiec68: KT.vol ? KT.vol.kupiec(in68, n, 0.68) : null,
      kupiec95: KT.vol ? KT.vol.kupiec(in95, n, 0.95) : null,
      directionCalls: dirCalls, directionRight: dirRight,
      directionRate: dirCalls ? round(dirRight / dirCalls * 100, 1) : null,
      directionCi: wilson(dirRight, dirCalls),
      directionSignificant: (function () { var c = wilson(dirRight, dirCalls); return !!(c && c[0] > 50); })(),
      mae: round(absErr / n, 3), naiveMae: round(naiveErr / n, 3),
      skill: naiveErr ? round(absErr / naiveErr, 3) : null,
      modes: modes, lanes: lanes,
      /* Sample size needed before a direction rate this size could be told
         apart from a coin at 80% power. Shown because the honest answer to
         "can I trade this" is almost always "not yet, and here is how far
         off you are". */
      callsNeeded: callsNeeded(dirCalls ? dirRight / dirCalls : 0.5),
    };
  }

  function callsNeeded(p) {
    if (!(p > 0.5)) return null;
    var za = 1.6449, zb = 0.8416;                       // one-sided 5%, 80% power
    return Math.ceil(Math.pow(za * 0.5 + zb * Math.sqrt(p * (1 - p)), 2) / Math.pow(p - 0.5, 2));
  }

  /* The miss record ACI learns from: oldest first, 1 for a band that missed.
     Only settled rows, only this symbol and timeframe, because a band fitted
     to the daily chart tells you nothing about the hourly one. */
  function missRecord(symbol, timeframe) {
    return load().filter(function (r) {
      return r.status === 'settled' && r.explain && r.origin !== 'seeded' &&
             (!symbol || r.symbol === symbol) && (!timeframe || r.timeframe === timeframe);
    }).sort(function (a, b) { return a.generatedAt - b.generatedAt; })
      .map(function (r) { return r.explain.inside68 ? 0 : 1; });
  }

  /* Prefer a forecast this browser actually wrote down. Fall back to a seeded
     one only so the panel has something to show on a first visit, and the
     caller is told which it got so it can label it. */
  function latest(symbol, timeframe, status) {
    var rows = load().filter(function (r) {
      return (!symbol || r.symbol === symbol) && (!timeframe || r.timeframe === timeframe) &&
             (!status || r.status === status);
    });
    rows.sort(function (a, b) { return b.generatedAt - a.generatedAt; });
    var forward = rows.filter(function (r) { return r.origin !== 'seeded'; });
    return forward[0] || rows[0] || null;
  }

  function all() { return load(); }
  function clear() { core.store.remove(KEY); }

  function round(v, d) {
    var m = Math.pow(10, d == null ? 2 : d);
    return Math.round(v * m) / m;
  }

  /* ---------------------------------------------------- history seeding

     A forward record takes a year to become evidence, and until then the
     panel would have nothing to show and no way to prove the machinery works.
     Seeding rebuilds forecasts at past bars using only the candles available
     then, records them, and settles them against the bars that really
     followed - the same walk calibrate() does, but through record/settle/
     explain so every stage is exercised end to end.

     These rows are marked origin 'seeded' and are excluded from the forward
     aggregate. They demonstrate the plumbing; they are not evidence about the
     future, and counting them as if they were would reproduce exactly the
     overstatement this file was written to end. */
  function seedFromHistory(candles, symbol, timeframe, opts) {
    opts = opts || {};
    if (!KT.forecast || !candles || candles.length < 250) return { seeded: 0 };
    var tf = C.timeframes[timeframe];
    if (!tf) return { seeded: 0 };
    var bars = Math.max(6, Math.round(tf.visibleBars * tf.forecastRatio));
    if (tf.maxForecastBars) bars = Math.min(bars, tf.maxForecastBars);

    var want = opts.count || 6;
    var rows = load().filter(function (r) { return r.origin !== 'seeded' || r.timeframe !== timeframe || r.symbol !== symbol; });
    var made = 0;

    for (var i = 0; i < want; i++) {
      var at = candles.length - 1 - bars * (i + 1);
      if (at < 200) break;
      var hist = candles.slice(0, at + 1);
      var f = null;
      try {
        f = KT.forecast.build({
          candles: hist.slice(), timeframe: timeframe, news: [],
          seasonality: opts.seasonality || null, global: null, flows: null,
          structureStats: opts.structureStats || null,
        });
      } catch (e) { f = null; }
      if (!f || !f.checkpoints || !f.checkpoints.length) continue;

      var row = {
        id: idOf(symbol, timeframe, 'seed' + at), origin: 'seeded',
        symbol: symbol, timeframe: timeframe,
        generatedAt: hist[hist.length - 1].time * 1000, recordedAt: Date.now(),
        horizonLabel: f.horizonLabel, bars: f.forecastBars, lastClose: f.lastClose,
        direction: f.direction, bias: f.bias, confidence: f.confidence,
        target: f.target, targetPct: f.targetPct,
        rangeLow: f.rangeLow, rangeHigh: f.rangeHigh,
        lanes: (f.lanes || []).map(function (l) {
          return { id: l.id, label: l.label, score: l.score, weight: l.weight,
                   contribution: l.contribution, note: l.note, hasData: !!l.hasData };
        }),
        checkpoints: f.checkpoints.map(function (c) {
          return { time: c.time, label: c.label, value: c.value, low: c.low, high: c.high,
                   low95: c.low95, high95: c.high95, pUp: c.pUp, bars: c.bars };
        }),
        newsEnd: f.components ? f.components.news.end : null,
        patternEnd: f.components ? f.components.pattern.end : null,
        agree: f.components ? f.components.agree : null,
        gapPct: f.components ? f.components.gapPct : null,
        vix: null, sigmaPerBar: f.volPerBar,
        volModel: f.volModel ? f.volModel.kind : null,
        volPersistence: f.volModel ? f.volModel.persistence : null,
        z68: f.z68, z95: f.z95, zBasis: f.zBasis,
        topHeadline: null, status: 'pending',
      };
      rows.push(row);
      made++;
    }
    save(rows);
    var res = settle(candles, symbol, timeframe);
    return { seeded: made, settled: res.settled };
  }

  /* ========================================================= session lock

     The ledger above answers "was the model right, on average, over many
     horizons". This answers the cruder question a person actually asks on the
     day: the line you drew this morning - did price follow it?

     That question is only worth asking if the line cannot move. A forecast
     recomputed every second and then compared against the tape is a model
     marking its own homework with the answers in front of it, and it will
     look excellent forever. So exactly two calls are frozen per session and
     neither is ever rewritten:

       advance  the first time the page computes a forecast for a session that
                has not opened yet - Sunday evening, or after Friday's close.
                This is the "where does it start on Monday" call.
       open     recomputed once between 09:00 and 09:15 IST, when the overnight
                cues are complete and the pre-open auction is under way. This
                is the call that gets scored against the day.

     Both are kept. The chart draws the later one, because that is the live
     claim, and the record keeps the earlier one so a good pre-open call
     cannot be back-dated into a good Sunday call.

     Rewriting a lock is the single failure mode that would make this whole
     panel worthless, so `write()` refuses rather than overwrites, and the
     refusal is silent by design - it happens on most of the 25,000 ticks in a
     session and is not news. */
  var LOCK_KEY = 'fcLocks';
  var MAX_LOCKS = 40;                                  // a few weeks of sessions

  function lockLoad() {
    var rows = core.store.get(LOCK_KEY, []);
    return Object.prototype.toString.call(rows) === '[object Array]' ? rows : [];
  }
  function lockSave(rows) {
    return core.store.set(LOCK_KEY, rows.slice(-MAX_LOCKS));
  }

  /* The IST calendar date of the session a forecast is about - which is not
     today's date when the market is shut. A Sunday-evening forecast is about
     Monday, so it must key on Monday or Monday's lock would be created twice
     and Sunday's would be scored against Monday's tape. The first projected
     bar already carries that answer, because advance() walked the holiday
     table to produce it. */
  function sessionKeyOf(f) {
    var t = f && f.path && f.path.length ? f.path[0].time : null;
    if (!t) return null;
    return dateKey(core.fmt.ist(t));
  }
  function dateKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Which of the two stages we are entitled to write right now. Null means
     neither - during the session, after the open lock exists, there is nothing
     left to freeze and the honest answer is to leave the record alone. */
  function stageNow(f) {
    if (!f || !f.path || !f.path.length) return null;
    var now = core.fmt.ist(Math.floor(Date.now() / 1000));
    var mins = now.getHours() * 60 + now.getMinutes();
    var open = C.market.regular.from;

    /* Which session is being forecast decides this, not the wall clock alone.

       This read the clock only, and it was wrong in the case the feature was
       built for: on a Sunday afternoon the minute count is past 09:15, so it
       returned null and refused to freeze anything - on the one evening a
       person is most likely to be asking where Monday opens. The same hole
       swallowed every weekday evening after 15:30, which is when tomorrow's
       call is worth writing down.

       If the session in the forecast is not today's, nothing about it has
       traded yet whatever the time is, and the call is the day-before one. */
    var target = sessionKeyOf(f);
    if (target && target !== dateKey(now)) return 'advance';

    // The pre-open window: the auction is running, the cues are in, nothing
    // has traded in the cash market yet.
    if (mins >= open - 15 && mins < open) return 'open';
    // Anything earlier, on a day the market has not opened yet.
    if (mins < open - 15) return 'advance';
    return null;
  }

  function lock(f, ctx) {
    if (!f || !f.path || !f.path.length) return null;
    var symbol = (ctx && ctx.symbol) || 'NIFTY';
    var key = sessionKeyOf(f);
    if (!key) return null;

    var rows = lockLoad();
    /* Scoped to the timeframe as well as the session. A 5-minute path and a
       1-minute path are different claims about the same day, and sharing one
       lock between them would let whichever view loaded first decide what the
       other one is judged on. */
    var mine = rows.filter(function (r) {
      return r.session === key && r.symbol === symbol && r.timeframe === f.timeframe;
    });
    var stage = stageNow(f);

    // Already have this stage, or the clock has closed the window: read, do
    // not write. Never both - a lock that can be rewritten is not a lock.
    var have = {};
    mine.forEach(function (r) { have[r.stage] = true; });
    if (stage && !have[stage]) {
      var row = {
        id: symbol + ':' + key + ':' + f.timeframe + ':' + stage,
        symbol: symbol, session: key, stage: stage,
        timeframe: f.timeframe,
        lockedAt: Date.now(),
        anchorTime: f.path[0].time - (C.timeframes[f.timeframe] ? C.timeframes[f.timeframe].barSec : 60),
        anchorPrice: f.lastClose,
        openPrice: f.open && f.open.hasData ? f.open.price : f.path[0].value,
        openGapPct: f.open && f.open.hasData ? f.open.gapPct : null,
        openParts: f.open ? (f.open.parts || []).slice(0, 5) : [],
        direction: f.direction, confidence: f.confidence,
        target: f.target, targetPct: f.targetPct,
        /* Every projected minute. This is the whole point of the row and the
           reason it is capped: 375 points at two numbers each is about 9 KB,
           and forty of those is well inside what localStorage will hold, but
           a thousand would not be. */
        path: f.path.map(function (pt) { return { time: pt.time, value: pt.value }; }),
        lanes: (f.lanes || []).filter(function (l) { return l.hasData; })
          .map(function (l) { return { id: l.id, label: l.label, contribution: l.contribution, note: l.note }; }),
        topHeadline: f.topNews ? {
          headline: String(f.topNews.headline || '').slice(0, 180),
          source: f.topNews.source, ts: f.topNews.ts,
        } : null,
      };
      rows.push(row);
      lockSave(rows);
      mine.push(row);
    }

    if (!mine.length) return null;
    // The later stage is the live claim; 'open' sorts after 'advance'.
    mine.sort(function (a, b) { return a.lockedAt - b.lockedAt; });
    return mine[mine.length - 1];
  }

  /* ---------------------------------------------------------- lock score

     What the locked line claimed against what printed, minute by minute.

     Read by time, never by index. `candles[i]` and `path[i]` are not the same
     minute the moment one bar is missing from the feed - which happens - and
     scoring them as if they were would silently compare 11:04's forecast with
     11:07's price for the rest of the day. Same rule the replay learned the
     hard way; see closeAtTime() in forecast.js. */
  function scoreLock(row, candles) {
    if (!row || !row.path || !row.path.length || !candles || candles.length < 2) return null;
    var byTime = {};
    for (var i = 0; i < candles.length; i++) byTime[candles[i].time] = candles[i].close;

    var pairs = [], absErr = 0, naive = 0, dirRight = 0, dirCalls = 0, worst = null;
    for (var k = 0; k < row.path.length; k++) {
      var pt = row.path[k];
      var actual = byTime[pt.time];
      if (actual == null) continue;
      var err = actual - pt.value;
      absErr += Math.abs(err);
      naive += Math.abs(actual - row.anchorPrice);
      // A minute the model called flat is not a direction call.
      var called = Math.abs(pt.value - row.anchorPrice) / row.anchorPrice * 100 > 0.02;
      if (called) {
        dirCalls++;
        if ((actual > row.anchorPrice) === (pt.value > row.anchorPrice)) dirRight++;
      }
      if (!worst || Math.abs(err) > Math.abs(worst.err)) worst = { time: pt.time, err: round(err, 2) };
      pairs.push({ time: pt.time, predicted: pt.value, actual: actual, err: round(err, 2) });
    }
    if (!pairs.length) {
      return { n: 0, pending: true, session: row.session, stage: row.stage };
    }

    /* The open is scored on its own because it is its own claim. A model that
       calls the gap well and the day badly is a different animal from one that
       does the reverse, and one blended error number hides which you have. */
    var firstActual = pairs[0];
    var openErr = row.openPrice != null ? round(firstActual.actual - row.openPrice, 2) : null;

    var last = pairs[pairs.length - 1];
    return {
      n: pairs.length, total: row.path.length, pending: pairs.length < row.path.length,
      session: row.session, stage: row.stage, lockedAt: row.lockedAt,
      anchorPrice: row.anchorPrice,
      openPredicted: row.openPrice, openActual: firstActual.actual, openErr: openErr,
      openErrPct: openErr != null ? round(openErr / row.anchorPrice * 100, 3) : null,
      openDirectionRight: row.openGapPct == null || Math.abs(row.openGapPct) < 0.02 ? null
        : ((firstActual.actual > row.anchorPrice) === (row.openGapPct > 0)),
      nowPredicted: last.predicted, nowActual: last.actual, nowErr: last.err,
      nowErrPct: round(last.err / row.anchorPrice * 100, 3),
      mae: round(absErr / pairs.length, 2),
      maePct: round(absErr / pairs.length / row.anchorPrice * 100, 3),
      /* Below 1 the locked line beat "price stays at yesterday's close", which
         is the only benchmark worth clearing. Above 1 it was worse than doing
         nothing, and the panel should say so in those words. */
      skill: naive ? round(absErr / naive, 3) : null,
      directionCalls: dirCalls, directionRight: dirRight,
      directionRate: dirCalls ? round(dirRight / dirCalls * 100, 1) : null,
      worst: worst,
      pairs: pairs,
    };
  }

  /* Write each lock's outcome onto the row, once, when its session has
     printed. The learner reads these rather than rescoring from candles,
     because by the time it runs the candles for that session are usually no
     longer loaded - the page is showing today and the lock is from Tuesday.
     A number that can only be recomputed while the evidence happens to be in
     memory is not a record. */
  function settleLocks(candles, symbol) {
    if (!candles || candles.length < 2) return 0;
    var rows = lockLoad(), changed = 0;
    var last = candles[candles.length - 1].time;
    rows.forEach(function (r) {
      if (r.outcome || !r.path || !r.path.length) return;
      if (r.symbol !== symbol) return;
      // Only once the whole locked window is behind us. A partial score
      // frozen at lunchtime would be a half-day masquerading as a session.
      if (last < r.path[r.path.length - 1].time) return;
      var sc = scoreLock(r, candles);
      if (!sc || !sc.n) return;
      r.outcome = {
        n: sc.n, total: sc.total,
        openPredicted: sc.openPredicted, openActual: sc.openActual, openErr: sc.openErr,
        mae: sc.mae, maePct: sc.maePct, skill: sc.skill,
        directionRate: sc.directionRate, directionCalls: sc.directionCalls,
        closePredicted: sc.nowPredicted, closeActual: sc.nowActual,
        settledAt: Date.now(),
      };
      changed++;
    });
    if (changed) lockSave(rows);
    return changed;
  }

  function locks(symbol, limit) {
    return lockLoad().filter(function (r) { return !symbol || r.symbol === symbol; })
      .sort(function (a, b) { return b.lockedAt - a.lockedAt; })
      .slice(0, limit || 20);
  }

  KT.ledger = {
    record: record, settle: settle, explain: explain, aggregate: aggregate,
    missRecord: missRecord, latest: latest, all: all, clear: clear,
    seedFromHistory: seedFromHistory, wilson: wilson, callsNeeded: callsNeeded,
    lock: lock, scoreLock: scoreLock, locks: locks, sessionKeyOf: sessionKeyOf,
    stageNow: stageNow,
    settleLocks: settleLocks,
    // app.js points this at the live news array so arrivalsIn() can scan it.
    newsSource: null,
  };
})(window.KT);
