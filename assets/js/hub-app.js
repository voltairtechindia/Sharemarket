/* ============================================================================
   Data hub: every source the terminal reads, checked from this browser.

   The page makes the same calls the terminal makes, times them, counts what
   came back and says how old it is. A source card that says "live" here
   answered a request a few seconds ago; one that says "fallback" is running
   on the workflow's copy; one that says "unavailable" did neither. Each card
   names what it feeds, so a dead lane can be traced to the panel it starves.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core, data = KT.data, fmt = core.fmt, el = core.el, text = core.text;
  var R = {};          // results by source id
  var D = {};          // the datasets the explorer draws
  var running = false;

  function esc(x) {
    return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function noop() {}
  function ago(ts) { return ts ? core.fmt.ago(ts) : '—'; }
  function isoTs(iso) { var t = Date.parse(iso || ''); return isFinite(t) ? Math.floor(t / 1000) : null; }

  /* --------------------------------------------------------- the sources */
  var SOURCES = [
    { id: 'price', name: 'Live index price', provider: 'Moneycontrol price feed', method: 'direct',
      feeds: 'chart tick, ticker board', run: function () {
        return data.getLiveQuote('NIFTY').then(function (q) {
          return { rows: 1, ts: q.updatedEpoch || Math.floor(Date.now() / 1000), sample: q,
                   note: 'NIFTY ' + fmt.price(q.price) + ' ' + fmt.pct(q.changePct) };
        });
      } },
    { id: 'candles', name: 'OHLC candles', provider: 'Yahoo Finance', method: 'proxy',
      feeds: 'chart, every price-based lane, the trail replay', run: function () {
        return data.getCandles('NIFTY', '1D').then(function (r) {
          var c = r.candles || [];
          var h = data.health.candles || {};
          return { rows: c.length, ts: c.length ? c[c.length - 1].time : null, sample: c.slice(-3),
                   fallback: /cached|workflow/.test(h.note || ''), note: c.length + ' five-minute bars · ' + (h.note || '') };
        });
      } },
    { id: 'fastnews', name: 'Fast news sweep', provider: C.directFeeds.length + ' RSS feeds (CNBC TV18, CNBC, MarketWatch, Yahoo)', method: 'direct',
      feeds: 'news lane (weight ' + Math.round(C.forecast.weights.news * 100) + '%)', run: function () {
        return data.fetchFastLane().then(function (items) {
          if (!items.length) throw new Error('no items');
          D.news = (D.news || []).concat(items);
          return { rows: items.length, ts: Math.max.apply(null, items.map(function (i) { return i.ts || 0; })),
                   sample: items.slice(0, 5).map(function (i) { return { headline: i.headline, source: i.source, sentiment: i.sentiment }; }),
                   note: items.length + ' headlines this sweep' };
        });
      } },
    { id: 'deepnews', name: 'Deep news index', provider: 'GitHub Actions over 448 feeds', method: 'workflow',
      feeds: 'news lane, street calls, holdings alerts', run: function () {
        return data.loadBaked(C.baked.news).then(function (n) {
          var items = n.news_items || [];
          D.news = (D.news || []).concat(items);
          D.feeds = { alive: n.feeds_alive, total: n.feeds_total, polled: n.feeds_polled };
          return { rows: items.length, ts: isoTs(n.updated_iso), sample: items.slice(0, 4),
                   note: (n.feeds_alive || '?') + ' of ' + (n.feeds_total || '?') + ' feeds answered on the last run' };
        });
      } },
    { id: 'archive', name: 'News archive', provider: 'live-data branch, one file per day', method: 'workflow',
      feeds: 'street-call history, the news lane backtest (from 18 Sep 2026)', run: function () {
        return data.fetchText(C.remote.base + 'data/news_archive/index.json', { timeout: 9000 }).then(function (t) {
          var j = JSON.parse(t), days = j.days || [];
          var total = days.reduce(function (s, d) { return s + (d.count || 0); }, 0);
          D.archive = { days: days, total: total };
          return { rows: total, ts: j.generated_at || null, sample: days.slice(-3),
                   note: days.length + ' days, ' + fmt.count(total) + ' scored headlines' };
        });
      } },
    { id: 'options', name: 'NIFTY option chain', provider: 'NSE option-chain-v3', method: 'proxy',
      feeds: 'options lane (' + Math.round(C.forecast.weights.options * 100) + '%): PCR, max pain, OI walls', run: function () {
        return data.getOptionChain('NIFTY').then(function (o) {
          if (o) return { rows: o.strikes, ts: isoTs(o.generated_at), sample: { pcrOi: o.pcrOi, pcrChgOi: o.pcrChgOi, maxPain: o.maxPain, expiry: o.expiry },
                          note: 'PCR ' + o.pcrOi + ', max pain ' + fmt.price(o.maxPain) + ', expiry ' + o.expiry };
          return data.loadBaked(C.baked.options).then(function (b) {
            return { rows: b.strikes || 0, ts: isoTs(b.generated_at), fallback: true, sample: { pcrOi: b.pcrOi, maxPain: b.maxPain },
                     note: 'workflow copy · PCR ' + b.pcrOi };
          });
        });
      } },
    { id: 'internals', name: 'Breadth, VIX and sectors', provider: 'NSE allIndices', method: 'proxy',
      feeds: 'flow lane breadth, India VIX in the band, sector board', run: function () {
        return data.getMarketInternals().then(function (m) {
          if (!m) throw new Error('no answer');
          return { rows: (m.sectors || []).length + 2, ts: isoTs(m.generated_at), sample: { breadth: m.breadth, vix: m.vix, sectors: (m.sectors || []).slice(0, 4) },
                   note: 'NIFTY 50 ' + (m.breadth ? m.breadth.advances + '↑ ' + m.breadth.declines + '↓' : '—') + ' · VIX ' + (m.vix || '—') };
        });
      } },
    { id: 'global', name: 'Global cues + GIFT Nifty', provider: 'TradingView screener', method: 'direct',
      feeds: 'global lane (' + Math.round(C.forecast.weights.global * 100) + '%), the opening call', run: function () {
        return data.getLiveGlobal().then(function (g) {
          if (!g) throw new Error('no answer');
          D.global = g;
          var gift = g.items.gift_nifty;
          return { rows: g.count, ts: isoTs(g.generated_at), sample: g.items,
                   note: g.count + ' cues' + (gift ? ' · GIFT Nifty ' + fmt.price(gift.price) + ' ' + fmt.pct(gift.changePct) : '') };
        });
      } },
    { id: 'members', name: 'NIFTY 50 members', provider: 'TradingView screener', method: 'direct',
      feeds: 'movers, profile prices, analyst consensus, technical ratings', run: function () {
        return data.getIndexMembers('SYML:NSE;NIFTY').then(function (r) {
          if (!r) throw new Error('no answer');
          D.members = r.rows;
          var cov = r.rows.filter(function (x) { return x.analysts; }).length;
          return { rows: r.rows.length, ts: isoTs(r.at), sample: r.rows.slice(0, 3),
                   note: r.rows.length + ' stocks, ' + cov + ' with analyst targets · ' + (r.rows[0] ? r.rows[0].delay : 15) + ' min delayed' };
        });
      } },
    { id: 'fiidii', name: 'FII / DII cash', provider: 'NSE fiidiiTradeReact', method: 'proxy',
      feeds: 'flow lane, the FII/DII board', run: function () {
        return data.getFiiDiiLive().then(function (r) {
          if (!r) throw new Error('no answer');
          return { rows: (r.fii ? 1 : 0) + (r.dii ? 1 : 0), ts: isoTs(r.at), sample: r,
                   note: (r.fii ? 'FII ' + fmt.croreSigned(r.fii.netCr) : '') + (r.dii ? ' · DII ' + fmt.croreSigned(r.dii.netCr) : '') +
                         ' · ' + ((r.fii || r.dii).date || '') };
        });
      } },
    { id: 'partoi', name: 'Participant open interest', provider: 'NSE archives, daily CSV', method: 'proxy',
      feeds: 'flow lane (FII index-futures positioning), the positioning board', run: function () {
        return data.getParticipantOi(6).then(function (r) {
          if (!r) throw new Error('no files');
          D.partoi = r.sessions;
          var last = r.sessions[r.sessions.length - 1];
          return { rows: r.sessions.length * 5, ts: data.nseDate(last.date), sample: last.rows,
                   note: r.sessions.length + ' sessions · FII ' + (last.rows.FII ? last.rows.FII.longPct + '% long' : '—') };
        });
      } },
    { id: 'deals', name: 'Bulk, block and short deals', provider: 'NSE large-deal snapshot', method: 'proxy',
      feeds: 'smart-money panel, profile feed', run: function () {
        return data.getLargeDeals().then(function (r) {
          if (!r) throw new Error('no answer');
          D.deals = r;
          return { rows: r.rows.length, ts: data.nseDate(r.asOn), sample: r.rows.slice(0, 3),
                   note: r.counts.bulk + ' bulk · ' + r.counts.block + ' block · ' + r.counts.short + ' short (' + (r.asOn || '') + ')' };
        });
      } },
    { id: 'calendar', name: 'Results and board meetings', provider: 'NSE event calendar', method: 'proxy',
      feeds: 'results calendar, profile alerts', run: function () {
        return data.getEventCalendar().then(function (r) {
          if (!r) throw new Error('no answer');
          D.calendar = r.rows;
          var res = r.rows.filter(function (x) { return x.results; }).length;
          return { rows: r.rows.length, ts: isoTs(r.at), sample: r.rows.slice(0, 3),
                   note: r.rows.length + ' meetings ahead, ' + res + ' of them results' };
        });
      } },
    { id: 'oispurts', name: 'Open-interest spurts', provider: 'NSE live analysis', method: 'proxy',
      feeds: 'derivatives panel', run: function () {
        return data.getOiSpurts().then(function (r) {
          if (!r) throw new Error('no answer');
          D.oi = r;
          return { rows: r.rows.length, ts: isoTs(r.at), sample: r.rows.slice(0, 3), note: r.rows.length + ' F&O stocks · ' + (r.timestamp || '') };
        });
      } },
    { id: 'sast', name: 'Takeover-code (SAST) filings', provider: 'NSE corporate-sast-reg29', method: 'proxy',
      feeds: 'smart-money panel, profile feed', run: function () {
        return data.getSast(14).then(function (r) {
          if (!r) throw new Error('no answer');
          D.sast = r.rows;
          var prom = r.rows.filter(function (x) { return x.promoter; }).length;
          return { rows: r.rows.length, ts: r.rows[0] ? r.rows[0].ts : null, sample: r.rows.slice(0, 3),
                   note: r.rows.length + ' filings in 14 days, ' + prom + ' by promoters' };
        });
      } },
    { id: 'pit', name: 'Insider-trading (PIT) filings', provider: 'NSE corporates-pit-gg', method: 'proxy',
      feeds: 'smart-money panel, profile feed', run: function () {
        return data.getInsiderFilings().then(function (r) {
          if (!r) throw new Error('no answer');
          D.pit = r.rows;
          return { rows: r.total, ts: r.rows[0] ? r.rows[0].ts : null, sample: r.rows.slice(0, 3), note: fmt.count(r.total) + ' filings in the current list' };
        });
      } },
    { id: 'filings', name: 'Corporate announcements', provider: 'NSE (BSE blocked from datacentres)', method: 'workflow',
      feeds: 'news stream "Filings" filter, holdings alerts', run: function () {
        return data.loadBaked(C.baked.filings).then(function (f) {
          return { rows: f.count || (f.filings || []).length, ts: isoTs(f.updated_iso), sample: (f.filings || []).slice(0, 3),
                   note: (f.count || 0) + ' announcements, ' + (f.high || 0) + ' high impact' };
        });
      } },
    { id: 'season', name: 'Seasonality, ~19 years', provider: 'Yahoo monthly closes', method: 'workflow',
      feeds: 'seasonal lane (' + Math.round(C.forecast.weights.seasonal * 100) + '%)', run: function () {
        return data.loadBaked(C.baked.seasonality).then(function (s) {
          return { rows: s.history_months || (s.months || []).length, ts: isoTs(s.updated_iso), sample: s.current_month,
                   note: (s.history_months || '?') + ' monthly closes' };
        });
      } },
    { id: 'events', name: 'Holidays + global calendar', provider: 'NSE holiday master, ForexFactory', method: 'workflow',
      feeds: 'the projection clock, the hover card', run: function () {
        return data.loadBaked(C.baked.events).then(function (e) {
          return { rows: (e.holidays || []).length + (e.events || []).length, ts: isoTs(e.generated_at), sample: { nextHoliday: e.nextHoliday },
                   note: (e.holidays || []).length + ' trading holidays, ' + (e.events || []).length + ' scheduled releases' };
        });
      } },
    { id: 'constituents', name: 'Index membership', provider: 'niftyindices.com', method: 'workflow',
      feeds: 'news relevance tiers', run: function () {
        return data.loadBaked(C.baked.constituents).then(function (c) {
          D.constituents = c.members || [];
          return { rows: c.count || (c.members || []).length, ts: isoTs(c.generated_at), sample: (c.members || []).slice(0, 2),
                   note: (c.count || 0) + ' members across NIFTY 50, Bank and Next 50' };
        });
      } },
    { id: 'universe', name: 'Stock universe', provider: 'NSE equity master', method: 'workflow',
      feeds: 'symbol search, headline-to-stock matching', run: function () {
        return data.loadBaked(C.baked.universe).then(function (u) {
          D.universe = u.symbols || [];
          KT.portfolio.setUniverse(u);
          KT.streetcalls.setUniverse(D.universe);
          return { rows: (u.symbols || []).length, ts: isoTs(u.generated_at), sample: (u.symbols || []).slice(0, 2),
                   note: fmt.count((u.symbols || []).length) + ' listed names with aliases' };
        });
      } },
    { id: 'ipo', name: 'IPO book', provider: 'NSE issue APIs', method: 'workflow',
      feeds: 'the IPO terminal', run: function () {
        return data.loadBaked(C.baked.ipo).then(function (i) {
          var n = (i.issues || i.current || []).length || (i.count || 0);
          return { rows: n, ts: isoTs(i.generated_at), sample: { keys: Object.keys(i).slice(0, 8) }, note: n + ' issues in the file' };
        });
      } },
    { id: 'llm', name: 'Language model vote', provider: 'OpenRouter free tier', method: 'key',
      feeds: 'model lane (' + Math.round(C.forecast.weights.model * 100) + '%), the plain-English narrative', run: function () {
        var saved = core.store.get('settings', {}) || {};
        var key = saved.key || (window.KT_LOCAL && window.KT_LOCAL.openrouterKey) || '';
        return data.listFreeModels(key).then(function (models) {
          return { rows: models.length, ts: Math.floor(Date.now() / 1000), sample: models.slice(0, 6), fallback: !key,
                   note: models.length + ' free models · ' + (key ? 'key set in this browser' : 'no key set — add one in the terminal’s Settings') };
        });
      } },
  ];

  /* ------------------------------------------------------------- run */
  function card(src) {
    var r = R[src.id];
    var st = !r ? 'checking' : r.error ? 'down' : r.fallback ? 'fallback' : 'live';
    var label = { checking: 'checking…', down: 'unavailable', fallback: src.method === 'key' ? 'needs key' : 'fallback', live: 'live' }[st];
    return '<div class="src-card st-' + st + '">' +
      '<div class="src-top"><span class="src-name">' + esc(src.name) + '</span><span class="src-pill ' + st + '">' + label + '</span></div>' +
      '<div class="src-prov"><span class="src-method m-' + src.method + '">' + esc(src.method) + '</span> ' + esc(src.provider) + '</div>' +
      '<div class="src-note">' + esc(r ? (r.error ? r.error : r.note) : '') + '</div>' +
      '<div class="src-meta">' +
        '<span><em>rows</em> <b class="num">' + (r && !r.error ? fmt.count(r.rows) : '—') + '</b></span>' +
        '<span><em>as of</em> <b>' + (r && r.ts ? esc(ago(r.ts)) : '—') + '</b></span>' +
        '<span><em>took</em> <b class="num">' + (r && r.ms != null ? (r.ms < 1000 ? r.ms + ' ms' : (r.ms / 1000).toFixed(1) + ' s') : '—') + '</b></span>' +
        (r && r.sample ? '<button class="btn btn-sm" data-peek="' + esc(src.id) + '">Peek</button>' : '') +
      '</div>' +
      '<div class="src-feeds">Feeds: ' + esc(src.feeds) + '</div>' +
    '</div>';
  }

  function renderCards() {
    var host = el('src-grid');
    if (host) host.innerHTML = SOURCES.map(card).join('');
    var live = 0, done = 0, rows = 0;
    SOURCES.forEach(function (s) {
      var r = R[s.id];
      if (!r) return;
      done++;
      if (!r.error) { live++; rows += r.rows || 0; }
    });
    text('h-live', live + ' / ' + SOURCES.length);
    text('h-live-s', done < SOURCES.length ? 'checking ' + (SOURCES.length - done) + ' more…' : 'checked ' + fmt.clock(new Date()));
    text('h-rows', fmt.count(rows));
    if (D.feeds) { text('h-feeds', D.feeds.alive + ' / ' + D.feeds.total); text('h-feeds-s', 'answered on the last workflow run'); }
    if (D.archive) { text('h-arch', fmt.count(D.archive.total)); text('h-arch-s', D.archive.days.length + ' days since ' + (D.archive.days[0] ? D.archive.days[0].day : '—')); }
  }

  function runOne(src) {
    var t0 = Date.now();
    return Promise.resolve().then(src.run).then(function (r) {
      r.ms = Date.now() - t0;
      R[src.id] = r;
    }).catch(function (e) {
      R[src.id] = { error: String((e && e.message) || e || 'failed').slice(0, 90), ms: Date.now() - t0 };
    }).then(function () { renderCards(); renderExplorer(); });
  }

  function runAll() {
    if (running) return;
    running = true;
    R = {}; D.news = [];
    renderCards();
    // Direct and workflow reads in parallel; proxy hops one at a time, because
    // the hop is shared and rate-limits when leaned on.
    var direct = SOURCES.filter(function (s) { return s.method !== 'proxy'; });
    var proxy = SOURCES.filter(function (s) { return s.method === 'proxy'; });
    var first = Promise.all(direct.map(runOne));
    var chain = Promise.resolve();
    proxy.forEach(function (s) { chain = chain.then(function () { return runOne(s); }); });
    Promise.all([first, chain]).then(function () {
      running = false;
      loadArchiveCalls();
    });
  }

  /* --------------------------------------------- street calls, 14 days
     The current stream plus the archive's last fortnight, parsed once. */
  function loadArchiveCalls() {
    var days = (D.archive && D.archive.days || []).slice(-14);
    var items = (D.news || []).slice();
    var chain = Promise.resolve();
    days.forEach(function (d) {
      chain = chain.then(function () {
        return data.fetchText(C.remote.base + 'data/news_archive/' + d.day + '.json', { timeout: 12000 }).then(function (t) {
          var j = JSON.parse(t);
          (j.items || []).forEach(function (x) { items.push({ headline: x.h, ts: x.ts, source: x.src, key: x.k }); });
        }).catch(noop);
      });
    });
    chain.then(function () {
      var calls = KT.streetcalls.extract(items);
      var quotes = {};
      (D.members || []).forEach(function (m) { quotes[m.symbol] = m; });
      // Price every stock the calls name, in one more screener request.
      var want = {};
      calls.slice(0, 150).forEach(function (c) { c.stocks.forEach(function (s) { if (!quotes[s]) want[s] = 1; }); });
      var list = Object.keys(want).slice(0, 250).map(function (s) { return { symbol: s, exchange: 'NSE' }; });
      return (list.length ? data.getStockQuotes(list) : Promise.resolve({})).then(function (got) {
        Object.keys(got).forEach(function (k) { quotes[k] = got[k]; });
        D.calls = KT.streetcalls.track(calls, quotes);
        D.callQuotes = quotes;
        D.callsFrom = items.length;
        renderExplorer();
      });
    });
  }

  /* ----------------------------------------------------------- explorer */
  function techLabel(r) {
    if (r == null) return '—';
    return r >= 0.5 ? 'Strong buy' : r >= 0.1 ? 'Buy' : r > -0.1 ? 'Neutral' : r > -0.5 ? 'Sell' : 'Strong sell';
  }
  function markLabel(m) {
    if (m == null) return '—';
    return m <= 1.5 ? 'Strong buy' : m <= 2.5 ? 'Buy' : m <= 3.5 ? 'Hold' : m <= 4.5 ? 'Sell' : 'Strong sell';
  }
  function n50() {
    var set = {};
    (D.constituents || []).forEach(function (m) { if ((m.tiers || []).indexOf('nifty50') !== -1) set[m.symbol] = 1; });
    return set;
  }

  function renderExplorer() {
    var idx = n50();
    // Deals
    if (D.deals) {
      text('deals-asof', D.deals.asOn || '');
      var rows = D.deals.rows.filter(function (r) { return r.kind !== 'short'; })
        .sort(function (a, b) { return (b.valueCr || 0) - (a.valueCr || 0); }).slice(0, 40);
      el('deals-rows').innerHTML = rows.map(function (r) {
        return '<tr><td><b>' + esc(r.symbol) + '</b>' + (idx[r.symbol] ? ' <span class="sig brand">N50</span>' : '') + '<small>' + esc(r.name) + '</small></td>' +
          '<td>' + esc(r.kind) + '</td><td class="pf-note">' + esc(r.client) + '</td>' +
          '<td><span class="side-pill ' + (r.side === 'BUY' ? 'buy' : 'sell') + '">' + esc(r.side) + '</span></td>' +
          '<td class="num">' + fmt.count(r.qty) + '</td><td class="num">' + fmt.price(r.price) + '</td>' +
          '<td class="num">' + (r.valueCr != null ? '₹' + fmt.price(r.valueCr) + ' Cr' : '—') + '</td></tr>';
      }).join('');
    }
    if (D.sast) {
      el('sast-list').innerHTML = D.sast.slice(0, 18).map(function (r) {
        return '<li class="feed-item"><span class="feed-kind ' + (r.side === 'BUY' ? 'call' : 'filing') + '">' + (r.side === 'BUY' ? 'bought' : 'sold') + '</span>' +
          '<span class="feed-text"><b>' + esc(r.symbol) + '</b> ' + (r.promoter ? 'Promoter ' : '') + esc(r.who) + ' ' +
          (r.pct != null ? r.pct + '%' : fmt.count(r.shares) + ' shares') + (r.afterPct != null ? ' → holds ' + r.afterPct + '%' : '') +
          '<small>' + esc(r.mode || '') + ' · filed ' + esc(r.filed || '') + '</small></span></li>';
      }).join('');
    }
    if (D.pit) {
      el('pit-list').innerHTML = D.pit.slice(0, 14).map(function (r) {
        return '<li class="feed-item"><span class="feed-kind filing">PIT</span><span class="feed-text"><b>' + esc(r.symbol) + '</b> ' +
          (r.link ? '<a href="' + esc(r.link) + '" target="_blank" rel="noopener">' + esc(r.company) + '</a>' : esc(r.company)) +
          '<small>' + esc(r.reg || '') + ' · ' + esc(r.type || '') + ' · ' + esc(r.filed || '') + '</small></span></li>';
      }).join('');
    }
    // Calls
    if (D.calls) {
      text('calls-asof', D.calls.length + ' calls from ' + fmt.count(D.callsFrom || 0) + ' headlines');
      el('calls-rows').innerHTML = D.calls.slice(0, 60).map(function (c) {
        var t = (c.track || [])[0] || {};
        return '<tr><td class="num">' + (c.ts ? esc(core.fmt.dayShort(c.ts)) : '—') + '</td>' +
          '<td><b>' + esc(c.stocks.slice(0, 3).join(', ')) + '</b>' + (c.stocks.length > 3 ? ' <small>+' + (c.stocks.length - 3) + '</small>' : '') + '</td>' +
          '<td><span class="side-pill ' + (c.rating === 'sell' ? 'sell' : c.rating === 'buy' ? 'buy' : 'pick') + '"' +
            (c.rating === 'pick' ? ' title="Named as a pick; the headline does not say which way"' : '') + '>' +
            esc(c.rating.toUpperCase()) + '</span></td>' +
          '<td>' + esc(c.broker || '—') + '</td>' +
          '<td class="num">' + (c.target ? fmt.price(c.target) : '—') + '</td>' +
          '<td class="num">' + (t.ltp != null ? fmt.price(t.ltp) : '—') + '</td>' +
          '<td class="num ' + (t.toTargetPct != null ? fmt.cls(t.toTargetPct) : '') + '">' + (t.toTargetPct != null ? fmt.pct(t.toTargetPct, 1) : '—') + '</td>' +
          '<td class="pf-note">' + (c.url ? '<a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.headline) + '</a>' : esc(c.headline)) + '</td></tr>';
      }).join('');
      var tally = KT.streetcalls.tally(D.calls).slice(0, 10);
      var max = tally.length ? tally[0].n : 1;
      el('calls-tally').innerHTML = tally.map(function (t) {
        return '<div class="alloc-row"><span class="alloc-k">' + esc(t.symbol) + '</span><span class="alloc-bar"><span style="width:' +
          (t.n / max * 100).toFixed(0) + '%"></span></span><span class="alloc-v num">' + t.n + ' · ' + t.buy + 'B ' + (t.sell || 0) + 'S</span></div>';
      }).join('');
    }
    if (D.members) {
      text('cons-asof', 'live · ' + ((D.members[0] || {}).delay || 15) + ' min delayed');
      var cons = D.members.filter(function (m) { return m.analysts; })
        .sort(function (a, b) { return (b.upsidePct || -99) - (a.upsidePct || -99); });
      el('cons-rows').innerHTML = cons.map(function (m) {
        return '<tr><td><b>' + esc(m.symbol) + '</b><small>' + esc(m.sector || '') + '</small></td>' +
          '<td class="num">' + fmt.price(m.price) + '<small class="' + fmt.cls(m.changePct) + '">' + fmt.pct(m.changePct) + '</small></td>' +
          '<td class="num">' + m.analysts + '</td><td>' + markLabel(m.analystMark) + '</td>' +
          '<td class="num">' + (m.targetAvg ? fmt.price(m.targetAvg) : '—') + '</td>' +
          '<td class="num ' + fmt.cls(m.upsidePct) + '">' + (m.upsidePct != null ? fmt.pct(m.upsidePct, 1) : '—') + '</td>' +
          '<td>' + techLabel(m.techRating) + '</td></tr>';
      }).join('');
    }
    // Derivatives
    if (D.partoi && D.partoi.length) {
      var ss = D.partoi.slice(-6);
      text('poi-asof', ss.length + ' sessions to ' + ss[ss.length - 1].date);
      el('poi-head').innerHTML = '<tr><th>Participant</th>' + ss.map(function (s) { return '<th class="num">' + esc(s.date.slice(0, 6)) + '</th>'; }).join('') + '</tr>';
      el('poi-rows').innerHTML = [['FII', 'FII'], ['CLIENT', 'Retail'], ['PRO', 'Prop desks'], ['DII', 'DII']].map(function (p) {
        return '<tr><td><b>' + p[1] + '</b><small>% of index-futures book long</small></td>' + ss.map(function (s, i) {
          var r = s.rows[p[0]], prev = i > 0 ? ss[i - 1].rows[p[0]] : null;
          if (!r) return '<td class="num">—</td>';
          var ch = prev ? r.longPct - prev.longPct : null;
          return '<td class="num">' + r.longPct.toFixed(1) + '%' + (ch != null ? '<small class="' + fmt.cls(ch) + '">' + (ch >= 0 ? '+' : '') + ch.toFixed(1) + '</small>' : '') + '</td>';
        }).join('') + '</tr>';
      }).join('');
    }
    if (D.oi) {
      text('oi-asof', D.oi.timestamp || '');
      el('oi-rows').innerHTML = D.oi.rows.slice().sort(function (a, b) { return Math.abs(b.changeOIPct || 0) - Math.abs(a.changeOIPct || 0); })
        .slice(0, 20).map(function (r) {
          return '<tr><td><b>' + esc(r.symbol) + '</b></td><td class="num">' + fmt.count(r.latestOI) + '</td>' +
            '<td class="num ' + fmt.cls(r.changeOI) + '">' + (r.changeOIPct != null ? fmt.pct(r.changeOIPct, 1) : '—') + '<small>' + fmt.count(r.changeOI) + '</small></td>' +
            '<td class="num">' + fmt.price(r.underlying) + '</td></tr>';
        }).join('');
    }
    // Calendar
    if (D.calendar) {
      var now = Date.now() / 1000 - 86400;
      var up = D.calendar.filter(function (r) { return (r.ts || 0) >= now; }).slice(0, 80);
      text('cal-asof', up.length + ' upcoming');
      el('cal-rows').innerHTML = up.map(function (r) {
        return '<tr><td class="num">' + esc(r.date) + '</td><td><b>' + esc(r.symbol) + '</b>' + (idx[r.symbol] ? ' <span class="sig brand">N50</span>' : '') + '</td>' +
          '<td>' + esc(r.company) + '</td><td class="pf-note">' + esc(r.desc || r.purpose) + '</td>' +
          '<td>' + (r.results ? '<span class="sig warn">results</span>' : '') + '</td></tr>';
      }).join('');
    }
    // Global
    if (D.global) {
      text('glob-asof', 'live · ' + core.fmt.timeShort(Math.floor(Date.parse(D.global.generated_at) / 1000)));
      var base = D.globalBaked && D.globalBaked.items || {};
      var feedsOf = function (k) {
        var g = KT.CONFIG.forecast && k;
        var map = { us_futures: 'global lane, open', nasdaq_fut: 'global lane, open', nikkei: 'global lane, open', hangseng: 'global lane, open',
                    crude: 'global lane, open', usdinr: 'global lane, open', dxy: 'global lane, open', us10y: 'global lane, open',
                    gold: 'global lane', cboe_vix: 'global lane, open', gift_nifty: 'shown only (futures premium)' };
        return g ? (map[k] || 'shown only') : '';
      };
      el('glob-rows').innerHTML = (C.tvGlobal || []).map(function (w) {
        var r = D.global.items[w.key];
        if (!r) return '';
        var b = base[w.key];
        return '<tr><td><b>' + esc(w.label) + '</b></td><td><small>' + esc(r.tv) + '</small></td>' +
          '<td class="num">' + fmt.price(r.price) + '</td><td class="num ' + fmt.cls(r.changePct) + '">' + fmt.pct(r.changePct) + '</td>' +
          '<td class="num ' + (b ? fmt.cls(b.changePct) : '') + '">' + (b ? fmt.pct(b.changePct) : '—') + '</td>' +
          '<td>' + (r.delay ? r.delay + ' min' : 'live') + '</td><td>' + esc(feedsOf(w.key)) + '</td></tr>';
      }).join('');
    }
  }

  /* ---------------------------------------------------------- catalogue */
  var CATALOGUE = [
    ['GIFT Nifty history (for the gap model)', 'NSE IX / TradingView', 'Free quote now; history needs a data vendor', 'Measuring the futures premium would let GIFT Nifty enter the opening call directly - the single strongest predictor of the open', 'Quote connected, model input next'],
    ['NSDL FPI daily flows', 'fpi.nsdl.co.in', 'Free, workflow scrape', 'Foreign flows split by equity, debt and hybrid, a day earlier and finer than the FII cash number', 'Ready to add'],
    ['Security-wise delivery %', 'NSE bhavcopy (sec_bhavdata_full)', 'Free CSV, workflow', 'How much of a move was taken home rather than day-traded: conviction behind price', 'Ready to add'],
    ['Corporate actions', 'NSE corporates-corporateActions', 'Free, proxy', 'Dividends, splits and bonuses on the profile, so P&L and quantities adjust correctly', 'Ready to add'],
    ['Shareholding and promoter pledges', 'NSE shareholding filings', 'Free, quarterly', 'Rising pledges and falling promoter stakes are among the cleaner risk flags for a holding', 'Ready to add'],
    ['F&O ban list and MWPL', 'NSE archives', 'Free CSV, daily', 'Stocks near the market-wide position limit move differently; flags for the profile', 'Ready to add'],
    ['Mutual fund flows and SIP book', 'AMFI monthly data', 'Free', 'The domestic bid behind DII buying, month by month', 'Ready to add'],
    ['India macro: CPI, IIP, credit growth', 'RBI DBIE, MOSPI', 'Free', 'Scheduled India releases the global calendar does not carry (it has no INR rows)', 'Ready to add'],
    ['Reddit retail sentiment', 'r/IndianStreetBets, r/IndiaInvestments', 'Free with an app key; blocked anonymously (measured 6 Oct 2026)', 'Retail positioning and euphoria, a contrarian read on single stocks', 'Needs key'],
    ['Telegram public channels', 't.me/s/<channel> previews', 'Free, workflow', 'Where Indian retail tips circulate; useful only as a sentiment count, never as calls', 'Ready to add'],
    ['X (Twitter) market accounts', 'X API', 'Paid', 'Breaking policy and corporate news minutes ahead of the RSS feeds', 'Paid'],
    ['Broker order sync and tick data', 'Kite Connect, Upstox, Angel One SmartAPI, Dhan, Fyers', 'Your account keys; some free, some paid', 'Exchange-grade ticks for the chart and the profile filled from your real contract notes instead of typed in', 'Needs key'],
    ['Earnings transcripts and annual reports', 'NSE / BSE filings (PDF)', 'Free, needs PDF parsing', 'Guidance and tone, summarised by the model lane with sources quoted', 'Research'],
    ['Options history and IV surface', 'This repo’s own option-chain archive', 'Free, accumulating since 19 Sep 2026', 'Makes the options lane backtestable once a few months have built up', 'Accumulating'],
  ];
  function renderCatalogue() {
    var host = el('cat-rows');
    if (!host) return;
    host.innerHTML = CATALOGUE.map(function (r) {
      var cls = /Ready/.test(r[4]) ? 'up' : /Paid|key/i.test(r[4]) ? 'warn' : 'brand';
      return '<tr><td><b>' + esc(r[0]) + '</b></td><td>' + esc(r[1]) + '</td><td class="pf-note">' + esc(r[2]) + '</td>' +
        '<td class="pf-note">' + esc(r[3]) + '</td><td><span class="sig ' + cls + '">' + esc(r[4]) + '</span></td></tr>';
    }).join('');
  }

  /* ---------------------------------------------------------------- boot */
  function boot() {
    document.documentElement.setAttribute('data-theme', core.store.get('theme', 'light') === 'dark' ? 'dark' : 'light');
    el('btn-theme').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      core.store.set('theme', next);
    });
    (function tick() {
      var ms = core.marketState();
      text('market-clock', fmt.clock(ms.ist) + ' IST');
      text('market-state', ms.label);
      var dot = el('market-dot');
      if (dot) dot.className = 'dot ' + (ms.state === 'live' ? 'live' : ms.state === 'pre' ? 'pre' : 'closed');
      setTimeout(tick, 1000);
    })();
    el('hub-tabs').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.filter-btn') : null;
      if (!b) return;
      var tab = b.getAttribute('data-tab');
      document.querySelectorAll('#hub-tabs .filter-btn').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      document.querySelectorAll('.hub-pane').forEach(function (p) { p.classList.toggle('hidden', p.getAttribute('data-pane') !== tab); });
    });
    el('src-grid').addEventListener('click', function (e) {
      var id = e.target.dataset && e.target.dataset.peek;
      if (!id || !R[id]) return;
      var src = SOURCES.filter(function (s) { return s.id === id; })[0];
      text('peek-title', src.name + ' — sample of what came back');
      el('peek-body').textContent = JSON.stringify(R[id].sample, null, 2).slice(0, 6000);
      el('peek-modal').classList.remove('hidden');
    });
    el('btn-close-peek').addEventListener('click', function () { el('peek-modal').classList.add('hidden'); });
    el('peek-modal').addEventListener('click', function (e) { if (e.target === el('peek-modal')) el('peek-modal').classList.add('hidden'); });
    el('btn-recheck').addEventListener('click', runAll);
    renderCatalogue();

    data.loadBaked(C.baked.lexicon).then(function (lex) { core.setLexicon(lex); })
      .catch(function () { core.setLexicon({ bullish: {}, bearish: {}, impact_high: [], impact_medium: [], relevance: [], noise: [], sector_map: {} }); })
      .then(function () { return data.loadBaked(C.baked.global).then(function (g) { D.globalBaked = g; }).catch(noop); })
      .then(runAll);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.KT);
