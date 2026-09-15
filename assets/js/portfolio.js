/* ============================================================================
   Portfolio.

   What you actually bought through your broker, typed in here once, so the
   terminal can tell you when something happens to it rather than making you
   read six hundred headlines looking for your own names.

   Storage rule, same as the trade journal: holdings live in this browser's
   localStorage and nowhere else. They are never uploaded, never written to the
   repo, and never sent to any model. The repo is public; a public repo is no
   place for a position book.

   Prices come from data/stocks.json, which the workflow fills for a universe
   of NSE names. A holding outside that universe falls back to an on-demand
   Yahoo fetch through the same proxy chain the index candles use, so a
   smallcap still works, just a little slower.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;
  var KEY = 'holdings', ALERT_KEY = 'holding-alerts';

  var state = { rows: [], quotes: {}, universe: null, alerts: [], lastMatch: 0 };

  /* ------------------------------------------------------------- storage */
  function load() {
    var raw = core.store.get(KEY, []);
    state.rows = Array.isArray(raw) ? raw.filter(valid) : [];
    var al = core.store.get(ALERT_KEY, []);
    var cutoff = Date.now() / 1000 - C.holdings.alertTtlHours * 3600;
    state.alerts = (Array.isArray(al) ? al : []).filter(function (a) { return a.ts > cutoff; });
    return state.rows;
  }
  function persist() {
    core.store.set(KEY, state.rows);
    core.store.set(ALERT_KEY, state.alerts.slice(0, C.holdings.maxAlerts));
  }
  function valid(r) {
    return r && typeof r.symbol === 'string' && r.symbol.length &&
           isFinite(r.qty) && isFinite(r.avgPrice);
  }

  function rows() { return state.rows.slice(); }

  function add(entry) {
    var sym = String(entry.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9&.\-]/g, '');
    if (!sym) throw new Error('A symbol is required.');
    var qty = Number(entry.qty), price = Number(entry.avgPrice);
    if (!isFinite(qty) || qty === 0) throw new Error('Quantity must be a non-zero number.');
    if (!isFinite(price) || price <= 0) throw new Error('Average price must be above zero.');
    if (state.rows.length >= C.holdings.maxSymbols) throw new Error('Holding limit reached.');

    // Adding the same symbol again averages into the existing line rather than
    // creating a second row, which is how a broker shows it and how a P&L
    // number stays meaningful.
    var found = state.rows.filter(function (r) { return r.symbol === sym && r.exchange === (entry.exchange || 'NSE'); })[0];
    if (found) {
      var totalQty = found.qty + qty;
      if (totalQty === 0) { remove(found.id); return null; }
      found.avgPrice = Math.round(((found.avgPrice * found.qty + price * qty) / totalQty) * 100) / 100;
      found.qty = totalQty;
      found.updated = Math.floor(Date.now() / 1000);
      persist();
      return found;
    }
    var row = {
      id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      symbol: sym,
      name: String(entry.name || '').trim() || nameFor(sym) || sym,
      exchange: entry.exchange === 'BSE' ? 'BSE' : 'NSE',
      qty: qty, avgPrice: price,
      date: entry.date || new Date().toISOString().slice(0, 10),
      note: String(entry.note || '').slice(0, 200),
      added: Math.floor(Date.now() / 1000),
    };
    state.rows.push(row);
    persist();
    return row;
  }

  function remove(id) {
    state.rows = state.rows.filter(function (r) { return r.id !== id; });
    persist();
  }
  function clear() { state.rows = []; state.alerts = []; persist(); }

  /* ------------------------------------------------------------ universe
     symbol -> { name, aliases } so a headline that says "Reliance Industries"
     can be matched to a holding typed as RELIANCE. */
  function setUniverse(u) {
    if (!u) return;
    state.universe = {};
    var list = u.symbols || u;
    if (Array.isArray(list)) {
      list.forEach(function (row) {
        if (!row || !row.symbol) return;
        state.universe[row.symbol.toUpperCase()] = {
          name: row.name || row.symbol,
          aliases: (row.aliases || []).map(function (a) { return String(a).toLowerCase(); }),
          sector: row.sector || null,
        };
      });
    } else {
      Object.keys(list).forEach(function (k) {
        var row = list[k];
        state.universe[k.toUpperCase()] = {
          name: typeof row === 'string' ? row : (row.name || k),
          aliases: (row.aliases || []).map(function (a) { return String(a).toLowerCase(); }),
          sector: row.sector || null,
        };
      });
    }
  }
  function nameFor(sym) {
    return state.universe && state.universe[sym] ? state.universe[sym].name : null;
  }
  function universeList() {
    if (!state.universe) return [];
    return Object.keys(state.universe).map(function (k) {
      return { symbol: k, name: state.universe[k].name };
    });
  }

  /* --------------------------------------------------------------- quotes */
  function setQuotes(payload) {
    if (!payload) return;
    var src = payload.quotes || payload;
    Object.keys(src).forEach(function (k) {
      var q = src[k];
      if (!q) return;
      state.quotes[k.toUpperCase()] = {
        price: num(q.price != null ? q.price : q.ltp),
        prevClose: num(q.prevClose != null ? q.prevClose : q.prev_close),
        changePct: num(q.changePct != null ? q.changePct : q.change_pct),
        dayHigh: num(q.dayHigh != null ? q.dayHigh : q.high),
        dayLow: num(q.dayLow != null ? q.dayLow : q.low),
        week52High: num(q.week52High != null ? q.week52High : q.high_52w),
        week52Low: num(q.week52Low != null ? q.week52Low : q.low_52w),
        at: payload.generated_at || null,
      };
    });
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }

  /* On-demand quote for a symbol the workflow universe does not carry. */
  function fetchQuote(row) {
    var ticker = row.symbol + (row.exchange === 'BSE' ? '.BO' : C.holdings.suffix);
    var url = C.endpoints.yahooChart(ticker, '1d', '5d');
    return KT.data.fetchJSONVia(url, { timeout: 12000 }).then(function (j) {
      var meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
      if (!meta) throw new Error('no meta');
      var price = meta.regularMarketPrice, prev = meta.chartPreviousClose || meta.previousClose;
      state.quotes[row.symbol] = {
        price: price, prevClose: prev,
        changePct: prev ? (price - prev) / prev * 100 : null,
        dayHigh: meta.regularMarketDayHigh || null, dayLow: meta.regularMarketDayLow || null,
        week52High: meta.fiftyTwoWeekHigh || null, week52Low: meta.fiftyTwoWeekLow || null,
        at: new Date().toISOString(),
      };
      return state.quotes[row.symbol];
    });
  }

  function refreshMissing() {
    var missing = state.rows.filter(function (r) { return !state.quotes[r.symbol]; });
    if (!missing.length) return Promise.resolve(0);
    // Sequential and capped: this runs through a shared public proxy, and
    // firing twenty parallel requests at it is how the whole lane gets rate
    // limited for everything else on the page.
    var i = 0, done = 0;
    function step() {
      if (i >= Math.min(missing.length, 6)) return Promise.resolve(done);
      var row = missing[i++];
      return fetchQuote(row).then(function () { done++; }).catch(function () {}).then(step);
    }
    return step();
  }

  /* ------------------------------------------------------------ valuation */
  function valuation() {
    var invested = 0, current = 0, lines = [], dayChange = 0;
    state.rows.forEach(function (r) {
      var q = state.quotes[r.symbol] || {};
      var ltp = q.price != null ? q.price : null;
      var cost = r.avgPrice * r.qty;
      var value = ltp != null ? ltp * r.qty : null;
      var pl = value != null ? value - cost : null;
      invested += cost;
      if (value != null) current += value;
      else current += cost;                       // unpriced lines held at cost
      if (q.changePct != null && ltp != null) dayChange += ltp * r.qty * q.changePct / 100;
      lines.push({
        row: r, ltp: ltp, cost: cost, value: value, pl: pl,
        plPct: (pl != null && cost) ? pl / cost * 100 : null,
        dayPct: q.changePct != null ? q.changePct : null,
        priced: ltp != null,
        near52High: (q.week52High && ltp) ? (q.week52High - ltp) / q.week52High * 100 : null,
      });
    });
    lines.sort(function (a, b) { return Math.abs(b.value || b.cost) - Math.abs(a.value || a.cost); });
    return {
      invested: Math.round(invested * 100) / 100,
      current: Math.round(current * 100) / 100,
      pl: Math.round((current - invested) * 100) / 100,
      plPct: invested ? Math.round((current - invested) / invested * 10000) / 100 : null,
      dayChange: Math.round(dayChange * 100) / 100,
      unpriced: lines.filter(function (l) { return !l.priced; }).length,
      lines: lines,
    };
  }

  /* ========================================================= news matching
     A holding is matched on its symbol, its full name, and any alias the
     universe carries. Matching is word-boundary aware, because "IOC" inside
     "choice" and "TCS" inside "BTCS" are the kind of false positive that
     makes an alert feed useless within a day.

     Very short symbols are only matched in upper case, since a three-letter
     lowercase run appears in ordinary prose constantly. */
  function tokensFor(row) {
    var toks = [];
    var sym = row.symbol;
    toks.push({ text: sym, caseSensitive: sym.length <= 4, weight: 1 });
    var name = row.name && row.name !== sym ? row.name : null;
    if (name) {
      toks.push({ text: name, caseSensitive: false, weight: 1 });
      // "Reliance Industries Ltd" should also match a bare "Reliance".
      var head = name.replace(/\b(ltd|limited|inc|plc|corp|corporation|industries|india|services|company|co)\b/gi, '').trim();
      if (head.length >= 5 && head !== name) toks.push({ text: head, caseSensitive: false, weight: 0.9 });
    }
    var uni = state.universe && state.universe[sym];
    if (uni) (uni.aliases || []).forEach(function (a) {
      if (a.length >= 4) toks.push({ text: a, caseSensitive: false, weight: 0.9 });
    });
    return toks;
  }

  function esc(t) { return String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function matchNews(items) {
    if (!state.rows.length || !items || !items.length) return [];
    var compiled = state.rows.map(function (r) {
      return {
        row: r,
        tests: tokensFor(r).map(function (t) {
          return { rx: new RegExp('(?:^|[^A-Za-z0-9])' + esc(t.text) + '(?![A-Za-z0-9])', t.caseSensitive ? '' : 'i'),
                   weight: t.weight };
        }),
      };
    });

    var out = [];
    items.forEach(function (n) {
      var text = n.headline || '';
      compiled.forEach(function (cp) {
        var hit = null;
        for (var i = 0; i < cp.tests.length; i++) {
          if (cp.tests[i].rx.test(text)) { hit = cp.tests[i]; break; }
        }
        if (!hit) return;
        out.push({ holding: cp.row, item: n, weight: hit.weight });
      });
    });
    return out;
  }

  /* ----------------------------------------------------------- alerts
     Three sources: a headline naming a holding, a filing naming one, and the
     holding's own price action. Each alert is keyed so the same story cannot
     arrive twice, and the store is bounded and time limited. */
  function raise(alert) {
    if (state.alerts.some(function (a) { return a.key === alert.key; })) return false;
    state.alerts.unshift(alert);
    if (state.alerts.length > C.holdings.maxAlerts) state.alerts.length = C.holdings.maxAlerts;
    return true;
  }

  function scan(items) {
    if (!state.rows.length) return { fresh: 0, alerts: state.alerts.slice() };
    var fresh = 0, now = Math.floor(Date.now() / 1000);

    matchNews(items).forEach(function (m) {
      var n = m.item, r = m.holding;
      var strong = n.impact === 'high' ||
                   Math.abs(n.sentiment || 0) >= C.holdings.newsSentimentAlert ||
                   n.kind === 'filing';
      if (!strong) return;
      if (raise({
        key: 'n:' + r.symbol + ':' + (n.key || core.keyOf(n.headline)),
        ts: n.ts || now, kind: n.kind === 'filing' ? 'filing' : 'news',
        symbol: r.symbol, name: r.name,
        headline: n.headline, source: n.source, url: n.url || '',
        sentiment: n.sentiment || 0, impact: n.impact || 'low',
        severity: n.impact === 'high' ? 'high' : Math.abs(n.sentiment || 0) >= 2 ? 'high' : 'medium',
      })) fresh++;
    });

    // Price alerts are bucketed by day so one bad session raises one alert and
    // not one per poll.
    var day = new Date().toISOString().slice(0, 10);
    state.rows.forEach(function (r) {
      var q = state.quotes[r.symbol];
      if (!q || q.changePct == null) return;
      if (Math.abs(q.changePct) >= C.holdings.movePctAlert) {
        if (raise({
          key: 'p:' + r.symbol + ':' + day + ':' + (q.changePct > 0 ? 'up' : 'dn'),
          ts: now, kind: 'price', symbol: r.symbol, name: r.name,
          headline: r.name + ' is ' + core.fmt.pct(q.changePct) + ' today at ' + core.fmt.price(q.price),
          source: 'price', url: '', sentiment: q.changePct > 0 ? 1 : -1,
          impact: 'medium', severity: Math.abs(q.changePct) >= C.holdings.movePctAlert * 2 ? 'high' : 'medium',
        })) fresh++;
      }
      if (q.week52High && q.price && q.price >= q.week52High * 0.999) {
        if (raise({ key: 'h:' + r.symbol + ':' + day, ts: now, kind: 'level', symbol: r.symbol, name: r.name,
          headline: r.name + ' is at a 52 week high (' + core.fmt.price(q.price) + ')',
          source: 'price', url: '', sentiment: 1, impact: 'medium', severity: 'medium' })) fresh++;
      }
      if (q.week52Low && q.price && q.price <= q.week52Low * 1.001) {
        if (raise({ key: 'l:' + r.symbol + ':' + day, ts: now, kind: 'level', symbol: r.symbol, name: r.name,
          headline: r.name + ' is at a 52 week low (' + core.fmt.price(q.price) + ')',
          source: 'price', url: '', sentiment: -1, impact: 'medium', severity: 'high' })) fresh++;
      }
    });

    if (fresh) persist();
    state.lastMatch = now;
    return { fresh: fresh, alerts: state.alerts.slice() };
  }

  function alerts() { return state.alerts.slice(); }
  function dismiss(key) {
    state.alerts = state.alerts.filter(function (a) { return a.key !== key; });
    persist();
  }
  function dismissAll() { state.alerts = []; persist(); }

  /* Headlines that touch the book, whether or not they cleared the alert bar -
     this is the "news for my stocks" list, as opposed to the alert feed. */
  function relatedNews(items, limit) {
    var seen = {}, out = [];
    matchNews(items).forEach(function (m) {
      var k = (m.item.key || m.item.headline) + '|' + m.holding.symbol;
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ symbol: m.holding.symbol, name: m.holding.name, item: m.item });
    });
    out.sort(function (a, b) { return (b.item.ts || 0) - (a.item.ts || 0); });
    return out.slice(0, limit || 40);
  }

  function exportJson() {
    return JSON.stringify({ kind: 'kt-holdings', version: 1, exported: new Date().toISOString(), rows: state.rows }, null, 2);
  }
  function importJson(text) {
    var parsed = JSON.parse(text);
    var incoming = Array.isArray(parsed) ? parsed : parsed.rows;
    if (!Array.isArray(incoming)) throw new Error('That file has no holdings in it.');
    var added = 0;
    incoming.forEach(function (r) {
      if (!valid(r)) return;
      try { add(r); added++; } catch (e) {}
    });
    return added;
  }

  KT.portfolio = {
    load: load, rows: rows, add: add, remove: remove, clear: clear,
    setUniverse: setUniverse, universeList: universeList, nameFor: nameFor,
    setQuotes: setQuotes, refreshMissing: refreshMissing, quotes: function () { return state.quotes; },
    valuation: valuation, scan: scan, alerts: alerts, dismiss: dismiss, dismissAll: dismissAll,
    relatedNews: relatedNews, matchNews: matchNews,
    exportJson: exportJson, importJson: importJson,
    count: function () { return state.rows.length; },
  };
})(window.KT);
