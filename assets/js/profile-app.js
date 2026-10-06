/* ============================================================================
   Profile page: the order book, the positions it adds up to, and what is
   happening to each stock in it.

   Everything the owner types is kept in this browser (orders.js). Everything
   the page reads about the stocks comes from the same free lanes the
   terminal uses - TradingView's screener for live prices, ratings and
   analyst targets, NSE through the proxy for deals, results dates and
   filings, the news stream for headlines and published broker calls - and
   each panel says which of those it is showing and when it last answered.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core, data = KT.data, fmt = core.fmt;
  var el = core.el, text = core.text;

  var S = {
    quotes: {}, quotesAt: null, quoteSource: null,
    side: 'BUY', editing: null,
    news: [], calls: [], deals: null, events: null, sast: null, insider: null,
    feedFilter: 'all', showClosed: false, book: null, typedQuote: null,
  };

  function esc(x) {
    return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function noop() {}
  function money(n) { return n == null || !isFinite(n) ? '—' : '₹' + fmt.price(n); }
  function moneySigned(n) {
    if (n == null || !isFinite(n)) return '—';
    return (n >= 0 ? '+' : '−') + '₹' + fmt.price(Math.abs(n));
  }
  function big(n) {
    // Lakh and crore once the number is large enough that digits stop reading.
    if (n == null || !isFinite(n)) return '—';
    var a = Math.abs(n), s = n < 0 ? '−' : '';
    if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(2) + ' Cr';
    if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(2) + ' L';
    return s + '₹' + fmt.price(a);
  }
  function bigSigned(n) { return n == null || !isFinite(n) ? '—' : (n >= 0 ? '+' : '') + big(n).replace(/^(?!−)/, ''); }

  /* ================================================================ BOOT */
  function boot() {
    applyTheme(core.store.get('theme', 'light'));
    KT.orders.load();
    KT.portfolio.load();
    wire();
    startClock();
    setDefaults();
    renderAll();

    data.loadBaked(C.baked.lexicon)
      .then(function (lex) { core.setLexicon(lex); })
      .catch(function () {
        core.setLexicon({ bullish: {}, bearish: {}, impact_high: [], impact_medium: [], relevance: [], noise: [], sector_map: {} });
      })
      .then(function () {
        return Promise.all([
          data.loadBaked(C.baked.universe).then(function (u) {
            KT.portfolio.setUniverse(u);
            KT.streetcalls.setUniverse(u.symbols || []);
            fillUniverse(u.symbols || []);
          }).catch(noop),
          data.loadBaked(C.baked.stocks).then(function (q) {
            KT.portfolio.setQuotes(q);
            mergeBakedQuotes();
          }).catch(noop),
          data.loadBaked(C.baked.news).then(function (n) {
            data.adoptBakedNews(n);
          }).catch(noop),
        ]);
      })
      .then(function () {
        S.news = data.getNews();
        buildCalls();
        renderAll();
        refreshQuotes();
        // The proxy lanes go last and one at a time: they share a public hop
        // that rate-limits, and none of them is needed to read the page.
        setTimeout(refreshExtras, 1200);
        data.fetchFastLane().then(function (items) {
          data.mergeNews(items);
          S.news = data.getNews();
          buildCalls();
          renderFeed();
        }).catch(noop);
      });

    setInterval(function () {
      var m = core.marketState();
      if (m.live || !S.quotesAt || Date.now() - S.quotesAt > 300000) refreshQuotes();
    }, 30000);
    setInterval(refreshExtras, 900000);
  }

  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode === 'dark' ? 'dark' : 'light');
  }

  function startClock() {
    function tick() {
      var ms = core.marketState();
      text('market-clock', fmt.clock(ms.ist) + ' IST');
      text('market-state', ms.label);
      var dot = el('market-dot');
      if (dot) dot.className = 'dot ' + (ms.state === 'live' ? 'live' : ms.state === 'pre' ? 'pre' : 'closed');
    }
    tick();
    setInterval(tick, 1000);
  }

  function setDefaults() {
    var d = el('of-date');
    if (d) { d.value = KT.orders.todayIso(); d.max = KT.orders.todayIso(); }
  }

  /* ============================================================== QUOTES

     TradingView first: one request for every symbol in the book, with the
     rating, the analyst consensus and the sector alongside the price. The
     workflow's stocks.json is the floor under it, and a symbol neither
     carries is held at cost and flagged rather than given a made-up price. */
  function symbolsInBook() {
    var seen = {}, list = [];
    KT.orders.all().forEach(function (o) {
      var k = o.exchange + ':' + o.symbol;
      if (seen[k]) return;
      seen[k] = 1;
      list.push({ symbol: o.symbol, exchange: o.exchange });
    });
    return list;
  }

  function mergeBakedQuotes() {
    var q = KT.portfolio.quotes() || {};
    Object.keys(q).forEach(function (k) {
      if (!S.quotes[k] || S.quotes[k].via !== 'tradingview') {
        S.quotes[k] = { price: q[k].price, prevClose: q[k].prevClose, changePct: q[k].changePct,
                        week52High: q[k].week52High, week52Low: q[k].week52Low, via: 'workflow' };
      }
    });
  }

  function refreshQuotes() {
    var list = symbolsInBook();
    if (!list.length) { renderAll(); return Promise.resolve(); }
    return data.getStockQuotes(list).then(function (got) {
      var n = 0;
      Object.keys(got).forEach(function (k) {
        var g = got[k];
        g.via = 'tradingview';
        g.prevClose = g.price != null && g.changePct != null ? g.price / (1 + g.changePct / 100) : null;
        S.quotes[k] = g;
        n++;
      });
      if (n) { S.quotesAt = Date.now(); S.quoteSource = 'TradingView, ' + (got[Object.keys(got)[0]].delay || 15) + ' min delayed'; }
      renderAll();
    }).catch(function () { renderAll(); });
  }

  /* ============================================================== EXTRAS */
  function refreshExtras() {
    var chain = Promise.resolve();
    [['events', data.getEventCalendar], ['deals', data.getLargeDeals],
     ['sast', function () { return data.getSast(14); }], ['insider', data.getInsiderFilings]].forEach(function (pair) {
      chain = chain.then(function () {
        return pair[1]().then(function (r) { if (r) S[pair[0]] = r; renderAll(); }).catch(noop);
      });
    });
    return chain;
  }

  function buildCalls() {
    try {
      var calls = KT.streetcalls.extract(S.news || [], { limit: 400 });
      S.calls = KT.streetcalls.track(calls, S.quotes);
    } catch (e) { S.calls = []; }
  }

  /* ============================================================== RENDER */
  function renderAll() {
    var b = KT.orders.book(S.quotes);
    S.book = b;
    renderHero(b);
    renderKpis(b);
    renderPositions(b);
    renderOrders();
    renderClosed(b);
    renderAlloc(b);
    renderAlerts(b);
    renderFeed();
  }

  function renderHero(b) {
    var p = KT.orders.profile() || {};
    text('pf-name', p.name ? p.name + '’s portfolio' : 'Your profile');
    var bits = [];
    if (p.style) bits.push(p.style);
    if (p.horizon) bits.push('usual horizon: ' + p.horizon.toLowerCase());
    if (p.broker) bits.push('trades through ' + p.broker);
    bits.push(KT.orders.count() + ' order' + (KT.orders.count() === 1 ? '' : 's') + ' recorded');
    if (p.since) bits.push('profile since ' + p.since);
    text('pf-who-sub', bits.join(' · ') + '. Stored in this browser only.');
    var av = el('pf-avatar');
    if (av) av.textContent = (p.name || '?').trim().charAt(0).toUpperCase() || '?';

    var top = el('pf-topstats');
    if (top) {
      top.innerHTML = b.openCount
        ? '<span><em>Value</em> <b class="num">' + esc(big(b.current)) + '</b></span>' +
          '<span><em>Today</em> <b class="num ' + fmt.cls(b.dayChange) + '">' + esc(moneySigned(b.dayChange)) + '</b></span>' +
          '<span><em>Total P&amp;L</em> <b class="num ' + fmt.cls(b.totalPnl) + '">' + esc(moneySigned(b.totalPnl)) + '</b></span>'
        : '';
    }
  }

  function setKpi(id, value, cls, sub, subCls) {
    var v = el(id);
    if (v) { v.textContent = value; v.className = 'kpi-v num ' + (cls || ''); }
    if (sub !== undefined) {
      var s = el(id + '-s');
      if (s) { s.textContent = sub; s.className = 'kpi-s ' + (subCls || ''); }
    }
  }

  function renderKpis(b) {
    if (!KT.orders.count()) {
      ['k-current', 'k-invested', 'k-unreal', 'k-real', 'k-day', 'k-xirr'].forEach(function (id) { setKpi(id, '—'); });
      return;
    }
    setKpi('k-current', big(b.current), '', b.openCount + ' open position' + (b.openCount === 1 ? '' : 's') +
           (b.unpriced ? ' · ' + b.unpriced + ' held at cost (no price)' : ''));
    setKpi('k-invested', big(b.invested), '', 'cost of what is still open');
    setKpi('k-unreal', bigSigned(b.unrealised), fmt.cls(b.unrealised),
           b.unrealisedPct == null ? '—' : fmt.pct(b.unrealisedPct), fmt.cls(b.unrealisedPct));
    setKpi('k-real', bigSigned(b.netRealised), fmt.cls(b.netRealised),
           'after ' + money(b.charges) + ' charges · ' + b.closed.length + ' closed lot' + (b.closed.length === 1 ? '' : 's') +
           (b.winRate != null ? ' · ' + b.winRate.toFixed(0) + '% won' : ''));
    setKpi('k-day', bigSigned(b.dayChange), fmt.cls(b.dayChange),
           S.quoteSource ? S.quoteSource : 'workflow prices');
    setKpi('k-xirr', b.xirr == null ? '—' : fmt.pct(b.xirr, 1), b.xirr == null ? '' : fmt.cls(b.xirr),
           b.xirr == null ? 'needs a month of history' : 'annualised, on the money put in');
  }

  /* --------------------------------------------------------------- signals */
  function techLabel(r) {
    if (r == null || !isFinite(r)) return null;
    if (r >= 0.5) return { t: 'Strong buy', c: 'up' };
    if (r >= 0.1) return { t: 'Buy', c: 'up' };
    if (r > -0.1) return { t: 'Neutral', c: 'flat' };
    if (r > -0.5) return { t: 'Sell', c: 'down' };
    return { t: 'Strong sell', c: 'down' };
  }
  function analystLabel(m) {
    if (m == null || !isFinite(m)) return null;
    if (m <= 1.5) return { t: 'Strong buy', c: 'up' };
    if (m <= 2.5) return { t: 'Buy', c: 'up' };
    if (m <= 3.5) return { t: 'Hold', c: 'flat' };
    if (m <= 4.5) return { t: 'Sell', c: 'down' };
    return { t: 'Strong sell', c: 'down' };
  }
  function nextEvent(sym) {
    var ev = S.events && S.events.rows;
    if (!ev) return null;
    var now = Date.now() / 1000 - 86400;
    for (var i = 0; i < ev.length; i++) if (ev[i].symbol === sym && (ev[i].ts || 0) >= now) return ev[i];
    return null;
  }
  function callsFor(sym) {
    return (S.calls || []).filter(function (c) { return c.stocks.indexOf(sym) !== -1; });
  }
  function dealsFor(sym) {
    return ((S.deals && S.deals.rows) || []).filter(function (d) { return d.symbol === sym; });
  }
  function filingsFor(sym) {
    var a = ((S.sast && S.sast.rows) || []).filter(function (r) { return r.symbol === sym; })
      .map(function (r) { r.kind = 'sast'; return r; });
    var b = ((S.insider && S.insider.rows) || []).filter(function (r) { return r.symbol === sym; })
      .map(function (r) { r.kind = 'pit'; return r; });
    return a.concat(b);
  }

  function signalsHtml(p) {
    var q = S.quotes[p.symbol] || {};
    var chips = [];
    var t = techLabel(q.techRating);
    if (t) chips.push('<span class="sig ' + t.c + '" title="TradingView technical rating: moving averages and oscillators combined">Tech ' + esc(t.t) + '</span>');
    var a = analystLabel(q.analystMark);
    if (a && q.analysts) {
      chips.push('<span class="sig ' + a.c + '" title="Consensus of ' + q.analysts + ' analysts (FactSet, via TradingView)' +
                 (q.targetAvg ? '; average target ' + fmt.price(q.targetAvg) : '') + '">' + q.analysts + ' analysts: ' + esc(a.t) +
                 (q.upsidePct != null ? ' · ' + fmt.pct(q.upsidePct, 0) : '') + '</span>');
    }
    var ev = nextEvent(p.symbol);
    if (ev) chips.push('<span class="sig warn" title="' + esc(ev.desc || ev.purpose) + '">' + esc(ev.results ? 'Results ' : 'Board ') + esc(core.fmt.dayShort(ev.ts)) + '</span>');
    var cs = callsFor(p.symbol);
    if (cs.length) {
      var buys = cs.filter(function (c) { return c.rating === 'buy'; }).length;
      chips.push('<span class="sig ' + (buys >= cs.length - buys ? 'up' : 'down') + '" title="Published broker and analyst calls in the news stream">' +
                 cs.length + ' call' + (cs.length === 1 ? '' : 's') + '</span>');
    }
    var ds = dealsFor(p.symbol);
    if (ds.length) chips.push('<span class="sig brand" title="Bulk / block deals reported by NSE">' + ds.length + ' big deal' + (ds.length === 1 ? '' : 's') + '</span>');
    var fl = filingsFor(p.symbol);
    if (fl.length) chips.push('<span class="sig brand" title="Insider-trading and takeover-code filings">' + fl.length + ' filing' + (fl.length === 1 ? '' : 's') + '</span>');
    var m = p.meta || {};
    if (m.target) chips.push('<span class="sig" title="Your target">T ' + fmt.price(m.target) + '</span>');
    if (m.stop) chips.push('<span class="sig" title="Your stop">SL ' + fmt.price(m.stop) + '</span>');
    return chips.join('');
  }

  function renderPositions(b) {
    var body = el('pos-rows');
    if (!body) return;
    var list = b.positions.filter(function (p) { return p.open || S.showClosed; });
    el('pos-empty').classList.toggle('hidden', KT.orders.count() > 0);
    text('pos-note', b.openCount ? b.openCount + ' open · ' +
      (S.quoteSource || 'prices from the workflow file') +
      (S.quotesAt ? ' · ' + core.fmt.timeShort(Math.floor(S.quotesAt / 1000)) : '') : '—');
    body.innerHTML = list.map(function (p) {
      var q = S.quotes[p.symbol] || {};
      var name = (KT.portfolio.nameFor && KT.portfolio.nameFor(p.symbol)) || q.name || p.symbol;
      var dayTxt = p.dayPct != null ? '<small class="' + fmt.cls(p.dayPct) + '">' + fmt.pct(p.dayPct) + '</small>' : '';
      return '<tr class="' + (p.open ? '' : 'is-closed') + '" data-sym="' + esc(p.symbol) + '">' +
        '<td class="pf-stock"><b>' + esc(p.symbol) + '</b>' + (p.short ? ' <span class="sig down">short</span>' : '') +
          '<small>' + esc(name) + (q.sector ? ' · ' + esc(q.sector) : '') + (p.heldDays != null && p.open ? ' · held ' + p.heldDays + 'd' : '') + '</small></td>' +
        '<td class="num">' + (p.open ? fmt.count(p.qty) : '—') + '</td>' +
        '<td class="num">' + (p.avgPrice != null ? fmt.price(p.avgPrice) : '—') + '</td>' +
        '<td class="num">' + (p.ltp != null ? fmt.price(p.ltp) : '<span class="muted" title="No live or workflow price for this symbol; valued at cost">at cost</span>') + dayTxt + '</td>' +
        '<td class="num">' + (p.value != null ? big(p.value) : (p.open ? big(p.invested) : '—')) + '</td>' +
        '<td class="num ' + fmt.cls(p.unrealised) + '">' + (p.unrealised != null && p.open ? moneySigned(p.unrealised) +
          '<small>' + fmt.pct(p.unrealisedPct) + '</small>' : '—') + '</td>' +
        '<td class="num ' + fmt.cls(p.realised) + '">' + (p.realised ? moneySigned(p.realised) : '—') + '</td>' +
        '<td class="num">' + (p.weightPct != null ? p.weightPct.toFixed(1) + '%' : '—') + '</td>' +
        '<td class="pf-sigs">' + signalsHtml(p) + '</td>' +
        '<td><button class="btn btn-sm" data-detail="' + esc(p.symbol) + '">Open</button></td>' +
      '</tr>';
    }).join('');
  }

  function renderOrders() {
    var body = el('orders-rows');
    if (!body) return;
    var f = (el('orders-filter') && el('orders-filter').value || '').trim().toUpperCase();
    var list = KT.orders.all().reverse().filter(function (o) {
      return !f || o.symbol.indexOf(f) !== -1 || String(o.tag || '').toUpperCase().indexOf(f) !== -1;
    });
    text('orders-note', KT.orders.count() + ' order' + (KT.orders.count() === 1 ? '' : 's') +
         (f ? ' · ' + list.length + ' shown' : ''));
    body.innerHTML = list.map(function (o) {
      return '<tr>' +
        '<td class="num">' + esc(o.date) + (o.time ? ' <small>' + esc(o.time) + '</small>' : '') + '</td>' +
        '<td><b>' + esc(o.symbol) + '</b> <small>' + esc(o.exchange) + '</small></td>' +
        '<td><span class="side-pill ' + (o.side === 'BUY' ? 'buy' : 'sell') + '">' + o.side + '</span></td>' +
        '<td class="num">' + fmt.count(o.qty) + '</td>' +
        '<td class="num">' + fmt.price(o.price) + '</td>' +
        '<td class="num">' + big(o.qty * o.price) + '</td>' +
        '<td class="num">' + (o.charges ? fmt.price(o.charges) : '—') + '</td>' +
        '<td>' + (o.product === 'MIS' ? 'Intraday' : 'Delivery') + '</td>' +
        '<td class="pf-note">' + (o.tag ? '<span class="sig">' + esc(o.tag) + '</span> ' : '') + esc(o.note || '') + '</td>' +
        '<td class="pf-row-actions"><button class="btn btn-sm" data-edit="' + esc(o.id) + '">Edit</button>' +
        '<button class="btn btn-sm" data-del="' + esc(o.id) + '" title="Delete this order">&times;</button></td>' +
      '</tr>';
    }).join('');
  }

  function renderClosed(b) {
    var body = el('closed-rows');
    if (!body) return;
    var won = b.closed.filter(function (c) { return c.pnl > 0; }).length;
    text('closed-note', b.closed.length ? b.closed.length + ' closed lot' + (b.closed.length === 1 ? '' : 's') + ' · ' +
         won + ' won · gross ' + moneySigned(b.realised) : 'nothing sold yet');
    body.innerHTML = b.closed.map(function (c) {
      return '<tr>' +
        '<td><b>' + esc(c.symbol) + '</b></td>' +
        '<td>' + (c.side === 'short' ? 'Short' : 'Long') + '</td>' +
        '<td class="num">' + fmt.count(c.qty) + '</td>' +
        '<td class="num">' + esc(c.openDate) + '</td>' +
        '<td class="num">' + esc(c.closeDate) + '</td>' +
        '<td class="num">' + fmt.price(c.openPrice) + '</td>' +
        '<td class="num">' + fmt.price(c.closePrice) + '</td>' +
        '<td class="num ' + fmt.cls(c.pnl) + '">' + moneySigned(c.pnl) + '<small>' + fmt.pct(c.pnlPct) + '</small></td>' +
        '<td class="num">' + c.days + '</td>' +
        '<td>' + esc(c.term) + '</td>' +
      '</tr>';
    }).join('');
  }

  function barRows(rows) {
    return rows.map(function (r) {
      return '<div class="alloc-row" title="' + esc(r.title || '') + '"><span class="alloc-k">' + esc(r.k) + '</span>' +
        '<span class="alloc-bar"><span style="width:' + Math.max(1, Math.min(100, r.pct)).toFixed(1) + '%" class="' + (r.cls || '') + '"></span></span>' +
        '<span class="alloc-v num">' + r.pct.toFixed(1) + '%</span></div>';
    }).join('');
  }

  function renderAlloc(b) {
    var open = b.open || [];
    text('alloc-note', open.length ? 'by current value' : '—');
    var top = open.slice(0, 8).map(function (p) {
      return { k: p.symbol, pct: p.weightPct || 0, cls: p.short ? 'short' : '',
               title: p.symbol + ' ' + big(p.value != null ? p.value : p.invested) };
    });
    var rest = open.slice(8).reduce(function (s, p) { return s + (p.weightPct || 0); }, 0);
    if (rest > 0) top.push({ k: open.length - 8 + ' others', pct: rest });
    var host = el('alloc-stocks');
    if (host) host.innerHTML = top.length ? barRows(top) : '<p class="fine">Nothing open.</p>';
    var sec = el('alloc-sectors');
    if (sec) sec.innerHTML = (b.sectors || []).length
      ? barRows(b.sectors.slice(0, 8).map(function (s) { return { k: s.sector, pct: s.pct, title: big(s.value) }; }))
      : '<p class="fine">Sectors appear once live prices load.</p>';
  }

  /* -------------------------------------------------------------- alerts */
  var DISMISS_KEY = 'pfAlertsDismissed';
  function renderAlerts(b) {
    var host = el('pf-alerts');
    if (!host) return;
    var dismissed = core.store.get(DISMISS_KEY, {}) || {};
    var list = KT.orders.alertsFor(b);
    try {
      var scan = KT.portfolio.scan(S.news || []);
      (scan.alerts || []).slice(0, 12).forEach(function (a) {
        if (a.kind === 'news' || a.kind === 'filing') {
          list.push({ key: a.key, symbol: a.symbol, kind: 'news', severity: a.severity,
                      text: a.headline, source: a.source, url: a.url, ts: a.ts });
        }
      });
    } catch (e) { /* matching needs the universe; it arrives shortly */ }
    list = list.filter(function (a) { return !dismissed[a.key]; });
    text('alerts-note', list.length ? list.length + ' open' : 'none');
    host.innerHTML = list.length ? list.map(function (a) {
      return '<li class="feed-item sev-' + esc(a.severity || 'medium') + '">' +
        '<span class="feed-kind ' + esc(a.kind) + '">' + esc(a.kind) + '</span>' +
        '<span class="feed-text"><b>' + esc(a.symbol) + '</b> ' +
          (a.url ? '<a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.text) + '</a>' : esc(a.text)) +
          (a.source ? ' <small>' + esc(a.source) + '</small>' : '') + '</span>' +
        '<button class="feed-x" data-dismiss="' + esc(a.key) + '" aria-label="Dismiss">&times;</button></li>';
    }).join('') : '<li class="fine">Set a target or a stop on a position (Open → levels) and an alert fires here when price reaches it. Big moves, 52-week extremes and high-impact headlines on your stocks show up too.</li>';
  }

  /* ---------------------------------------------------------------- feed */
  function feedItems() {
    var held = {};
    (S.book ? S.book.open : []).forEach(function (p) { held[p.symbol] = 1; });
    var syms = Object.keys(held);
    var out = [];
    if (!syms.length) return out;
    try {
      KT.portfolio.relatedNews(S.news || [], 60).forEach(function (m) {
        out.push({ kind: 'news', ts: m.item.ts, symbol: m.symbol, text: m.item.headline, url: m.item.url,
                   source: m.item.source, tone: m.item.sentiment });
      });
    } catch (e) { /* matching needs the universe */ }
    (S.calls || []).forEach(function (c) {
      c.stocks.forEach(function (s) {
        if (!held[s]) return;
        var tr = (c.track || []).filter(function (t) { return t.symbol === s; })[0];
        out.push({ kind: 'call', ts: c.ts, symbol: s,
                   text: (c.broker ? c.broker + ': ' : '') + c.rating.toUpperCase() +
                         (c.target ? ', target ' + fmt.price(c.target) : '') +
                         (tr && tr.toTargetPct != null ? ' (' + fmt.pct(tr.toTargetPct, 1) + ' from here)' : '') + ' — ' + c.headline,
                   url: c.url, source: c.source, tone: c.rating === 'sell' ? -1 : c.rating === 'buy' ? 1 : 0 });
      });
    });
    ((S.deals && S.deals.rows) || []).forEach(function (d) {
      if (!held[d.symbol]) return;
      out.push({ kind: 'deal', ts: d.ts, symbol: d.symbol,
                 text: d.kind + ' deal: ' + d.client + ' ' + (d.side === 'BUY' ? 'bought ' : 'sold ') + fmt.count(d.qty) +
                       ' at ' + fmt.price(d.price) + (d.valueCr != null ? ' (₹' + fmt.price(d.valueCr) + ' Cr)' : ''),
                 source: 'NSE ' + d.kind + ' deals', tone: d.side === 'BUY' ? 1 : -1 });
    });
    ((S.events && S.events.rows) || []).forEach(function (e) {
      if (!held[e.symbol] || (e.ts || 0) < Date.now() / 1000 - 86400) return;
      out.push({ kind: 'event', ts: e.ts, symbol: e.symbol, upcoming: true,
                 text: (e.results ? 'Results / board meeting on ' : 'Board meeting on ') + e.date + ': ' + (e.desc || e.purpose),
                 source: 'NSE event calendar', tone: 0 });
    });
    syms.forEach(function (s) {
      filingsFor(s).forEach(function (r) {
        out.push({ kind: 'filing', ts: r.ts, symbol: s, url: r.link,
                   text: r.kind === 'sast'
                     ? (r.promoter ? 'Promoter ' : '') + r.who + ' ' + (r.side === 'BUY' ? 'acquired ' : 'sold ') +
                       (r.pct != null ? r.pct + '%' : fmt.count(r.shares) + ' shares') + (r.afterPct != null ? ', now holds ' + r.afterPct + '%' : '') +
                       ' (' + (r.mode || 'mode not stated') + ')'
                     : 'Insider-trading disclosure filed (' + (r.reg || 'PIT') + ', ' + (r.type || 'original') + ')',
                   source: r.kind === 'sast' ? 'NSE SAST filings' : 'NSE insider filings', tone: r.side === 'SELL' ? -1 : 0 });
      });
    });
    out.sort(function (a, b) {
      if (!!a.upcoming !== !!b.upcoming) return a.upcoming ? -1 : 1;
      return a.upcoming ? (a.ts || 0) - (b.ts || 0) : (b.ts || 0) - (a.ts || 0);
    });
    return out;
  }

  function renderFeed() {
    var host = el('pf-feed');
    if (!host) return;
    var items = feedItems();
    var f = S.feedFilter;
    var shown = items.filter(function (x) { return f === 'all' || x.kind === f; }).slice(0, 80);
    text('feed-note', items.length ? items.length + ' items' : '—');
    host.innerHTML = shown.length ? shown.map(function (x) {
      var when = x.ts ? (x.upcoming ? core.fmt.dayShort(x.ts) : core.fmt.ago(x.ts)) : '';
      return '<li class="feed-item">' +
        '<span class="feed-kind ' + esc(x.kind) + '">' + esc(x.kind === 'event' ? 'results' : x.kind === 'filing' ? 'insider' : x.kind) + '</span>' +
        '<span class="feed-text"><b>' + esc(x.symbol) + '</b> ' +
          (x.url ? '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.text) + '</a>' : esc(x.text)) +
          '<small>' + esc(x.source || '') + (when ? ' · ' + esc(when) : '') + '</small></span>' +
        '<span class="feed-tone ' + (x.tone > 0 ? 'up' : x.tone < 0 ? 'down' : '') + '"></span></li>';
    }).join('') : '<li class="fine">' + (S.book && S.book.open.length
        ? 'Nothing yet for your stocks in the lanes that have answered. Results dates, deals and filings load through the NSE proxy a few seconds after the page.'
        : 'Add a position and this fills with the news, published broker calls, bulk and block deals, results dates and insider filings that touch it.') + '</li>';
    var src = [];
    src.push((S.news || []).length + ' headlines');
    src.push((S.calls || []).length + ' broker calls parsed');
    src.push(S.deals ? (S.deals.rows.length + ' deals (' + (S.deals.asOn || 'today') + ')') : 'deals not loaded');
    src.push(S.events ? S.events.rows.length + ' calendar rows' : 'calendar not loaded');
    src.push(S.sast ? S.sast.rows.length + ' SAST filings' : 'SAST not loaded');
    text('feed-sources', 'Read: ' + src.join(' · ') + '. Calls are parsed from published headlines and are not advice; deals, results dates and filings come from NSE.');
  }

  /* =============================================================== DETAIL */
  function openDetail(sym) {
    var b = S.book || KT.orders.book(S.quotes);
    var p = b.positions.filter(function (x) { return x.symbol === sym; })[0];
    if (!p) return;
    var q = S.quotes[sym] || {};
    var name = (KT.portfolio.nameFor && KT.portfolio.nameFor(sym)) || q.name || sym;
    text('detail-title', sym + ' · ' + name);
    var m = p.meta || {};
    var h = [];

    // headline numbers
    h.push('<div class="dt-top">' +
      kv('Price', p.ltp != null ? fmt.price(p.ltp) + (p.dayPct != null ? ' <small class="' + fmt.cls(p.dayPct) + '">' + fmt.pct(p.dayPct) + '</small>' : '') : 'no price') +
      kv('Position', p.open ? fmt.count(p.qty) + ' @ ' + fmt.price(p.avgPrice) : 'closed') +
      kv('Unrealised', p.unrealised != null && p.open ? '<span class="' + fmt.cls(p.unrealised) + '">' + moneySigned(p.unrealised) + ' (' + fmt.pct(p.unrealisedPct) + ')</span>' : '—') +
      kv('Realised', '<span class="' + fmt.cls(p.realised) + '">' + moneySigned(p.realised) + '</span>') +
      kv('52 week', q.week52Low && q.week52High ? fmt.price(q.week52Low) + ' – ' + fmt.price(q.week52High) : '—') +
      kv('P/E · M.cap', (q.pe ? q.pe.toFixed(1) : '—') + ' · ' + (q.marketCapCr ? fmt.crore(q.marketCapCr) : '—')) +
    '</div>');

    // the owner's levels
    h.push('<h3 class="pf-sub">Your levels</h3><form class="dt-levels" id="levels-form" data-sym="' + esc(sym) + '">' +
      '<div class="field"><label>Target</label><input type="number" step="any" min="0" name="target" value="' + (m.target || '') + '" /></div>' +
      '<div class="field"><label>Stop-loss</label><input type="number" step="any" min="0" name="stop" value="' + (m.stop || '') + '" /></div>' +
      '<div class="field f-note"><label>Why you hold it</label><input name="thesis" maxlength="300" value="' + esc(m.thesis || '') + '" /></div>' +
      '<div class="field"><label>&nbsp;</label><button class="btn btn-primary" type="submit">Save levels</button></div></form>');

    // analyst consensus with a range bar
    if (q.analysts && q.targetLow && q.targetHigh) {
      var lo = Math.min(q.targetLow, q.price || q.targetLow), hi = Math.max(q.targetHigh, q.price || q.targetHigh);
      var pos = function (v) { return ((v - lo) / (hi - lo || 1) * 100).toFixed(1); };
      var al = analystLabel(q.analystMark);
      h.push('<h3 class="pf-sub">Analyst consensus <small>' + q.analysts + ' analysts, FactSet via TradingView</small></h3>' +
        '<div class="tgt-bar"><span class="tgt-range" style="left:' + pos(q.targetLow) + '%;right:' + (100 - pos(q.targetHigh)) + '%"></span>' +
        '<span class="tgt-mark avg" style="left:' + pos(q.targetAvg) + '%" title="average target"></span>' +
        (q.price ? '<span class="tgt-mark now" style="left:' + pos(q.price) + '%" title="price now"></span>' : '') + '</div>' +
        '<div class="tgt-legend"><span>low ' + fmt.price(q.targetLow) + '</span><span><b>avg ' + fmt.price(q.targetAvg) + '</b>' +
        (q.upsidePct != null ? ' (' + fmt.pct(q.upsidePct, 1) + ')' : '') + '</span><span>high ' + fmt.price(q.targetHigh) + '</span></div>' +
        '<p class="fine">Consensus rating: <b class="' + (al ? al.c : '') + '">' + esc(al ? al.t : '—') + '</b>. ' +
        'Technical rating: <b>' + esc((techLabel(q.techRating) || {}).t || '—') + '</b>' +
        (q.rsi ? ', RSI ' + q.rsi.toFixed(0) : '') + (q.perf1M != null ? ', 1 month ' + fmt.pct(q.perf1M, 1) : '') +
        '. These are other people’s published views, shown with their sources, not a recommendation.</p>');
    }

    // lots
    if (p.lots.length) {
      h.push('<h3 class="pf-sub">Open lots <small>first in, first out</small></h3><table class="pf-table mini"><thead><tr><th>Bought</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Held</th><th class="num">P&amp;L now</th></tr></thead><tbody>' +
        p.lots.map(function (l) {
          var pl = p.ltp != null ? (p.ltp - l.price) * l.qty : null;
          return '<tr><td>' + esc(l.date) + '</td><td class="num">' + fmt.count(l.qty) + '</td><td class="num">' + fmt.price(l.price) +
                 '</td><td class="num">' + l.days + 'd' + (l.days >= 365 ? ' <small>LT</small>' : '') + '</td><td class="num ' + fmt.cls(pl) + '">' + (pl != null ? moneySigned(pl) : '—') + '</td></tr>';
        }).join('') + '</tbody></table>');
    }

    // calls, deals, filings, events
    var cs = callsFor(sym);
    if (cs.length) {
      h.push('<h3 class="pf-sub">Published calls <small>parsed from headlines, tracked from when this page first saw them</small></h3><ul class="pf-feed">' +
        cs.slice(0, 12).map(function (c) {
          var tr = (c.track || []).filter(function (t) { return t.symbol === sym; })[0] || {};
          return '<li class="feed-item"><span class="feed-kind call">' + esc(c.rating) + '</span><span class="feed-text">' +
            (c.url ? '<a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.headline) + '</a>' : esc(c.headline)) +
            '<small>' + esc(c.source || '') + (c.ts ? ' · ' + esc(core.fmt.ago(c.ts)) : '') +
            (tr.withCallPct != null ? ' · since first seen ' + fmt.pct(tr.withCallPct, 1) + ' the way of the call' : '') +
            (tr.toTargetPct != null ? ' · target ' + fmt.pct(tr.toTargetPct, 1) + ' away' : '') + '</small></span></li>';
        }).join('') + '</ul>');
    }
    var ds = dealsFor(sym);
    if (ds.length) {
      h.push('<h3 class="pf-sub">Bulk and block deals</h3><ul class="pf-feed">' + ds.map(function (d) {
        return '<li class="feed-item"><span class="feed-kind deal">' + esc(d.kind) + '</span><span class="feed-text">' + esc(d.client) + ' ' +
          (d.side === 'BUY' ? 'bought' : 'sold') + ' ' + fmt.count(d.qty) + ' at ' + fmt.price(d.price) +
          (d.valueCr != null ? ' · ₹' + fmt.price(d.valueCr) + ' Cr' : '') + '<small>' + esc(d.date || '') + '</small></span></li>';
      }).join('') + '</ul>');
    }
    var fl = filingsFor(sym);
    if (fl.length) {
      h.push('<h3 class="pf-sub">Insider and takeover-code filings</h3><ul class="pf-feed">' + fl.slice(0, 12).map(function (r) {
        var t = r.kind === 'sast'
          ? (r.promoter ? 'Promoter ' : '') + esc(r.who) + ' ' + (r.side === 'BUY' ? 'acquired' : 'sold') + ' ' +
            (r.pct != null ? r.pct + '%' : fmt.count(r.shares) + ' shares') + (r.afterPct != null ? ', now ' + r.afterPct + '%' : '')
          : 'Insider-trading disclosure (' + esc(r.reg || 'PIT') + ')';
        return '<li class="feed-item"><span class="feed-kind filing">' + (r.kind === 'sast' ? 'SAST' : 'PIT') + '</span><span class="feed-text">' +
          (r.link ? '<a href="' + esc(r.link) + '" target="_blank" rel="noopener">' + t + '</a>' : t) +
          '<small>' + esc(r.filed || '') + '</small></span></li>';
      }).join('') + '</ul>');
    }
    var news = [];
    try { news = KT.portfolio.relatedNews(S.news || [], 200).filter(function (x) { return x.symbol === sym; }).slice(0, 10); } catch (e) {}
    if (news.length) {
      h.push('<h3 class="pf-sub">Headlines</h3><ul class="pf-feed">' + news.map(function (x) {
        return '<li class="feed-item"><span class="feed-kind news">news</span><span class="feed-text">' +
          (x.item.url ? '<a href="' + esc(x.item.url) + '" target="_blank" rel="noopener">' + esc(x.item.headline) + '</a>' : esc(x.item.headline)) +
          '<small>' + esc(x.item.source || '') + ' · ' + esc(core.fmt.ago(x.item.ts)) + '</small></span>' +
          '<span class="feed-tone ' + (x.item.sentiment > 0 ? 'up' : x.item.sentiment < 0 ? 'down' : '') + '"></span></li>';
      }).join('') + '</ul>');
    }
    var ev = nextEvent(sym);
    if (ev) h.push('<p class="notice info">Next on the exchange calendar: <b>' + esc(ev.date) + '</b> — ' + esc(ev.desc || ev.purpose) + '</p>');

    el('detail-body').innerHTML = h.join('');
    el('detail-modal').classList.remove('hidden');
    var lf = el('levels-form');
    if (lf) lf.addEventListener('submit', function (e) {
      e.preventDefault();
      KT.orders.setMeta(sym, { target: lf.elements.target.value, stop: lf.elements.stop.value, thesis: lf.elements.thesis.value });
      KT.portfolio.reload && KT.portfolio.reload();
      renderAll();
      el('detail-modal').classList.add('hidden');
    });
  }
  function kv(k, v) { return '<div class="dt-kv"><span>' + esc(k) + '</span><b class="num">' + v + '</b></div>'; }

  /* ================================================================ FORM */
  function fillUniverse(list) {
    var dl = el('of-universe');
    if (!dl || dl.options.length) return;
    var frag = document.createDocumentFragment();
    list.forEach(function (r) {
      var o = document.createElement('option');
      o.value = r.symbol; o.label = r.name || r.symbol;
      frag.appendChild(o);
    });
    dl.appendChild(frag);
  }

  function setSide(side) {
    S.side = side === 'SELL' ? 'SELL' : 'BUY';
    document.querySelectorAll('.side-btn').forEach(function (b) {
      var on = b.getAttribute('data-side') === S.side;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    var form = el('order-form');
    if (form) form.classList.toggle('is-sell', S.side === 'SELL');
    updateTotal();
  }

  function updateTotal() {
    var q = parseFloat(el('of-qty').value), p = parseFloat(el('of-price').value), c = parseFloat(el('of-charges').value) || 0;
    var t = el('of-total');
    if (!t) return;
    if (!(q > 0 && p > 0)) { t.textContent = '—'; return; }
    var gross = q * p;
    t.textContent = (S.side === 'BUY' ? 'You pay ' : 'You receive ') + money(S.side === 'BUY' ? gross + c : gross - c);
    // Selling more than is held opens a short; say so before it is saved.
    var sym = KT.orders.cleanSymbol(el('of-symbol').value);
    if (S.side === 'SELL' && sym && S.book && !S.editing) {
      var p0 = S.book.positions.filter(function (x) { return x.symbol === sym && x.open && x.qty > 0; })[0];
      var held = p0 ? p0.qty : 0;
      text('order-error', q > held
        ? (held ? 'You hold ' + fmt.count(held) + '. The other ' + fmt.count(q - held) + ' will be recorded as a short position.'
                : 'You hold none of this. The sale will be recorded as a short position.')
        : '');
    }
  }

  var lookupTimer = null;
  function onSymbolInput() {
    var sym = KT.orders.cleanSymbol(el('of-symbol').value);
    var name = sym && KT.portfolio.nameFor ? KT.portfolio.nameFor(sym) : null;
    text('of-name', name || (sym ? 'not in the NSE list — check the symbol' : ' '));
    var q = S.quotes[sym];
    text('of-ltp', q && q.price != null ? 'last ' + fmt.price(q.price) + (q.changePct != null ? ' (' + fmt.pct(q.changePct) + ')' : '') : ' ');
    clearTimeout(lookupTimer);
    if (!sym || sym.length < 2 || !name) return;
    lookupTimer = setTimeout(function () {
      data.getStockQuotes([{ symbol: sym, exchange: el('of-exchange').value }]).then(function (got) {
        if (got[sym]) {
          got[sym].via = 'tradingview';
          got[sym].prevClose = got[sym].changePct != null ? got[sym].price / (1 + got[sym].changePct / 100) : null;
          S.quotes[sym] = got[sym];
          if (KT.orders.cleanSymbol(el('of-symbol').value) === sym) {
            text('of-ltp', 'last ' + fmt.price(got[sym].price) + ' (' + fmt.pct(got[sym].changePct) + ', ' + (got[sym].delay || 15) + ' min delayed)');
          }
        }
      });
    }, 350);
    updateTotal();
  }

  function resetForm() {
    S.editing = null;
    ['of-symbol', 'of-qty', 'of-price', 'of-charges', 'of-tag', 'of-note', 'of-time'].forEach(function (id) { var e = el(id); if (e) e.value = ''; });
    el('of-date').value = KT.orders.todayIso();
    text('of-name', ' '); text('of-ltp', ' ');
    text('order-title', 'Record a buy or a sell');
    text('btn-order-save', 'Add order');
    el('btn-order-cancel').classList.add('hidden');
    setSide('BUY');
  }

  function editOrder(id) {
    var o = KT.orders.all().filter(function (x) { return x.id === id; })[0];
    if (!o) return;
    S.editing = id;
    el('of-symbol').value = o.symbol; el('of-exchange').value = o.exchange;
    el('of-qty').value = o.qty; el('of-price').value = o.price; el('of-charges').value = o.charges || '';
    el('of-date').value = o.date; el('of-time').value = o.time || '';
    el('of-product').value = o.product; el('of-tag').value = o.tag || ''; el('of-note').value = o.note || '';
    setSide(o.side);
    text('order-title', 'Edit order · ' + o.symbol + ' ' + o.date);
    text('btn-order-save', 'Save changes');
    el('btn-order-cancel').classList.remove('hidden');
    el('order-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function submitOrder(e) {
    e.preventDefault();
    text('order-error', '');
    var o = {
      symbol: el('of-symbol').value, exchange: el('of-exchange').value, side: S.side,
      qty: el('of-qty').value, price: el('of-price').value, charges: el('of-charges').value || 0,
      date: el('of-date').value, time: el('of-time').value, product: el('of-product').value,
      tag: el('of-tag').value, note: el('of-note').value,
    };
    try {
      if (S.editing) KT.orders.update(S.editing, o); else KT.orders.add(o);
      KT.portfolio.reload && KT.portfolio.reload();
      resetForm();
      refreshQuotes();
      renderAll();
    } catch (err) {
      text('order-error', String(err.message || err));
    }
  }

  function download(name, body, type) {
    var blob = new Blob([body], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  /* ================================================================ WIRE */
  function wire() {
    el('btn-theme').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      core.store.set('theme', next);
    });

    el('btn-edit-profile').addEventListener('click', function () {
      var f = el('profile-form'), p = KT.orders.profile() || {};
      f.classList.toggle('hidden');
      el('pp-name').value = p.name || ''; el('pp-style').value = p.style || '';
      el('pp-horizon').value = p.horizon || ''; el('pp-broker').value = p.broker || '';
    });
    el('profile-form').addEventListener('submit', function (e) {
      e.preventDefault();
      KT.orders.setProfile({ name: el('pp-name').value, style: el('pp-style').value,
                             horizon: el('pp-horizon').value, broker: el('pp-broker').value });
      el('profile-form').classList.add('hidden');
      renderAll();
    });

    document.querySelectorAll('.side-btn').forEach(function (b) {
      b.addEventListener('click', function () { setSide(b.getAttribute('data-side')); });
    });
    el('of-symbol').addEventListener('input', onSymbolInput);
    el('of-exchange').addEventListener('change', onSymbolInput);
    ['of-qty', 'of-price', 'of-charges'].forEach(function (id) { el(id).addEventListener('input', updateTotal); });
    el('btn-use-ltp').addEventListener('click', function () {
      var q = S.quotes[KT.orders.cleanSymbol(el('of-symbol').value)];
      if (q && q.price) { el('of-price').value = q.price; updateTotal(); }
      else text('order-error', 'No live price for that symbol yet — type the price you paid.');
    });
    el('order-form').addEventListener('submit', submitOrder);
    el('btn-order-cancel').addEventListener('click', resetForm);

    el('orders-filter').addEventListener('input', core.debounce(renderOrders, 150));
    el('orders-rows').addEventListener('click', function (e) {
      var t = e.target;
      if (t.dataset.edit) editOrder(t.dataset.edit);
      if (t.dataset.del) {
        if (!window.confirm('Delete this order? Positions and P&L are recomputed without it.')) return;
        KT.orders.remove(t.dataset.del);
        KT.portfolio.reload && KT.portfolio.reload();
        renderAll();
      }
    });
    el('pos-rows').addEventListener('click', function (e) {
      var d = e.target.closest ? e.target.closest('[data-detail]') : null;
      if (d) { openDetail(d.getAttribute('data-detail')); return; }
      var row = e.target.closest ? e.target.closest('tr[data-sym]') : null;
      if (row && !e.target.closest('a')) openDetail(row.getAttribute('data-sym'));
    });
    el('show-closed').addEventListener('change', function () { S.showClosed = this.checked; renderPositions(S.book); });

    el('btn-close-detail').addEventListener('click', function () { el('detail-modal').classList.add('hidden'); });
    el('detail-modal').addEventListener('click', function (e) { if (e.target === el('detail-modal')) el('detail-modal').classList.add('hidden'); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') el('detail-modal').classList.add('hidden'); });

    el('pf-alerts').addEventListener('click', function (e) {
      var k = e.target.dataset && e.target.dataset.dismiss;
      if (!k) return;
      var d = core.store.get(DISMISS_KEY, {}) || {};
      d[k] = Date.now();
      // Bounded: a week of dismissals is plenty to keep an alert from coming back.
      Object.keys(d).forEach(function (kk) { if (Date.now() - d[kk] > 7 * 86400000) delete d[kk]; });
      core.store.set(DISMISS_KEY, d);
      renderAlerts(S.book);
    });
    el('feed-filters').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.filter-btn') : null;
      if (!b) return;
      S.feedFilter = b.getAttribute('data-f');
      document.querySelectorAll('#feed-filters .filter-btn').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      renderFeed();
    });

    el('btn-export-json').addEventListener('click', function () {
      download('profile-orders-' + KT.orders.todayIso() + '.json', KT.orders.exportJson(), 'application/json');
    });
    el('btn-export-csv').addEventListener('click', function () {
      download('orders-' + KT.orders.todayIso() + '.csv', KT.orders.exportCsv(), 'text/csv');
    });
    el('btn-import').addEventListener('click', function () { el('import-file').click(); });
    el('import-file').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var body = String(fr.result);
          var n = /^\s*[\[{]/.test(body) ? KT.orders.importJson(body) : KT.orders.importCsv(body);
          text('io-note', n + ' order' + (n === 1 ? '' : 's') + ' imported from ' + file.name + '.');
          KT.portfolio.reload && KT.portfolio.reload();
          refreshQuotes();
          renderAll();
        } catch (err) { text('io-note', 'Could not read that file: ' + (err.message || err)); }
      };
      fr.readAsText(file);
      e.target.value = '';
    });
    el('btn-clear-all').addEventListener('click', function () {
      if (!KT.orders.count()) return;
      if (!window.confirm('Remove every order from this browser? There is no server copy to restore from — export first if you want one.')) return;
      KT.orders.clear();
      KT.portfolio.reload && KT.portfolio.reload();
      renderAll();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.KT);
