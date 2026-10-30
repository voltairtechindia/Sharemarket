/* ============================================================================
   Any NSE stock.

   The forecast was built around NIFTY: nine lanes, the option chain, the
   seasonal study and the opening-gap model are all about the index. This file
   is what lets the same engine run on any of the ~2,600 NSE names in
   data/universe.json, and it is careful about which parts carry over.

     carries over   price action (momentum, structure, levels, the band and
                    its volatility model) - computed from the stock's own
                    candles, so it is the stock's own read
                    the market backdrop (global cues, FII/DII, breadth) - the
                    same numbers, because they are the same market
     does not       the NIFTY option chain and NIFTY's seasonal study, which
                    say nothing about one company; both lanes go dark
     changes        the news lane reads headlines that name the company first,
                    with macro stories behind them (forecast.js setFocus), and
                    the opening gap is scaled by the stock's beta when the
                    screener has one

   Prices come from TradingView's screener: one direct request, no proxy, no
   key. NSE rows on it are fifteen minutes delayed and the page says so; the
   candles come from Yahoo through the proxy chain like the index's do.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;

  /* Words that are a company's name only in combination. "Bank" is not a
     company; "Bandhan Bank" is. Same rule streetcalls.js applies. */
  var GENERIC = /^(india|indian|bank|banks|finance|financial|capital|power|energy|steel|cement|pharma|chemicals?|industries|industry|technologies|technology|tech|infra|infrastructure|motors?|auto|holdings?|enterprises?|services|international|global|limited|ltd|the|group|life|general|insurance|products|foods?|textiles?|paper|sugar|ports?|gas|oil|metals?|mines?|minerals?|realty|housing|homes?|consumer|retail|media|digital|systems|solutions|labs?|health|healthcare|hospitals?|electric|electricals|engineering|projects|exports?|trading|investments?|ventures|corporation|corp|company|co|national|new|first|united|western|eastern|southern|northern|bharat|hindustan|asian)$/i;

  /* The names headlines actually use for the biggest companies, where the
     universe file's generated aliases are not what a reporter writes. */
  var BRANDS = {
    RELIANCE: ['RIL', 'Reliance Industries', 'Reliance Jio', 'Jio Platforms', 'Reliance Retail'],
    HDFCBANK: ['HDFC Bank'], ICICIBANK: ['ICICI Bank'], AXISBANK: ['Axis Bank'],
    SBIN: ['SBI', 'State Bank of India'], KOTAKBANK: ['Kotak Mahindra Bank', 'Kotak Bank'],
    INDUSINDBK: ['IndusInd Bank'], BAJFINANCE: ['Bajaj Finance'], BAJAJFINSV: ['Bajaj Finserv'],
    INFY: ['Infosys'], TCS: ['TCS', 'Tata Consultancy Services'], WIPRO: ['Wipro'],
    HCLTECH: ['HCL Tech', 'HCLTech', 'HCL Technologies'], TECHM: ['Tech Mahindra'], LTIM: ['LTIMindtree'],
    LT: ['L&T', 'Larsen & Toubro', 'Larsen and Toubro'], BHARTIARTL: ['Bharti Airtel', 'Airtel'],
    ITC: ['ITC'], HINDUNILVR: ['HUL', 'Hindustan Unilever'], NESTLEIND: ['Nestle India'],
    MARUTI: ['Maruti Suzuki', 'Maruti'], 'M&M': ['Mahindra & Mahindra', 'M&M'],
    TATAMOTORS: ['Tata Motors', 'Jaguar Land Rover', 'JLR'], TATASTEEL: ['Tata Steel'],
    JSWSTEEL: ['JSW Steel'], HINDALCO: ['Hindalco'], COALINDIA: ['Coal India'], ONGC: ['ONGC'],
    NTPC: ['NTPC'], POWERGRID: ['Power Grid'], SUNPHARMA: ['Sun Pharma'], DRREDDY: ["Dr Reddy's", 'Dr Reddys'],
    CIPLA: ['Cipla'], ASIANPAINT: ['Asian Paints'], TITAN: ['Titan'], ULTRACEMCO: ['UltraTech Cement', 'UltraTech'],
    ADANIENT: ['Adani Enterprises'], ADANIPORTS: ['Adani Ports'], ADANIGREEN: ['Adani Green'],
    HAL: ['HAL', 'Hindustan Aeronautics'], BEL: ['BEL', 'Bharat Electronics'], IRCTC: ['IRCTC'],
    LICI: ['LIC', 'Life Insurance Corporation'], DMART: ['DMart', 'Avenue Supermarts'],
    PAYTM: ['Paytm', 'One 97'], NYKAA: ['Nykaa'], POLICYBZR: ['Policybazaar', 'PB Fintech'],
    ETERNAL: ['Zomato', 'Eternal', 'Blinkit'], JIOFIN: ['Jio Financial'], TRENT: ['Trent'],
    BAJAJ_AUTO: ['Bajaj Auto'], 'BAJAJ-AUTO': ['Bajaj Auto'], HEROMOTOCO: ['Hero MotoCorp'],
    EICHERMOT: ['Eicher Motors', 'Royal Enfield'], GRASIM: ['Grasim'], SHRIRAMFIN: ['Shriram Finance'],
    APOLLOHOSP: ['Apollo Hospitals'], BRITANNIA: ['Britannia'], TATACONSUM: ['Tata Consumer'],
    VEDL: ['Vedanta'], IOC: ['Indian Oil', 'IOC'], BPCL: ['BPCL', 'Bharat Petroleum'], GAIL: ['GAIL'],
    YESBANK: ['Yes Bank'], PNB: ['Punjab National Bank', 'PNB'], BANKBARODA: ['Bank of Baroda'],
    IDEA: ['Vodafone Idea', 'Vi'], SUZLON: ['Suzlon'], IREDA: ['IREDA'], IRFC: ['IRFC'],
  };

  var MACRO_RX = /\b(rbi|repo rate|monetary policy|mpc|inflation|cpi|wpi|gdp|fiscal deficit|budget|rupee|usd\/?inr|crude|brent|fed|fomc|federal reserve|tariffs?|trade deal|fii|fpi|dii|foreign investors|nifty|sensex|bank nifty|indian (?:markets?|equities|stocks)|dalal street|stock market|sebi)\b/i;

  var U = { list: [], bySym: {}, owners: {}, ready: false };
  var matchers = {};
  /* Index membership, as a tiebreak in search: typing "reli" should offer
     Reliance Industries before Reliable Data Services. Fed from
     constituents.json by app.js; empty until then, which only means
     alphabetical ties. */
  var POPULAR = {};
  function setPopular(payload) {
    POPULAR = {};
    ((payload && payload.members) || []).forEach(function (m) {
      if (!m || !m.symbol) return;
      var t = m.tiers || [];
      POPULAR[String(m.symbol).toUpperCase()] = t.indexOf('nifty50') !== -1 ? 12 : t.indexOf('bank') !== -1 ? 8 : 6;
    });
    return Object.keys(POPULAR).length;
  }

  function escRx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function clean(sym) { return String(sym || '').toUpperCase().replace(/[^A-Z0-9&_-]/g, '').slice(0, 20); }

  /* Every name a company answers to, each with how it is matched. A ticker,
     or a short name in capitals (RIL, HUL, SBI), is matched case-sensitively:
     headlines print those in capitals, and FOCUS or TIMES in lower case is a
     word. Anything longer is matched in any case. The two are different
     matchers, so RELIANCE (the ticker) and "Reliance" (a name six companies
     share) are kept apart rather than deduplicated into one. */
  function nameKey(n) { return n.cs ? 'cs:' + n.a : n.a.toLowerCase(); }
  function namesOf(row) {
    var raw = [row.symbol];
    if (row.short && row.short.toUpperCase() !== row.symbol) raw.push(row.short);
    (row.aliases || []).forEach(function (a) { raw.push(a); });
    (BRANDS[row.symbol] || []).forEach(function (a) { raw.push(a); });
    var seen = {}, out = [];
    raw.forEach(function (a) {
      a = String(a || '').trim();
      // Two-letter tickers (LT, PI) are words in other names ("LT Foods");
      // those companies are found by their names instead.
      if (a.length < 3) return;
      if (GENERIC.test(a)) return;
      var n = { a: a, cs: a === row.symbol || (a.length <= 4 && a === a.toUpperCase()) };
      var k = nameKey(n);
      if (seen[k]) return;
      seen[k] = 1;
      out.push(n);
    });
    return out;
  }

  function setUniverse(u) {
    var rows = (u && (u.symbols || u)) || [];
    if (!Array.isArray(rows)) return 0;
    U = { list: [], bySym: {}, owners: {}, ready: false };
    matchers = {};
    rows.forEach(function (r) {
      if (!r || !r.symbol) return;
      var sym = clean(r.symbol);
      var name = String(r.name || sym);
      var row = {
        symbol: sym, name: name,
        short: name.replace(/\s+(limited|ltd\.?)$/i, '').trim(),
        aliases: (r.aliases || []).map(String), sector: r.sector || null,
      };
      row.hay = (sym + ' ' + name + ' ' + row.aliases.join(' ')).toLowerCase();
      U.list.push(row);
      U.bySym[sym] = row;
    });
    // Who answers to each name. A name two companies share identifies a group.
    U.list.forEach(function (row) {
      namesOf(row).forEach(function (n) {
        var k = nameKey(n);
        (U.owners[k] = U.owners[k] || {})[row.symbol] = 1;
      });
    });
    U.ready = U.list.length > 0;
    return U.list.length;
  }

  function lookup(sym) { return U.bySym[clean(sym)] || null; }

  /* --------------------------------------------------------- registration
     A stock becomes a symbol the rest of the page can open: same shape as
     the index entries in config.js, marked stock:true so the quote loop, the
     learner and the option lane know to treat it differently. */
  function register(sym) {
    sym = clean(sym);
    if (!sym) return null;
    if (C.symbols[sym]) return sym;
    var row = U.bySym[sym];
    if (!row && U.ready) return null;          // not an NSE symbol we know
    C.symbols[sym] = {
      key: sym, label: sym, name: row ? row.name : sym,
      exchange: 'NSE', yahoo: sym + '.NS', mcId: null, primary: false,
      stock: true, sector: row ? row.sector : null,
    };
    return sym;
  }
  function isStock(key) { return !!(key && C.symbols[key] && C.symbols[key].stock); }

  /* --------------------------------------------------------------- search */
  var INDICES = [
    { symbol: 'NIFTY', name: 'NIFTY 50 index', hay: 'nifty nifty 50 nifty50 index nse', index: true },
    { symbol: 'SENSEX', name: 'BSE SENSEX index', hay: 'sensex bse index', index: true },
  ];
  function search(q, limit) {
    q = String(q || '').trim();
    if (!q) return [];
    var low = q.toLowerCase(), up = q.toUpperCase().replace(/\s+/g, '');
    var out = [];
    function scoreOf(r) {
      var s = 0;
      if (r.symbol === up) s = 100;
      else if (r.symbol.indexOf(up) === 0) s = 80 - Math.min(20, r.symbol.length - up.length);
      else if ((r.name || '').toLowerCase().indexOf(low) === 0) s = 70;
      else if ((' ' + (r.name || '').toLowerCase()).indexOf(' ' + low) !== -1) s = 60;
      else if (r.hay && r.hay.indexOf(low) !== -1) s = 35;
      return s;
    }
    INDICES.forEach(function (r) { var s = scoreOf(r); if (s) out.push({ symbol: r.symbol, name: r.name, index: true, score: s + 5 }); });
    for (var i = 0; i < U.list.length; i++) {
      var r = U.list[i], s = scoreOf(r);
      // An exact ticker always wins; below that, index members rank higher.
      if (s) out.push({ symbol: r.symbol, name: r.name, sector: r.sector, score: s + (s < 100 ? (POPULAR[r.symbol] || 0) : 0) });
    }
    out.sort(function (a, b) { return b.score - a.score || a.symbol.length - b.symbol.length || (a.symbol < b.symbol ? -1 : 1); });
    return out.slice(0, limit || 8);
  }

  /* ------------------------------------------------------------- headlines */
  function matcherFor(sym) {
    sym = clean(sym);
    if (matchers[sym]) return matchers[sym];
    var row = U.bySym[sym] || { symbol: sym, name: sym, short: sym, aliases: [] };
    // The ticker is always this company's. Any other name only if no other
    // listed company answers to it too.
    var names = namesOf(row).filter(function (n) {
      if (n.a === row.symbol) return true;
      var o = U.owners[nameKey(n)];
      return !o || Object.keys(o).length === 1;
    });
    var rx = names.map(function (n) {
      return new RegExp('(?:^|[^A-Za-z0-9&])' + escRx(n.a) + '(?![A-Za-z0-9])', n.cs ? '' : 'i');
    });
    var m = {
      symbol: sym, names: names.map(function (n) { return n.a; }),
      test: function (txt) {
        var t = ' ' + String(txt || '') + ' ';
        for (var i = 0; i < rx.length; i++) if (rx[i].test(t)) return true;
        return false;
      },
    };
    matchers[sym] = m;
    return m;
  }
  function textOf(n) { return String(n.headline || '') + ' ' + String(n.summary || ''); }
  function newsFor(sym, items) {
    var m = matcherFor(sym);
    return (items || []).filter(function (n) { return n && n.headline && m.test(textOf(n)); });
  }
  /* What the forecast's news lane reads for a stock: the company's own
     stories, and the macro stories that move every stock with the market. */
  function forecastNews(sym, items) {
    var m = matcherFor(sym);
    return (items || []).filter(function (n) {
      if (!n || !n.headline) return false;
      var t = textOf(n);
      return m.test(t) || MACRO_RX.test(t);
    });
  }
  function focusFor(sym) {
    var m = matcherFor(sym);
    return { symbol: m.symbol, test: m.test, macro: MACRO_RX };
  }

  /* ---------------------------------------------------------------- quotes */
  var fundCache = {};       // sym -> { at, row }
  var extraCache = {};      // sym -> { at, row }
  var EXTRA_COLS = ['beta_1_year', 'earnings_release_next_date', 'industry', 'open'];

  function tvTicker(sym) { return 'NSE:' + String(sym).toUpperCase().replace(/-/g, '_'); }

  function fundamentals(sym, maxAgeMs) {
    sym = clean(sym);
    var hit = fundCache[sym];
    if (hit && Date.now() - hit.at < (maxAgeMs || 60000)) return Promise.resolve(hit.row);
    if (!KT.data || !KT.data.getStockQuotes) return Promise.resolve(hit ? hit.row : null);
    return KT.data.getStockQuotes([{ symbol: sym, exchange: 'NSE' }]).then(function (out) {
      var row = out && out[sym] ? out[sym] : null;
      if (row) {
        var ex = extraCache[sym] && extraCache[sym].row;
        if (ex) Object.keys(ex).forEach(function (k) { if (ex[k] != null) row[k] = ex[k]; });
        fundCache[sym] = { at: Date.now(), row: row };
      }
      return row || (hit ? hit.row : null);
    }).catch(function () { return hit ? hit.row : null; });
  }

  /* Columns that are useful and not yet measured against the screener from
     this origin. Asked for separately, once a day per stock, so an unknown
     field name can only cost this request and never the price above. */
  function extras(sym) {
    sym = clean(sym);
    var hit = extraCache[sym];
    if (hit && Date.now() - hit.at < 6 * 3600000) return Promise.resolve(hit.row);
    if (!KT.data || !KT.data.tvScan) return Promise.resolve(null);
    return KT.data.tvScan('india', { columns: EXTRA_COLS, symbols: { tickers: [tvTicker(sym)] } }, 8000)
      .then(function (j) {
        var d = j && j.data && j.data[0] && j.data[0].d;
        if (!d) return null;
        var row = {
          beta: isFinite(d[0]) ? +d[0] : null,
          nextEarnings: isFinite(d[1]) && d[1] > 0 ? +d[1] : null,
          industry: d[2] || null,
          open: isFinite(d[3]) ? +d[3] : null,
        };
        extraCache[sym] = { at: Date.now(), row: row };
        if (fundCache[sym]) Object.keys(row).forEach(function (k) { if (row[k] != null) fundCache[sym].row[k] = row[k]; });
        return row;
      })
      .catch(function () { extraCache[sym] = { at: Date.now(), row: null }; return null; });
  }

  // The same shape getLiveQuote() returns for an index, so renderQuote() and
  // everything after it needs no special case.
  function quote(sym) {
    sym = clean(sym);
    return fundamentals(sym, 15000).then(function (r) {
      if (!r || r.price == null) throw new Error('no quote for ' + sym);
      var prev = r.change != null ? r.price - r.change
               : (r.changePct != null ? r.price / (1 + r.changePct / 100) : null);
      return {
        symbol: sym, price: r.price, prevClose: prev != null ? Math.round(prev * 100) / 100 : null,
        change: r.change, changePct: r.changePct,
        open: r.open != null ? r.open : null, high: r.dayHigh, low: r.dayLow,
        dayHigh: r.dayHigh, dayLow: r.dayLow,
        week52High: r.week52High, week52Low: r.week52Low,
        returns: { '1w': r.perfW, '1m': r.perf1M, 'ytd': r.perfYtd },
        source: 'TradingView', delayMin: r.delay || 0, stock: true,
      };
    });
  }

  /* The opening gap the index model calls, scaled to this stock. Beta from
     the screener when it has one, clamped, because a beta of 3.4 on an
     illiquid name is a statement about its trading, not its sensitivity. */
  function gapScale(sym) {
    var f = fundCache[clean(sym)];
    var b = f && f.row && f.row.beta;
    if (b == null || !isFinite(b)) return 1;
    return Math.max(0.3, Math.min(2, b));
  }

  /* --------------------------------------------------------------- recents */
  var RECENT_KEY = 'v2Recent';
  function recent() {
    var r = core.store.get(RECENT_KEY, []);
    return Array.isArray(r) ? r.slice(0, 8) : [];
  }
  function remember(sym) {
    sym = clean(sym);
    if (!sym) return;
    var r = recent().filter(function (x) { return x !== sym; });
    r.unshift(sym);
    core.store.set(RECENT_KEY, r.slice(0, 8));
  }

  KT.stocks = {
    setUniverse: setUniverse, setPopular: setPopular, ready: function () { return U.ready; }, lookup: lookup,
    register: register, isStock: isStock, search: search, clean: clean,
    matcherFor: matcherFor, newsFor: newsFor, forecastNews: forecastNews, focusFor: focusFor,
    fundamentals: fundamentals, extras: extras, quote: quote, gapScale: gapScale,
    recent: recent, remember: remember, MACRO_RX: MACRO_RX,
  };
})(window.KT);
