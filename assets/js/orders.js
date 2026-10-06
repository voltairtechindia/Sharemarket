/* ============================================================================
   Orders: every buy and every sell, and the positions they add up to.

   The holdings book this replaces stored one averaged line per stock, which
   is how a broker's holdings screen looks and is not how money moves. A line
   that says "100 @ 812" cannot tell you that 40 of those were bought in March
   at 640 and sold in June at 930, that the sale realised a profit, or how
   long the rest have been held. So the record here is the orders themselves,
   and the positions are computed from them.

   Matching is FIFO - the first shares bought are the first sold - because
   that is how Indian capital-gains holding periods are counted, and it is
   what a contract note reconciles against. A sell larger than the open long
   opens a short for the remainder, and a buy against a short covers it
   first, so an intraday short round-trip books correctly too.

   Storage rule, same as the journal and the old holdings book: this browser
   only. Never uploaded, never written to the repo, never sent to a model.
   Export and import are there so the record can be moved by its owner.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;
  var KEY = 'orders', META = 'orderMeta', PROFILE = 'profile', MIGRATED = 'ordersMigrated';

  var state = { orders: [], meta: {}, profile: {} };

  /* ------------------------------------------------------------- storage */
  function load() {
    var raw = core.store.get(KEY, null);
    state.orders = Array.isArray(raw) ? raw.filter(valid) : [];
    state.meta = core.store.get(META, {}) || {};
    state.profile = core.store.get(PROFILE, {}) || {};
    if (raw === null && !core.store.get(MIGRATED, false)) migrateHoldings();
    return state.orders;
  }
  function persist() {
    core.store.set(KEY, state.orders);
    core.store.set(META, state.meta);
  }
  function valid(o) {
    return o && typeof o.symbol === 'string' && o.symbol &&
           (o.side === 'BUY' || o.side === 'SELL') && o.qty > 0 && o.price > 0;
  }

  /* The old book stored one averaged line per stock. Each becomes a single
     order at its average price and date, which is all the old record knew -
     the import says so in the note rather than inventing lot history. */
  function migrateHoldings() {
    var old = core.store.get('holdings', []);
    var made = 0;
    (Array.isArray(old) ? old : []).forEach(function (h) {
      if (!h || !h.symbol || !isFinite(h.qty) || !isFinite(h.avgPrice) || !h.qty || h.avgPrice <= 0) return;
      state.orders.push(build({
        symbol: h.symbol, exchange: h.exchange, side: h.qty > 0 ? 'BUY' : 'SELL',
        qty: Math.abs(h.qty), price: h.avgPrice, date: h.date,
        note: (h.note ? h.note + ' · ' : '') + 'moved from the holdings book (averaged line)',
      }));
      made++;
    });
    core.store.set(MIGRATED, true);
    if (made) persist();
    return made;
  }

  function cleanSymbol(s) {
    return String(s || '').trim().toUpperCase().replace(/^NSE:|^BSE:/, '').replace(/[^A-Z0-9&.\-]/g, '');
  }
  function todayIso() {
    var d = core.fmt.ist();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function build(o) {
    var sym = cleanSymbol(o.symbol);
    if (!sym) throw new Error('A symbol is required.');
    var qty = Number(o.qty), price = Number(o.price), charges = Number(o.charges || 0);
    if (!isFinite(qty) || qty <= 0) throw new Error('Quantity must be above zero.');
    if (!isFinite(price) || price <= 0) throw new Error('Price must be above zero.');
    if (!isFinite(charges) || charges < 0) throw new Error('Charges cannot be negative.');
    var side = String(o.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    var date = /^\d{4}-\d{2}-\d{2}$/.test(o.date || '') ? o.date : todayIso();
    if (date > todayIso()) throw new Error('An order cannot be dated in the future.');
    return {
      id: o.id || ('o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      symbol: sym,
      exchange: o.exchange === 'BSE' ? 'BSE' : 'NSE',
      side: side, qty: qty, price: price, charges: charges,
      date: date, time: /^\d{2}:\d{2}$/.test(o.time || '') ? o.time : '',
      product: o.product === 'MIS' ? 'MIS' : 'CNC',
      tag: String(o.tag || '').slice(0, 40),
      note: String(o.note || '').slice(0, 240),
      created: o.created || Date.now(),
    };
  }

  function add(o) {
    var row = build(o);
    state.orders.push(row);
    persist();
    return row;
  }
  function update(id, patch) {
    var i = indexOf(id);
    if (i < 0) throw new Error('No such order.');
    var merged = {};
    Object.keys(state.orders[i]).forEach(function (k) { merged[k] = state.orders[i][k]; });
    Object.keys(patch || {}).forEach(function (k) { merged[k] = patch[k]; });
    state.orders[i] = build(merged);
    persist();
    return state.orders[i];
  }
  function remove(id) {
    state.orders = state.orders.filter(function (o) { return o.id !== id; });
    persist();
  }
  function removeSymbol(symbol, exchange) {
    var s = cleanSymbol(symbol);
    state.orders = state.orders.filter(function (o) {
      return !(o.symbol === s && (!exchange || o.exchange === exchange));
    });
    delete state.meta[s];
    persist();
  }
  function clear() { state.orders = []; state.meta = {}; persist(); }
  function indexOf(id) {
    for (var i = 0; i < state.orders.length; i++) if (state.orders[i].id === id) return i;
    return -1;
  }
  function all() { return sorted(state.orders.slice()); }
  function count() { return state.orders.length; }

  function sorted(list) {
    return list.sort(function (a, b) {
      var ka = a.date + ' ' + (a.time || '00:00'), kb = b.date + ' ' + (b.time || '00:00');
      return ka < kb ? -1 : ka > kb ? 1 : a.created - b.created;
    });
  }

  /* -------------------------------------------------------- per-stock meta
     A target and a stop the owner sets on a position, and why they hold it.
     Alerts fire against these. */
  function meta(symbol) { return state.meta[cleanSymbol(symbol)] || {}; }
  function setMeta(symbol, m) {
    var s = cleanSymbol(symbol);
    var cur = state.meta[s] || {};
    ['target', 'stop'].forEach(function (k) {
      if (!(k in m)) return;
      var v = m[k] === '' || m[k] == null ? null : Number(m[k]);
      cur[k] = v != null && isFinite(v) && v > 0 ? v : null;
    });
    if ('thesis' in m) cur.thesis = String(m.thesis || '').slice(0, 300);
    state.meta[s] = cur;
    persist();
    return cur;
  }

  function profile() { return state.profile; }
  function setProfile(p) {
    state.profile = {
      name: String(p.name || '').slice(0, 60),
      style: String(p.style || '').slice(0, 30),
      horizon: String(p.horizon || '').slice(0, 30),
      broker: String(p.broker || '').slice(0, 40),
      since: state.profile.since || todayIso(),
    };
    core.store.set(PROFILE, state.profile);
    return state.profile;
  }

  /* ============================================================== FIFO book */
  function daysBetween(a, b) {
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  }

  /* quotes: { SYMBOL: { price, prevClose?, changePct?, sector?, ... } } */
  function book(quotes) {
    quotes = quotes || {};
    var groups = {};
    sorted(state.orders.slice()).forEach(function (o) {
      var k = o.symbol + '|' + o.exchange;
      (groups[k] = groups[k] || []).push(o);
    });

    var positions = [], closed = [], totals = {
      invested: 0, current: 0, unrealised: 0, realised: 0, charges: 0, dayChange: 0,
      longValue: 0, shortValue: 0, unpriced: 0, open: 0,
    };

    Object.keys(groups).forEach(function (k) {
      var list = groups[k], lots = [], realised = 0, charges = 0, buys = 0, sells = 0;
      var sym = list[0].symbol, exch = list[0].exchange;
      list.forEach(function (o) {
        charges += o.charges || 0;
        var q = o.qty, sign = o.side === 'BUY' ? 1 : -1;
        if (sign > 0) buys += q; else sells += q;
        // Close against open lots of the opposite sign first, oldest first.
        while (q > 1e-9 && lots.length && (lots[0].qty > 0 ? 1 : -1) !== sign) {
          var lot = lots[0], m = Math.min(q, Math.abs(lot.qty));
          var long = lot.qty > 0;
          var pnl = long ? (o.price - lot.price) * m : (lot.price - o.price) * m;
          realised += pnl;
          closed.push({
            symbol: sym, exchange: exch, side: long ? 'long' : 'short', qty: m,
            openDate: lot.date, closeDate: o.date, openPrice: lot.price, closePrice: o.price,
            pnl: round2(pnl), pnlPct: round2((long ? o.price / lot.price - 1 : lot.price / o.price - 1) * 100),
            days: daysBetween(lot.date, o.date),
            // Twelve months or more is long-term for listed equity in India.
            term: daysBetween(lot.date, o.date) >= 365 ? 'long-term' : 'short-term',
            openId: lot.id, closeId: o.id,
          });
          lot.qty = long ? lot.qty - m : lot.qty + m;
          q -= m;
          if (Math.abs(lot.qty) < 1e-9) lots.shift();
        }
        if (q > 1e-9) lots.push({ qty: sign * q, price: o.price, date: o.date, id: o.id });
      });

      var net = lots.reduce(function (s, l) { return s + l.qty; }, 0);
      var absQty = lots.reduce(function (s, l) { return s + Math.abs(l.qty); }, 0);
      var cost = lots.reduce(function (s, l) { return s + Math.abs(l.qty) * l.price; }, 0);
      var avg = absQty ? cost / absQty : null;
      var q = quotes[sym] || {};
      var ltp = q.price != null && isFinite(q.price) ? q.price : null;
      var prev = q.prevClose != null ? q.prevClose
               : (ltp != null && q.changePct != null ? ltp / (1 + q.changePct / 100) : null);
      var unreal = ltp != null && avg != null ? (ltp - avg) * net : null;
      var value = ltp != null ? ltp * net : null;
      var oldest = lots.length ? lots[0].date : null;

      totals.realised += realised;
      totals.charges += charges;
      if (Math.abs(net) > 1e-9) {
        totals.open++;
        totals.invested += cost;
        if (value != null) {
          totals.current += value;
          totals.unrealised += unreal;
          if (net > 0) totals.longValue += value; else totals.shortValue += -value;
        } else {
          totals.current += net > 0 ? cost : -cost;   // unpriced lines held at cost
          totals.unpriced++;
        }
        if (prev != null && ltp != null) totals.dayChange += (ltp - prev) * net;
      }
      positions.push({
        symbol: sym, exchange: exch, qty: round4(net), avgPrice: avg != null ? round2(avg) : null,
        invested: round2(cost), ltp: ltp, value: value != null ? round2(value) : null,
        unrealised: unreal != null ? round2(unreal) : null,
        unrealisedPct: unreal != null && cost ? round2(unreal / cost * 100) : null,
        realised: round2(realised), charges: round2(charges),
        dayChange: prev != null && ltp != null ? round2((ltp - prev) * net) : null,
        dayPct: q.changePct != null ? q.changePct : null,
        lots: lots.map(function (l) { return { qty: l.qty, price: l.price, date: l.date, days: daysBetween(l.date, todayIso()) }; }),
        oldest: oldest, heldDays: oldest ? daysBetween(oldest, todayIso()) : null,
        orders: list.length, bought: buys, sold: sells,
        open: Math.abs(net) > 1e-9, short: net < -1e-9,
        sector: q.sector || null, quote: q, meta: meta(sym),
      });
    });

    positions.sort(function (a, b) {
      if (a.open !== b.open) return a.open ? -1 : 1;
      return Math.abs(b.value != null ? b.value : b.invested) - Math.abs(a.value != null ? a.value : a.invested);
    });
    closed.sort(function (a, b) { return a.closeDate < b.closeDate ? 1 : -1; });

    var openPos = positions.filter(function (p) { return p.open; });
    var gross = openPos.reduce(function (s, p) { return s + Math.abs(p.value != null ? p.value : p.invested); }, 0);
    openPos.forEach(function (p) {
      p.weightPct = gross ? round2(Math.abs(p.value != null ? p.value : p.invested) / gross * 100) : null;
    });

    var t = totals;
    var out = {
      positions: positions, open: openPos, closed: closed,
      invested: round2(t.invested), current: round2(t.current),
      unrealised: round2(t.unrealised), unrealisedPct: t.invested ? round2(t.unrealised / t.invested * 100) : null,
      realised: round2(t.realised), charges: round2(t.charges),
      netRealised: round2(t.realised - t.charges),
      totalPnl: round2(t.unrealised + t.realised - t.charges),
      dayChange: round2(t.dayChange), unpriced: t.unpriced, openCount: t.open,
      longValue: round2(t.longValue), shortValue: round2(t.shortValue),
      sectors: sectorsOf(openPos),
      winRate: closed.length ? round2(closed.filter(function (c) { return c.pnl > 0; }).length / closed.length * 100) : null,
    };
    out.xirr = xirr(cashflows(out));
    return out;
  }

  function sectorsOf(open) {
    var by = {}, tot = 0;
    open.forEach(function (p) {
      var v = Math.abs(p.value != null ? p.value : p.invested);
      var k = p.sector || 'Unclassified';
      by[k] = (by[k] || 0) + v; tot += v;
    });
    return Object.keys(by).map(function (k) { return { sector: k, value: round2(by[k]), pct: tot ? round2(by[k] / tot * 100) : 0 }; })
      .sort(function (a, b) { return b.value - a.value; });
  }

  /* ================================================================ XIRR
     The annualised return on the money actually put in, when it was put in -
     the number a mutual fund statement prints, and the only return figure
     that does not flatter a portfolio built up over time. Buys are outflows,
     sells inflows, and whatever is still open is valued at today's price as a
     final inflow. */
  function cashflows(b) {
    var flows = [];
    sorted(state.orders.slice()).forEach(function (o) {
      var amt = o.qty * o.price;
      flows.push({ date: o.date, amt: o.side === 'BUY' ? -(amt + (o.charges || 0)) : (amt - (o.charges || 0)) });
    });
    if (b && b.open && b.open.length) flows.push({ date: todayIso(), amt: b.current });
    return flows;
  }

  function xirr(flows) {
    if (!flows || flows.length < 2) return null;
    var pos = flows.some(function (f) { return f.amt > 0; }), neg = flows.some(function (f) { return f.amt < 0; });
    if (!pos || !neg) return null;
    var d0 = Date.parse(flows[0].date + 'T00:00:00Z');
    var span = (Date.parse(flows[flows.length - 1].date + 'T00:00:00Z') - d0) / 86400000;
    // Under a month, an annualised rate is a large number describing nothing.
    if (span < 30) return null;
    function npv(r) {
      return flows.reduce(function (s, f) {
        var t = (Date.parse(f.date + 'T00:00:00Z') - d0) / 86400000 / 365;
        return s + f.amt / Math.pow(1 + r, t);
      }, 0);
    }
    var lo = -0.99, hi = 10, flo = npv(lo), fhi = npv(hi);
    if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2, fm = npv(mid);
      if (Math.abs(fm) < 1e-6) { lo = hi = mid; break; }
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return round2((lo + hi) / 2 * 100);
  }

  /* ======================================================== alerts
     Fired against the owner's own levels: a target reached, a stop broken,
     or a move big enough to look at. Keyed per day so a position sitting
     past its target raises one alert, not one a minute. */
  function alertsFor(b) {
    var out = [], day = todayIso();
    (b.open || []).forEach(function (p) {
      var m = p.meta || {}, ltp = p.ltp;
      if (ltp == null) return;
      var long = p.qty > 0;
      if (m.target && (long ? ltp >= m.target : ltp <= m.target)) {
        out.push({ key: 't:' + p.symbol + ':' + day, symbol: p.symbol, kind: 'target', severity: 'medium',
                   text: p.symbol + ' reached your target ' + core.fmt.price(m.target) + ' (now ' + core.fmt.price(ltp) + ')' });
      }
      if (m.stop && (long ? ltp <= m.stop : ltp >= m.stop)) {
        out.push({ key: 's:' + p.symbol + ':' + day, symbol: p.symbol, kind: 'stop', severity: 'high',
                   text: p.symbol + ' crossed your stop ' + core.fmt.price(m.stop) + ' (now ' + core.fmt.price(ltp) + ')' });
      }
      var mv = C.holdings ? C.holdings.movePctAlert : 2.5;
      if (p.dayPct != null && Math.abs(p.dayPct) >= mv) {
        out.push({ key: 'm:' + p.symbol + ':' + day + ':' + (p.dayPct > 0 ? 'u' : 'd'), symbol: p.symbol, kind: 'move',
                   severity: Math.abs(p.dayPct) >= mv * 2 ? 'high' : 'medium',
                   text: p.symbol + ' is ' + core.fmt.pct(p.dayPct) + ' today' });
      }
      if (p.quote && p.quote.week52High && ltp >= p.quote.week52High * 0.999) {
        out.push({ key: 'h:' + p.symbol + ':' + day, symbol: p.symbol, kind: 'level', severity: 'medium',
                   text: p.symbol + ' is at a 52-week high' });
      }
      if (p.quote && p.quote.week52Low && ltp <= p.quote.week52Low * 1.001) {
        out.push({ key: 'l:' + p.symbol + ':' + day, symbol: p.symbol, kind: 'level', severity: 'high',
                   text: p.symbol + ' is at a 52-week low' });
      }
    });
    return out;
  }

  /* The terminal's holdings panel and news matcher read positions in the
     shape the old book used, so one source of truth serves both pages. */
  function asHoldings() {
    return book({}).open.map(function (p) {
      return { id: 'pos:' + p.symbol + ':' + p.exchange, symbol: p.symbol, exchange: p.exchange,
               name: (KT.portfolio && KT.portfolio.nameFor && KT.portfolio.nameFor(p.symbol)) || p.symbol,
               qty: p.qty, avgPrice: p.avgPrice, date: p.oldest, note: (p.meta && p.meta.thesis) || '' };
    });
  }

  /* ---------------------------------------------------------- export */
  function exportJson() {
    return JSON.stringify({ kind: 'kt-orders', version: 1, exported: new Date().toISOString(),
                            profile: state.profile, meta: state.meta, orders: sorted(state.orders.slice()) }, null, 2);
  }
  function exportCsv() {
    var head = ['date', 'time', 'symbol', 'exchange', 'side', 'qty', 'price', 'charges', 'product', 'tag', 'note'];
    var rows = sorted(state.orders.slice()).map(function (o) {
      return head.map(function (h) {
        var v = o[h] == null ? '' : String(o[h]);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    });
    return head.join(',') + '\n' + rows.join('\n') + '\n';
  }
  function importJson(text) {
    var parsed = JSON.parse(text);
    var list = Array.isArray(parsed) ? parsed : (parsed.orders || null);
    var added = 0;
    if (!list && parsed && Array.isArray(parsed.rows)) {
      // A holdings-book export: one averaged line per stock.
      list = parsed.rows.map(function (h) {
        return { symbol: h.symbol, exchange: h.exchange, side: h.qty > 0 ? 'BUY' : 'SELL',
                 qty: Math.abs(h.qty), price: h.avgPrice, date: h.date, note: h.note };
      });
    }
    if (!Array.isArray(list)) throw new Error('That file has no orders in it.');
    var have = {};
    state.orders.forEach(function (o) { have[o.id] = 1; });
    list.forEach(function (o) {
      if (o.id && have[o.id]) return;
      try { state.orders.push(build(o)); added++; } catch (e) { /* skip bad rows */ }
    });
    if (parsed && parsed.meta && typeof parsed.meta === 'object') {
      Object.keys(parsed.meta).forEach(function (k) { if (!state.meta[k]) state.meta[k] = parsed.meta[k]; });
    }
    persist();
    return added;
  }
  /* Broker tradebook CSVs differ by broker; this reads the common shape -
     a header row naming symbol, side/type, quantity, price and date in any
     order - which covers Zerodha's tradebook and most others. */
  function importCsv(text) {
    var lines = String(text || '').split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) throw new Error('That file has no rows.');
    function split(line) {
      var out = [], cur = '', q = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
        else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
      }
      out.push(cur);
      return out.map(function (x) { return x.trim(); });
    }
    var head = split(lines[0]).map(function (h) { return h.toLowerCase(); });
    function find(names) {
      for (var i = 0; i < names.length; i++) { var j = head.indexOf(names[i]); if (j >= 0) return j; }
      return -1;
    }
    var cS = find(['symbol', 'tradingsymbol', 'scrip', 'stock']), cSide = find(['side', 'trade_type', 'type', 'buy/sell', 'transaction type']);
    var cQ = find(['qty', 'quantity']), cP = find(['price', 'trade price', 'rate', 'avg price']);
    var cD = find(['date', 'trade_date', 'trade date', 'order_execution_time']);
    var cX = find(['exchange']), cC = find(['charges', 'brokerage']), cN = find(['note', 'notes']);
    if (cS < 0 || cSide < 0 || cQ < 0 || cP < 0) throw new Error('Need columns for symbol, side, quantity and price.');
    var added = 0;
    lines.slice(1).forEach(function (l) {
      var c = split(l);
      var d = cD >= 0 ? String(c[cD] || '') : '';
      var iso = /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10)
              : (/^(\d{2})[-\/](\d{2})[-\/](\d{4})/.exec(d) ? d.replace(/^(\d{2})[-\/](\d{2})[-\/](\d{4}).*/, '$3-$2-$1') : '');
      try {
        state.orders.push(build({
          symbol: c[cS], side: /^s/i.test(c[cSide] || '') ? 'SELL' : 'BUY',
          qty: c[cQ], price: c[cP], date: iso, exchange: cX >= 0 ? c[cX] : 'NSE',
          charges: cC >= 0 ? c[cC] : 0, note: cN >= 0 ? c[cN] : 'imported from CSV',
        }));
        added++;
      } catch (e) { /* skip the row */ }
    });
    persist();
    return added;
  }

  function round2(n) { return Math.round(n * 100) / 100; }
  function round4(n) { return Math.round(n * 10000) / 10000; }

  KT.orders = {
    load: load, add: add, update: update, remove: remove, removeSymbol: removeSymbol, clear: clear,
    all: all, count: count, book: book, xirr: xirr, cashflows: cashflows, alertsFor: alertsFor,
    meta: meta, setMeta: setMeta, profile: profile, setProfile: setProfile,
    asHoldings: asHoldings, exportJson: exportJson, exportCsv: exportCsv,
    importJson: importJson, importCsv: importCsv, cleanSymbol: cleanSymbol, todayIso: todayIso,
    migrateHoldings: migrateHoldings,
  };
})(window.KT);
