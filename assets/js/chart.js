/* ============================================================================
   Chart: candles for the past and present, a live projection for the future,
   the geometry of every detected pattern drawn where it actually sits, the
   levels price has respected, and a reason point wherever something moved
   the index.

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
  var newsFcSeries = null, patFcSeries = null;   // the two component projections
  var pool = { structure: [], overlay: [] };     // reusable line series
  var priceLines = [];                            // horizontal lines on the candle series
  var state = {
    candles: [], forecast: null, reasons: [], patternMarkers: [],
    structures: [], levels: null, indicators: null,
    overlays: { ema: true, bands: false, supertrend: false, vwap: false, levels: true, patterns: true },
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
      fcNews: css('--fc-news', '#0284c7'),
      fcPattern: css('--fc-pattern', '#ea580c'),
      locked: css('--fc-locked', '#db2777'),
      actual: css('--actual-line', '#111827'),
      now: css('--now-line', '#94a3b8'),
      bull: css('--pattern-bull', '#0ea5e9'),
      bear: css('--pattern-bear', '#d97706'),
      neutral: css('--pattern-neutral', '#94a3b8'),
      level: css('--level-line', '#64748b'),
    };
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

    candleSeries = chart.addCandlestickSeries({
      upColor: p.up, downColor: p.down,
      borderUpColor: p.up, borderDownColor: p.down,
      wickUpColor: p.up, wickDownColor: p.down,
      priceLineVisible: true, priceLineWidth: 1, priceLineStyle: LightweightCharts.LineStyle.Dotted,
      lastValueVisible: true,
    });

    /* The frozen call. Set once per session and never rewritten, so what is
       drawn at 15:30 is the same line that was drawn at 09:15. Widening it or
       nudging it later would turn the whole record into decoration. */
    lockSeries = chart.addLineSeries({
      color: p.locked, lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
      title: 'Predicted',
    });
    /* What price actually did over the frozen call's window. Drawn on top of
       the candles rather than instead of them: the candles are the evidence,
       this line is only there to be compared against the one above it. */
    actualSeries = chart.addLineSeries({
      color: p.actual, lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Solid,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
      title: 'Actual',
    });
    // Component paths sit under the blended line so the blend reads on top.
    newsFcSeries = chart.addLineSeries({
      color: p.fcNews, lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
      title: 'News',
    });
    patFcSeries = chart.addLineSeries({
      color: p.fcPattern, lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
      title: 'Pattern',
    });

    fcSeries = chart.addLineSeries({
      color: p.forecast, lineWidth: 3, lineStyle: LightweightCharts.LineStyle.Solid,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
      title: 'Forecast',
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
    fcSeries.applyOptions({ color: p.forecast });
    if (lockSeries) lockSeries.applyOptions({ color: p.locked });
    if (actualSeries) actualSeries.applyOptions({ color: p.actual });
    if (newsFcSeries) newsFcSeries.applyOptions({ color: p.fcNews });
    if (patFcSeries) patFcSeries.applyOptions({ color: p.fcPattern });
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
      // Both start from the same real close, so any divergence between them is
      // the models disagreeing rather than a plotting offset.
      newsFcSeries.setData(forecast.pathNews ? [anchor].concat(forecast.pathNews) : []);
      patFcSeries.setData(forecast.pathPattern ? [anchor].concat(forecast.pathPattern) : []);
      state.total = state.candles.length + forecast.path.length;
    } else {
      [fcSeries, newsFcSeries, patFcSeries]
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
      if (a) showForecastCard(a, param.point); else hideForecastCard();
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

    core.text('fcd-when', a.label + '  ·  bar ' + a.bar + ' of ' + f.forecastBars);
    var mv = core.el('fcd-move');
    if (mv) { mv.textContent = core.fmt.pct(a.driftPct); mv.className = 'fcard-move num ' + core.fmt.cls(a.driftPct); }
    core.text('fcd-price', core.fmt.price(centre));
    /* Above what, exactly. The reference moved from "the last close" to "the
       price the projection starts from" when the opening gap arrived, and a
       card that kept naming the old one would be labelling the number with a
       price it is no longer measured against. */
    var fc = state.forecast;
    var ref = fc && fc.checkpoints && fc.checkpoints.length && fc.checkpoints[0].pUpFrom != null
      ? fc.checkpoints[0].pUpFrom : last;
    core.text('fcd-prob', a.pUp + '% chance above ' + core.fmt.price(ref));

    /* The lead sentence names the lane doing the most work at THIS bar, which
       is often not the lane doing the most work overall - that is the whole
       reason this card exists. */
    var top = a.lanes[0], second = a.lanes[1];
    var lead;
    if (!top) {
      lead = 'No lane is pushing measurably at this point. The line is flat here because the inputs cancel, not because they are absent.';
    } else {
      var dir = top.pct > 0 ? 'up' : 'down';
      lead = top.label + ' is the strongest pull ' + dir + ' here (' + top.note + ')';
      if (second) {
        lead += (second.pct > 0) === (top.pct > 0)
          ? ', with ' + second.label.toLowerCase() + ' adding to it'
          : ', against ' + second.label.toLowerCase() + ' pulling the other way';
      }
      lead += '.';
    }
    core.text('fcd-lead', lead);

    /* Bars, scaled to the largest contribution at this bar so the comparison is
       between lanes rather than against the whole horizon - a 0.01% push that
       is the only thing moving the line should look like the thing moving the
       line. */
    var host = core.el('fcd-bars');
    if (host) {
      host.innerHTML = '';
      var rows = a.lanes.slice(0, 5);
      if (a.shapePct) rows.push({ label: 'Time of day', pct: a.shapePct, arrived: null, id: 'shape' });
      // The analogue bends the line without changing any lane's view, so it
      // gets its own row rather than being smeared across theirs.
      if (a.analogPct) rows.push({ label: 'Past analogue', pct: a.analogPct, arrived: null, id: 'analog' });
      var max = 0;
      rows.forEach(function (r) { max = Math.max(max, Math.abs(r.pct)); });
      if (!max) max = 1;
      rows.forEach(function (r) {
        var row = document.createElement('div'); row.className = 'fcard-row';
        var nm = document.createElement('span'); nm.className = 'fcard-name'; nm.textContent = r.label;
        var track = document.createElement('span'); track.className = 'fcard-track';
        var fill = document.createElement('span');
        fill.className = 'fcard-fill ' + (r.pct >= 0 ? 'pos' : 'neg');
        fill.style.width = (Math.abs(r.pct) / max * 50) + '%';
        var zero = document.createElement('span'); zero.className = 'fcard-zero';
        track.appendChild(fill); track.appendChild(zero);
        var val = document.createElement('span');
        val.className = 'fcard-val ' + core.fmt.cls(r.pct);
        val.textContent = core.fmt.pct(r.pct, 3);
        row.appendChild(nm); row.appendChild(track); row.appendChild(val);
        host.appendChild(row);
      });
    }

    var lo = last * (1 + (a.driftPct - a.sdPct * (f.z68 || 1)) / 100);
    var hi = last * (1 + (a.driftPct + a.sdPct * (f.z68 || 1)) / 100);
    core.text('fcd-range', 'Likely range ' + core.fmt.price(lo) + ' – ' + core.fmt.price(hi));
    core.text('fcd-width', '±' + core.fmt.pct(a.sdPct * (f.z68 || 1), 2).replace('+', ''));

    /* The small print carries the two things that make the number checkable:
       how far each timing curve has travelled, and what set the width. */
    var fine = [];
    if (top && top.arrived != null) fine.push(top.arrived + '% of the ' + top.label.toLowerCase() + ' push has landed by this bar');
    if (a.profileMult && Math.abs(a.profileMult - 1) > 0.15) {
      fine.push('this slot runs at ' + a.profileMult + '× the average bar variance, so the band is ' +
                (a.profileMult > 1 ? 'wider' : 'tighter') + ' here');
    }
    if (a.temperPct) fine.push('a level with a record trimmed ' + core.fmt.pct(a.temperPct, 3) + ' off the push');
    if (a.cappedPct) fine.push('the per-bar drift cap removed ' + core.fmt.pct(a.cappedPct, 3));
    /* A scheduled release inside this bar is worth naming, because it is the
       one thing on the card the model does NOT price: India VIX already
       carries event risk in aggregate, so widening the band here as well would
       double-count it the way the GARCH double-counted the intraday profile.
       Saying it is coming is honest; pretending to have calibrated it is not. */
    var ev = eventNear(a.time);
    if (ev) {
      fine.push(ev.country + ' ' + ev.title + ' lands in this bar (' + ev.impact +
                ' impact) - the band does not widen for it, VIX already prices scheduled risk in aggregate');
    }
    if (f.zBasis) fine.push('band width: ' + f.zBasis);
    core.text('fcd-fine', fine.join(' · ') + '.');

    els.fcard.classList.remove('hidden');
    if (point && els.stage) {
      var w = els.stage.clientWidth, h = els.stage.clientHeight;
      var cw = els.fcard.offsetWidth || 300, ch = els.fcard.offsetHeight || 200;
      // Flip to the left of the pointer near the right edge, which on the
      // forecast half is where the pointer usually is.
      var x = point.x + 16 + cw > w - 8 ? point.x - cw - 16 : point.x + 16;
      els.fcard.style.left = core.clamp(x, 8, Math.max(8, w - cw - 8)) + 'px';
      els.fcard.style.top = core.clamp(point.y - ch / 2, 8, Math.max(8, h - ch - 8)) + 'px';
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
