/* ============================================================================
   Chart: candles for the past and present, a dashed projection and a likely
   range band for the future, and a reason point wherever something actually
   moved the index.

   The visible window is always 4 parts history to 1 part forecast, which is
   what makes the projection read as "the last fifth of the picture".
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;

  var chart = null, candleSeries = null, fcSeries = null, upSeries = null, loSeries = null;
  var state = {
    candles: [], forecast: null, reasons: [], tf: C.defaultTimeframe, symbol: C.defaultSymbol,
    lastCandleTime: null, pinned: null, total: 0,
  };
  var els = {};

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
      now: css('--now-line', '#94a3b8'),
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

    upSeries = chart.addLineSeries({
      color: p.forecast, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      title: '',
    });
    loSeries = chart.addLineSeries({
      color: p.forecast, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      title: '',
    });
    fcSeries = chart.addLineSeries({
      color: p.forecast, lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed,
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
    [fcSeries, upSeries, loSeries].forEach(function (s) { s.applyOptions({ color: p.forecast }); });
    applyMarkers();
  }

  /* ------------------------------------------------------------------ data */
  function setData(candles, forecast, reasons, tfKey, symbol) {
    if (!chart) return;
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
      upSeries.setData([anchor].concat(forecast.upper));
      loSeries.setData([anchor].concat(forecast.lower));
      state.total = state.candles.length + forecast.path.length;
    } else {
      fcSeries.setData([]); upSeries.setData([]); loSeries.setData([]);
      state.total = state.candles.length;
    }

    applyMarkers();
    frameView();
    if (els.empty) els.empty.classList.add('hidden');
    if (els.zone) els.zone.hidden = !(forecast && forecast.path && forecast.path.length);
    if (els.now) els.now.hidden = !state.lastCandleTime;
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
    positionOverlays();
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
    markers = markers.concat(trades);
    markers.sort(function (a, b) { return a.time - b.time; });
    try { candleSeries.setMarkers(markers); } catch (e) {}
  }

  /* -------------------------------------------------------------- framing
     4 parts history, 1 part forecast, anchored to the right edge.          */
  function frameView() {
    if (!chart || !state.total) return;
    var tf = C.timeframes[state.tf];
    var fcBars = state.forecast && state.forecast.path ? state.forecast.path.length : 0;
    var histBars = Math.min(state.candles.length, fcBars ? fcBars * 4 : tf.visibleBars);
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

  function onCrosshair(param) {
    if (state.pinned) return;
    if (!param || !param.point || !param.time) { hideCard(); return; }
    var r = nearestReason(param.time);
    if (r) showCard(r, param.point); else hideCard();
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

  function showEmpty(message, detail) {
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
    getState: function () { return state; },
  };
})(window.KT);
