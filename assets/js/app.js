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
  };

  /* ================================================================= BOOT */
  function boot() {
    loadSettings();
    applyTheme(core.store.get('theme', 'light'));
    wireUI();
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
          data.loadBaked(C.baked.index).then(function (i) { if (!S.feedsTotal) { S.feedsTotal = i.count; renderFeedCount(null); } }).catch(noop),
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
    ]).then(function () { renderNews(); });
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

  /* Recompute forecast + reasons from whatever we currently hold. */
  function recompute() {
    if (!S.candles.length) return;
    S.forecast = engine.buildForecast({
      candles: S.candles,
      news: data.getNews(),
      seasonality: S.seasonality,
      timeframe: S.timeframe,
      livePrice: S.quote && S.quote.price ? S.quote.price : null,
    });
    S.reasons = engine.buildReasons(S.candles, data.getNews(), S.timeframe);
    chart.setData(S.candles, S.forecast, S.reasons, S.timeframe);
    renderForecast(S.forecast);
    renderLanes();
    maybeEnrichNarrative();
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
    var items = data.getNews().filter(function (n) {
      switch (S.newsFilter) {
        case 'high':  return n.impact === 'high';
        case 'pos':   return n.sentiment > 0.6;
        case 'neg':   return n.sentiment < -0.6;
        case 'india': return n.region === 'indian';
        case 'world': return n.region === 'international';
        default:      return true;
      }
    }).slice(0, 120);

    if (!items.length) {
      list.innerHTML = '<li class="news-row"><span class="muted" style="grid-column:1/-1">' +
        (core.hasLexicon() ? 'No headlines match this filter yet.' : 'Loading feeds…') + '</span></li>';
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
    text('fc-weights-note', 'weights ' + Object.keys(C.forecast.weights).map(function (k) {
      return Math.round(C.forecast.weights[k] * 100) + '%';
    }).join(' / '));
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

  function renderLanes() {
    var box = el('source-lanes');
    if (!box) return;
    var h = data.health;
    var lanes = [
      { k: 'Live price', id: 'quote', hint: 'Moneycontrol price feed, read directly by your browser' },
      { k: 'Candles', id: 'candles', hint: 'Yahoo Finance OHLC through the proxy chain' },
      { k: 'Fast news', id: 'feed:mc_top', hint: C.directFeeds.length + ' CORS-friendly feeds every ' + Math.round(S.settings.newsMs / 1000) + 's' },
      { k: 'Deep news', id: null, hint: 'GitHub Actions fetches the full feed index every 5 minutes' },
      { k: 'Model', id: 'openrouter', hint: S.settings.key ? S.settings.model : 'no key set — using the local rule engine' },
    ];
    box.innerHTML = '';
    lanes.forEach(function (lane) {
      var st = lane.id ? h[lane.id] : (S.feedsAlive ? { ok: true, note: S.feedsAlive + ' alive' } : null);
      var row = document.createElement('div');
      row.className = 'source-row';
      row.title = lane.hint + (st && st.note ? ' · ' + st.note : '');
      var k = document.createElement('span'); k.className = 'muted'; k.textContent = lane.k;
      var v = document.createElement('span');
      v.className = 'src-state ' + (st ? (st.ok ? 'up' : 'down') : 'muted');
      v.textContent = st ? (st.ok ? 'live' : 'unavailable') : 'idle';
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
      .catch(noop);
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
