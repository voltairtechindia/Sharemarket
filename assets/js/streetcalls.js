/* ============================================================================
   Street calls: the stock tips that are published, tracked.

   Brokers and market analysts publish buy and sell calls every day, and the
   financial press carries them as headlines - "Nomura retains 'Buy' on
   Marico, target price Rs 1,000", "Top 5 stocks to buy ... by Sumeet
   Bagadia". That is the legitimate version of a "tip": a public call with a
   name attached to it. Unpublished price-sensitive information is the other
   kind, and trading on it is insider trading under SEBI's PIT regulations;
   nothing here goes near it.

   What this does with the published kind is the thing nobody else on the
   page could: it pulls the call apart (who, which stock, which way, what
   target), and keeps the price at the moment this page first saw it, so a
   call can be checked against what the stock did afterwards rather than
   remembered by how confident it sounded.

   Parsing is deliberately conservative. A headline only becomes a call when
   it names a known stock AND carries a rating word or a target; "Buy, sell
   or hold?" questions and stories about a company buying another company are
   rejected, because a wrong call in this list is worse than a missing one.
   ========================================================================== */
(function (KT) {
  'use strict';
  var core = KT.core;

  var BROKERS = [
    'Motilal Oswal', 'Goldman Sachs', 'Morgan Stanley', 'JP Morgan', 'JPMorgan', 'Citi', 'Citigroup', 'CLSA',
    'Jefferies', 'Nomura', 'Macquarie', 'UBS', 'HSBC', 'BofA', 'Bank of America', 'Bernstein', 'Kotak',
    'HDFC Sec', 'HDFC Securities', 'ICICI Sec', 'ICICI Securities', 'Axis Securities', 'Axis Capital', 'Emkay',
    'Nuvama', 'Elara', 'Ambit', 'Prabhudas Lilladher', 'Sharekhan', 'Anand Rathi', 'Geojit', 'Religare',
    'IIFL', 'JM Financial', 'Antique', 'InCred', 'Investec', 'Systematix', 'Phillip Capital', 'PhillipCapital',
    'Yes Securities', 'SBI Securities', 'Centrum', 'Choice Broking', 'Mirae Asset', 'Dolat', 'BNP Paribas',
    'Deutsche', 'Barclays', 'Bernstein', 'Equirus', 'Ventura', 'Nirmal Bang', 'Arihant', 'LKP', 'Angel One',
    'Monarch Networth', 'Monarch', 'MOFSL', 'MarketSmith', 'Sumeet Bagadia', 'Vaishali Parekh', 'Raja Venkatraman', 'Ganesh Dongre', 'Chandan Taparia',
    'Nooresh Merani', 'Kunal Bothra', 'Rajesh Palviya', 'Shrikant Chouhan', 'Ajit Mishra', 'Rupak De',
    // Added 6 Oct 2026 from the archive: houses and analysts that were being
    // read as stocks ("says Ashika Securities" filed a call on Ashika Credit)
    // or left the call unattributed.
    'Ashika', 'PL Capital', 'ICICI Direct', 'Chola Securities', '360 ONE', 'Kotak Securities', 'Bonanza',
    'Master Capital', 'Swastika', 'Mehta Equities', 'StoxBox', 'Jay Thakkar', 'Jigar Patel', 'Nagaraj Shetti',
    'Ambareesh Baliga', 'Mehul Kothari', 'Osho Krishan', 'Sudeep Shah', 'Anuj Gupta',
  ];
  var BROKER_RX = new RegExp('\\b(' + BROKERS.map(function (b) { return b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); })
    .sort(function (a, b) { return b.length - a.length; }).join('|') + ')\\b', 'i');

  // What a broker does when it is the one making the call.
  var CALLER_RX = /^[\s,'’]*(?:\w+\s+){0,2}?(?:upgrades?|downgrades?|upgraded|downgraded|retains?|maintains?|reiterates?|initiates?|starts?|keeps?|sees?|says|raises?|cuts?|lifts?|trims?|recommends?|is bullish|is bearish|bullish|bearish|turns|likes|prefers|picks|has a|gives|assigns|values)\b/i;

  // A broker, an analyst or a rating somewhere in the sentence.
  var CALL_CONTEXT = '^(?=.*(?:\\b(?:brokerage|analysts?|rating|rated|target)\\b|' + BROKER_RX.source + '))';

  // Rating words, strongest reading first. Each maps to a direction.
  var RATINGS = [
    [/\b(strong buy|top pick|top picks)\b/i, 'buy', 'top pick'],
    [/\bupgrad(?:e|es|ed)\b[^.]*?\bto\s+['"‘’]?(buy|outperform|overweight|add|accumulate)/i, 'buy', 'upgrade'],
    [/\bdowngrad(?:e|es|ed)\b[^.]*?\bto\s+['"‘’]?(sell|underperform|underweight|reduce|hold|neutral)/i, 'sell', 'downgrade'],
    // A bare upgrade is only a stock call when a broker, an analyst or a
    // rating is in the sentence: "a wave of upgrades" to GDP forecasts and
    // "restaurant upgrades" were both being filed as BUY calls.
    [new RegExp(CALL_CONTEXT + '[^]*?\\bupgrad(?:e|es|ed)\\b', 'i'), 'buy', 'upgrade'],
    [new RegExp(CALL_CONTEXT + '[^]*?\\bdowngrad(?:e|es|ed)\\b', 'i'), 'sell', 'downgrade'],
    [/['"‘’]\s*(buy|outperform|overweight|accumulate|add)\s*['"‘’]/i, 'buy', null],
    [/['"‘’]\s*(sell|underperform|underweight|reduce)\s*['"‘’]/i, 'sell', null],
    [/['"‘’]\s*(hold|neutral|equal[- ]weight)\s*['"‘’]/i, 'hold', null],
    [/\b(initiates?|initiated|starts?)\s+coverage\b[^.]*?\b(buy|outperform|overweight|add|accumulate)\b/i, 'buy', 'initiate'],
    [/\b(initiates?|initiated|starts?)\s+coverage\b[^.]*?\b(sell|underperform|underweight|reduce)\b/i, 'sell', 'initiate'],
    [/\b(retains?|maintains?|reiterates?|keeps?)\b[^.]*?\b(buy|outperform|overweight|accumulate|add)\b/i, 'buy', 'reiterate'],
    [/\b(retains?|maintains?|reiterates?|keeps?)\b[^.]*?\b(sell|underperform|underweight|reduce)\b/i, 'sell', 'reiterate'],
    [/\bstocks? to buy\b|\bbuy or sell\b.*\bexperts? recommend\b|\brecommends?\b[^.]*\bstocks?\b/i, 'buy', 'list'],
    [/\bsays\s+['"‘’]?(buy|sell)\b/i, null, null],
  ];

  // Headlines that look like calls and are not.
  var REJECT_RX = /\b(buy,? sell,? or hold\??|should you buy|is it time to buy|to buy or not|which\b[^.:]*\bto buy|fitch|moody'?s|s&(?:amp;)?p|crisil|icra|care ratings|india ratings|buyback|buy[- ]?back|to buy stake|buys stake|to acquire|acquires|acquisition|sell[- ]off|selloff|sold off|offer for sale|block deal|bulk deal)\b|\?\s*$|\bbest\b[^?]{0,80}\bto buy\b[^?]*\?/i;

  var TARGET_RX = [
    /\btarget(?: price)?(?: of| at| to|:)?\s*(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)/i,
    /(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)\s*(?:target|tp)\b/i,
    /\b(?:raises|cuts|sets|lifts|hikes|trims)\b[^.]*?(?:target(?: price)?)\s*(?:to\s*)?(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)/i,
  ];
  var UPSIDE_RX = /(\d+(?:\.\d+)?)\s*%\s*(upside|downside)/i;

  /* ----------------------------------------------------- stock matching */
  var index = { aliases: [], ready: false };

  // members: [{ symbol, name, aliases[] }] - the universe file's shape.
  var GENERIC_RX = /^(bank|india|indian|steel|power|motors?|finance|financial|capital|life|energy|global|infra|share|shares|standard|multi|times|live|today|express|business|securities|top|best|stock|stocks|market|markets|group|first|united|national|new|star)$/i;

  /* The names the press actually prints, which the exchange's company list
     does not carry. Measured against the archive: "DMart plunges 6.7% as
     Citi, Goldman retain sell call" matched nothing, because the listed name
     is Avenue Supermarts and the ticker only matches in capitals. One of
     these also corrects the universe file: its first-word alias for SPARC is
     "Sun Pharma", which would file every Sun Pharmaceutical call against the
     research spin-off. A brand only applies when its symbol is in the list. */
  var BRANDS = {
    DMART: ['DMart', 'D-Mart'], BHARTIARTL: ['Airtel'], HINDUNILVR: ['HUL'], SBIN: ['SBI'],
    LT: ['L&T'], RELIANCE: ['RIL'], ETERNAL: ['Zomato'], SUNPHARMA: ['Sun Pharma'],
    DRREDDY: ["Dr Reddy's", 'Dr Reddys'], HCLTECH: ['HCL Tech'], LICI: ['LIC'],
    KOTAKBANK: ['Kotak Bank', 'Kotak Mahindra Bank'], POLICYBZR: ['Policybazaar'],
    PAYTM: ['Paytm'], NYKAA: ['Nykaa'], MARUTI: ['Maruti'], ADANIENT: ['Adani Ent'],
    'M&MFIN': ['M&M Finance', 'M&M Fin'], IDEAFORGE: ['ideaForge', 'Ideaforge'],
  };

  function setUniverse(members) {
    var list = [], owners = {};
    (members || []).forEach(function (m) {
      if (!m || !m.symbol) return;
      var names = [m.symbol].concat(m.aliases || []);
      if (m.name) names.push(String(m.name).replace(/\b(ltd|limited)\.?$/i, '').trim());
      var mine = {};
      names.forEach(function (a) {
        a = String(a || '').trim();
        // Short tokens collide with English: "ITC" is fine in capitals,
        // "Bank" is not a company.
        if (a.length < 3 || GENERIC_RX.test(a)) return;
        var low = a.toLowerCase();
        if (mine[low]) return;
        mine[low] = 1;
        (owners[low] = owners[low] || {})[m.symbol] = 1;
        // A bare ticker is matched in capitals only: headlines print tickers
        // that way, and FOCUS or TIMES in lower case is just a word.
        list.push({ alias: a, symbol: m.symbol, cs: a === m.symbol || (a.length <= 4 && a === a.toUpperCase()) });
      });
    });
    /* A name more than one listed company answers to - "Bajaj", "Godrej",
       "Jindal" - identifies a group, not a stock. Matching it would file one
       Bajaj Finance call against eight Bajaj companies, which is what the
       first run against the 19-day archive did. Only the longer, unique
       names ("Bajaj Finance", "Godrej Consumer") are kept. */
    list = list.filter(function (x) { return Object.keys(owners[x.alias.toLowerCase()]).length === 1; });
    var have = {};
    (members || []).forEach(function (m) { if (m && m.symbol) have[m.symbol] = 1; });
    Object.keys(BRANDS).forEach(function (sym) {
      if (!have[sym]) return;
      BRANDS[sym].forEach(function (a) {
        var low = a.toLowerCase();
        list = list.filter(function (x) { return x.alias.toLowerCase() !== low; });
        list.push({ alias: a, symbol: sym, cs: a.length <= 4 && a === a.toUpperCase() });
      });
    });
    list.sort(function (a, b) { return b.alias.length - a.alias.length; });
    index = { aliases: list.map(function (x) {
      return { symbol: x.symbol, rx: new RegExp('(?:^|[^A-Za-z0-9&])' + x.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                                                '(?![A-Za-z0-9])', x.cs ? '' : 'i') };
    }), ready: list.length > 0 };
    return list.length;
  }

  /* Longest name first, and a matched name is blanked out of the text so a
     shorter one cannot match inside it again - "Reliance Power" must not
     also count as Reliance Industries. */
  function stocksIn(text) {
    if (!index.ready) return [];
    var out = [], seen = {}, t = ' ' + text + ' ';
    for (var i = 0; i < index.aliases.length && out.length < 8; i++) {
      var a = index.aliases[i];
      if (seen[a.symbol]) continue;
      var m = a.rx.exec(t);
      if (m) {
        seen[a.symbol] = 1; out.push(a.symbol);
        t = t.slice(0, m.index) + new Array(m[0].length + 1).join(' ') + t.slice(m.index + m[0].length);
      }
    }
    return out;
  }

  /* --------------------------------------------------------------- parse */
  function parse(item) {
    var h = String(item.headline || item.h || '').replace(/\s+/g, ' ').trim();
    if (!h || h.length < 20) return null;
    // Google News appends " - Publisher"; that tail names the outlet, not the call.
    var core0 = h.replace(/\s+-\s+[^-]{3,60}$/, '');
    if (REJECT_RX.test(core0)) return null;

    var rating = null, action = null;
    for (var i = 0; i < RATINGS.length; i++) {
      var m = RATINGS[i][0].exec(core0);
      if (!m) continue;
      rating = RATINGS[i][1];
      if (!rating) {
        var w = (m[1] || '').toLowerCase();
        rating = /buy/.test(w) ? 'buy' : /sell/.test(w) ? 'sell' : null;
      }
      action = RATINGS[i][2];
      if (rating) break;
    }
    var target = null;
    for (var t = 0; t < TARGET_RX.length && target == null; t++) {
      var tm = TARGET_RX[t].exec(core0);
      if (tm) {
        var v = parseFloat(tm[1].replace(/,/g, ''));
        if (isFinite(v) && v > 0) target = v;
      }
    }
    var up = UPSIDE_RX.exec(core0);
    var upside = up ? (up[2].toLowerCase() === 'downside' ? -1 : 1) * parseFloat(up[1]) : null;
    if (!rating && upside != null) rating = upside >= 0 ? 'buy' : 'sell';
    if (!rating && target == null) return null;
    /* "Top 2 stocks to buy or sell for tomorrow: Nykaa, LIC" names two picks
       and does not say which way either goes, and a bare target price with no
       rating word does not either. Both used to be filed as BUY. They are a
       'pick' now: named, tracked, and not counted as a direction. */
    if (action === 'list' && /\bbuy,? or sell\b|\bbuy\/sell\b/i.test(core0)) rating = 'pick';
    if (!rating) rating = 'pick';

    /* The broker is the one doing the calling. "Kotak, BoB, PB Fintech:
       Macquarie Upgrades Nine Stocks" names Kotak first, as a stock, and the
       first-match rule filed the call under Kotak. A broker followed closely
       by a rating verb wins; otherwise the first one named. */
    var broker = null, firstBroker = null, brx = new RegExp(BROKER_RX.source, 'gi'), b0;
    while ((b0 = brx.exec(core0))) {
      if (!firstBroker) firstBroker = b0[1];
      if (CALLER_RX.test(core0.slice(b0.index + b0[0].length, b0.index + b0[0].length + 28))) { broker = b0[1]; break; }
    }
    broker = broker || firstBroker;
    /* The broker is not the stock. "Motilal Oswal initiates coverage on
       Molbio" names four listed Oswal companies before it names Molbio, and
       "an upgrade from Kotak" is not a call on Kotak Bank. Brokers and
       publisher domains are blanked before the stock match runs. */
    var forStocks = core0.replace(new RegExp(BROKER_RX.source + '(?:\\s+(?:Securities|Sec|Capital|Institutional Equities|Financial|India))?', 'gi'), ' ')
      .replace(/\b[\w-]+\.(?:com|in|co\.in|net)\b/gi, ' ');
    var stocks = stocksIn(forStocks);
    if (!stocks.length) return null;
    // A list headline ("Top 5 stocks to buy: A, B, C") is a call on each of
    // them; a single-stock headline with a target is a call on that one.
    var list = action === 'list' || stocks.length > 2;
    if (!list && stocks.length > 1 && target != null) stocks = stocks.slice(0, 1);
    return {
      key: item.key || item.k || core.keyOf(h), ts: item.ts || null,
      headline: h, source: item.source || item.src || '', url: item.url || '',
      broker: broker, rating: rating, action: action,
      stocks: stocks, target: list ? null : target, upsidePct: list ? null : upside, list: list,
    };
  }

  function extract(items, opts) {
    opts = opts || {};
    var out = [], seen = {};
    (items || []).forEach(function (n) {
      var c = parse(n);
      if (!c) return;
      // One call per story, however many outlets syndicated it.
      var sig = c.stocks.join(',') + '|' + c.rating + '|' + (c.broker || '') + '|' + (c.target || '');
      if (seen[sig]) { seen[sig].copies++; return; }
      c.copies = 1;
      seen[sig] = c;
      out.push(c);
    });
    out.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  /* -------------------------------------------------------- the record
     The price when this page first saw the call, kept per call. That is the
     honest anchor available to a static page: there is no free intraday
     history per stock to look up the price at the exact minute a headline
     went out, and backfilling one from a daily bar would put a precision on
     the record it does not have. */
  var SEEN_KEY = 'streetSeen';
  function track(calls, quotes) {
    var seen = core.store.get(SEEN_KEY, {}) || {};
    var now = Date.now(), dirty = false;
    calls.forEach(function (c) {
      c.track = [];
      c.stocks.forEach(function (s) {
        var q = quotes && quotes[s];
        var k = c.key + ':' + s;
        if (!seen[k] && q && q.price) { seen[k] = { p: q.price, at: now }; dirty = true; }
        var first = seen[k];
        var ltp = q && q.price != null ? q.price : null;
        var sinceSeen = first && ltp != null ? Math.round((ltp / first.p - 1) * 10000) / 100 : null;
        c.track.push({
          symbol: s, ltp: ltp, firstPrice: first ? first.p : null, firstAt: first ? first.at : null,
          sincePct: sinceSeen,
          // Positive means the stock has moved the way the call said.
          withCallPct: sinceSeen == null ? null : (c.rating === 'sell' ? -sinceSeen : (c.rating === 'buy' ? sinceSeen : null)),
          toTargetPct: c.target && ltp ? Math.round((c.target / ltp - 1) * 10000) / 100 : null,
        });
      });
    });
    if (dirty) {
      var keys = Object.keys(seen);
      if (keys.length > 800) {
        keys.sort(function (a, b) { return seen[a].at - seen[b].at; });
        keys.slice(0, keys.length - 800).forEach(function (k) { delete seen[k]; });
      }
      core.store.set(SEEN_KEY, seen);
    }
    return calls;
  }

  /* Who is being talked about most this week, and which way. */
  function tally(calls) {
    var by = {};
    calls.forEach(function (c) {
      c.stocks.forEach(function (s) {
        var t = by[s] || (by[s] = { symbol: s, buy: 0, sell: 0, hold: 0, n: 0, brokers: {} });
        t[c.rating] = (t[c.rating] || 0) + 1; t.n++;
        if (c.broker) t.brokers[c.broker] = 1;
      });
    });
    return Object.keys(by).map(function (k) {
      var t = by[k]; t.brokers = Object.keys(t.brokers); return t;
    }).sort(function (a, b) { return b.n - a.n; });
  }

  KT.streetcalls = {
    setUniverse: setUniverse, parse: parse, extract: extract, track: track, tally: tally,
    stocksIn: stocksIn, ready: function () { return index.ready; },
  };
})(window.KT);
