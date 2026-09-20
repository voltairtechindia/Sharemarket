/* ============================================================================
   App: boot, the polling loops, and every bit of DOM rendering.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core, data = KT.data, engine = KT.engine, chart = KT.chart;
  var el = core.el, text = core.text, fmt = core.fmt;

  var S = {
    symbol: C.defaultSymbol,
    timeframe: C.defaultTimeframe,
    quote: null,
    quotes: {},
    candles: [],
    seasonality: null,
    rollup: null,
    forecast: null,
    reasons: [],
    newsFilter: 'all',
    settings: {
      key: '',
      model: C.defaultModel,
      tickMs: C.poll.tickMs,
      newsMs: C.poll.newsMs,
    },
    timers: {},
    backoff: 0,
    lastPrice: null,
    feedsTotal: null,
    feedsAlive: null,
    narrativeAt: 0,
    booted: false,
    /* --- added lanes and computed views --------------------------------- */
    indicators: null,       // KT.ind.snapshot of the loaded candles
    levels: null,           // clustered S/R, pivots, fib, profile, gaps
    structures: [],         // triangles, flags, double tops currently on screen
    structureStats: {},     // what each of those patterns did historically here
    calibration: null,      // how well the band has actually held up
    calibratedAt: 0,
    calibratedKey: null,    // symbol:timeframe the calibration above belongs to
    global: null,           // overnight cues from the workflow
    flows: null,            // breadth, FII and DII
    options: null,          // option chain: PCR, max pain, OI walls
    internals: null,        // live breadth, VIX and midcap divergence
    constituents: null,     // index membership, so news relevance can be scored
    events: null,           // NSE trading holidays + scheduled global releases
    vix: null,
    alertsOpen: false,
  };

  /* ================================================================= BOOT */
  function boot() {
    loadSettings();
    applyTheme(core.store.get('theme', 'light'));
    wireUI();
    // The journal is an add-on. If anything in it throws, the terminal itself
    // must still boot, so its wiring never sits on the critical path.
    try { wireJournal(); } catch (e) { console.warn('journal unavailable:', e); }
    // Same rule for the holdings book: an add-on that must never stop the
    // terminal from starting.
    try { KT.portfolio.load(); wirePortfolio(); } catch (e) { console.warn('holdings unavailable:', e); }
    // The shipped gate keeps the journal shut for anyone opening the public
    // page. Failing to load it only falls back to a browser-set code.
    data.loadBaked(C.baked.auth)
      .then(function (a) { if (KT.journal) KT.journal.adoptShipped(a); })
      .catch(noop);
    renderWatchlist();
    startClock();

    // The lexicon gates scoring, so nothing else can start until it lands.
    data.loadBaked(C.baked.lexicon)
      .then(function (lex) { core.setLexicon(lex); })
      .catch(function () {
        core.setLexicon({ bullish: {}, bearish: {}, impact_high: [], impact_medium: [], relevance: [], noise: [], sector_map: {} });
        note('Lexicon did not load — news scoring is degraded.');
      })
      .then(function () {
        data.restoreNews();
        renderNews();
        return Promise.all([
          data.loadBaked(C.baked.seasonality).then(function (s) { S.seasonality = s; renderSeasonality(); }).catch(noop),
          data.loadBaked(C.baked.news).then(function (n) {
            data.adoptBakedNews(n);
            S.feedsTotal = n.feeds_total; S.feedsAlive = n.feeds_alive;
            renderNews(); renderFeedCount(n);
          }).catch(noop),
          data.loadBaked(C.baked.rollup).then(function (r) { S.rollup = r; renderSectors(); }).catch(noop),
          loadFilings().catch(noop),
          data.loadBaked(C.baked.index).then(function (i) { if (!S.feedsTotal) { S.feedsTotal = i.count; renderFeedCount(null); } }).catch(noop),
          data.loadBaked(C.baked.global).then(function (g) { S.global = g; renderCues(); }).catch(noop),
          data.loadBaked(C.baked.flows).then(function (f) { S.flows = f; }).catch(noop),
          data.loadBaked(C.baked.options).then(function (o) { S.options = o; }).catch(noop),
          data.loadBaked(C.baked.events).then(applyEvents).catch(noop),
          data.loadBaked(C.baked.constituents).then(applyConstituents).catch(noop),
          // The universe is what turns "RELIANCE" into "Reliance Industries"
          // for headline matching, so it has to land before the first scan.
          data.loadBaked(C.baked.universe).then(function (u) { KT.portfolio.setUniverse(u); fillUniverseList(); }).catch(noop),
          data.loadBaked(C.baked.stocks).then(function (q) { KT.portfolio.setQuotes(q); }).catch(noop),
        ]);
      })
      .then(function () {
        chart.init(el('chart'));
        S.booted = true;
        return refreshAll();
      })
      .then(startLoops)
      .catch(function (e) {
        chart.showEmpty('Could not load chart data', String(e && e.message || e));
      });
  }

  function noop() {}

  function note(message) {
    var n = el('key-notice');
    if (n) { n.textContent = message; n.className = 'notice'; }
  }

  /* ============================================================== SETTINGS */
  function loadSettings() {
    var saved = core.store.get('settings', {});
    S.settings.key = saved.key || (window.KT_LOCAL && window.KT_LOCAL.openrouterKey) || '';
    S.settings.model = saved.model || C.defaultModel;
    S.settings.tickMs = saved.tickMs || C.poll.tickMs;
    S.settings.newsMs = saved.newsMs || C.poll.newsMs;
  }

  function saveSettings() {
    core.store.set('settings', S.settings);
  }

  function openSettings() {
    el('cfg-key').value = S.settings.key || '';
    el('cfg-tick').value = String(S.settings.tickMs);
    el('cfg-news').value = String(S.settings.newsMs);
    text('storage-note', 'Cached news and candles use about ' + core.store.sizeKb() +
      ' KB in this browser. Headlines older than ' + C.storage.newsTtlHours +
      ' hours and anything past ' + C.storage.newsMax + ' items are dropped automatically.');

    if (KT.ledger && KT.ledger.locks) {
      var rows = KT.ledger.locks(null, 999);
      var settled = rows.filter(function (r) { return r.outcome; }).length;
      text('locks-note', rows.length
        ? rows.length + ' frozen call' + (rows.length === 1 ? '' : 's') + ', ' + settled + ' already scored. ' +
          'The oldest is ' + rows[rows.length - 1].session + '.'
        : 'Nothing frozen yet. The first call is written before the next session opens.');
    }

    var sel = el('cfg-model');
    if (sel && !sel.options.length) {
      sel.innerHTML = '<option>Loading free models…</option>';
      data.listFreeModels(S.settings.key).then(function (models) {
        sel.innerHTML = '';
        models.forEach(function (m) {
          var o = document.createElement('option');
          o.value = m; o.textContent = m;
          sel.appendChild(o);
        });
        sel.value = S.settings.model;
        if (sel.selectedIndex < 0 && models.length) {
          // The saved model has been retired by OpenRouter - move to a live one.
          sel.value = models[0];
          S.settings.model = models[0];
          saveSettings();
        }
      });
    } else if (sel) {
      sel.value = S.settings.model;
    }
    el('settings-modal').classList.remove('hidden');
  }

  function closeSettings() { el('settings-modal').classList.add('hidden'); }

  function commitSettings() {
    S.settings.key = el('cfg-key').value.trim();
    S.settings.model = el('cfg-model').value || C.defaultModel;
    S.settings.tickMs = parseInt(el('cfg-tick').value, 10) || C.poll.tickMs;
    S.settings.newsMs = parseInt(el('cfg-news').value, 10) || C.poll.newsMs;
    saveSettings();
    closeSettings();
    restartLoops();
    S.narrativeAt = 0;
    recompute();
  }

  /* ================================================================== UI */
  function wireUI() {
    el('btn-settings').addEventListener('click', openSettings);
    el('btn-close-settings').addEventListener('click', closeSettings);
    el('btn-cancel-settings').addEventListener('click', closeSettings);
    el('btn-save-settings').addEventListener('click', commitSettings);
    el('settings-modal').addEventListener('click', function (e) {
      if (e.target === el('settings-modal')) closeSettings();
    });
    el('btn-clear-cache').addEventListener('click', function () {
      core.store.clearNews();
      text('storage-note', 'Cached news cleared. It refills on the next refresh.');
    });

    /* Wiping the frozen record is destructive and permanent, so it asks, and
       it says how many sessions are about to go. Everything this panel is
       worth rests on old calls being unarguable; the button exists only
       because a development run leaves locks that were never a real claim. */
    el('btn-clear-locks').addEventListener('click', function () {
      if (!KT.ledger || !KT.ledger.locks) return;
      var n = KT.ledger.locks(null, 999).length;
      if (!n) { text('locks-note', 'There are no locked calls to forget.'); return; }
      if (!window.confirm('Forget ' + n + ' locked call' + (n === 1 ? '' : 's') +
                          '? The predicted-vs-actual record goes with them and cannot be rebuilt.')) return;
      core.store.set('fcLocks', []);
      text('locks-note', n + ' locked call' + (n === 1 ? '' : 's') + ' forgotten.');
      recompute();
    });

    el('btn-theme').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      core.store.set('theme', next);
      chart.retheme();
    });

    el('btn-insight').addEventListener('click', function () {
      el('insight-panel').classList.toggle('is-open');
    });

    el('btn-reforecast').addEventListener('click', function () {
      S.narrativeAt = 0;
      refreshNews().then(recompute);
    });

    var ovg = el('overlay-group');
    if (ovg) {
      // Remember which overlays you had on. This is a per-viewer convenience,
      // so localStorage is the right home for it and losing it costs nothing.
      var saved = core.store.get('overlays', null);
      if (saved) {
        Object.keys(saved).forEach(function (k) { chart.setOverlay(k, saved[k]); });
        ovg.querySelectorAll('.ov-btn').forEach(function (b) {
          b.classList.toggle('is-on', !!saved[b.dataset.ov]);
        });
      }
      ovg.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.ov-btn') : null;
        if (!btn) return;
        var on = !btn.classList.contains('is-on');
        btn.classList.toggle('is-on', on);
        chart.setOverlay(btn.dataset.ov, on);
        core.store.set('overlays', chart.overlays());
      });
    }

    el('tf-group').addEventListener('click', function (e) {
      var btn = e.target.closest('.tf-btn');
      if (!btn) return;
      setTimeframe(btn.getAttribute('data-tf'));
    });

    el('ticker-strip').addEventListener('click', function (e) {
      var t = e.target.closest('.tick');
      if (t) setSymbol(t.getAttribute('data-symbol'));
    });

    document.querySelector('.news-filters').addEventListener('click', function (e) {
      var b = e.target.closest('.filter-btn');
      if (!b) return;
      S.newsFilter = b.getAttribute('data-filter');
      document.querySelectorAll('.filter-btn').forEach(function (x) {
        x.setAttribute('aria-pressed', String(x === b));
      });
      renderNews();
    });

    el('mw-search').addEventListener('input', core.debounce(function (e) {
      var q = e.target.value.toLowerCase().trim();
      document.querySelectorAll('#mw-list .mw-item').forEach(function (li) {
        var name = (li.getAttribute('data-name') || '').toLowerCase();
        li.style.display = !q || name.indexOf(q) !== -1 ? '' : 'none';
      });
    }, 150));

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSettings();
    });
  }

  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode === 'dark' ? 'dark' : 'light');
  }

  function setTimeframe(tf) {
    if (!C.timeframes[tf] || tf === S.timeframe) return;
    S.timeframe = tf;
    document.querySelectorAll('.tf-btn').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-tf') === tf));
    });
    text('reason-granularity', 'Reason points: ' + C.timeframes[tf].reasonLabel);
    chart.showEmpty('Loading ' + C.timeframes[tf].label.toLowerCase() + ' candles…', '');
    refreshCandles().then(recompute).catch(function (e) {
      chart.showEmpty('Could not load candles', String(e && e.message || e));
    });
  }

  function setSymbol(sym) {
    if (!C.symbols[sym] || sym === S.symbol) return;
    S.symbol = sym;
    S.lastPrice = null;
    var meta = C.symbols[sym];
    text('asset-name', meta.label);
    text('asset-exch', meta.exchange);
    document.querySelectorAll('.tick').forEach(function (t) {
      t.setAttribute('aria-selected', String(t.getAttribute('data-symbol') === sym));
    });
    document.querySelectorAll('#mw-list .mw-item').forEach(function (li) {
      li.setAttribute('aria-selected', String(li.getAttribute('data-symbol') === sym));
    });
    chart.showEmpty('Loading ' + meta.label + '…', '');
    refreshAll();
  }

  /* ============================================================== REFRESH */
  function refreshCandles() {
    return data.getCandles(S.symbol, S.timeframe).then(function (res) {
      S.candles = res.candles;
      // Trust the data over the label. If the provider handed back a coarser
      // granularity than the timeframe asked for, every downstream consumer -
      // the forecast's clock, the reason buckets, the live tick's slot maths -
      // needs the real spacing, and they all read it from this one place.
      var tf = C.timeframes[S.timeframe];
      var real = core.deriveBarSec(S.candles, tf.barSec);
      if (real !== tf.barSec) {
        console.info('[' + S.timeframe + '] provider returned ' + real + 's bars, not ' +
                     tf.barSec + 's; using the measured spacing.');
        tf.barSec = real;
      }
      return res;
    });
  }

  function refreshQuote() {
    var symbolAtStart = S.symbol;
    return data.getLiveQuote(S.symbol)
      .catch(function () { return data.getQuoteFallback(S.symbol); })
      .then(function (q) {
        if (symbolAtStart !== S.symbol) return q;
        S.quote = q;
        S.quotes[S.symbol] = q;
        renderQuote(q);
        S.backoff = 0;
        return q;
      })
      .catch(function (e) {
        S.backoff = Math.min(C.poll.maxBackoffMs, (S.backoff || S.settings.tickMs) * 2);
        throw e;
      });
  }

  function refreshOtherQuotes() {
    Object.keys(C.symbols).forEach(function (k) {
      if (k === S.symbol) return;
      var p = C.symbols[k].mcId
        ? data.getLiveQuote(k).catch(function () { return data.getQuoteFallback(k); })
        : data.getQuoteFallback(k);
      p.then(function (q) {
        S.quotes[k] = q;
        renderTicker(k, q);
        renderWatchRow(k, q);
      }).catch(noop);
    });
  }

  function refreshNews() {
    return data.fetchFastLane().then(function (items) {
      var r = data.mergeNews(items);
      renderNews();
      text('news-updated', 'updated ' + fmt.clock(new Date()));
      return r;
    }).catch(function () { return { total: 0, fresh: 0 }; });
  }

  function refreshBaked() {
    return Promise.all([
      data.loadBaked(C.baked.news).then(function (n) {
        data.adoptBakedNews(n);
        S.feedsTotal = n.feeds_total; S.feedsAlive = n.feeds_alive;
        renderFeedCount(n);
      }).catch(noop),
      data.loadBaked(C.baked.rollup).then(function (r) { S.rollup = r; renderSectors(); }).catch(noop),
      loadFilings().catch(noop),
      data.loadBaked(C.baked.global).then(function (g) { S.global = g; renderCues(); }).catch(noop),
      data.loadBaked(C.baked.flows).then(function (f) { S.flows = f; }).catch(noop),
      data.loadBaked(C.baked.options).then(function (o) { S.options = o; }).catch(noop),
      data.loadBaked(C.baked.events).then(applyEvents).catch(noop),
      data.loadBaked(C.baked.constituents).then(applyConstituents).catch(noop),
      data.loadBaked(C.baked.stocks).then(function (q) { KT.portfolio.setQuotes(q); }).catch(noop),
    ]).then(function () { renderNews(); scanAlerts(); });
  }

  function refreshAll() {
    return Promise.all([
      refreshCandles(),
      refreshQuote().catch(noop),
      refreshNews(),
    ]).then(function () {
      refreshOtherQuotes();
      recompute();
    });
  }

  /* Recompute every derived view from whatever we currently hold.

     Order matters: indicators and levels feed the structure scan, and all
     three feed the forecast, so a stale snapshot never reaches the projection.
     Calibration is the expensive one - it replays the model across the series -
     so it runs on its own slow timer rather than on every tick. */
  function recompute() {
    if (!S.candles.length) return;
    var news = data.getNews();

    S.indicators = KT.ind.snapshot(S.candles);
    S.levels = KT.levels.build(S.candles);
    S.structures = KT.structures.detect(S.candles);
    S.structureStats = KT.structures.outcomes(S.candles);

    /* India VIX, best source first. NSE's allIndices carries it live and is
       already being fetched for breadth, so it costs nothing extra; the Yahoo
       quote is the fallback and rate-limits (429) often enough that it cannot
       be the only source.

       The previous line assigned null whenever the quote was missing, which
       silently threw away a live value this function had already been handed -
       the band then fell back to realised vol alone with no indication that the
       forward-looking half had gone. Keep the last good number instead. */
    var vixQuote = S.quotes && S.quotes.INDIAVIX;
    var vixLive = S.internals && S.internals.vix;
    var vixNext = vixLive || (vixQuote && vixQuote.price) || S.vix || null;
    S.vix = vixNext;

    S.forecast = engine.buildForecast({
      candles: S.candles,
      news: news,
      seasonality: S.seasonality,
      timeframe: S.timeframe,
      livePrice: S.quote && S.quote.price ? S.quote.price : null,
      indicators: S.indicators,
      levels: S.levels,
      structures: S.structures,
      structureStats: S.structureStats,
      global: S.global,
      flows: S.flows,
      options: S.options,
      vix: S.vix,
      /* The band multiplier that the last replay says would have delivered the
         coverage the band claims. Absent on the first load, which is correct -
         the panel then says the width is uncalibrated rather than implying a
         measurement that has not happened. */
      conformal: (S.calibration && S.calibration.conformal) || null,
    });
    S.reasons = engine.buildReasons(S.candles, news, S.timeframe);

    /* The frozen call, and how it is doing. Written before the chart draws,
       because the chart reads `forecast.locked` and a lock created after the
       repaint would show up a second late on every load.

       Intraday only. A lock is a claim about one session; on the monthly and
       yearly views there is no session to claim, and the minute path that
       makes the comparison readable does not exist. */
    var tfDef = C.timeframes[S.timeframe];
    S.forecast.locked = null;
    S.lockScore = null;
    if (KT.ledger && KT.ledger.lock && tfDef && tfDef.barSec <= 300) {
      try {
        S.forecast.locked = KT.ledger.lock(S.forecast, { symbol: S.symbol });
        if (S.forecast.locked) S.lockScore = KT.ledger.scoreLock(S.forecast.locked, S.candles);
      } catch (e) { S.forecast.locked = null; S.lockScore = null; }
    }

    chart.setStructures(S.structures);
    chart.setLevels(S.levels);
    chart.setData(S.candles, S.forecast, S.reasons, S.timeframe, S.symbol);

    renderPosition();
    computePatterns();
    renderForecast(S.forecast);
    renderOpenCall(S.forecast);
    renderLockScore(S.lockScore, S.forecast.locked);
    renderCheckpoints(S.forecast);
    renderStructures();
    renderLevels();
    renderIndicators();
    renderLanes();
    renderNewsIntel();
    renderPortfolio();
    updateLedger(news);
    maybeCalibrate();
    maybeEnrichNarrative();
  }

  /* --------------------------------------------------- live market internals

     Breadth, India VIX and the midcap-against-large-cap divergence, from one
     request. Breadth used to arrive only through the workflow, so the flow lane
     was voting on a count that could be hours old during the session it was
     meant to describe.

     Everything here is an override on top of the workflow copies, never a
     replacement for them: a throttled proxy leaves the older-but-real numbers
     in place rather than blanking three lanes at once. */
  function refreshInternals() {
    if (!KT.data.getMarketInternals) return Promise.resolve(false);
    var ms = core.marketState();
    if (ms && !ms.live && S.internals) return Promise.resolve(false);

    return KT.data.getMarketInternals().then(function (m) {
      if (!m) return false;
      S.internals = m;
      if (m.vix) S.vix = m.vix;
      if (m.breadth || m.breadthDivergence != null) {
        S.flows = S.flows || {};
        if (m.breadth) { S.flows.breadth = m.breadth; S.flows.breadthOrigin = 'browser'; }
        if (m.breadthDivergence != null) S.flows.breadthDivergence = m.breadthDivergence;
      }
      recompute();
      return true;
    }).catch(function () { return false; });
  }

  /* ------------------------------------------------------ live option chain

     The option chain is the only forward-looking input in the model and it used
     to arrive only through the workflow, which CLAUDE.md measured at roughly one
     run every two and a half hours. At that age its fastest signal - who is
     writing options today - is noise. Measured from a real page origin, the
     proxy returns the full chain in about 1.7 seconds, so the browser can have
     it live and does.

     The workflow copy is still loaded and still the fallback. A browser result
     only replaces it when it actually parses, so a throttled proxy or a shut
     exchange leaves the lane on the older-but-real number rather than blanking
     it. Which one is in play is recorded on the payload, and the lane prints
     the age, because "live" and "from this morning" are different claims. */
  function refreshOptionChain() {
    if (!KT.data.getOptionChain) return Promise.resolve(false);
    // Nothing moves while the exchange is shut, and every call costs a trip
    // through a shared public proxy that rate-limits.
    var ms = core.marketState();
    var haveLive = S.options && S.options.origin === 'browser';
    if (ms && !ms.live && haveLive) return Promise.resolve(false);

    return KT.data.getOptionChain(S.symbol === 'SENSEX' ? 'NIFTY' : 'NIFTY')
      .then(function (live) {
        if (!live) return false;
        S.options = live;
        recompute();
        return true;
      })
      .catch(function () { return false; });
  }

  /* Index membership, which is what lets the news lane tell a NIFTY story from
     a microcap filing. Without it every headline is scored alike and the lane
     reports relevanceReady false rather than pretending otherwise. */
  function applyConstituents(c) {
    if (!c || !c.members) return;
    S.constituents = c;
    try {
      if (KT.forecast.setConstituents(c) && S.booted) recompute();
    } catch (e) { /* a bad list must not take the lane down */ }
  }

  /* The exchange calendar. Until this landed, advance() knew about weekends
     and nothing else, so a daily projection walked straight through Diwali and
     put every date after it one session wrong. A failed fetch leaves the
     holiday table empty, which is exactly the old weekends-only behaviour. */
  function applyEvents(e) {
    if (!e) return;
    S.events = e;
    try { chart.setEvents(e); } catch (err) { /* chart may not be up yet */ }
    try {
      var n = KT.forecast.setHolidays(e.holidays || []);
      if (n) recompute();
    } catch (err) { /* a bad calendar must not take the clock down */ }
  }

  /* ============================================================== LEDGER

     Write down what was forecast, then score it when its horizon elapses.
     This is the only evidence on the page that the model has not already
     seen: calibrate() replays history the model was built on, which answers
     a weaker question. Both are shown, kept apart, and labelled. */
  function updateLedger(news) {
    if (!KT.ledger || !S.forecast) return;
    // arrivalsIn() scans this to name what landed inside a forecast window.
    KT.ledger.newsSource = function () { return news || S.news || []; };
    try {
      KT.ledger.record(S.forecast, { symbol: S.symbol, vix: S.vix });
      KT.ledger.settle(S.candles, S.symbol, S.timeframe);
      // Freeze each finished session's verdict onto its own lock row, so the
      // learner can read Tuesday's result on Friday without Tuesday's candles.
      if (KT.ledger.settleLocks) KT.ledger.settleLocks(S.candles, S.symbol);
      maybeSeedLedger();
      maybeLearn();
    } catch (e) { /* a full localStorage must not take the page down */ }
    renderLedger();
  }

  /* The learner reads the whole settled record and rewrites two numbers. That
     is a localStorage read, an aggregate over every row and a write - far too
     much to do on a one-second tick, and the evidence it reads only changes
     when a horizon elapses. Ten minutes here, and its own hourly guard inside,
     because the thing being measured moves once a day. */
  var lastLearnAt = 0;
  function maybeLearn() {
    if (!KT.learn || Date.now() - lastLearnAt < 600000) return;
    lastLearnAt = Date.now();
    try {
      KT.learn.update(S.symbol, S.timeframe);
      renderLearn();
    } catch (e) { /* learning is optional; the forecast is not */ }
  }

  /* What the model has actually changed about itself, in numbers a reader can
     check. When nothing has moved this says nothing has moved - a learning
     panel that always has something to report is reporting noise. */
  function renderLearn() {
    var box = el('learn-note');
    if (!box || !KT.learn) return;
    var sum = KT.learn.summary();
    if (!sum.fitted) {
      box.textContent = 'Weights are the hand-written defaults. ' + sum.samples +
        ' settled call' + (sum.samples === 1 ? '' : 's') + ' so far; a lane needs ' +
        sum.minSample + ' before it may move.';
      return;
    }
    var bits = ['Weights fitted over ' + sum.samples + ' settled calls, ' + sum.steps + ' step' +
                (sum.steps === 1 ? '' : 's') + ' taken'];
    if (sum.openSamples >= 10 && sum.openGain !== 1) {
      bits.push('opening gaps scaled ' + sum.openGain + 'x on ' + sum.openSamples + ' mornings');
    }
    box.textContent = bits.join('. ') + '.';
  }

  /* The band is only worth showing if it has been checked. This replays the
     technical core of the model across the loaded series and reports how often
     price actually finished inside the range it drew. */
  function maybeCalibrate() {
    // Keyed on symbol and timeframe, not just on time. Each timeframe is a
    // different series scored over a different horizon, so reusing the daily
    // view's number under the yearly chart would put a flattering figure next
    // to a projection it says nothing about.
    var key = S.symbol + ':' + S.timeframe;
    if (key === S.calibratedKey && Date.now() - S.calibratedAt < C.forecast.calibrateEveryMs && S.calibration) return;
    if (key !== S.calibratedKey) {
      S.calibration = null;
      renderAccuracy();            // clear the stale number while the new one runs
    }
    S.calibratedKey = key;
    S.calibratedAt = Date.now();
    // Yield first: on a long series this is tens of milliseconds of maths, and
    // running it inline would show up as a stutter in the 1 second tick.
    var forKey = key, forCandles = S.candles, forTf = S.timeframe;
    /* Sliced, not deferred. Ninety-six replays measured just under five
       seconds of arithmetic; running that in one setTimeout still froze the
       chart and the live price for five seconds, it just froze them slightly
       later. calibrate() now yields between batches of windows and calls back
       when it is done. */
    try {
      KT.forecast.calibrate(forCandles, forTf, { slice: 4 }, function (result) {
        // The view can change while this runs. Dropping a late result is right:
        // showing it would label the new chart with the old chart's score.
        if (forKey !== S.calibratedKey) return;
        S.calibration = result;
        renderAccuracy();
        // The band multiplier the replay just produced feeds the next build.
        if (result && result.conformal) recompute();
      });
    } catch (e) {
      S.calibration = null;
      renderAccuracy();
    }
  }

  /* =============================================================== LOOPS */
  function startLoops() {
    restartLoops();
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { refreshQuote().catch(noop); refreshNews(); }
    });
  }

  function restartLoops() {
    Object.keys(S.timers).forEach(function (k) { clearInterval(S.timers[k]); });
    S.timers = {};
    S.timers.tick = setInterval(tickLoop, 1000);
    S.timers.news = setInterval(function () { refreshNews().then(recompute); }, S.settings.newsMs);
    S.timers.baked = setInterval(function () { refreshBaked().then(recompute); }, C.poll.bakedMs);
    S.timers.candles = setInterval(function () { refreshCandles().then(recompute).catch(noop); }, 300000);
    S.timers.others = setInterval(refreshOtherQuotes, 30000);
    S.timers.options = setInterval(refreshOptionChain, C.poll.optionsMs);
    S.timers.internals = setInterval(refreshInternals, C.poll.internalsMs);
    /* First run off the critical path.

       These were briefly inside boot's Promise.all, which meant the chart
       waited on two proxy hops with 14 and 20 second timeouts before anything
       rendered - the page looked broken for as long as the slowest one took,
       and candles had not even been requested yet. The workflow copies already
       loaded in boot are what the lanes run on until these land, so there is
       no reason for anything to wait on them. */
    setTimeout(function () { refreshOptionChain(); refreshInternals(); }, 1500);
    // Holdings outside the workflow universe are priced on their own slower
    // timer, because each one costs a trip through the shared public proxy.
    S.timers.holdings = setInterval(function () {
      KT.portfolio.refreshMissing().then(function (n) { if (n) { renderPortfolio(); scanAlerts(); } });
    }, C.holdings.quoteRefreshMs * 5);
  }

  var lastTickAt = 0;
  function tickLoop() {
    var ms = core.marketState();
    renderClock(ms);
    if (!S.booted) return;

    var wanted = ms.live ? (S.backoff || S.settings.tickMs) : C.poll.tickMsClosed;
    var now = Date.now();
    if (now - lastTickAt < wanted) return;
    lastTickAt = now;

    refreshQuote().then(function (q) {
      if (q && q.price && ms.live) chart.tick(q.price);
    }).catch(noop);
  }

  function startClock() {
    renderClock(core.marketState());
  }

  /* ============================================================ RENDERING */
  function renderClock(ms) {
    text('market-clock', fmt.clock(ms.ist) + ' IST');
    text('market-state', ms.label);
    var dot = el('market-dot');
    if (dot) dot.className = 'dot ' + (ms.state === 'live' ? 'live' : ms.state === 'pre' ? 'pre' : 'closed');
  }

  function renderWatchlist() {
    var list = el('mw-list');
    if (!list) return;
    list.innerHTML = '';
    Object.keys(C.symbols).forEach(function (k) {
      var m = C.symbols[k];
      var li = document.createElement('li');
      li.className = 'mw-item';
      li.setAttribute('data-symbol', k);
      li.setAttribute('data-name', m.label + ' ' + m.exchange);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(k === S.symbol));
      li.innerHTML =
        '<div><span class="mw-title">' + m.label + '</span><span class="mw-sub">' + m.exchange + '</span></div>' +
        '<div class="mw-right"><span class="mw-ltp num" data-f="ltp">—</span>' +
        '<span class="mw-chg num" data-f="chg">—</span></div>';
      li.addEventListener('click', function () { setSymbol(k); });
      list.appendChild(li);
    });
  }

  function renderWatchRow(sym, q) {
    var li = document.querySelector('#mw-list .mw-item[data-symbol="' + sym + '"]');
    if (!li || !q) return;
    var ltp = li.querySelector('[data-f="ltp"]'), chg = li.querySelector('[data-f="chg"]');
    if (ltp) ltp.textContent = fmt.price(q.price);
    if (chg) { chg.textContent = fmt.pct(q.changePct); chg.className = 'mw-chg num ' + fmt.cls(q.changePct); }
  }

  function renderTicker(sym, q) {
    var t = document.querySelector('.tick[data-symbol="' + sym + '"]');
    if (!t || !q) return;
    var ltp = t.querySelector('[data-field="ltp"]'), chg = t.querySelector('[data-field="chg"]');
    if (ltp) ltp.textContent = fmt.price(q.price);
    if (chg) {
      chg.textContent = fmt.signed(q.change) + ' (' + fmt.pct(q.changePct) + ')';
      chg.className = 'tick-chg num ' + fmt.cls(q.changePct);
    }
  }

  function renderQuote(q) {
    if (!q) return;
    renderTicker(q.symbol, q);
    renderWatchRow(q.symbol, q);

    var ltpEl = el('asset-ltp');
    if (ltpEl) {
      ltpEl.textContent = fmt.price(q.price);
      ltpEl.className = 'asset-ltp num ' + fmt.cls(q.changePct);
      if (S.lastPrice !== null && q.price !== S.lastPrice) {
        ltpEl.classList.remove('flash-up', 'flash-down');
        void ltpEl.offsetWidth;
        ltpEl.classList.add(q.price > S.lastPrice ? 'flash-up' : 'flash-down');
      }
      S.lastPrice = q.price;
    }
    var chgEl = el('asset-chg');
    if (chgEl) {
      chgEl.textContent = fmt.signed(q.change) + '  (' + fmt.pct(q.changePct) + ')';
      chgEl.className = 'asset-chg num ' + fmt.cls(q.changePct);
    }

    text('st-open', fmt.price(q.open));
    text('st-prev', fmt.price(q.prevClose));
    text('st-high', fmt.price(q.high));
    text('st-low', fmt.price(q.low));
    text('st-52w', q.week52Low && q.week52High ? fmt.price(q.week52Low) + ' – ' + fmt.price(q.week52High) : '—');
    text('ohlc-updated', q.source || '');

    if (q.week52High && q.price) {
      var away = (q.price - q.week52High) / q.week52High * 100;
      text('st-from-high', fmt.pct(away));
      core.cls('st-from-high', fmt.cls(away));
    }
    if (q.dma50 && q.dma200 && q.price) {
      var a50 = q.price >= q.dma50, a200 = q.price >= q.dma200;
      text('st-dma', (a50 ? 'Above' : 'Below') + ' / ' + (a200 ? 'Above' : 'Below'));
      core.cls('st-dma', a50 && a200 ? 'up' : (!a50 && !a200 ? 'down' : 'flat'));
    }

    var adv = q.advances, dec = q.declines, unc = q.unchanged;
    var section = el('breadth-section');
    if (adv != null && dec != null) {
      if (section) section.classList.remove('hidden');
      var total = Math.max(1, adv + dec + (unc || 0));
      text('br-adv', fmt.int(adv)); text('br-dec', fmt.int(dec)); text('br-unc', fmt.int(unc || 0));
      el('br-bar-a').style.width = (adv / total * 100) + '%';
      el('br-bar-u').style.width = ((unc || 0) / total * 100) + '%';
      el('br-bar-d').style.width = (dec / total * 100) + '%';
      text('breadth-note', adv >= dec ? 'advances lead' : 'declines lead');
    } else if (section) {
      section.classList.add('hidden');
    }

    var r = q.returns || {};
    [['rt-1w', '1w'], ['rt-1m', '1m'], ['rt-3m', '3m'], ['rt-6m', '6m'], ['rt-1y', '1y'], ['rt-ytd', 'ytd']]
      .forEach(function (pair) {
        var v = r[pair[1]];
        text(pair[0], v == null ? '—' : fmt.pct(v));
        core.cls(pair[0], v == null ? 'flat' : fmt.cls(v));
      });
  }

  /* What the news lane made of the stream. The feed count already says how
     much arrived; these say what survived and whether it points anywhere.
     Reads off the forecast rather than recomputing, so the panel and the model
     cannot disagree about the same stream. */
  function renderNewsIntel() {
    var f = S.forecast, n = f && f.newsDetail;
    var stories = el('news-stories'), relevant = el('news-relevant'), cons = el('news-consensus');
    if (!n || !n.hasData) {
      [stories, relevant, cons].forEach(function (e) { if (e) { e.textContent = '—'; e.className = 'chip'; } });
      return;
    }
    if (stories) {
      stories.textContent = n.stories + ' stories';
      stories.title = n.items + ' items folded into ' + n.stories + ' stories (' +
        n.duplicates + ' syndicated repeats, ' + n.suppressed + ' procedural filings dropped)';
    }
    if (relevant) {
      var rel = n.macro + n.named;
      relevant.textContent = rel + ' index-relevant';
      relevant.className = 'chip' + (rel >= 10 ? ' brand' : '');
      relevant.title = n.macro + ' macro drivers, ' + n.named + ' naming an index constituent' +
        (n.relevanceReady ? '' : ' — membership list not loaded, so everything is scored equally');
    }
    if (cons) {
      if (n.consensus == null) {
        cons.textContent = 'no consensus yet';
        cons.className = 'chip';
      } else {
        var pct = Math.round(n.consensus * 100);
        cons.textContent = pct + '% agree';
        // Near a coin, the lane's own evidence is split and its vote is shrunk.
        cons.className = 'chip ' + (pct >= 70 ? 'brand' : '');
        cons.title = pct + '% of ' + n.opinionated + ' opinionated stories agree on direction; ' +
          'spread ' + n.dispersion + '. The lane keeps ' + Math.round(n.shrink * 100) + '% of its vote.';
      }
    }
  }

  function renderFeedCount(payload) {
    var alive = (payload && payload.feeds_alive) || S.feedsAlive;
    var total = (payload && payload.feeds_total) || S.feedsTotal;
    var direct = C.directFeeds.length;
    var label;
    if (total && alive) label = alive + ' live / ' + total + ' feeds';
    else if (total) label = total + ' feeds configured';
    else label = direct + ' direct feeds';
    text('feed-count', label);
    var fc = el('feed-count');
    if (fc) fc.title = direct + ' feeds are read live in your browser every ' +
      Math.round(S.settings.newsMs / 1000) + 's; the rest are fetched server side every 5 minutes by GitHub Actions.';
  }

  function renderNews() {
    var list = el('news-list');
    if (!list) return;
    var all = data.getNews();
    // "My stocks" is the only filter that needs work up front: build the set
    // of matched headline keys once rather than re-matching inside the filter.
    var mine = null;
    if (S.newsFilter === 'mine') {
      mine = {};
      KT.portfolio.matchNews(all).forEach(function (m) {
        mine[m.item.key || core.keyOf(m.item.headline)] = m.holding.symbol;
      });
    }
    var matching = all.filter(function (n) {
      switch (S.newsFilter) {
        case 'high':   return n.impact === 'high';
        case 'filing': return n.lane === 'filing';
        case 'pos':   return n.sentiment > 0.6;
        case 'neg':   return n.sentiment < -0.6;
        case 'india': return n.region === 'indian';
        case 'world': return n.region === 'international';
        case 'mine':  return !!mine[n.key];
        default:      return true;
      }
    });
    var items = diversify(matching, 120);

    if (!items.length) {
      var why = !core.hasLexicon() ? 'Loading feeds…'
        : S.newsFilter === 'mine'
          ? (KT.portfolio.count()
              ? 'Nothing in the current stream names one of your holdings.'
              : 'Add holdings first and this shows only the news that names them.')
          : 'No headlines match this filter yet.';
      list.innerHTML = '';
      var li0 = document.createElement('li');
      li0.className = 'news-row';
      var sp0 = document.createElement('span');
      sp0.className = 'muted';
      sp0.style.gridColumn = '1/-1';
      sp0.textContent = why;
      li0.appendChild(sp0);
      list.appendChild(li0);
      return;
    }

    var frag = document.createDocumentFragment();
    items.forEach(function (n) {
      var li = document.createElement('li');
      li.className = 'news-row' + (n.isNew ? ' is-new' : '');

      var chip = document.createElement('span');
      chip.className = 'chip ' + (n.impact === 'high' ? 'high' : n.sentiment > 0.6 ? 'pos' : n.sentiment < -0.6 ? 'neg' : '');
      chip.textContent = n.impact === 'high' ? 'HIGH' : (n.industry || 'gen').slice(0, 6).toUpperCase();

      var time = document.createElement('span');
      time.className = 'news-time';
      time.textContent = fmt.timeShort(n.ts);
      time.title = fmt.stamp(n.ts, 3600) + ' · ' + fmt.ago(n.ts) + ' · ' + n.source;

      var head = document.createElement('span');
      head.className = 'news-head-text';
      head.title = n.headline + '  —  ' + n.source;
      if (n.url) {
        var a = document.createElement('a');
        a.href = n.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = n.headline;
        head.appendChild(a);
      } else {
        head.textContent = n.headline;
      }

      var score = document.createElement('span');
      score.className = 'news-score ' + fmt.cls(n.sentiment);
      score.textContent = n.sentiment > 0 ? '+' + n.sentiment.toFixed(1) : n.sentiment.toFixed(1);
      score.title = 'Sentiment score ' + n.sentiment + (n.terms && n.terms.length ? ' from: ' + n.terms.join(', ') : '');

      li.appendChild(chip); li.appendChild(time); li.appendChild(head); li.appendChild(score);
      frag.appendChild(li);
      n.isNew = false;
    });
    list.innerHTML = '';
    list.appendChild(frag);
  }

  /* A feed that publishes 20 notices at once - the RBI press release feed is
     the usual culprit - would otherwise own the whole visible stream, since
     everything it posts shares a timestamp. Nothing is discarded: the full set
     still feeds scoring and the forecast. This only decides display order, by
     holding an over-represented source back rather than dropping it. */
  function diversify(list, limit) {
    var PER_SOURCE_RUN = 3;   // at most this many in a row from one source
    var PER_SOURCE_CAP = 12;  // and at most this many on screen overall
    var out = [], held = [], counts = {}, run = { src: null, n: 0 };

    for (var i = 0; i < list.length && out.length < limit; i++) {
      var n = list[i], src = n.source || '?';
      var over = (counts[src] || 0) >= PER_SOURCE_CAP;
      var streak = (run.src === src && run.n >= PER_SOURCE_RUN);
      if (over || streak) { held.push(n); continue; }
      out.push(n);
      counts[src] = (counts[src] || 0) + 1;
      run = (run.src === src) ? { src: src, n: run.n + 1 } : { src: src, n: 1 };
    }
    // Backfill from what was held so the list is never short.
    for (var h = 0; h < held.length && out.length < limit; h++) out.push(held[h]);
    return out;
  }

  /* Corporate filings are just a very high quality news lane: an order win or
     an insolvency petition is published here before the wires carry it. They
     merge into the same store so they score, rank and mark the chart like any
     other headline, with lane 'filing' so they can be filtered on their own. */
  function loadFilings() {
    return data.loadBaked(C.baked.filings).then(function (j) {
      var rows = (j && j.filings) || [];
      if (!rows.length) return;
      data.mergeNews(rows.map(function (f) {
        return {
          key: core.keyOf(f.headline),
          headline: f.headline,
          url: f.url || '',
          ts: f.ts,
          sentiment: typeof f.sentiment === 'number' ? f.sentiment : 0,
          impact: f.impact || 'medium',
          terms: f.kind ? [f.kind] : [],
          industry: f.kind || 'filing',
          source: f.source || 'Exchange filing',
          region: 'indian',
          lane: 'filing',
        };
      }));
      S.filings = { count: j.count, high: j.high, at: j.updated_iso };
      renderNews();
    });
  }

  function renderPosition() {
    var sec = el('position-section');
    if (!sec) return;
    if (!KT.journal || !KT.journal.isUnlocked()) { sec.classList.add('hidden'); return; }
    var live = S.quote && S.quote.price ? S.quote.price : null;
    var pos = KT.journal.position(S.symbol, live);
    if (!pos.trades) { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');
    text('pos-qty', fmt.int(pos.qty));
    text('pos-avg', pos.qty ? fmt.price(pos.avgCost) : '—');
    text('pos-unreal', pos.qty ? fmt.signed(pos.unrealised) + '  (' + fmt.pct(pos.pctOnCost) + ')' : '—');
    core.cls('pos-unreal', fmt.cls(pos.unrealised));
    text('pos-real', fmt.signed(pos.realised));
    core.cls('pos-real', fmt.cls(pos.realised));
    text('pos-count', pos.trades + ' on ' + C.symbols[S.symbol].label);
  }

  /* ------------------------------------------------------------- journal UI */
  function wireJournal() {
    var J = KT.journal;
    if (!J) return;
    var modal = el('journal-modal');

    function open() {
      modal.classList.remove('hidden');
      el('gate-setup').classList.toggle('hidden', J.hasAuth());
      el('btn-journal-unlock').textContent = J.hasAuth() ? 'Unlock' : 'Set passcode';
      if (J.isUnlocked()) showLog(); else showGate();
    }
    function close() { modal.classList.add('hidden'); }

    function showGate() {
      el('journal-gate').classList.remove('hidden');
      el('journal-body').classList.add('hidden');
      el('btn-journal-unlock').classList.remove('hidden');
      el('btn-journal-lock').classList.add('hidden');
      ['btn-journal-export', 'btn-journal-import'].forEach(function (b) { el(b).classList.add('hidden'); });
    }
    function showLog() {
      el('journal-gate').classList.add('hidden');
      el('journal-body').classList.remove('hidden');
      el('btn-journal-unlock').classList.add('hidden');
      el('btn-journal-lock').classList.remove('hidden');
      ['btn-journal-export', 'btn-journal-import'].forEach(function (b) { el(b).classList.remove('hidden'); });
      fillSymbols();
      if (!el('j-date').value) {
        el('j-date').value = core.fmt.ist().toISOString().slice(0, 16);
      }
      renderRows();
    }

    function fillSymbols() {
      var sel = el('j-symbol');
      if (sel.options.length) return;
      Object.keys(C.symbols).forEach(function (k) {
        var o = document.createElement('option');
        o.value = k; o.textContent = C.symbols[k].label;
        sel.appendChild(o);
      });
      sel.value = S.symbol;
    }

    function renderRows() {
      var rows = J.all(), body = el('journal-rows');
      text('journal-count', rows.length + (rows.length === 1 ? ' entry' : ' entries') + ' in this browser');
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="7" class="journal-empty">No entries yet. Add one above and it appears on the chart.</td></tr>';
      } else {
        body.innerHTML = '';
        rows.forEach(function (t) {
          var tr = document.createElement('tr');
          tr.innerHTML =
            '<td>' + fmt.stamp(t.ts, 3600) + '</td>' +
            '<td>' + ((C.symbols[t.symbol] || {}).label || t.symbol) + '</td>' +
            '<td class="side-' + t.side.toLowerCase() + '">' + t.side + '</td>' +
            '<td class="num-col">' + fmt.int(t.qty) + '</td>' +
            '<td class="num-col">' + fmt.price(t.price) + '</td>' +
            '<td>' + (t.note ? t.note.replace(/[<>&]/g, '') : '<span class="muted">—</span>') + '</td>' +
            '<td><button class="row-del" data-id="' + t.id + '" title="Delete">&times;</button></td>';
          body.appendChild(tr);
        });
      }
      var live = S.quote && S.quote.price ? S.quote.price : null;
      var pos = J.position(S.symbol, live);
      el('journal-summary').innerHTML =
        tile('Net qty', fmt.int(pos.qty)) +
        tile('Avg cost', pos.qty ? fmt.price(pos.avgCost) : '—') +
        tile('Unrealised', pos.qty ? fmt.signed(pos.unrealised) : '—', fmt.cls(pos.unrealised)) +
        tile('Realised', fmt.signed(pos.realised), fmt.cls(pos.realised));
      renderPosition();
      chart.refreshMarkers();
    }
    function tile(k, v, cls) {
      return '<div class="stat"><span class="stat-k">' + k + '</span>' +
             '<span class="stat-v ' + (cls || '') + '">' + v + '</span></div>';
    }

    el('btn-journal').addEventListener('click', open);
    var openBtn = el('btn-open-journal');
    if (openBtn) openBtn.addEventListener('click', open);
    el('btn-close-journal').addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

    el('btn-journal-unlock').addEventListener('click', function () {
      var u = el('j-user').value.trim(), pw = el('j-pass').value;
      if (!u || !pw) { text('gate-error', 'Enter both an ID and a passcode.'); return; }
      text('gate-error', 'Checking…');
      var step = J.hasAuth() ? J.verify(u, pw) : J.setAuth(u, pw).then(function () { return true; });
      step.then(function (ok) {
        if (!ok) { text('gate-error', 'That ID or passcode does not match.'); return; }
        text('gate-error', '');
        el('j-pass').value = '';
        J.unlock(); J.load(); showLog();
      }).catch(function () { text('gate-error', 'Could not check the passcode in this browser.'); });
    });
    el('j-pass').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') el('btn-journal-unlock').click();
    });

    el('btn-journal-lock').addEventListener('click', function () {
      J.lock(); showGate(); renderPosition(); chart.refreshMarkers();
    });

    el('journal-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var when = el('j-date').value;
      if (!when) return;
      // datetime-local carries no zone; the page works in IST, so read it as IST.
      var ts = Math.floor(Date.parse(when + ':00+05:30') / 1000);
      if (!ts || isNaN(ts)) ts = Math.floor(Date.now() / 1000);
      J.add({
        ts: ts, symbol: el('j-symbol').value, side: el('j-side').value,
        qty: el('j-qty').value, price: el('j-price').value, note: el('j-note').value,
      });
      el('j-qty').value = ''; el('j-price').value = ''; el('j-note').value = '';
      renderRows();
    });

    el('journal-rows').addEventListener('click', function (e) {
      var b = e.target.closest('.row-del');
      if (!b) return;
      J.remove(b.getAttribute('data-id'));
      renderRows();
    });

    el('btn-journal-export').addEventListener('click', function () {
      var blob = new Blob([J.exportJson()], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'trade-journal-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });
    el('btn-journal-import').addEventListener('click', function () { el('journal-file').click(); });
    el('journal-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var n = J.importJson(String(fr.result));
          text('journal-count', 'Imported ' + n + ' new ' + (n === 1 ? 'entry' : 'entries'));
          renderRows();
        } catch (err) { text('journal-count', 'That file could not be read as a journal export.'); }
      };
      fr.readAsText(f);
      e.target.value = '';
    });
  }

  /* Pattern recognition. Detection is the easy half; the half that matters is
     measuring how each pattern has actually resolved on this instrument, so a
     marker can say "58% of 136" instead of asserting a reversal. */
  function computePatterns() {
    if (!KT.patterns || !S.candles.length) return;
    try {
      var found = KT.patterns.detect(S.candles);
      var stats = KT.patterns.hitRates(S.candles, found);
      S.patterns = { found: found, stats: stats,
                     current: KT.patterns.current(S.candles, found, 3) };
      // Eight, not eighteen. The chart now also carries reason points, trade
      // entries, forecast checkpoints and the drawn structure geometry, and
      // the candlestick markers were the ones that turned into an unreadable
      // row of overlapping abbreviations. The full table is in the panel.
      chart.setPatterns(KT.patterns.markers(found, stats, 8));
      renderPatterns();
    } catch (e) {
      console.warn('pattern pass failed:', e);
    }
  }

  function renderPatterns() {
    var P = S.patterns;
    if (!P) return;
    var rows = Object.keys(P.stats).map(function (k) { return P.stats[k]; })
      .filter(function (g) { return g.n > 0; })
      .sort(function (a, b) {
        // most decisive record first, thin samples last
        var ea = a.reliable && a.hitRate != null ? Math.abs(a.hitRate - 50) : -1;
        var eb = b.reliable && b.hitRate != null ? Math.abs(b.hitRate - 50) : -1;
        return eb - ea;
      });

    var horizon = rows.length ? rows[0].horizon : 0;
    text('pattern-horizon', horizon ? 'measured ' + horizon + ' bars ahead' : '');

    var now = el('pattern-now');
    if (now) {
      if (!P.current.length) {
        now.innerHTML = '<span class="muted">Nothing forming at the live edge right now.</span>';
      } else {
        now.innerHTML = P.current.map(function (p) {
          var g = P.stats[p.key] || {};
          var cls = p.dir > 0 ? 'pos' : p.dir < 0 ? 'neg' : '';
          var rate = (g.reliable && g.hitRate != null)
            ? g.hitRate + '% of ' + g.n
            : (g.n ? 'only ' + g.n + ' seen' : 'no record');
          return '<div class="pattern-live" title="' + esc(p.why) + '">' +
                 '<span class="chip ' + cls + '">' + esc(p.name) + '</span>' +
                 '<span class="muted">' + rate + '</span></div>';
        }).join('');
      }
    }

    var body = el('pattern-rows');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="4" class="muted" style="padding:10px">Not enough history on this timeframe to measure patterns.</td></tr>';
      return;
    }
    body.innerHTML = '';
    rows.slice(0, 10).forEach(function (g) {
      var tr = document.createElement('tr');
      if (!g.reliable) tr.className = 'thin';
      var rate = g.hitRate != null
        ? g.hitRate + '%'
        : (g.upRate != null ? '\u2191' + g.upRate + '%' : '—');
      var rateCls = g.hitRate == null ? '' : (g.hitRate >= 60 ? 'up' : g.hitRate <= 40 ? 'down' : 'flat');
      tr.innerHTML =
        '<td title="' + esc(g.why || '') + '">' + esc(g.name) +
          (g.reliable ? '' : ' <span class="thin-tag">thin</span>') + '</td>' +
        '<td class="num-col">' + g.n + '</td>' +
        '<td class="num-col ' + rateCls + '">' + rate + '</td>' +
        '<td class="num-col ' + fmt.cls(g.avgMove) + '">' + fmt.pct(g.avgMove) + '</td>';
      body.appendChild(tr);
    });
  }

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  /* News against pattern. Two numbers and a verdict, because the useful
     question is not just "where does it point" but "do the two reasons for
     pointing there agree". A conflict is worth reading as a warning that the
     blended line is averaging a disagreement rather than confirming a view. */
  function renderForecastSplit(f) {
    var box = el('fc-split');
    if (!box) return;
    var comp = f && f.components;
    if (!comp) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');

    function put(id, part) {
      var node = el(id);
      if (!node) return;
      node.textContent = fmt.price(part.end) + '  (' + fmt.pct(part.changePct) + ')';
      node.className = 'fc-split-v num ' + fmt.cls(part.changePct);
      node.title = part.note || '';
    }
    put('fc-news-v', comp.news);
    put('fc-pat-v', comp.pattern);

    var v = el('fc-split-verdict');
    if (!v) return;
    var conflict = comp.agree === 'conflict';
    v.className = 'fc-split-verdict' + (conflict ? ' conflict' : '');

    /* The two lines are news+global against structure+momentum+levels. That
       leaves seasonal, flows and options positioning in neither - 27% of the
       weight as of the options lane joining. Without saying so, a reader who
       sees both lines agree and the blend land somewhere else has no way to
       know why, and the sentence below would be describing a two-way
       disagreement when the blend is a three-way one. */
    var offLine = (f.lanes || []).filter(function (l) {
      return l.hasData && ['seasonal', 'flow', 'options'].indexOf(l.id) !== -1;
    });
    var offNote = offLine.length
      ? ' ' + offLine.map(function (l) { return l.label.toLowerCase(); }).join(', ') +
        ' sit in neither line and still move the blend.'
      : '';
    if (conflict) {
      v.textContent = 'The headlines and the chart disagree, ' + fmt.pct(comp.gapPct, 2).replace('+', '') +
        ' apart at the end of the horizon. The blended line is averaging a conflict, so treat it as low conviction.' + offNote;
    } else if (comp.agree === 'flat') {
      v.textContent = 'Neither the news nor the chart is pushing in a direction right now.' + offNote;
    } else {
      v.textContent = 'News and chart point the same way, ' + fmt.pct(comp.gapPct, 2).replace('+', '') +
        ' apart at the end of the horizon. Agreement is the stronger case of the two.';
    }
  }

  /* The evidence behind the projection's shape. Everything here is a count or
     a measured outcome from real history, which is the only kind of support a
     forecast can honestly offer. */
  function ensureLongHistory() {
    if (S.longHistoryState) return;
    S.longHistoryState = 'loading';
    data.getLongHistory(S.symbol)
      .then(function (candles) {
        S.longHistory = candles;
        S.longHistoryState = 'ready';
        renderAnalogue(S.forecast);
      })
      .catch(function () { S.longHistoryState = 'failed'; });
  }

  /* Daily analogue over the full record, so "when did this happen before"
     reaches back two decades rather than a few intraday sessions. Horizon is
     fixed in trading days, so it reads as "over the next month" whatever the
     chart timeframe happens to be. */
  function dailyAnalogue() {
    if (!S.longHistory || !KT.analogs) return null;
    if (S.dailyAnalogue && S.dailyAnalogueFor === S.symbol) return S.dailyAnalogue;
    var a = KT.analogs.find(S.longHistory, { window: 30, horizon: 21, k: 8 });
    S.dailyAnalogue = a && a.ok ? a : null;
    S.dailyAnalogueFor = S.symbol;
    return S.dailyAnalogue;
  }

  function renderAnalogue(f) {
    var sec = el('analog-section');
    if (!sec) return;
    // Daily precedent is the better evidence when we have it: decades of bars
    // rather than whatever the current timeframe happens to hold.
    var daily = dailyAnalogue();
    var a = daily || (f && f.analog);
    if (!a || !a.ok || !a.matches || !a.matches.length) {
      sec.classList.add('hidden');
      return;
    }
    sec.classList.remove('hidden');

    var tf = C.timeframes[S.timeframe] || {};
    var barSec = daily ? 86400 : (tf.barSec || 86400);
    var spanDays = Math.round(a.bars * barSec / 86400);
    var scope = spanDays >= 400 ? (Math.round(spanDays / 365 * 10) / 10) + ' years of bars'
              : spanDays >= 60 ? Math.round(spanDays / 30) + ' months of bars'
              : spanDays + ' days of bars';
    text('analog-scope', a.scanned + ' windows scanned \u00b7 ' + scope + (daily ? ' · next ' + a.horizon + ' days' : ''));

    var upCls = a.upRate >= 60 ? 'up' : a.upRate <= 40 ? 'down' : 'flat';
    el('analog-tiles').innerHTML =
      tile('Went up after', a.ups + ' of ' + a.n, upCls) +
      tile('Base rate', a.upRate + '%', upCls) +
      tile('Average', fmt.pct(a.avgEnd), fmt.cls(a.avgEnd)) +
      tile('Median', fmt.pct(a.medianEnd), fmt.cls(a.medianEnd));

    text('analog-quality', a.quality + '%  ' + (a.quality >= 40 ? 'close' : a.quality >= 20 ? 'loose' : 'weak'));
    core.cls('analog-quality', a.quality >= 40 ? 'up' : a.quality >= 20 ? 'flat' : 'down');
    text('analog-extremes', fmt.pct(a.bestEnd) + '  /  ' + fmt.pct(a.worstEnd));

    var body = el('analog-rows');
    body.innerHTML = '';
    a.matches.forEach(function (m) {
      var tr = document.createElement('tr');
      if (m.similarity < 20) tr.className = 'weak';
      var when = KT.analogs ? KT.analogs.describeMatch(m, barSec) : '';
      tr.innerHTML =
        '<td>' + when + '</td>' +
        '<td class="num-col">' + m.similarity + '%</td>' +
        '<td class="num-col ' + fmt.cls(m.endChange) + '">' + fmt.pct(m.endChange) + '</td>';
      tr.title = 'Over the ' + a.horizon + (daily ? ' trading days' : ' bars') + ' after this window closed.';
      body.appendChild(tr);
    });

    var note = el('analog-note');
    if (note) {
      note.textContent = a.quality < 20
        ? 'Today\u2019s shape has no close precedent here, so these matches are loose and the projection borrows little from them. Read this as weak support.'
        : 'Similar-looking history is not a cause. The sample is small by construction and regimes change, so read the spread and the match quality, not just the average.';
    }
  }

  function tile(k, v, cls) {
    return '<div class="stat"><span class="stat-k">' + k + '</span>' +
           '<span class="stat-v ' + (cls || '') + '">' + v + '</span></div>';
  }

  function renderForecast(f) {
    if (!f) return;
    text('fc-horizon', f.horizonLabel);
    var dir = el('fc-direction');
    if (dir) {
      dir.textContent = f.direction;
      dir.className = 'verdict-dir ' + (f.direction === 'BULLISH' ? 'up' : f.direction === 'BEARISH' ? 'down' : 'flat');
    }
    text('fc-range', fmt.price(f.rangeLow) + '  –  ' + fmt.price(f.rangeHigh));
    text('fc-confidence', 'Confidence ' + f.confidence + '%  ·  midpoint ' + fmt.price(f.target) + ' (' + fmt.pct(f.targetPct) + ')');
    var pin = el('fc-pin');
    if (pin) pin.style.left = ((f.bias + 1) / 2 * 100) + '%';
    renderForecastSplit(f);
    renderAnalogue(f);
    ensureLongHistory();
    text('fc-narrative', f.narrative);

    var box = el('fc-drivers');
    if (box) {
      box.innerHTML = '';
      f.lanes.forEach(function (lane) {
        var row = document.createElement('div');
        row.className = 'driver';
        row.title = lane.note;

        var k = document.createElement('span'); k.className = 'driver-k'; k.textContent = lane.label;
        var bar = document.createElement('div'); bar.className = 'driver-bar';
        var fill = document.createElement('div'); fill.className = 'driver-fill';
        var pctWidth = Math.abs(lane.score) * 50;
        fill.style.width = pctWidth + '%';
        fill.style.left = lane.score >= 0 ? '50%' : (50 - pctWidth) + '%';
        fill.style.background = lane.score >= 0 ? 'var(--up)' : 'var(--down)';
        bar.appendChild(fill);
        var v = document.createElement('span');
        v.className = 'driver-v ' + fmt.cls(lane.score);
        v.textContent = (lane.score >= 0 ? '+' : '') + lane.score.toFixed(2);

        row.appendChild(k); row.appendChild(bar); row.appendChild(v);
        box.appendChild(row);
      });
    }
    /* The weights the build actually used, not the ones in CONFIG. Once the
       learner has moved them those are two different sets of numbers, and
       printing the static one under a fitted forecast would be describing a
       model the page is not running. */
    var wUsed = (KT.learn && KT.learn.weights && KT.learn.weights()) || C.forecast.weights;
    text('fc-weights-note', 'weights ' + Object.keys(C.forecast.weights).map(function (k) {
      return Math.round(wUsed[k] * 100) + '%';
    }).join(' / ') + (wUsed.fitted ? ' (fitted)' : ''));
  }

  /* ========================================================= OPENING CALL

     One price, one time, one reason. Shown only while the market is shut,
     because once it opens the gap is a fact in the candles and repeating the
     prediction next to it would be describing the past in the future tense.

     The basis line is not decoration. These betas have not been fitted to
     anything yet - see OPEN_BETA in forecast.js - and a page that prints a
     confident-looking price without saying that is doing the thing this
     project exists not to do. */
  function renderOpenCall(f) {
    var box = el('open-call');
    if (!box) return;
    var o = f && f.open;
    if (!o || !o.applies || !o.hasData || o.price == null) { box.hidden = true; return; }
    box.hidden = false;

    text('open-when', o.at ? core.fmt.stamp(o.at, 60) : 'next session');
    text('open-price', fmt.price(o.price));

    var gapEl = el('open-gap');
    if (gapEl) {
      var pts = o.gapPoints;
      gapEl.textContent = (pts >= 0 ? '+' : '') + fmt.price(Math.abs(pts)) + ' pts  ·  ' +
                          fmt.pct(o.gapPct) + '  from ' + fmt.price(o.prevClose);
      gapEl.className = 'open-call-gap num ' + (o.gapPct > 0.02 ? 'up' : o.gapPct < -0.02 ? 'down' : '');
    }

    // The three cues that moved it most, with the number each one moved it by.
    var why = (o.parts || []).slice(0, 3).map(function (p) {
      var moved = (p.contributionPct >= 0 ? '+' : '') + p.contributionPct.toFixed(2) + '%';
      return p.changePct != null
        ? p.label + ' ' + fmt.pct(p.changePct) + ' → ' + moved
        : p.label + ' → ' + moved;
    }).join('  ·  ');
    text('open-why', why || 'cues flat');

    text('open-basis', o.cues + ' overnight cue' + (o.cues === 1 ? '' : 's') + '. ' +
      (o.fitted
        ? 'Weights fitted on this browser’s settled opens.'
        : 'Weights are judgements, not fits — nothing has been measured against them yet.'));
  }

  /* ================================================== PREDICTED VS ACTUAL

     The scoreboard for the frozen call. Every number here compares a line
     written before the session to prices printed after it, which is the only
     comparison on this page that the model could not have influenced.

     `skill` carries the verdict, not the error: an average error of 40 points
     sounds bad and is excellent on a day the index moved 300, and sounds fine
     and is useless on a day it moved 45. Against "price does not move" is the
     only benchmark that survives both days. */
  function renderLockScore(score, row) {
    var box = el('lockscore');
    if (!box) return;
    if (!row || !score) { box.hidden = true; return; }
    box.hidden = false;

    text('lock-stage', row.stage === 'open' ? 'pre-open' : 'day before');
    text('lock-when', 'frozen ' + core.fmt.stamp(Math.floor(row.lockedAt / 1000), 60));

    if (score.pending && !score.n) {
      text('lock-pred', fmt.price(row.openPrice));
      ['lock-act', 'lock-err', 'lock-open', 'lock-mae', 'lock-dir'].forEach(function (id) { text(id, '—'); });
      text('lock-verdict', 'Frozen and waiting. Nothing from this session has printed yet, so there is nothing to score.');
      return;
    }

    text('lock-pred', fmt.price(score.nowPredicted));
    text('lock-act', fmt.price(score.nowActual));

    var errEl = el('lock-err');
    if (errEl) {
      errEl.textContent = (score.nowErr >= 0 ? '+' : '') + score.nowErr.toFixed(0) + ' pts';
      // Sign convention: positive means price came in ABOVE the line, so the
      // model was too low. Coloured by that, not by whether price rose.
      errEl.className = 'ls-v num ' + (score.nowErr > 0 ? 'up' : score.nowErr < 0 ? 'down' : '');
    }

    var openEl = el('lock-open');
    if (openEl) {
      if (score.openErr == null) openEl.textContent = '—';
      else openEl.textContent = fmt.price(score.openPredicted) + ' vs ' + fmt.price(score.openActual) +
                                '  (' + (score.openErr >= 0 ? '+' : '') + score.openErr.toFixed(0) + ')';
      openEl.className = 'ls-v num';
    }

    text('lock-mae', score.mae.toFixed(0) + ' pts  ·  ' + score.maePct.toFixed(2) + '%');
    text('lock-dir', score.directionRate == null
      ? 'no call'
      : score.directionRate.toFixed(0) + '%  (' + score.directionRight + '/' + score.directionCalls + ')');

    var bits = [];
    bits.push(score.n + ' of ' + score.total + ' minutes scored');
    if (score.skill != null) {
      bits.push(score.skill < 1
        ? 'Beating a flat line by ' + Math.round((1 - score.skill) * 100) + '%'
        : score.skill > 1
          ? 'Worse than assuming no move, by ' + Math.round((score.skill - 1) * 100) + '%'
          : 'Level with assuming no move');
    }
    if (score.worst) {
      bits.push('worst minute ' + core.fmt.stamp(score.worst.time, 60) + ' off by ' +
                Math.abs(score.worst.err).toFixed(0) + ' pts');
    }
    text('lock-verdict', bits.join('. ') + '.');
  }

  /* ====================================================== CHECKPOINT TABLE
     The direct answer to "where will it be at X". One row per checkpoint, each
     carrying the centre of the range, the range itself, and the probability of
     trading above the current price by then. The probability is the honest
     part: on a near random walk at short horizons it will sit close to 50, and
     a panel that pretended otherwise would be lying to you every morning. */
  function renderCheckpoints(f) {
    var body = el('cp-rows');
    if (!body) return;
    body.innerHTML = '';
    if (!f || !f.checkpoints || !f.checkpoints.length) {
      text('cp-basis', '—');
      text('cp-note', 'Not enough history loaded to project a path.');
      return;
    }
    f.checkpoints.forEach(function (cp) {
      var tr = document.createElement('tr');

      var tdT = document.createElement('td');
      tdT.className = 'cp-time';
      tdT.textContent = cp.label;

      var tdV = document.createElement('td');
      tdV.className = 'num';
      tdV.textContent = fmt.price(cp.value);

      var tdR = document.createElement('td');
      tdR.className = 'num cp-range';
      tdR.textContent = fmt.int(cp.low) + '–' + fmt.int(cp.high);

      var tdP = document.createElement('td');
      tdP.className = 'num cp-prob ' + (cp.pUp >= 55 ? 'up' : cp.pUp <= 45 ? 'down' : 'flat');
      tdP.textContent = cp.pUp + '%';

      tr.appendChild(tdT); tr.appendChild(tdV); tr.appendChild(tdR); tr.appendChild(tdP);
      body.appendChild(tr);
    });

    var vol = f.volImplied
      ? 'vol ' + f.volRealised + '% realised blended with ' + f.volImplied + '% implied per bar'
      : 'vol ' + f.volRealised + '% per bar, realised';
    text('cp-basis', f.intradayProfile ? 'clock-aware' : 'flat vol');
    text('cp-note',
      'Range is one standard deviation, so price finishes inside it about two times in three. ' +
      vol + (f.intradayProfile ? ', widened at the open and tightened at lunch from this instrument’s own session profile' : '') +
      (f.dayShapeSessions ? '. Average session shape from ' + f.dayShapeSessions + ' sessions is folded into the path' : '') +
      '. "Up" is the chance of trading above ' + fmt.price(f.lastClose) + ' at that time.');
  }

  /* ========================================================= CALIBRATION */
  function renderAccuracy() {
    var c = S.calibration;
    if (!c) {
      text('acc-n', '—');
      ['acc-68', 'acc-95', 'acc-dir', 'acc-skill', 'acc-band'].forEach(function (id) { text(id, '—'); });
      setVerdict('acc-verdict', '', 'Scoring the band against history…');
      text('acc-note', 'Not enough loaded history on this timeframe to score the forecast. Switch to Daily or Monthly for a measured number.');
      return;
    }
    /* Both numbers, always. n alone reads as far more evidence than it is;
       nEff alone reads as noisier than the estimate really is. */
    text('acc-n', c.n + ' replays / ' + c.nEff + ' independent');

    /* Coverage is coloured by the Kupiec verdict, not by how close the number
       looks. The old rule painted green whenever the gap was under 8 points,
       which on 53 replays is true of almost any result the model can produce -
       it was reporting the sample size, dressed as a result. */
    putCoverage('acc-68', c.coverage68, c.kupiec68);
    putCoverage('acc-95', c.coverage95, c.kupiec95);

    var dir = el('acc-dir');
    if (dir) {
      if (c.directionRate == null) {
        dir.textContent = 'no directional calls';
        dir.className = 'kv-v';
      } else {
        dir.textContent = c.directionRate + '% of ' + c.directionCalls +
          (c.directionCi ? '  (' + c.directionCi[0] + '–' + c.directionCi[1] + '%)' : '');
        // Green only when the whole interval clears a coin, not when the point
        // estimate does.
        dir.className = 'kv-v ' + (c.directionSignificant ? 'up' : 'flat');
      }
    }
    var sk = el('acc-skill');
    if (sk) {
      sk.textContent = c.skill < 1
        ? (Math.round((1 - c.skill) * 1000) / 10) + '% better'
        : (Math.round((c.skill - 1) * 1000) / 10) + '% worse';
      sk.className = 'kv-v ' + (c.skill < 1 ? 'up' : 'down');
    }
    var band = el('acc-band');
    if (band) {
      band.textContent = c.conformal
        ? 'conformal ×' + c.conformal.z68 + ' on ' + c.conformal.n + ' replays'
        : 'uncalibrated';
      band.className = 'kv-v ' + (c.conformal ? '' : 'flat');
    }

    /* The verdict line. This is the answer to the only question that matters
       for someone deciding whether to act, and it is stated plainly because
       every softer phrasing has been read as encouragement. */
    var v = [], tone = 'warn';
    if (c.directionSignificant && c.skill < 1) {
      tone = 'good';
      v.push('The direction rate clears a coin flip across its whole 95% interval and the model beats a no-change guess.');
      v.push('That is the weakest bar worth clearing, not a green light — it says nothing about costs.');
    } else {
      tone = 'bad';
      if (c.directionCi) {
        v.push('The direction rate is ' + c.directionRate + '%, but its 95% interval runs ' +
               c.directionCi[0] + '–' + c.directionCi[1] + '%, which contains 50%. On this evidence the lean is not distinguishable from a coin.');
      } else {
        v.push('There are too few directional calls to say whether the lean beats a coin.');
      }
      if (c.skill >= 1) {
        v.push('The model is also ' + (Math.round((c.skill - 1) * 1000) / 10) +
               '% worse than assuming no change at this horizon.');
      }
      v.push('Do not size a position off this number.');
    }
    setVerdict('acc-verdict', tone, v.join(' '));

    var note = 'Measured by rebuilding the forecast at ' + c.n + ' past points on this timeframe and checking what price ' +
      'actually did over the next ' + c.bars + ' bars. ';
    note += 'Those windows overlap by ' + c.overlapFraction + '%, so they cover about ' + c.nEff +
            ' independent horizons. Every percentage above is the estimate from all ' + c.n +
            ' — overlap costs precision, not validity — and every interval and p-value is computed on the ' +
            c.nEff + '. Scoring ' + c.n + ' as if they were independent is what made earlier versions of this panel ' +
            'swing by tens of points when the replay grid moved a few bars. ';
    note += c.basis.charAt(0).toUpperCase() + c.basis.slice(1) + '. ';
    if (c.kupiec68 && c.kupiec68.message) note += c.kupiec68.message + ' ';
    note += 'This is a backtest: it scores the model against history the model was built on. The forward record below is the stronger evidence.';
    text('acc-note', note);
  }

  function putCoverage(id, value, kupiec) {
    var node = el(id);
    if (!node) return;
    node.textContent = value + '%' + (kupiec && kupiec.verdict !== 'insufficient-data'
      ? '  (p=' + kupiec.pValue + ')' : '');
    node.className = 'kv-v ' + (!kupiec || kupiec.verdict === 'insufficient-data' ? 'flat'
      : kupiec.verdict === 'well-calibrated' ? 'up' : 'down');
  }

  function setVerdict(id, tone, txt) {
    var node = el(id);
    if (!node) return;
    node.textContent = txt;
    node.className = 'verdict-line' + (tone ? ' ' + tone : '');
  }

  /* A forward record takes a horizon to produce its first row - 6.5 hours on
     the daily view, longer elsewhere - and until then this panel would have
     nothing to show and no way to demonstrate that it works. Seeding rebuilds
     a handful of forecasts at past bars using only the candles available then,
     settles them against the bars that really followed, and marks them.

     They are excluded from every forward statistic. They are here to show what
     the post-mortem looks like and to prove the plumbing runs, not to pad the
     sample - see aggregate() in ledger.js, which filters them out. */
  function maybeSeedLedger() {
    if (!KT.ledger || !S.candles || S.candles.length < 250) return;
    var key = S.symbol + ':' + S.timeframe;
    if (S.seededKey === key) return;
    S.seededKey = key;
    // Off the critical path: this runs build() several times over.
    setTimeout(function () {
      if (S.seededKey !== key) return;
      try {
        KT.ledger.seedFromHistory(S.candles, S.symbol, S.timeframe,
                                  { count: 6, seasonality: S.seasonality });
        renderLedger();
      } catch (e) { /* seeding is a nicety, never a reason to break the page */ }
    }, 1200);
  }

  /* ========================================================= HOW IT WENT */
  function renderLedger() {
    if (!KT.ledger) return;
    var body = el('ledger-body'), empty = el('ledger-empty');
    var row = KT.ledger.latest(S.symbol, S.timeframe, 'settled');
    var agg = KT.ledger.aggregate(S.symbol, S.timeframe);
    var pending = KT.ledger.all().filter(function (r) {
      return r.symbol === S.symbol && r.timeframe === S.timeframe && r.status !== 'settled';
    }).length;

    text('ledger-n', agg.n ? agg.n + ' scored, ' + pending + ' pending' : (pending + ' pending'));

    if (!row || !row.explain) {
      if (body) body.classList.add('hidden');
      if (empty) {
        empty.classList.remove('hidden');
        // An empty panel is indistinguishable from a broken one, so say which.
        empty.textContent = pending
          ? 'No forecast on this view has reached the end of its horizon yet. ' + pending +
            ' is waiting; the oldest settles once ' + (S.forecast ? S.forecast.horizonLabel : 'the horizon') +
            ' of trading has passed since it was written down. Nothing is scored until then.'
          : 'Nothing recorded on this view yet. A row is written the first time a forecast is built here, ' +
            'and scored when its horizon elapses.';
      }
      return;
    }
    if (empty) empty.classList.add('hidden');
    if (body) body.classList.remove('hidden');

    var e = row.explain;
    var seeded = row.origin === 'seeded';
    var did0 = el('ledger-n');
    if (did0 && seeded && !agg.n) {
      did0.textContent = 'example from history · ' + pending + ' pending';
    }
    var said = el('lg-said'), did = el('lg-did'), err = el('lg-err');
    if (said) { said.textContent = fmt.pct(e.forecastPct) + '  (' + row.direction.toLowerCase() + ')'; said.className = 'kv-v ' + fmt.cls(e.forecastPct); }
    if (did)  { did.textContent = fmt.pct(e.realisedPct); did.className = 'kv-v ' + fmt.cls(e.realisedPct); }
    if (err)  { err.textContent = fmt.pct(e.errorPct); err.className = 'kv-v ' + (Math.abs(e.errorPct) < 0.15 ? 'up' : 'down'); }

    var tone = e.mode === 'hit' ? 'good'
      : e.mode === 'vol-surprise' ? 'bad'
      : e.mode === 'lean-wrong-range-held' ? 'warn' : 'bad';
    setVerdict('lg-mode', tone, e.modeText);

    var host = el('lg-lane-rows');
    if (host) {
      host.innerHTML = '';
      e.lanes.forEach(function (l) {
        var tr = document.createElement('tr');
        var scored = l.verdict === 'right' || l.verdict === 'wrong';
        if (!scored) tr.className = 'idle';
        var td1 = document.createElement('td'); td1.textContent = l.label;
        var td2 = document.createElement('td'); td2.className = 'num-col';
        td2.textContent = scored || l.askedPct ? fmt.pct(l.askedPct) : '—';
        var td3 = document.createElement('td'); td3.className = 'num-col ' +
          (l.verdict === 'right' ? 'lg-verdict-right' : l.verdict === 'wrong' ? 'lg-verdict-wrong' : 'lg-verdict-idle');
        td3.textContent = l.verdict;
        tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
        host.appendChild(tr);
      });
    }

    var res = el('lg-residual');
    if (res) {
      res.textContent = fmt.pct(e.residualPct);
      // A residual larger than everything the lanes asked for together means
      // the model did not merely get the direction wrong, it was blind.
      res.className = 'kv-v ' + (Math.abs(e.residualPct) > Math.abs(e.askedTotalPct) * 2 ? 'down' : '');
    }
    var win = el('lg-winner');
    if (win) {
      win.textContent = e.componentWinner === 'news' ? 'the headlines were closer'
        : e.componentWinner === 'pattern' ? 'the chart was closer'
        : e.componentWinner === 'neither' ? 'neither, they finished level' : '—';
      win.className = 'kv-v';
    }

    var arr = el('lg-arrivals');
    if (arr) {
      arr.innerHTML = '';
      var a = e.arrivals;
      if (a && a.top && a.top.length) {
        a.top.forEach(function (n) {
          var p = document.createElement('p');
          p.className = 'lg-arrival';
          // Descriptive only. Naming the loudest headline in the window is
          // checkable; saying it caused the move is not.
          p.innerHTML = '<strong>Landed inside the window:</strong> ' +
            fmt.stamp(n.ts, 3600) + ' &middot; ' + escapeHtml(n.headline) +
            ' <em>(' + escapeHtml(n.source || '') + ', ' + n.impact + ')</em>';
          arr.appendChild(p);
        });
      } else if (a && a.scanned) {
        var p2 = document.createElement('p');
        p2.className = 'fine';
        p2.textContent = 'Nothing scored in the live feed arrived inside this window. The fast lane only holds the current sweep, ' +
          'so a headline that has since aged out cannot be recovered — the workflow archive is what fixes that over time.';
        arr.appendChild(p2);
      }
    }

    /* ----------------------------------------------- the running record */
    text('lg-agg-n', agg.n + ' settled' + (agg.seeded ? ' (' + agg.seeded + ' seeded, excluded)' : ''));
    var cov = el('lg-cov');
    if (cov) {
      // With nothing settled there is no coverage, and printing "undefined%"
      // is worse than printing nothing at all.
      cov.textContent = agg.n
        ? agg.coverage68 + '%' + (agg.coverage68Ci ? '  (' + agg.coverage68Ci[0] + '–' + agg.coverage68Ci[1] + '%)' : '')
        : 'nothing settled yet';
      cov.className = 'kv-v ' + (!agg.n ? 'flat'
        : agg.kupiec68 && agg.kupiec68.verdict === 'well-calibrated' ? 'up'
        : agg.kupiec68 && agg.kupiec68.verdict === 'insufficient-data' ? 'flat' : 'down');
    }
    var ld = el('lg-dir');
    if (ld) {
      ld.textContent = agg.directionRate == null ? 'no calls yet'
        : agg.directionRate + '% of ' + agg.directionCalls +
          (agg.directionCi ? '  (' + agg.directionCi[0] + '–' + agg.directionCi[1] + '%)' : '');
      ld.className = 'kv-v ' + (agg.directionSignificant ? 'up' : 'flat');
    }
    var ls = el('lg-skill');
    if (ls) {
      ls.textContent = agg.skill == null ? '—'
        : agg.skill < 1 ? (Math.round((1 - agg.skill) * 1000) / 10) + '% better'
        : (Math.round((agg.skill - 1) * 1000) / 10) + '% worse';
      ls.className = 'kv-v ' + (agg.skill != null && agg.skill < 1 ? 'up' : 'down');
    }

    var aggHost = el('lg-agg-rows');
    if (aggHost) {
      aggHost.innerHTML = '';
      if (!agg.lanes.length) {
        var tr0 = document.createElement('tr');
        var td0 = document.createElement('td');
        td0.colSpan = 3; td0.className = 'lg-verdict-idle';
        td0.textContent = 'No lane has been scored often enough to have a record.';
        tr0.appendChild(td0); aggHost.appendChild(tr0);
      }
      agg.lanes.forEach(function (l) {
        var tr = document.createElement('tr');
        if (!l.significant) tr.className = 'idle';
        var a1 = document.createElement('td'); a1.textContent = l.label;
        var a2 = document.createElement('td'); a2.className = 'num-col';
        a2.textContent = l.right + '/' + l.n + '  ' + l.rate + '%';
        var a3 = document.createElement('td'); a3.className = 'num-col ' + (l.significant ? 'lg-verdict-right' : 'lg-verdict-idle');
        a3.textContent = l.ci ? l.ci[0] + '–' + l.ci[1] + '%' : '—';
        tr.appendChild(a1); tr.appendChild(a2); tr.appendChild(a3);
        aggHost.appendChild(tr);
      });
    }

    var note = '';
    if (seeded && !agg.n) {
      note += 'The post-mortem above is rebuilt from history, using only candles that existed at that bar, ' +
              'because no forecast written down in this browser has settled yet. It shows what the panel will say; ' +
              'it is not forward evidence and it is excluded from the totals below. ';
    }
    note += 'Each counted row was written down before its outcome existed, which is what separates this from the backtest above. ';
    if (agg.seeded) note += agg.seeded + ' seeded row' + (agg.seeded === 1 ? ' is' : 's are') + ' excluded. ';
    if (agg.n < 30) {
      note += 'At ' + agg.n + ' settled forecast' + (agg.n === 1 ? '' : 's') + ' none of these rates means anything yet — ' +
              'read the intervals, not the percentages. ';
    }
    if (agg.callsNeeded) {
      note += 'For a ' + agg.directionRate + '% direction rate to be distinguishable from a coin at 80% power would take about ' +
              agg.callsNeeded + ' independent calls. ';
    }
    note += 'Rows marked seeded are rebuilt from history to exercise the machinery and are excluded from these totals.';
    text('lg-note', note);
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* ========================================================== STRUCTURES */
  function renderStructures() {
    var host = el('structure-list');
    if (!host) return;
    host.innerHTML = '';
    var list = S.structures || [];
    text('structure-count', list.length ? list.length + ' drawn' : 'none');
    if (!list.length) {
      text('structure-note', 'No triangle, flag, double top or head and shoulders clears the quality bar on this timeframe right now. The bar is deliberately high: geometry finds these shapes in pure noise if you let it.');
      return;
    }
    list.forEach(function (st) {
      var stat = S.structureStats[st.key] || {};
      var row = document.createElement('div');
      row.className = 'structure-row ' + (st.dir > 0 ? 'bull' : st.dir < 0 ? 'bear' : '');

      var top = document.createElement('div');
      top.className = 'structure-top';
      var name = document.createElement('span');
      name.className = 'structure-name';
      name.textContent = st.name;
      var status = document.createElement('span');
      status.className = 'structure-status ' + st.status;
      status.textContent = st.status;
      top.appendChild(name); top.appendChild(status);

      var meta = document.createElement('div');
      meta.className = 'structure-meta';
      meta.appendChild(kvSpan('trigger', fmt.price(st.trigger)));
      meta.appendChild(kvSpan('target', fmt.price(st.target) + ' (' + fmt.pct(st.targetPct, 1) + ')'));
      meta.appendChild(kvSpan('invalid at', fmt.price(st.stop)));
      meta.appendChild(kvSpan('quality', Math.round(st.quality * 100) + '%'));

      var why = document.createElement('div');
      why.className = 'structure-why';
      why.textContent = st.why;

      var rate = document.createElement('div');
      if (stat.resolved) {
        rate.className = 'structure-rate' + (stat.reliable ? '' : ' thin');
        var n = stat.resolved, plural = n === 1 ? 'case' : 'cases';
        rate.textContent = stat.reliable
          ? 'On this instrument it reached target before stop ' + stat.hitRate + '% of ' + n + ' resolved ' + plural + '.'
          : 'Only ' + n + ' resolved ' + plural + ' in the loaded history \u2014 too few to call a rate, so treat the shape as context, not a signal.';
      } else {
        rate.className = 'structure-rate thin';
        rate.textContent = 'No resolved occurrences in the loaded history, so there is no measured record to quote.';
      }

      row.appendChild(top); row.appendChild(meta); row.appendChild(why); row.appendChild(rate);
      host.appendChild(row);
    });
    text('structure-note', 'Drawn on the chart in the same colour. Trigger is the level that confirms the shape; target is the measured move from its own height.');
  }

  function kvSpan(k, v) {
    var sp = document.createElement('span');
    sp.appendChild(document.createTextNode(k + ' '));
    var b = document.createElement('b');
    b.textContent = v;
    sp.appendChild(b);
    return sp;
  }

  /* ============================================================== LEVELS */
  function renderLevels() {
    var host = el('levels-list');
    if (!host) return;
    host.innerHTML = '';
    var lv = S.levels;
    if (!lv) { text('levels-basis', '—'); return; }
    text('levels-basis', lv.profile ? lv.profile.basis : '');

    var rows = [];
    lv.zones.slice(0, 6).forEach(function (z) {
      rows.push({ tag: z.side === 'resistance' ? 'res' : 'sup',
                  label: z.side === 'resistance' ? 'Resistance' : 'Support',
                  price: z.level, note: z.touches + ' touches · ' + fmt.pct(z.distPct, 1) });
    });
    if (lv.pivots) {
      rows.push({ tag: '', label: 'Pivot', price: lv.pivots.pp, note: 'from yesterday' });
      rows.push({ tag: 'res', label: 'R1', price: lv.pivots.r1, note: 'classic' });
      rows.push({ tag: 'sup', label: 'S1', price: lv.pivots.s1, note: 'classic' });
    }
    if (lv.profile) {
      rows.push({ tag: '', label: 'POC', price: lv.profile.poc, note: 'busiest price' });
      rows.push({ tag: '', label: 'Value area', price: lv.profile.vaLow,
                  note: 'to ' + fmt.int(lv.profile.vaHigh) });
    }
    (lv.gaps || []).slice(0, 2).forEach(function (g) {
      rows.push({ tag: g.dir === 'up' ? 'sup' : 'res', label: 'Open gap',
                  price: g.dir === 'up' ? g.from : g.to, note: fmt.pct(g.sizePct, 2) + ' unfilled' });
    });

    rows.forEach(function (r) {
      var div = document.createElement('div');
      div.className = 'level-row';
      var t = document.createElement('span');
      t.className = 'level-tag ' + r.tag;
      t.textContent = r.label;
      var pr = document.createElement('span');
      pr.className = 'level-price';
      pr.textContent = fmt.price(r.price);
      var n = document.createElement('span');
      n.className = 'level-note';
      n.textContent = r.note;
      div.appendChild(t); div.appendChild(pr); div.appendChild(n);
      host.appendChild(div);
    });
  }

  /* ========================================================= GLOBAL CUES */
  function renderCues() {
    var host = el('cues-list');
    if (!host) return;
    host.innerHTML = '';
    var g = S.global;
    // An empty items object is the normal shape when every upstream source
    // refused the runner, so it has to be handled exactly like a missing file.
    if (!g || !g.items || !Object.keys(g.items).length) {
      text('cues-updated', g && g.generated_at ? 'no sources answered' : 'not loaded');
      var p = document.createElement('p');
      p.className = 'fine';
      p.textContent = 'Overnight cues have not arrived yet. Until they do, the forecast falls back to ' +
        'international headline sentiment for its global lane, and that lane\u2019s weight is spread ' +
        'across the others rather than counted as neutral.';
      host.appendChild(p);
      return;
    }
    text('cues-updated', g.generated_at ? fmt.ago(Math.floor(new Date(g.generated_at).getTime() / 1000)) : '');
    var order = ['us_futures', 'nasdaq_fut', 'nikkei', 'hangseng', 'crude', 'usdinr', 'dxy', 'us10y', 'gold', 'vix'];
    order.forEach(function (k) {
      var row = g.items[k];
      if (!row) return;
      var d = document.createElement('div');
      d.className = 'cue';
      var kk = document.createElement('span');
      kk.className = 'cue-k';
      kk.textContent = row.label || k;
      var vv = document.createElement('span');
      vv.className = 'cue-v ' + fmt.cls(row.changePct);
      vv.textContent = (row.price != null ? fmt.int(row.price) + '  ' : '') + fmt.pct(row.changePct, 2);
      d.appendChild(kk); d.appendChild(vv);
      host.appendChild(d);
    });
  }

  /* =========================================================== INDICATORS */
  function renderIndicators() {
    var host = el('indicator-grid');
    if (!host) return;
    host.innerHTML = '';
    var s = S.indicators;
    if (!s) { text('ind-basis', '—'); return; }
    text('ind-basis', s.bars + ' bars');

    function row(k, v, cls) {
      var d = document.createElement('div');
      d.className = 'ind';
      var a = document.createElement('span');
      a.className = 'ind-k';
      a.textContent = k;
      var b = document.createElement('span');
      b.className = 'ind-v ' + (cls || '');
      b.textContent = v;
      d.appendChild(a); d.appendChild(b);
      host.appendChild(d);
    }
    function n(v, d) { return v == null ? '—' : v.toFixed(d === undefined ? 1 : d); }

    row('RSI 14', n(s.rsi), s.rsi == null ? '' : s.rsi > 60 ? 'up' : s.rsi < 40 ? 'down' : '');
    row('ADX 14', n(s.adx), s.adx == null ? '' : s.adx > 25 ? 'up' : '');
    row('MACD hist', n(s.macdHist, 2), s.macdHist == null ? '' : fmt.cls(s.macdHist));
    row('ATR %', n(s.atrPct, 2));
    row('%B', n(s.pctB, 2), s.pctB == null ? '' : s.pctB > 1 ? 'up' : s.pctB < 0 ? 'down' : '');
    row('BB width', n(s.bbWidth, 2));
    row('Supertrend', s.supertrendDir == null ? '—' : (s.supertrendDir > 0 ? 'long' : 'short'),
        s.supertrendDir == null ? '' : (s.supertrendDir > 0 ? 'up' : 'down'));
    row('Squeeze', s.squeezeOn ? 'on, ' + s.squeezeAge + ' bars' : 'off', s.squeezeOn ? 'down' : '');
    row('Stochastic', n(s.stoch), s.stoch == null ? '' : s.stoch > 80 ? 'up' : s.stoch < 20 ? 'down' : '');
    row('CCI 20', n(s.cci, 0));
    row('20 EMA', s.ema20 == null ? '—' : fmt.price(s.ema20), s.ema20 == null ? '' : fmt.cls(s.price - s.ema20));
    row('50 EMA', s.ema50 == null ? '—' : fmt.price(s.ema50), s.ema50 == null ? '' : fmt.cls(s.price - s.ema50));
    if (s.hasVolume) {
      row('VWAP', s.vwap == null ? '—' : fmt.price(s.vwap), s.vwap == null ? '' : fmt.cls(s.price - s.vwap));
      row('MFI 14', n(s.mfi));
    }
  }

  /* ============================================================ PORTFOLIO
     Holdings live in this browser. Everything here reads them, matches them
     against the same news stream the index uses, and raises an alert when
     something lands on one of your names. */
  function renderPortfolio() {
    var v = KT.portfolio.valuation();
    var has = KT.portfolio.count() > 0;
    var empty = el('pf-empty');
    if (empty) empty.classList.toggle('hidden', has);

    if (!has) {
      ['pf-invested', 'pf-current', 'pf-pl', 'pf-day'].forEach(function (id) { text(id, '—'); });
      var mini0 = el('pf-mini');
      if (mini0) mini0.innerHTML = '';
      renderAlertBadge();
      return;
    }

    text('pf-invested', fmt.price(v.invested));
    text('pf-current', fmt.price(v.current));
    var pl = el('pf-pl');
    if (pl) {
      pl.textContent = fmt.signed(v.pl) + (v.plPct == null ? '' : '  (' + fmt.pct(v.plPct) + ')');
      pl.className = 'kv-v ' + fmt.cls(v.pl);
    }
    var day = el('pf-day');
    if (day) {
      day.textContent = fmt.signed(v.dayChange);
      day.className = 'kv-v ' + fmt.cls(v.dayChange);
    }

    var mini = el('pf-mini');
    if (mini) {
      mini.innerHTML = '';
      v.lines.slice(0, 6).forEach(function (l) {
        var li = document.createElement('li');
        var a = document.createElement('span');
        a.className = 'pf-sym';
        a.textContent = l.row.symbol;
        var b = document.createElement('span');
        b.className = 'pf-num ' + (l.dayPct == null ? '' : fmt.cls(l.dayPct));
        b.textContent = l.dayPct == null ? '—' : fmt.pct(l.dayPct, 1);
        var c = document.createElement('span');
        c.className = 'pf-num ' + (l.pl == null ? '' : fmt.cls(l.pl));
        c.textContent = l.pl == null ? 'no price' : fmt.signed(l.pl, 0);
        li.appendChild(a); li.appendChild(b); li.appendChild(c);
        mini.appendChild(li);
      });
      if (v.unpriced) {
        var li2 = document.createElement('li');
        li2.className = 'fine';
        li2.textContent = v.unpriced + ' holding' + (v.unpriced > 1 ? 's' : '') + ' without a live price, held at cost.';
        mini.appendChild(li2);
      }
    }
    renderAlertBadge();
  }

  function renderPortfolioTable() {
    var body = el('pf-rows');
    if (!body) return;
    body.innerHTML = '';
    var v = KT.portfolio.valuation();
    v.lines.forEach(function (l) {
      var tr = document.createElement('tr');
      function td(txt, cls) {
        var d = document.createElement('td');
        if (cls) d.className = cls;
        d.textContent = txt;
        return d;
      }
      var sym = document.createElement('td');
      var strong = document.createElement('strong');
      strong.textContent = l.row.symbol;
      var small = document.createElement('div');
      small.className = 'fine';
      small.textContent = l.row.name === l.row.symbol ? l.row.exchange : l.row.name;
      sym.appendChild(strong); sym.appendChild(small);
      tr.appendChild(sym);
      tr.appendChild(td(fmt.int(l.row.qty), 'num'));
      tr.appendChild(td(fmt.price(l.row.avgPrice), 'num'));
      tr.appendChild(td(l.ltp == null ? '—' : fmt.price(l.ltp), 'num'));
      tr.appendChild(td(l.dayPct == null ? '—' : fmt.pct(l.dayPct, 1), 'num ' + (l.dayPct == null ? '' : fmt.cls(l.dayPct))));
      tr.appendChild(td(l.pl == null ? '—' : fmt.signed(l.pl, 0) + (l.plPct == null ? '' : ' (' + fmt.pct(l.plPct, 1) + ')'),
                        'num ' + (l.pl == null ? '' : fmt.cls(l.pl))));
      var act = document.createElement('td');
      var btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.dataset.remove = l.row.id;
      btn.textContent = 'Remove';
      act.appendChild(btn);
      tr.appendChild(act);
      body.appendChild(tr);
    });

    var sum = el('pf-summary');
    if (sum) {
      sum.innerHTML = '';
      [['Invested', fmt.price(v.invested), ''],
       ['Value', fmt.price(v.current), ''],
       ['P&L', fmt.signed(v.pl), fmt.cls(v.pl)],
       ['Today', fmt.signed(v.dayChange), fmt.cls(v.dayChange)]].forEach(function (t) {
        var d = document.createElement('div');
        d.className = 'stat';
        var k = document.createElement('span');
        k.className = 'stat-k';
        k.textContent = t[0];
        var val = document.createElement('span');
        val.className = 'stat-v ' + t[2];
        val.textContent = t[1];
        d.appendChild(k); d.appendChild(val);
        sum.appendChild(d);
      });
    }
    text('pf-count', KT.portfolio.count() + ' holdings, stored in this browser only');

    var newsHost = el('pf-news');
    if (newsHost) {
      newsHost.innerHTML = '';
      var related = KT.portfolio.relatedNews(data.getNews(), 25);
      text('pf-news-count', related.length ? related.length + ' matched' : 'none yet');
      related.forEach(function (r) {
        var li = document.createElement('li');
        var head = document.createElement('div');
        head.className = 'news-meta';
        head.textContent = r.symbol + ' · ' + r.item.source + ' · ' + fmt.ago(r.item.ts);
        var a = document.createElement(r.item.url ? 'a' : 'span');
        if (r.item.url) { a.href = r.item.url; a.target = '_blank'; a.rel = 'noopener'; }
        a.className = 'news-head';
        a.textContent = r.item.headline;
        li.appendChild(head); li.appendChild(a);
        newsHost.appendChild(li);
      });
    }
  }

  function fillUniverseList() {
    var dl = el('pf-universe');
    if (!dl) return;
    dl.innerHTML = '';
    KT.portfolio.universeList().slice(0, 900).forEach(function (u) {
      var o = document.createElement('option');
      o.value = u.symbol;
      o.label = u.name;
      dl.appendChild(o);
    });
  }

  /* ================================================================ ALERTS */
  function scanAlerts() {
    if (!KT.portfolio.count()) return;
    try {
      var r = KT.portfolio.scan(data.getNews());
      if (r.fresh) renderAlerts();
      renderAlertBadge();
    } catch (e) { /* an alert failure must never stop the tape */ }
  }

  function renderAlertBadge() {
    var dot = el('alert-dot');
    if (!dot) return;
    var n = KT.portfolio.alerts().length;
    dot.textContent = n > 99 ? '99+' : String(n);
    dot.classList.toggle('hidden', n === 0);
  }

  function renderAlerts() {
    var list = el('alert-list');
    if (!list) return;
    list.innerHTML = '';
    var alerts = KT.portfolio.alerts();
    var empty = el('alerts-empty');
    if (empty) empty.classList.toggle('hidden', alerts.length > 0);

    alerts.forEach(function (a) {
      var li = document.createElement('li');
      li.className = 'alert-item ' + (a.severity || 'medium');

      var x = document.createElement('button');
      x.className = 'alert-x';
      x.dataset.dismiss = a.key;
      x.setAttribute('aria-label', 'Dismiss');
      x.textContent = '×';
      li.appendChild(x);

      var head = document.createElement('div');
      head.className = 'alert-head';
      var sym = document.createElement('span');
      sym.className = 'alert-sym';
      sym.textContent = a.symbol;
      var kind = document.createElement('span');
      kind.className = 'alert-kind';
      kind.textContent = a.kind;
      var when = document.createElement('span');
      when.textContent = fmt.ago(a.ts);
      head.appendChild(sym); head.appendChild(kind); head.appendChild(when);

      var body = document.createElement('div');
      body.className = 'alert-text';
      if (a.url) {
        var link = document.createElement('a');
        link.href = a.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = a.headline;
        body.appendChild(link);
      } else {
        body.textContent = a.headline;
      }

      li.appendChild(head); li.appendChild(body);
      list.appendChild(li);
    });
    renderAlertBadge();
  }

  function wirePortfolio() {
    var modal = el('portfolio-modal');
    if (!modal) return;

    function open() {
      renderPortfolioTable();
      fillUniverseList();
      var d = el('pf-date');
      if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);
      modal.classList.remove('hidden');
    }
    function close() { modal.classList.add('hidden'); }

    el('btn-portfolio').addEventListener('click', open);
    var side = el('btn-open-portfolio');
    if (side) side.addEventListener('click', open);
    el('btn-close-portfolio').addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

    el('portfolio-form').addEventListener('submit', function (e) {
      e.preventDefault();
      text('pf-error', '');
      try {
        KT.portfolio.add({
          symbol: el('pf-symbol').value,
          exchange: el('pf-exchange').value,
          qty: el('pf-qty').value,
          avgPrice: el('pf-price').value,
          date: el('pf-date').value,
          note: el('pf-note').value,
        });
        el('pf-symbol').value = ''; el('pf-qty').value = ''; el('pf-price').value = ''; el('pf-note').value = '';
        KT.portfolio.refreshMissing().then(function () {
          renderPortfolioTable(); renderPortfolio(); scanAlerts();
        });
        renderPortfolioTable(); renderPortfolio();
      } catch (err) {
        text('pf-error', String(err.message || err));
      }
    });

    el('pf-rows').addEventListener('click', function (e) {
      var id = e.target && e.target.dataset && e.target.dataset.remove;
      if (!id) return;
      KT.portfolio.remove(id);
      renderPortfolioTable(); renderPortfolio();
    });

    el('btn-pf-clear').addEventListener('click', function () {
      if (!KT.portfolio.count()) return;
      // Holdings only exist in this browser, so there is no copy to restore
      // from. Ask before wiping them.
      if (!window.confirm('Remove every holding from this browser? There is no server copy to restore from.')) return;
      KT.portfolio.clear();
      renderPortfolioTable(); renderPortfolio(); renderAlerts();
    });

    el('btn-pf-export').addEventListener('click', function () {
      var blob = new Blob([KT.portfolio.exportJson()], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'holdings-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });
    el('btn-pf-import').addEventListener('click', function () { el('pf-file').click(); });
    el('pf-file').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var n = KT.portfolio.importJson(String(fr.result));
          text('pf-error', n + ' holdings imported.');
          KT.portfolio.refreshMissing().then(function () { renderPortfolioTable(); renderPortfolio(); });
          renderPortfolioTable(); renderPortfolio();
        } catch (err) { text('pf-error', 'Could not read that file: ' + (err.message || err)); }
      };
      fr.readAsText(file);
      e.target.value = '';
    });

    /* ------------------------------------------------------ alerts drawer */
    var drawer = el('alerts-drawer');
    el('btn-alerts').addEventListener('click', function () {
      S.alertsOpen = !S.alertsOpen;
      drawer.classList.toggle('hidden', !S.alertsOpen);
      if (S.alertsOpen) renderAlerts();
    });
    el('btn-close-alerts').addEventListener('click', function () {
      S.alertsOpen = false;
      drawer.classList.add('hidden');
    });
    el('btn-alerts-clear').addEventListener('click', function () {
      KT.portfolio.dismissAll();
      renderAlerts();
    });
    el('alert-list').addEventListener('click', function (e) {
      var k = e.target && e.target.dataset && e.target.dataset.dismiss;
      if (!k) return;
      KT.portfolio.dismiss(k);
      renderAlerts();
    });

    renderAlerts();
    renderPortfolio();
  }

  function renderSeasonality() {
    var s = S.seasonality;
    if (!s || !s.months) return;
    text('season-years', (s.history_months ? Math.round(s.history_months / 12) : 0) + ' years of data');

    var cur = s.current_month;
    if (cur) {
      text('season-month-k', cur.name + ' average (' + cur.n + ' yrs)');
      text('season-month-v', fmt.pct(cur.avg));
      core.cls('season-month-v', fmt.cls(cur.avg));
      text('season-win', cur.win.toFixed(0) + '% of years positive');
    }
    var best = (s.days_of_week || []).slice().sort(function (a, b) { return b.avg - a.avg; })[0];
    if (best) text('season-dow', best.name + '  ' + fmt.pct(best.avg, 3));
    if (s.expiry_week) {
      text('season-expiry', fmt.pct(s.expiry_week.avg, 3) + '  vs  ' + fmt.pct(s.expiry_week.other_avg, 3));
    }

    var box = el('season-bars');
    if (!box) return;
    box.innerHTML = '';
    var maxAbs = Math.max.apply(null, s.months.map(function (m) { return Math.abs(m.avg); })) || 1;
    var thisMonth = new Date().getMonth() + 1;
    s.months.forEach(function (m) {
      var cell = document.createElement('div');
      cell.className = 'sb';
      cell.setAttribute('data-current', String(m.m === thisMonth));
      cell.title = m.name + ': average ' + fmt.pct(m.avg) + ', median ' + fmt.pct(m.median) +
                   ', positive in ' + m.win.toFixed(0) + '% of ' + m.n + ' years (best ' + fmt.pct(m.best) + ', worst ' + fmt.pct(m.worst) + ')';
      var h = Math.max(2, Math.abs(m.avg) / maxAbs * 28);
      var posCell = document.createElement('div'); posCell.className = 'sb-pos';
      var negCell = document.createElement('div'); negCell.className = 'sb-neg';
      var fill = document.createElement('div');
      fill.className = 'sb-fill ' + (m.avg < 0 ? 'neg' : 'pos');
      fill.style.height = h + 'px';
      fill.style.background = m.avg >= 0 ? 'var(--up)' : 'var(--down)';
      (m.avg >= 0 ? posCell : negCell).appendChild(fill);

      var label = document.createElement('div');
      label.className = 'sb-label';
      label.textContent = m.name[0];
      cell.appendChild(posCell); cell.appendChild(negCell); cell.appendChild(label);
      box.appendChild(cell);
    });
    text('season-scale', '±' + maxAbs.toFixed(1) + '%');
  }

  function renderSectors() {
    var box = el('sector-list');
    if (!box) return;
    var by = (S.rollup && S.rollup.by_sector) || {};
    var rows = Object.keys(by).map(function (k) { return { name: k, v: by[k] }; })
      .filter(function (r) { return r.name !== 'general'; })
      .sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); })
      .slice(0, 8);

    if (!rows.length) {
      box.innerHTML = '<span class="muted" style="font-size:11.5px">Sector bias appears once the scheduled feed run has published a rollup.</span>';
      return;
    }
    box.innerHTML = '';
    rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'sector-row';
      row.title = r.name + ' news sentiment over the last 24 hours: ' + r.v.toFixed(2) + ' on a -4 to +4 scale';
      var n = document.createElement('span'); n.className = 'sector-n'; n.textContent = r.name;
      var bar = document.createElement('div'); bar.className = 'sector-bar';
      var fill = document.createElement('div'); fill.className = 'sector-fill';
      var w = Math.min(50, Math.abs(r.v) / 3 * 50);
      fill.style.width = w + '%';
      fill.style.left = r.v >= 0 ? '50%' : (50 - w) + '%';
      fill.style.background = r.v >= 0 ? 'var(--up)' : 'var(--down)';
      bar.appendChild(fill);
      var v = document.createElement('span');
      v.className = 'sector-v ' + fmt.cls(r.v);
      v.textContent = (r.v >= 0 ? '+' : '') + r.v.toFixed(2);
      row.appendChild(n); row.appendChild(bar); row.appendChild(v);
      box.appendChild(row);
    });
  }

  function ageLabel(iso) {
    var ms = Date.now() - Date.parse(iso || '');
    if (!isFinite(ms)) return 'age unknown';
    var min = Math.round(ms / 60000);
    return min < 90 ? min + ' min old' : Math.round(min / 60) + 'h old';
  }

  function renderLanes() {
    var box = el('source-lanes');
    if (!box) return;
    var h = data.health;
    /* The fast lane's health used to be read off feed:mc_top alone - one feed
       out of fifteen standing in for the whole set. When Moneycontrol started
       answering 403 the lane read "unavailable" while seven other feeds were
       filling the page, and when that feed was removed it read "idle" forever.
       Count the direct set instead: alive if any of them answered. */
    var directOk = 0, directSeen = 0;
    C.directFeeds.forEach(function (f) {
      var st = h['feed:' + f.id];
      if (!st) return;
      directSeen++;
      if (st.ok) directOk++;
    });
    var fastState = directSeen
      ? { ok: directOk > 0, note: directOk + ' of ' + directSeen + ' answered' }
      : null;

    var lanes = [
      { k: 'Live price', id: 'quote', hint: 'Moneycontrol price feed, read directly by your browser' },
      { k: 'Candles', id: 'candles', hint: 'Yahoo Finance OHLC through the proxy chain' },
      { k: 'Fast news', st: fastState, hint: C.directFeeds.length + ' feeds your browser can read directly, every ' + Math.round(S.settings.newsMs / 1000) + 's' },
      { k: 'Deep news', id: null, hint: 'GitHub Actions fetches all ' + (S.feedsTotal || '') + ' feeds a run, where CORS does not apply' },
      { k: 'Model', id: 'openrouter', hint: S.settings.key ? S.settings.model : 'no key set — using the local rule engine' },
      /* The two browser-side NSE lanes. Both have a workflow fallback, so
         "unavailable" here means the lane is running on the older copy rather
         than that it is dead - the distinction matters and the state text says
         which. A lane the panel does not show is a lane nobody checks. */
      {
        k: 'Option chain',
        st: S.options
          ? { ok: S.options.origin === 'browser',
              note: S.options.origin === 'browser'
                ? 'live via ' + (S.options.via || 'proxy')
                : 'workflow copy, ' + ageLabel(S.options.generated_at) }
          : null,
        stale: S.options && S.options.origin !== 'browser',
        hint: 'NSE option chain: PCR, max pain, OI walls. Browser-side through the proxy, workflow copy as fallback',
      },
      {
        k: 'Market internals',
        st: S.internals
          ? { ok: true, note: 'breadth, VIX and midcap divergence, live via ' + (S.internals.via || 'proxy') }
          : null,
        stale: !S.internals,
        hint: 'NSE allIndices: NIFTY 50 breadth, India VIX and midcap-vs-large-cap breadth, one call',
      },
    ];
    box.innerHTML = '';
    lanes.forEach(function (lane) {
      var st = lane.st !== undefined ? lane.st
        : (lane.id ? h[lane.id] : (S.feedsAlive ? { ok: true, note: S.feedsAlive + ' alive' } : null));
      var row = document.createElement('div');
      row.className = 'source-row';
      row.title = lane.hint + (st && st.note ? ' · ' + st.note : '');
      var k = document.createElement('span'); k.className = 'muted'; k.textContent = lane.k;
      var v = document.createElement('span');
      // A lane running on its workflow fallback is not "unavailable" - it has
      // data, just older data - so it reads "workflow" rather than red.
      var fallback = lane.stale && st && !st.ok;
      v.className = 'src-state ' + (st ? (st.ok ? 'up' : (fallback ? 'muted' : 'down')) : 'muted');
      v.textContent = st ? (st.ok ? 'live' : (fallback ? 'workflow' : 'unavailable')) : 'idle';
      row.appendChild(k); row.appendChild(v);
      box.appendChild(row);
    });
    text('lane-updated', fmt.clock(new Date()));
  }

  /* Optional: let a free model phrase the reasoning. It only ever rewrites the
     wording - direction, range and confidence stay as the engine computed. */
  function maybeEnrichNarrative() {
    if (!S.settings.key || !S.forecast) return;
    if (Date.now() - S.narrativeAt < 240000) return;
    S.narrativeAt = Date.now();

    var f = S.forecast;
    var top = data.getNews().slice(0, 12).map(function (n, i) {
      return (i + 1) + '. [' + n.impact + ' ' + (n.sentiment >= 0 ? '+' : '') + n.sentiment + '] ' + n.headline;
    }).join('\n');

    var user =
      'Index: ' + C.symbols[S.symbol].label + ' at ' + fmt.price(f.lastClose) + '.\n' +
      'Engine verdict (do not change these numbers): ' + f.direction + ', confidence ' + f.confidence +
      '%, expected range ' + f.rangeLow + ' to ' + f.rangeHigh + ' over ' + f.horizonLabel + '.\n' +
      'Lane scores (-1 to +1): ' + f.lanes.map(function (l) { return l.label + ' ' + l.score.toFixed(2); }).join(', ') + '.\n' +
      'Seasonal note: ' + (f.seasonMonth ? f.seasonMonth.name + ' averages ' + f.seasonMonth.avg + '% across ' + f.seasonMonth.n + ' years' : 'none') + '.\n' +
      'Recent headlines:\n' + top + '\n\n' +
      'Write 2 to 3 sentences explaining WHY the index leans this way, naming the specific news drivers. ' +
      'Plain English, no bullet points, no disclaimer, no restating the numbers.';

    data.askModel(S.settings.key, S.settings.model,
      'You are a concise Indian equity market analyst. You explain the reasoning behind a forecast that has already been computed. You never invent numbers and never contradict the verdict you are given.',
      user)
      .then(function (txt) {
        var clean = String(txt).replace(/^\s*["'`]+|["'`]+\s*$/g, '').trim();
        if (clean.length > 40) {
          text('fc-narrative', clean);
          S.forecast.narrative = clean;
        }
      })
      .catch(noop)
      /* renderLanes() runs earlier in the same pass than this call, so the
         Model lane was always showing the state from before the request. It
         read "idle" on a page that was already displaying the model's own
         sentence. Redraw once the answer - or the failure - is in. */
      .then(renderLanes);
  }

  KT.app = {
    state: S,
    refreshAll: refreshAll,
    recompute: recompute,
    onReasonClick: function (r) { if (r && r.url) window.open(r.url, '_blank', 'noopener'); },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.KT);
