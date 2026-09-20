/* ============================================================================
   Chart: candles for the past and present, a live projection for the future,
   the geometry of every detected pattern drawn where it actually sits, the
   levels price has respected, and a reason point wherever something moved
   the index.

   Candles carry the picture. Everything else on it is deliberately quiet:
   two translucent lines under the bars - the forecast ahead of now, and the
   realised close line over the locked window - and nothing else competing
   with them. The News-only and Pattern-only projections were drawn here until
   20 Sep 2026; they are numbers on the forecast panel now ("News says" /
   "Pattern says"), because four coloured lines fanning out of one point read
   as four forecasts rather than one forecast and its components.

   The band lines were removed on 20 Sep 2026. Four dotted lines - 68% and 95%
   either side - occupied most of the picture and answered a question nobody
   was asking it; the band is still computed, still in the hover card and still
   what the accuracy panel scores, it is simply not drawn. What replaced it is
   the pair that does answer the question: `lockSeries`, the forecast frozen at
   the moment the session's call was made, and `actualSeries`, the close line
   over the same window. Divergence between those two is the model being wrong,
   in the one place a reader will look.

   The visible window is always 4 parts history to 1 part forecast, which is
   what makes the projection read as "the last fifth of the picture".

   Series are pooled rather than created per redraw. Lightweight Charts keeps
   every series you add until you remove it, and a terminal that repaints once
   a second would otherwise accumulate thousands of invisible line series and
   stall the tab inside an hour.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;

  var chart = null, candleSeries = null;
  var fcSeries = null, lockSeries = null, actualSeries = null;
  var pool = { structure: [], overlay: [] };     // reusable line series
  var priceLines = [];                            // horizontal lines on the candle series
  var state = {
    candles: [], forecast: null, reasons: [], patternMarkers: [],
    structures: [], levels: null, indicators: null,
    overlays: { ema: true, bands: false, supertrend: false, vwap: false, levels: true, patterns: true, why: true },
    tf: C.defaultTimeframe, symbol: C.defaultSymbol,
    lastCandleTime: null, pinned: null, total: 0, locked: null,
  };
  var els = {};

  /* A pool hands back a line series with the requested options, creating one
     only when the pool has run dry. Leftovers are blanked, not removed, so the
     next repaint can reuse them. */
  function take(kind, opts) {
    var list = pool[kind];
    if (!list.__used) list.__used = 0;
    var s;
    if (list.__used < list.length) s = list[list.__used];
    else { s = chart.addLineSeries({ priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); list.push(s); }
    list.__used++;
    s.applyOptions(opts);
    return s;
  }
  function beginPool(kind) { pool[kind].__used = 0; }
  function endPool(kind) {
    var list = pool[kind];
    for (var i = list.__used || 0; i < list.length; i++) {
      try { list[i].setData([]); } catch (e) {}
    }
  }

  function css(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  function palette() {
    return {
      bg: css('--bg', '#ffffff'),
      ink: css('--ink-muted', '#8a8f98'),
      grid: css('--grid', '#f0f2f5'),
      axis: css('--axis', '#dfe3e8'),
      up: css('--up', '#16a34a'),
      down: css('--down', '#ef4444'),
      forecast: css('--forecast', '#7c3aed'),
      /* --fc-news and --fc-pattern are still read by style.css for the
         "News says" / "Pattern says" dots on the forecast panel. The chart
         stopped drawing those two projections on 20 Sep 2026, so it stopped
         reading the colours too. */
      locked: css('--fc-locked', '#db2777'),
      actual: css('--actual-line', '#111827'),
      now: css('--now-line', '#94a3b8'),
      bull: css('--pattern-bull', '#0ea5e9'),
      bear: css('--pattern-bear', '#d97706'),
      neutral: css('--pattern-neutral', '#94a3b8'),
      level: css('--level-line', '#64748b'),
    };
  }

  /* A CSS colour at reduced opacity, for the lines that sit under the candles.

     Written by hand rather than reached for from a library because the only
     inputs are the six-digit hex values in style.css and the three rgb()
     strings a browser hands back from getComputedStyle. Anything else is
     returned untouched, so a future `oklch()` token degrades to a solid line
     rather than to `NaN` and an invisible series. */
  function soften(colour, a) {
    var c = String(colour || '').trim();
    var m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) {
      var n = parseInt(m[1], 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(c);
    if (m) return 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + a + ')';
    return c;
  }

  function chartOptions() {
    var p = palette();
    return {
      layout: { background: { type: 'solid', color: p.bg }, textColor: p.ink, fontFamily: "Inter, system-ui, sans-serif", fontSize: 11 },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderColor: p.axis, scaleMargins: { top: 0.12, bottom: 0.14 }, entireTextOnly: true },
      timeScale: { borderColor: p.axis, timeVisible: true, secondsVisible: false, rightOffset: 2, fixLeftEdge: false, lockVisibleTimeRangeOnResize: true },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: p.now, width: 1, style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: p.forecast },
        horzLine: { color: p.now, width: 1, style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: p.forecast },
      },
      localization: {
        locale: 'en-IN',
        priceFormatter: function (v) { return core.fmt.price(v); },
        timeFormatter: function (t) { return core.fmt.stamp(t, C.timeframes[state.tf].barSec); },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    };
  }

  function init(container) {
    els.stage = document.getElementById('chart-stage');
    els.now = document.getElementById('now-divider');
    els.zone = document.getElementById('forecast-zone');
    els.card = document.getElementById('reason-card');
    els.fcard = document.getElementById('forecast-card');
    els.empty = document.getElementById('chart-empty');

    if (chart) { chart.remove(); chart = null; }
    chart = LightweightCharts.createChart(container, chartOptions());
    var p = palette();

    /* ------------------------------------------------- draw order matters

       Lightweight Charts paints series in the order they were added, so these
       three go in FIRST and the candles go on top of them. That is the whole
       instruction: candles carry the chart, and the projection and the
       realised line sit underneath as translucent guides rather than as three
       more things fighting the bars for attention.

       Creation order is the only control over this - there is no z-index on a
       series - so moving the candle block back above these would silently undo
       it, with no error and no visual clue beyond the chart looking busier. */

    /* The frozen call. Set once per session and never rewritten, so what is
       drawn at 15:30 is the same line that was drawn at 09:15. Widening it or
       nudging it later would turn the whole record into decoration. */
    lockSeries = chart.addLineSeries({
      color: soften(p.locked, 0.55), lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
      title: 'Predicted',
    });
    /* What price actually did over the frozen call's window. The candles are
       the evidence and this line runs through them; it exists only to be read
       against the dashed one above, so it is the faintest thing here. */
    actualSeries = chart.addLineSeries({
      color: soften(p.actual, 0.45), lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Solid,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
      title: 'Actual',
    });

    fcSeries = chart.addLineSeries({
      color: soften(p.forecast, 0.6), lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Solid,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
      title: 'Forecast',
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: p.up, downColor: p.down,
      borderUpColor: p.up, borderDownColor: p.down,
      wickUpColor: p.up, wickDownColor: p.down,
      priceLineVisible: true, priceLineWidth: 1, priceLineStyle: LightweightCharts.LineStyle.Dotted,
      lastValueVisible: true,
    });

    chart.subscribeCrosshairMove(onCrosshair);
    chart.subscribeClick(onClick);
    chart.timeScale().subscribeVisibleLogicalRangeChange(positionOverlays);

    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (!chart || !container.clientWidth) return;
        chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
        positionOverlays();
      }).observe(container);
    }
    chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    return chart;
  }

  function retheme() {
    if (!chart) return;
    var p = palette();
    chart.applyOptions(chartOptions());
    candleSeries.applyOptions({ upColor: p.up, downColor: p.down, borderUpColor: p.up, borderDownColor: p.down, wickUpColor: p.up, wickDownColor: p.down });
    fcSeries.applyOptions({ color: soften(p.forecast, 0.6) });
    if (lockSeries) lockSeries.applyOptions({ color: soften(p.locked, 0.55) });
    if (actualSeries) actualSeries.applyOptions({ color: soften(p.actual, 0.45) });
    drawStructures(); drawOverlays(); drawLevels();
    applyMarkers();
  }

  /* ------------------------------------------------------------------ data */
  function setData(candles, forecast, reasons, tfKey, symbol) {
    if (!chart) return;
    // A card left over from the previous series would describe bars that no
    // longer exist on this one.
    hideForecastCard();
    state.tf = tfKey;
    if (symbol) state.symbol = symbol;
    state.candles = candles || [];
    state.forecast = forecast || null;
    state.reasons = reasons || [];
    state.lastCandleTime = state.candles.length ? state.candles[state.candles.length - 1].time : null;

    candleSeries.setData(state.candles);

    if (forecast && forecast.path && forecast.path.length) {
      // Anchor every projection line on the last real close so the dashed line
      // grows out of the candles instead of floating beside them.
      var anchor = { time: state.lastCandleTime, value: state.candles[state.candles.length - 1].close };
      fcSeries.setData([anchor].concat(forecast.path));
      state.total = state.candles.length + forecast.path.length;
    } else {
      [fcSeries, lockSeries, actualSeries]
        .forEach(function (x) { if (x) x.setData([]); });
      state.total = state.candles.length;
    }

    drawLocked(forecast && forecast.locked);

    drawStructures();
    drawOverlays();
    drawLevels();
    applyMarkers();
    frameView();
    if (els.empty) els.empty.classList.add('hidden');
    if (els.zone) els.zone.hidden = !(forecast && forecast.path && forecast.path.length);
    if (els.now) els.now.hidden = !state.lastCandleTime;
  }

  /* ======================================================= locked call

     Two lines and nothing else: what was predicted, and what happened.

     `locked.path` is written once and is not recomputed here - if this
     function ever rebuilt it, the comparison would be a model scoring its own
     hindsight, which is the failure the ledger exists to prevent. The actual
     line is derived from the candle series rather than stored, because the
     candles are the only record of price this page is entitled to treat as
     true, and deriving it means a corrected bar corrects the comparison too.

     Both lines are clipped to the locked window. Drawing the actual line
     before the lock existed would make the model look right about a stretch
     it never called. */
  function drawLocked(locked) {
    if (!lockSeries || !actualSeries) return;
    if (!locked || !locked.path || !locked.path.length) {
      lockSeries.setData([]); actualSeries.setData([]);
      state.locked = null;
      return;
    }
    state.locked = locked;

    var from = locked.anchorTime, to = locked.path[locked.path.length - 1].time;
    var seed = { time: from, value: locked.anchorPrice };

    // A point whose time is not strictly increasing makes Lightweight Charts
    // throw and take the whole repaint with it, so the seed is dropped rather
    // than prepended when the path already starts at the anchor.
    var pathData = locked.path[0].time <= from ? locked.path.slice() : [seed].concat(locked.path);
    lockSeries.setData(pathData);

    var real = [];
    for (var i = 0; i < state.candles.length; i++) {
      var b = state.candles[i];
      if (b.time < from || b.time > to) continue;
      real.push({ time: b.time, value: b.close });
    }
    if (real.length && real[0].time > from) real.unshift(seed);
    actualSeries.setData(real);
  }

  /* The actual line has to grow with the tape or it stops being the actual
     line. Called from tick(), which is the only place a bar changes between
     repaints. */
  function extendActual(price, slot) {
    if (!actualSeries || !state.locked) return;
    var L = state.locked;
    if (slot < L.anchorTime || slot > L.path[L.path.length - 1].time) return;
    actualSeries.update({ time: slot, value: price });
  }

  /* Live tick: rewrite the forming candle without touching the rest. */
  function tick(price, whenSec) {
    if (!chart || !state.candles.length || !price) return;
    var tf = C.timeframes[state.tf];
    var now = whenSec || Math.floor(Date.now() / 1000);
    var slot = Math.floor(now / tf.barSec) * tf.barSec;
    var last = state.candles[state.candles.length - 1];

    if (slot > last.time) {
      var fresh = { time: slot, open: price, high: price, low: price, close: price };
      state.candles.push(fresh);
      candleSeries.update(fresh);
      state.lastCandleTime = slot;
    } else {
      last.close = price;
      if (price > last.high) last.high = price;
      if (price < last.low) last.low = price;
      candleSeries.update(last);
    }
    extendActual(price, slot);
    positionOverlays();
  }

  /* ================================================== pattern geometry
     Each structure carries its own line segments, so the chart draws the
     triangle, the neckline, the flagpole - the thing itself - rather than a
     label claiming one is there. A label you cannot check is decoration; a
     line sitting on the highs is something you can disagree with.

     Two-point segments are drawn as-is. Lightweight Charts needs strictly
     increasing, de-duplicated times, so points are sorted and collapsed
     first - a segment whose ends land in the same bar would otherwise throw
     and take the whole repaint with it.                                     */
  function tidy(points) {
    var seen = {}, out = [];
    points.slice().sort(function (a, b) { return a.time - b.time; }).forEach(function (pt) {
      if (pt.value === null || pt.value === undefined || isNaN(pt.value)) return;
      if (seen[pt.time]) return;
      seen[pt.time] = 1;
      out.push({ time: pt.time, value: pt.value });
    });
    return out.length >= 2 ? out : [];
  }

  function drawStructures() {
    if (!chart) return;
    beginPool('structure');
    if (state.overlays.patterns) {
      var p = palette();
      state.structures.forEach(function (st) {
        var colour = st.dir > 0 ? p.bull : st.dir < 0 ? p.bear : p.neutral;
        (st.lines || []).forEach(function (ln) {
          var pts = tidy(ln.points);
          if (!pts.length) return;
          var dashed = ln.role === 'neckline';
          take('structure', {
            color: colour,
            lineWidth: ln.role === 'pole' ? 2 : 1,
            lineStyle: dashed ? LightweightCharts.LineStyle.Dashed : LightweightCharts.LineStyle.Solid,
            lineType: 0, priceLineVisible: false, lastValueVisible: false,
            crosshairMarkerVisible: false, title: '',
          }).setData(pts);
        });
      });
    }
    endPool('structure');
  }

  /* -------------------------------------------------------------- overlays */
  function drawOverlays() {
    if (!chart) return;
    beginPool('overlay');
    var c = state.candles, o = state.overlays;
    if (c.length > 30) {
      var p = palette();
      var closes = c.map(function (b) { return b.close; });
      function line(values, opts) {
        var pts = [];
        for (var i = 0; i < c.length; i++) {
          if (values[i] === null || values[i] === undefined || isNaN(values[i])) continue;
          pts.push({ time: c[i].time, value: Math.round(values[i] * 100) / 100 });
        }
        if (pts.length > 1) take('overlay', opts).setData(pts);
      }
      if (o.ema) {
        line(KT.ind.ema(closes, 20), { color: '#3b82f6', lineWidth: 1, title: '' });
        line(KT.ind.ema(closes, 50), { color: '#f59e0b', lineWidth: 1, title: '' });
        if (c.length > 220) line(KT.ind.ema(closes, 200), { color: '#a855f7', lineWidth: 1, title: '' });
      }
      if (o.bands) {
        var bb = KT.ind.bollinger(c, 20, 2);
        var dotted = { lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, color: '#64748b', title: '' };
        line(bb.upper, dotted); line(bb.lower, dotted);
      }
      if (o.supertrend) {
        var st = KT.ind.supertrend(c, 10, 3);
        line(st.value, { color: '#0d9488', lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dotted, title: '' });
      }
      if (o.vwap && c.some(function (b) { return (b.volume || 0) > 0; })) {
        line(KT.ind.vwap(c), { color: '#db2777', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.LargeDashed, title: '' });
      }
    }
    endPool('overlay');
  }

  /* ----------------------------------------------------------------- levels
     Horizontal price lines for the walls price has actually respected, plus
     the trigger and target of whatever structure is closest to firing. Price
     lines belong to the candle series and have to be removed by hand. */
  function drawLevels() {
    if (!candleSeries) return;
    priceLines.forEach(function (pl) { try { candleSeries.removePriceLine(pl); } catch (e) {} });
    priceLines = [];
    var p = palette();

    if (state.overlays.levels && state.levels) {
      [state.levels.nearestResistance, state.levels.nearestSupport].forEach(function (z) {
        if (!z) return;
        priceLines.push(candleSeries.createPriceLine({
          price: z.level, color: p.level, lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true,
          title: (z.side === 'resistance' ? 'R' : 'S') + ' ' + z.touches + 'x',
        }));
      });
    }
    if (state.overlays.patterns && state.structures.length) {
      var lead = state.structures[0];
      if (lead && lead.dir) {
        var col = lead.dir > 0 ? p.bull : p.bear;
        priceLines.push(candleSeries.createPriceLine({
          price: lead.target, color: col, lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.SparseDotted, axisLabelVisible: true,
          title: 'target',
        }));
        priceLines.push(candleSeries.createPriceLine({
          price: lead.trigger, color: col, lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true,
          title: 'trigger',
        }));
      }
    }
  }

  /* ---------------------------------------------------------------- markers */
  function applyMarkers() {
    if (!candleSeries) return;
    var p = palette();
    // Cap how many points can crowd one screen. The strongest moves and the
    // high-impact headlines win; the rest stay in the data but off the chart.
    var MAX = 45;
    var chosen = state.reasons;
    if (chosen.length > MAX) {
      chosen = chosen.slice().sort(function (a, b) {
        var wa = Math.abs(a.move) * (a.impact === 'high' ? 2.5 : a.impact === 'medium' ? 1.4 : 1);
        var wb = Math.abs(b.move) * (b.impact === 'high' ? 2.5 : b.impact === 'medium' ? 1.4 : 1);
        return wb - wa;
      }).slice(0, MAX);
    }
    var markers = chosen.map(function (r) {
      var up = r.move >= 0;
      return {
        time: r.time,
        position: up ? 'aboveBar' : 'belowBar',
        color: r.impact === 'high' ? (up ? p.up : p.down) : p.now,
        shape: r.impact === 'high' ? (up ? 'arrowUp' : 'arrowDown') : 'circle',
        size: r.impact === 'high' ? 1.3 : 0.8,
        // Label only the moves worth reading at a glance; the rest get a dot
        // and reveal their reason on hover.
        text: (r.impact === 'high' && Math.abs(r.move) >= 0.15) ? core.fmt.pct(r.move, 1) : '',
      };
    });
    // Your own entries sit on the same axis as the news points, so you can see
    // what the tape was doing at the moment you took the trade.
    var trades = [];
    if (KT.journal && KT.journal.isUnlocked && KT.journal.isUnlocked()) {
      try { trades = KT.journal.markers(state.symbol || KT.CONFIG.defaultSymbol); } catch (e) { trades = []; }
    }
    // Patterns sit alongside the news points and your own entries.
    var pats = [];
    if (state.patternMarkers && state.patternMarkers.length) pats = state.patternMarkers;

    // Forecast checkpoints: the "where will it be at X" answers, marked on the
    // projection itself so the time axis and the table cannot drift apart.
    var cps = [];
    if (state.forecast && state.forecast.checkpoints) {
      state.forecast.checkpoints.forEach(function (cp, i) {
        if (i !== state.forecast.checkpoints.length - 1 && i % 2 === 1) return;   // thin them out
        cps.push({
          time: cp.time, position: 'aboveBar', color: p.forecast, shape: 'circle', size: 0.7,
          text: cp.label + ' ' + cp.pUp + '%',
        });
      });
    }
    markers = markers.concat(trades).concat(pats).concat(cps);
    markers.sort(function (a, b) { return a.time - b.time; });
    try { candleSeries.setMarkers(markers); } catch (e) {}
  }

  /* -------------------------------------------------------------- framing
     4 parts history, 1 part forecast, anchored to the right edge.          */
  function frameView() {
    if (!chart || !state.total) return;
    var tf = C.timeframes[state.tf];
    var fcBars = state.forecast && state.forecast.path ? state.forecast.path.length : 0;
    var histBars = Math.min(state.candles.length, fcBars ? fcBars * (tf.histPerForecast || 4) : tf.visibleBars);
    var span = histBars + fcBars;
    var to = state.total - 0.5;
    try {
      chart.timeScale().setVisibleLogicalRange({ from: to - span, to: to });
    } catch (e) {
      chart.timeScale().fitContent();
    }
    positionOverlays();
  }

  function positionOverlays() {
    if (!chart || !els.stage || !state.lastCandleTime) return;
    var x = null;
    try { x = chart.timeScale().timeToCoordinate(state.lastCandleTime); } catch (e) { x = null; }
    var w = els.stage.clientWidth;
    if (x === null || x === undefined || x < 0 || x > w) {
      if (els.now) els.now.style.display = 'none';
      if (els.zone) els.zone.style.display = 'none';
      return;
    }
    if (els.now) { els.now.style.display = ''; els.now.style.left = x + 'px'; }
    if (els.zone && state.forecast && state.forecast.path && state.forecast.path.length) {
      // Stop the shaded band at the price axis, not at the panel edge, so the
      // forecast region reads as exactly the last fifth of the plot.
      var scaleW = 0;
      try { scaleW = chart.priceScale('right').width() || 0; } catch (e) { scaleW = 0; }
      els.zone.style.display = '';
      els.zone.style.left = x + 'px';
      els.zone.style.width = Math.max(0, w - scaleW - x) + 'px';
    }
  }

  /* -------------------------------------------------------------- the card */
  function nearestReason(time) {
    if (!state.reasons.length) return null;
    var bucket = C.timeframes[state.tf].reasonBucket;
    var best = null, bestD = Infinity;
    state.reasons.forEach(function (r) {
      var d = Math.abs(r.time - time);
      if (d < bestD) { bestD = d; best = r; }
    });
    return bestD <= bucket * 1.2 ? best : null;
  }

  function showCard(reason, point) {
    if (!els.card || !reason) return;
    var bucket = reason.bucketSec || C.timeframes[state.tf].reasonBucket;
    var label = bucket >= 86400 ? 'Day' : bucket >= 3600 ? Math.round(bucket / 3600) + '-hour window' : Math.round(bucket / 60) + '-minute window';

    core.text('rc-when', label + ' · ' + core.fmt.stamp(reason.bucketStart, bucket));
    var moveEl = core.el('rc-move');
    if (moveEl) {
      moveEl.textContent = core.fmt.pct(reason.move);
      moveEl.className = 'reason-move num ' + core.fmt.cls(reason.move);
    }
    core.text('rc-text', reason.text);

    var chip = core.el('rc-impact');
    if (chip) {
      chip.textContent = reason.impact === 'high' ? 'High impact' : reason.impact === 'medium' ? 'Medium impact' : 'Price action';
      chip.className = 'chip ' + (reason.impact === 'high' ? 'high' : reason.sentiment > 0 ? 'pos' : reason.sentiment < 0 ? 'neg' : '');
    }
    var src = reason.source + (reason.newsCount > 1 ? ' · ' + reason.newsCount + ' headlines in window' : '');
    if (reason.agrees === false) src += ' · headline and move disagree';
    core.text('rc-source', src);

    els.card.classList.remove('hidden');
    if (point && els.stage) {
      var w = els.stage.clientWidth, h = els.stage.clientHeight;
      var cw = els.card.offsetWidth || 300, ch = els.card.offsetHeight || 110;
      els.card.style.left = core.clamp(point.x + 16, 8, Math.max(8, w - cw - 8)) + 'px';
      els.card.style.top = core.clamp(point.y - ch - 12, 8, Math.max(8, h - ch - 8)) + 'px';
    }
  }

  function hideCard() { if (els.card && !state.pinned) els.card.classList.add('hidden'); }

  /* Hovering the traded half and the projected half are different questions.
     Left of NOW the useful answer is what happened; right of it there is no
     "what happened" to give, so the card explains why the line sits where it
     does at that minute instead. */
  function onCrosshair(param) {
    if (state.pinned) return;
    if (!param || !param.point || !param.time) { hideCard(); hideForecastCard(); return; }

    if (state.lastCandleTime && param.time > state.lastCandleTime) {
      hideCard();
      var a = nearestAttribution(param.time);
      if (a && state.overlays.why) showForecastCard(a, param.point); else hideForecastCard();
      return;
    }
    hideForecastCard();
    var r = nearestReason(param.time);
    if (r) showCard(r, param.point); else hideCard();
  }

  function nearestAttribution(time) {
    var att = state.forecast && state.forecast.attribution;
    if (!att || !att.length) return null;
    var best = null, bestD = Infinity;
    for (var i = 0; i < att.length; i++) {
      var d = Math.abs(att[i].time - time);
      if (d < bestD) { bestD = d; best = att[i]; }
    }
    // One bar-width of tolerance: beyond that the pointer is not on the line.
    var barSec = C.timeframes[state.tf] ? C.timeframes[state.tf].barSec : 300;
    return bestD <= barSec * 1.5 ? best : null;
  }

  function hideForecastCard() { if (els.fcard) els.fcard.classList.add('hidden'); }

  /* A scheduled release inside one bar-width of this projected bar. */
  function eventNear(time) {
    var evs = state.events && state.events.events;
    if (!evs || !evs.length) return null;
    var barSec = C.timeframes[state.tf] ? C.timeframes[state.tf].barSec : 300;
    var span = Math.max(barSec, 900);
    for (var i = 0; i < evs.length; i++) {
      if (Math.abs(evs[i].ts - time) <= span) return evs[i];
    }
    return null;
  }

  function showForecastCard(a, point) {
    if (!els.fcard || !state.forecast) return;
    var f = state.forecast, last = f.lastClose;
    var centre = last * (1 + a.driftPct / 100);

    // "bar 264/375" rather than "bar 264 of 375": at 260px the longer form
    // wraps the header onto two lines on the session view, where the bar
    // numbers run to three digits.
    core.text('fcd-when', a.label + '  ·  bar ' + a.bar + '/' + f.forecastBars);
    var mv = core.el('fcd-move');
    if (mv) { mv.textContent = core.fmt.pct(a.driftPct); mv.className = 'fcard-move num ' + core.fmt.cls(a.driftPct); }
    core.text('fcd-price', core.fmt.price(centre));
    /* Above what, exactly. The reference moved from "the last close" to "the
       price the projection starts from" when the opening gap arrived, and a
       card that kept naming the old one would be labelling the number with a
       price it is no longer measured against. */
    var ref = f.checkpoints && f.checkpoints.length && f.checkpoints[0].pUpFrom != null
      ? f.checkpoints[0].pUpFrom : last;
    core.text('fcd-prob', a.pUp + '% above ' + core.fmt.price(ref));

    /* One sentence, naming the lane doing the most work at THIS bar - which is
       often not the lane doing the most work overall, and is the whole reason
       this card exists rather than the panel answering it.

       The lane's own note used to be quoted here in parentheses. On the global
       lane that note is "US futures +1.62%, Crude -8.70%", which is already
       printed twice on the right: once in the driver list and once in the
       narrative. Three copies of one fact, and the widest of them sitting on
       top of the chart. The note is gone; the lane's name and direction are
       what this card is for. */
    var top = a.lanes[0], second = a.lanes[1];
    var lead;
    if (!top) {
      lead = 'Nothing is pushing measurably here — the line is flat because the inputs cancel, not because they are absent.';
    } else {
      lead = top.label + ' is pulling ' + (top.pct > 0 ? 'up' : 'down') + ' hardest here';
      if (second) {
        lead += (second.pct > 0) === (top.pct > 0)
          ? ', with ' + second.label.toLowerCase() + ' behind it'
          : ', against ' + second.label.toLowerCase();
      }
      lead += '.';
      /* One exception to the one-sentence rule, because it is the only thing
         on this card that is NOT on the panel: a scheduled release landing in
         this bar. The band deliberately does not widen for it - India VIX
         already prices scheduled risk in aggregate - so naming it is the only
         way a reader learns it is coming. */
      var ev = eventNear(a.time);
      if (ev) lead += ' ' + ev.country + ' ' + ev.title + ' lands in this bar.';
    }
    core.text('fcd-lead', lead);

    els.fcard.classList.remove('hidden');
    if (point && els.stage) {
      var w = els.stage.clientWidth, h = els.stage.clientHeight;
      var cw = els.fcard.offsetWidth || 260, ch = els.fcard.offsetHeight || 96;

      /* The time axis is off limits. Clamping to the stage height let the card
         sit over the axis labels, which is exactly the complaint: the one
         piece of information only the chart carries, hidden by a box repeating
         what the panel already said. Ask the chart how tall its axis is rather
         than guessing, because that height changes with the font and with
         whether seconds are shown. */
      var axisH = 28;
      try { axisH = (chart.timeScale().height() || 28) + 6; } catch (e) { axisH = 34; }
      var floor = Math.max(8, h - axisH - ch - 4);

      // Flip to the left of the pointer near the right edge, which on the
      // forecast half is where the pointer usually is.
      var x = point.x + 16 + cw > w - 8 ? point.x - cw - 16 : point.x + 16;
      // Sit above the pointer, not centred on it, so the card never straddles
      // the line it is describing.
      var y = point.y - ch - 14;
      if (y < 8) y = point.y + 18;
      els.fcard.style.left = core.clamp(x, 8, Math.max(8, w - cw - 8)) + 'px';
      els.fcard.style.top = core.clamp(y, 8, floor) + 'px';
    }
  }

  function onClick(param) {
    if (!param || !param.time) { state.pinned = null; hideCard(); return; }
    var r = nearestReason(param.time);
    if (!r) { state.pinned = null; hideCard(); return; }
    if (state.pinned && state.pinned.time === r.time) {
      state.pinned = null; hideCard();
    } else {
      state.pinned = r;
      showCard(r, param.point);
      if (r.url && KT.app && KT.app.onReasonClick) KT.app.onReasonClick(r);
    }
  }

  function setEvents(e) { state.events = e || null; }

  function showEmpty(message, detail) {
    hideForecastCard();
    if (!els.empty) return;
    els.empty.classList.remove('hidden');
    els.empty.innerHTML = '';
    var s = document.createElement('strong'); s.textContent = message;
    var d = document.createElement('span'); d.className = 'muted'; d.textContent = detail || '';
    els.empty.appendChild(s); els.empty.appendChild(d);
  }

  KT.chart = {
    init: init, setData: setData, tick: tick, retheme: retheme,
    frameView: frameView, showEmpty: showEmpty, refreshMarkers: applyMarkers,
    setEvents: setEvents,
    setPatterns: function (m) { state.patternMarkers = m || []; applyMarkers(); },
    setStructures: function (list) { state.structures = list || []; drawStructures(); drawLevels(); applyMarkers(); },
    setLevels: function (lv) { state.levels = lv || null; drawLevels(); },
    setOverlay: function (name, on) {
      if (!(name in state.overlays)) return;
      state.overlays[name] = !!on;
      drawOverlays(); drawStructures(); drawLevels();
    },
    overlays: function () { return state.overlays; },
    getState: function () { return state; },
  };
})(window.KT);
