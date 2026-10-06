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
  /* The prediction trail (see trail.js) and the miss it made at every bar.
     trailSeries is the line the model drew `lead` bars earlier, kept after
     its time has come; errSeries is actual minus that line, on its own scale
     along the bottom of the chart, so "how close" is a bar height rather than
     something a reader has to estimate between two thin lines. */
  var trailSeries = null, errSeries = null;
  var pool = { structure: [], overlay: [] };     // reusable line series
  var priceLines = [];                            // horizontal lines on the candle series
  var state = {
    candles: [], forecast: null, reasons: [], patternMarkers: [],
    structures: [], levels: null, indicators: null,
    overlays: { ema: true, bands: false, supertrend: false, vwap: false, levels: true, patterns: true, why: true,
                trail: true, errors: true },
    tf: C.defaultTimeframe, symbol: C.defaultSymbol,
    lastCandleTime: null, pinned: null, total: 0, locked: null,
    trail: null, trailByT: {}, candleByT: {}, replay: null,
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
      trail: css('--trail', '#6d28d9'),
      trailLive: css('--trail-live', '#d97706'),
      errOn: css('--err-on', '#94a3b8'),
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

  /* The candles give up the bottom fifth of the plot when the miss ribbon is
     on, so the two never overlap: a histogram drawn through the candles would
     be read as volume. */
  function mainMargins() {
    return state.overlays.errors && state.trail && state.trail.length
      ? { top: 0.07, bottom: 0.24 } : { top: 0.08, bottom: 0.12 };
  }

  /* The time axis was printing UTC. The crosshair label goes through
     core.fmt and said IST, while the tick marks under it used the library's
     default: on the 6 Oct 2026 replay of the 5 Oct session the axis read
     05:00 ... 09:00 for a market that trades 09:15-15:30 in Mumbai. The
     library still chooses WHERE ticks go on the UTC calendar, which is safe
     here - a session runs 03:45-10:00 UTC and never crosses UTC midnight, so
     the day mark still lands on each session's first bar - and only the
     label is converted. Hourly ticks therefore read 10:30, 11:30 ...: the
     UTC hour is half past in IST, and that is the true time of those bars. */
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function two(n) { return n < 10 ? '0' + n : String(n); }
  function tickMark(t, type) {
    var sec = typeof t === 'number' ? t : Date.UTC(t.year, t.month - 1, t.day) / 1000;
    var d = core.fmt.ist(sec);
    if (type === 0) return String(d.getFullYear());
    if (type === 1) return MON[d.getMonth()];
    if (type === 2) return String(d.getDate());
    if (type === 4) return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
    return two(d.getHours()) + ':' + two(d.getMinutes());
  }

  function chartOptions() {
    var p = palette();
    return {
      layout: { background: { type: 'solid', color: p.bg }, textColor: p.ink, fontFamily: "Inter, system-ui, sans-serif", fontSize: 11 },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderColor: p.axis, scaleMargins: mainMargins(), entireTextOnly: true },
      timeScale: { borderColor: p.axis, timeVisible: true, secondsVisible: false, rightOffset: 2, fixLeftEdge: false, lockVisibleTimeRangeOnResize: true,
                   tickMarkFormatter: tickMark },
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
    els.hud = document.getElementById('chart-hud');
    els.replayBar = document.getElementById('replay-bar');

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

    errSeries = chart.addHistogramSeries({
      priceScaleId: 'trailerr', priceLineVisible: false, lastValueVisible: false,
      base: 0, color: p.errOn,
    });
    chart.priceScale('trailerr').applyOptions({ scaleMargins: { top: 0.83, bottom: 0.01 }, visible: false });

    candleSeries = chart.addCandlestickSeries({
      upColor: p.up, downColor: p.down,
      borderUpColor: p.up, borderDownColor: p.down,
      wickUpColor: p.up, wickDownColor: p.down,
      priceLineVisible: true, priceLineWidth: 1, priceLineStyle: LightweightCharts.LineStyle.Dotted,
      lastValueVisible: true,
    });

    /* The one exception to "guides under the candles". The trail is the line
       the whole comparison is about, and a one-pixel line under five-minute
       bodies disappears exactly where price and prediction meet - which is
       the place it most needs to be seen. One pixel, on top, so the candles
       still carry the picture. Per-point colour separates the replayed
       stretch (violet) from what this browser recorded live (amber), because
       a backtest and a forward record are different evidence. */
    trailSeries = chart.addLineSeries({
      color: soften(p.trail, 0.95), lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Solid,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      title: '',
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
    drawStructures(); drawOverlays(); drawLevels(); drawTrail();
    applyMarkers();
  }

  /* ------------------------------------------------------------------ data */
  function setData(candles, forecast, reasons, tfKey, symbol) {
    if (!chart) return;
    // A replay owns the chart until it is stopped; the live repaint must not
    // overwrite the frame it is showing.
    if (state.replay) return;
    // A card left over from the previous series would describe bars that no
    // longer exist on this one.
    hideForecastCard();
    if (tfKey !== state.tf || (symbol && symbol !== state.symbol)) state.trail = null;
    state.tf = tfKey;
    if (symbol) state.symbol = symbol;
    state.candles = candles || [];
    state.forecast = forecast || null;
    state.reasons = reasons || [];
    state.lastCandleTime = state.candles.length ? state.candles[state.candles.length - 1].time : null;
    state.candleByT = {};
    for (var ci = 0; ci < state.candles.length; ci++) state.candleByT[state.candles[ci].time] = ci;

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
    drawTrail();
    applyMarkers();
    frameView();
    renderHud(null);
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

  /* ===================================================== prediction trail

     `points` is trail.merge() output: one entry per bar, live where this
     browser recorded one and replayed elsewhere. Only points on a bar that
     exists are drawn - see indexAtTime() in trail.js for why a point at a
     time no candle carries would push a gap into the candles. */
  function setTrail(points, meta) {
    state.trail = points || null;
    state.trailMeta = meta || null;
    state.trailByT = {};
    (points || []).forEach(function (p) { state.trailByT[p.t] = p; });
    if (!state.replay) drawTrail();
    renderHud(null);
  }

  function trailColour(p, pal) {
    return p.src === 'live' ? soften(pal.trailLive, 1) : soften(pal.trail, 0.95);
  }
  function errColour(p, pal) {
    if (p.side === 'above') return soften(pal.up, 0.75);
    if (p.side === 'below') return soften(pal.down, 0.75);
    return soften(pal.errOn, 0.6);
  }

  function trailLineData(points, upTo) {
    var pal = palette(), line = [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (upTo != null && p.m > upTo) continue;
      if (!(p.t in state.candleByT) && !state.replay) continue;
      line.push({ time: p.t, value: p.p, color: trailColour(p, pal) });
    }
    return line;
  }
  function trailErrData(points, upTo) {
    var pal = palette(), bars = [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (p.a == null || p.e == null) continue;
      if (upTo != null && p.t > upTo) continue;
      if (!(p.t in state.candleByT)) continue;
      bars.push({ time: p.t, value: p.e, color: errColour(p, pal) });
    }
    return bars;
  }

  function drawTrail() {
    if (!trailSeries || !errSeries) return;
    var pts = state.trail || [];
    var showLine = state.overlays.trail && pts.length;
    var showErr = state.overlays.errors && pts.length;
    try { trailSeries.setData(showLine ? trailLineData(pts) : []); } catch (e) { trailSeries.setData([]); }
    try { errSeries.setData(showErr ? trailErrData(pts) : []); } catch (e) { errSeries.setData([]); }
    try { chart.priceScale('right').applyOptions({ scaleMargins: mainMargins() }); } catch (e) {}
  }

  /* ============================================================ the HUD
     One readout in the corner of the plot that answers, for whatever bar is
     under the pointer: what traded, what the line said it would be, and by
     how much it missed. With the pointer off the chart it shows the latest
     bar, so the panel is never empty. */
  function hudBarLabel() {
    var tf = C.timeframes[state.tf];
    if (!tf) return '';
    var s = tf.barSec;
    if (s < 3600) return Math.round(s / 60) + '-min bars';
    if (s < 86400) return Math.round(s / 3600) + '-hour bars';
    if (s < 604800) return 'daily bars';
    if (s < 2419200) return 'weekly bars';
    return 'monthly bars';
  }

  function renderHud(time) {
    if (!els.hud) return;
    var c = state.candles;
    if (!c.length) { els.hud.innerHTML = ''; return; }
    var tf = C.timeframes[state.tf] || { barSec: 300 };
    var f = state.forecast;
    var parts = [];
    var sym = C.symbols[state.symbol] ? C.symbols[state.symbol].label : state.symbol;

    if (time != null && state.lastCandleTime != null && time > state.lastCandleTime && f && f.path) {
      // The projected half: what the line claims for this bar.
      var best = null;
      for (var q = 0; q < f.path.length; q++) {
        if (!best || Math.abs(f.path[q].time - time) < Math.abs(best.time - time)) best = f.path[q];
      }
      var idx = best ? f.path.indexOf(best) : -1;
      parts.push('<div class="hud-l1"><b>' + esc(sym) + '</b><span class="hud-dim">' + esc(hudBarLabel()) +
                 ' · forecast for ' + esc(core.fmt.stamp(best ? best.time : time, tf.barSec)) + '</span></div>');
      if (best) {
        var lo = f.lower && f.lower[idx], hi = f.upper && f.upper[idx];
        parts.push('<div class="hud-l2"><span class="hud-k">Model says</span> <b class="num">' + core.fmt.price(best.value) + '</b>' +
                   (lo && hi ? ' <span class="hud-dim">likely ' + core.fmt.price(lo.value) + ' – ' + core.fmt.price(hi.value) + '</span>' : '') +
                   ' <span class="num ' + core.fmt.cls(best.value - f.lastClose) + '">' +
                   core.fmt.pct((best.value - f.lastClose) / f.lastClose * 100) + '</span></div>');
      }
      els.hud.innerHTML = parts.join('');
      return;
    }

    var i = time != null && (time in state.candleByT) ? state.candleByT[time] : c.length - 1;
    var b = c[i], prev = i > 0 ? c[i - 1] : null;
    var chg = prev ? b.close - prev.close : null;
    parts.push('<div class="hud-l1"><b>' + esc(sym) + '</b><span class="hud-dim">' + esc(hudBarLabel()) + ' · ' +
               esc(core.fmt.stamp(b.time, tf.barSec < 86400 ? 60 : 86400)) + '</span>' +
               '<span class="hud-ohlc num">O ' + core.fmt.price(b.open) + ' H ' + core.fmt.price(b.high) +
               ' L ' + core.fmt.price(b.low) + ' C <b>' + core.fmt.price(b.close) + '</b></span>' +
               (chg != null ? '<span class="num ' + core.fmt.cls(chg) + '">' + core.fmt.signed(chg) +
                              ' (' + core.fmt.pct(chg / prev.close * 100) + ')</span>' : '') + '</div>');

    var tp = state.trailByT[b.time];
    var meta = state.trailMeta || {};
    if (tp && state.overlays.trail) {
      var made = core.fmt.stamp(tp.m, tf.barSec < 86400 ? 60 : 86400);
      var head = '<span class="hud-k">' + (tp.src === 'live' ? 'Recorded live' : 'Replayed') + ', drawn ' +
                 esc(meta.leadLabel || '') + ' earlier (' + esc(made) + ')</span> <b class="num">' + core.fmt.price(tp.p) + '</b>';
      var tail;
      if (tp.a == null) {
        tail = ' <span class="hud-dim">bar still forming — scored when it closes</span>';
      } else {
        var word = tp.side === 'on' ? 'inside its range' : (tp.side === 'above' ? 'price came in ABOVE the line' : 'price came in BELOW the line');
        tail = ' <span class="hud-dim">actual</span> <b class="num">' + core.fmt.price(tp.a) + '</b> <span class="num ' +
               (tp.side === 'on' ? 'flat' : (tp.e > 0 ? 'up' : 'down')) + '">' + core.fmt.signed(tp.e) + ' pts (' +
               core.fmt.pct(tp.ep) + ')</span> <span class="hud-tag ' + tp.side + '">' + word + '</span>';
      }
      parts.push('<div class="hud-l2 trail">' + head + tail + '</div>');
    } else if (meta.summary && state.overlays.trail) {
      parts.push('<div class="hud-l2 trail"><span class="hud-k">Trail</span> ' + esc(meta.summary) + '</div>');
    }
    els.hud.innerHTML = parts.join('');
  }
  function esc(x) {
    return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ================================================================ replay

     A past session played back bar by bar: the trail line runs `lead` bars
     ahead of the price - drawn from what the model knew at that moment - and
     the candles arrive to meet it. Nothing here is recomputed; every number
     comes from trail.replay(), which only ever saw candles up to the bar
     each prediction was made on. So what the animation shows is what the
     model would have shown a person watching that session live, minus the
     lanes that cannot be replayed.

     While it runs the live repaint is held off (setData returns early) and
     the overlays are blanked, because EMAs and pattern lines computed on the
     whole series would be drawing the future onto a frame that is meant to
     be the past. */
  function replayStart(cfg) {
    if (!chart || !cfg || !cfg.candles || !cfg.candles.length) return false;
    replayStop(true);
    var R = {
      candles: cfg.candles, points: cfg.points || [], from: cfg.from, to: cfg.to,
      at: cfg.from, speedMs: cfg.speedMs || 120, timer: null, onFrame: cfg.onFrame, onEnd: cfg.onEnd,
      lead: cfg.lead || 1,
    };
    state.replay = R;
    hideCard(); hideForecastCard();
    beginPool('structure'); endPool('structure');
    beginPool('overlay'); endPool('overlay');
    priceLines.forEach(function (pl) { try { candleSeries.removePriceLine(pl); } catch (e) {} });
    priceLines = [];
    try { candleSeries.setMarkers([]); } catch (e) {}
    [fcSeries, lockSeries, actualSeries].forEach(function (x) { if (x) x.setData([]); });
    if (els.zone) els.zone.hidden = true;
    if (els.now) els.now.hidden = true;

    // Every bar of the replayed window exists in the full series, so the
    // candle map is the full one and future trail points land on real bars.
    state.candleByT = {};
    for (var i = 0; i < R.candles.length; i++) state.candleByT[R.candles[i].time] = i;
    candleSeries.setData(R.candles.slice(0, R.from + 1));
    var upTo = R.candles[R.from].time;
    trailSeries.setData(trailLineData(R.points, upTo));
    errSeries.setData(trailErrData(R.points, upTo));
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.07, bottom: 0.24 } });
    frameReplay();
    R.timer = setInterval(replayStep, R.speedMs);
    return true;
  }

  function frameReplay() {
    var R = state.replay;
    if (!R) return;
    var span = Math.max(60, Math.min(400, (R.to - R.from) + R.lead + 10));
    var right = R.at + R.lead + 3;
    try { chart.timeScale().setVisibleLogicalRange({ from: right - span, to: right }); } catch (e) {}
  }

  function replayStep() {
    var R = state.replay;
    if (!R) return;
    if (R.at >= R.to) { replayStop(false); return; }
    R.at++;
    var bar = R.candles[R.at];
    candleSeries.update(bar);
    var pal = palette();
    // The prediction made on this bar, landing `lead` bars ahead.
    for (var i = 0; i < R.points.length; i++) {
      var p = R.points[i];
      if (p.m === bar.time) {
        try { trailSeries.update({ time: p.t, value: p.p, color: trailColour(p, pal) }); } catch (e) {}
      }
      if (p.t === bar.time && p.a != null) {
        try { errSeries.update({ time: p.t, value: p.e, color: errColour(p, pal) }); } catch (e) {}
      }
    }
    if ((R.at - R.from) % 4 === 0) frameReplay();
    renderHud(bar.time);
    if (R.onFrame) R.onFrame(R.at, R);
  }

  function replaySpeed(ms) {
    var R = state.replay;
    if (!R) return;
    R.speedMs = ms;
    clearInterval(R.timer);
    R.timer = setInterval(replayStep, ms);
  }

  /* Leaving a replay hands the chart back to the live state exactly as it
     was: the caller repaints through setData, which rebuilds every layer. */
  function replayStop(silent) {
    var R = state.replay;
    if (!R) return;
    clearInterval(R.timer);
    state.replay = null;
    if (!silent && R.onEnd) R.onEnd(R);
  }

  /* Live tick: rewrite the forming candle without touching the rest. */
  function tick(price, whenSec) {
    if (state.replay) return;
    if (!chart || !state.candles.length || !price) return;
    var tf = C.timeframes[state.tf];
    var now = whenSec || Math.floor(Date.now() / 1000);
    var slot = Math.floor(now / tf.barSec) * tf.barSec;
    var last = state.candles[state.candles.length - 1];

    if (slot > last.time) {
      var fresh = { time: slot, open: price, high: price, low: price, close: price };
      state.candles.push(fresh);
      state.candleByT[slot] = state.candles.length - 1;
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
    if (!state.hovering) renderHud(null);
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
        // Slate rather than the purple it used to be: purple is the forecast
        // family now (the projection and the remembered trail).
        if (c.length > 220) line(KT.ind.ema(closes, 200), { color: '#64748b', lineWidth: 1, title: '' });
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
    // A replay drives the readout frame by frame; the pointer must not fight it.
    if (state.replay) return;
    var over = !!(param && param.point && param.time);
    state.hovering = over;
    renderHud(over ? param.time : null);
    if (state.pinned) return;
    if (!over) { hideCard(); hideForecastCard(); return; }

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
    setTrail: setTrail, renderHud: renderHud,
    replayStart: replayStart, replayStop: replayStop, replaySpeed: replaySpeed,
    isReplaying: function () { return !!state.replay; },
    resize: function () {
      var box = document.getElementById('chart');
      if (chart && box && box.clientWidth) {
        chart.applyOptions({ width: box.clientWidth, height: box.clientHeight });
        positionOverlays();
      }
    },
    setPatterns: function (m) { state.patternMarkers = m || []; applyMarkers(); },
    setStructures: function (list) { state.structures = list || []; drawStructures(); drawLevels(); applyMarkers(); },
    setLevels: function (lv) { state.levels = lv || null; drawLevels(); },
    setOverlay: function (name, on) {
      if (!(name in state.overlays)) return;
      state.overlays[name] = !!on;
      if (state.replay) return;
      drawOverlays(); drawStructures(); drawLevels(); drawTrail();
      renderHud(null);
    },
    overlays: function () { return state.overlays; },
    getState: function () { return state; },
  };
})(window.KT);
