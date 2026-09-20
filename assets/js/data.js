/* ============================================================================
   Data layer.

   Three lanes, in order of how much we trust them:
     1. baked/   JSON written by .github/workflows/live-data.yml. Same origin,
                 no CORS, always parses. The reliable floor.
     2. direct/  Feeds and APIs that send CORS headers, so the browser reads
                 them itself. Moneycontrol's price API is the live tick source.
     3. proxied/ Everything else, through r.jina.ai -> allorigins -> rss2json.
                 Rate limited, so used sparingly and never depended on.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;

  var health = {};      // lane id -> { ok, at, note }
  function mark(id, ok, note) { health[id] = { ok: ok, at: Date.now(), note: note || '' }; }

  function withTimeout(ms) {
    var ac = new AbortController();
    var t = setTimeout(function () { ac.abort(); }, ms);
    return { signal: ac.signal, done: function () { clearTimeout(t); } };
  }

  /* --------------------------------------------------------- raw fetchers */
  function fetchText(url, opts) {
    opts = opts || {};
    var to = withTimeout(opts.timeout || 15000);
    return fetch(url, { signal: to.signal, headers: opts.headers || undefined, cache: 'no-store' })
      .then(function (r) {
        to.done();
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .catch(function (e) { to.done(); throw e; });
  }

  /* Try direct first (free and fast when CORS allows), then each proxy. */
  function fetchVia(url, opts) {
    opts = opts || {};
    var chain = [];
    if (!opts.proxyOnly) chain.push({ id: 'direct', url: url, headers: null, json: null });
    C.proxies.forEach(function (p) {
      if (opts.skipRss2json && p.json === 'rss2json') return;
      chain.push({ id: p.id, url: p.build(url), headers: p.headers, json: p.json });
    });

    var i = 0;
    function attempt() {
      if (i >= chain.length) return Promise.reject(new Error('all routes failed'));
      var hop = chain[i++];
      return fetchText(hop.url, { headers: hop.headers, timeout: opts.timeout || 15000 })
        .then(function (body) { return { body: body, via: hop.id, json: hop.json }; })
        .catch(function () { return attempt(); });
    }
    return attempt();
  }

  function fetchJSONVia(url, opts) {
    return fetchVia(url, opts).then(function (res) {
      try { return { data: JSON.parse(res.body), via: res.via }; }
      catch (e) { throw new Error('bad JSON via ' + res.via); }
    });
  }

  /* ------------------------------------------------------------- baked JSON
     Remote first, same-origin second.

     The workflow commits to a branch the Pages site is not built from, and
     raw.githubusercontent.com serves that branch with CORS headers within
     seconds of the push. Reading from there is what makes a 60 second data
     cycle possible: a commit to the published branch has to wait for a Pages
     build, and Pages throttles builds to a handful an hour.

     The same-origin copy under data/ is always tried if the remote read fails,
     so an offline viewer, a rate limit or a missing branch degrades to older
     data rather than to no data. A file not on the live list skips the remote
     hop entirely - the lexicon and the feed index change when the code does,
     not every minute, and the extra request would be waste.                 */
  function loadBaked(path, opts) {
    opts = opts || {};
    var live = C.remote && C.remote.enabled && C.liveFiles.indexOf(path) !== -1;
    if (!live || opts.localOnly) {
      return fetchText(path, { timeout: 12000 }).then(JSON.parse);
    }
    var url = C.remote.base + path;
    return fetchText(url, { timeout: C.remote.timeoutMs, cache: 'no-store' })
      .then(function (t) { mark('remote:' + path, true); return JSON.parse(t); })
      .catch(function (e) {
        mark('remote:' + path, false, String(e.message || e).slice(0, 60));
        return fetchText(path, { timeout: 12000 }).then(JSON.parse);
      });
  }

  /* --------------------------------------------------------------- candles
     Yahoo is the OHLC source. It blocks direct browser reads, so it always
     goes through the proxy chain; the baked candle file is the fallback.    */
  function parseYahoo(payload) {
    var res = payload && payload.chart && payload.chart.result && payload.chart.result[0];
    if (!res) throw new Error('empty chart payload');
    var ts = res.timestamp || [], q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
    var out = [];
    for (var i = 0; i < ts.length; i++) {
      var o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], c = q.close && q.close[i];
      if (o == null || h == null || l == null || c == null) continue;
      out.push({ time: ts[i], open: +o, high: +h, low: +l, close: +c });
    }
    return { candles: out, meta: res.meta || {} };
  }

  function getCandles(symbolKey, tfKey) {
    var sym = C.symbols[symbolKey], tf = C.timeframes[tfKey];
    var cacheKey = 'candles:' + symbolKey + ':' + tfKey;
    var cached = core.store.get(cacheKey, null);

    var live = fetchJSONVia(C.endpoints.yahooChart(sym.yahoo, tf.interval, tf.range), { proxyOnly: true, skipRss2json: true, timeout: 20000 })
      .then(function (r) {
        var parsed = parseYahoo(r.data);
        if (!parsed.candles.length) throw new Error('no candles');
        mark('candles', true, 'yahoo via ' + r.via);
        core.store.set(cacheKey, parsed, C.storage.candleTtlMin * 60000);
        return parsed;
      });

    return live.catch(function (err) {
      if (cached && cached.candles && cached.candles.length) {
        mark('candles', true, 'cached');
        return cached;
      }
      return loadBaked(C.baked.candles(symbolKey, tfKey))
        .then(function (j) {
          mark('candles', true, 'workflow file');
          return {
            meta: {},
            candles: (j.candles || []).map(function (r) {
              return { time: r[0], open: r[1], high: r[2], low: r[3], close: r[4] };
            }),
          };
        })
        .catch(function () { mark('candles', false, String(err.message || err)); throw err; });
    });
  }

  /* ----------------------------------------------------------- live quote
     Moneycontrol's public price feed sends CORS headers, so this is a real
     browser-side tick with no proxy in the way. Yahoo meta is the fallback. */
  function num(v) { var n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? null : n; }

  function getLiveQuote(symbolKey) {
    var sym = C.symbols[symbolKey];
    if (!sym.mcId) return Promise.reject(new Error('no live endpoint'));
    return fetchText(C.endpoints.mcPrice(sym.mcId), { timeout: 9000 })
      .then(function (body) {
        var j = JSON.parse(body);
        if (!j || !j.data) throw new Error('empty');
        var d = j.data;
        mark('quote', true, 'moneycontrol');
        return {
          symbol: symbolKey,
          price: num(d.pricecurrent),
          prevClose: num(d.priceprevclose),
          change: num(d.pricechange),
          changePct: num(d.pricepercentchange),
          open: num(d.OPEN), high: num(d.HIGH), low: num(d.LOW),
          week52High: num(d['52wkhi']), week52Low: num(d['52wklow']),
          advances: num(d.adv), declines: num(d.decl), unchanged: num(d.unchg),
          dma50: num(d['50d']), dma200: num(d['200d']), dma30: num(d['30d']),
          marketState: d.market_state || '',
          updatedEpoch: num(d.lastupd_epoch),
          returns: {
            '1w': num(d.cl1wPerChange), '1m': num(d.cl1mPerChange), '3m': num(d.cl3mPerChange),
            '6m': num(d.cl6mPerChange), '1y': num(d.cl1yPerChange), 'ytd': num(d.clYtdPerChange),
          },
          source: 'Moneycontrol',
        };
      })
      .catch(function (e) { mark('quote', false, String(e.message || e)); throw e; });
  }

  function getQuoteFallback(symbolKey) {
    var sym = C.symbols[symbolKey];
    return fetchJSONVia(C.endpoints.yahooChart(sym.yahoo, '5m', '1d'), { proxyOnly: true, skipRss2json: true })
      .then(function (r) {
        var m = (r.data.chart.result[0] || {}).meta || {};
        return {
          symbol: symbolKey, price: m.regularMarketPrice, prevClose: m.chartPreviousClose,
          change: m.regularMarketPrice - m.chartPreviousClose,
          changePct: m.chartPreviousClose ? (m.regularMarketPrice - m.chartPreviousClose) / m.chartPreviousClose * 100 : null,
          high: m.regularMarketDayHigh, low: m.regularMarketDayLow,
          week52High: m.fiftyTwoWeekHigh, week52Low: m.fiftyTwoWeekLow,
          returns: {}, source: 'Yahoo',
        };
      });
  }

  /* ------------------------------------------------------------------ RSS */
  var parser = new DOMParser();

  function textOf(node, tag) {
    var n = node.getElementsByTagName(tag)[0];
    return n && n.textContent ? n.textContent.trim() : '';
  }

  function parseRSS(xmlText, feed) {
    var doc = parser.parseFromString(xmlText, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) return [];
    var nodes = doc.getElementsByTagName('item');
    if (!nodes.length) nodes = doc.getElementsByTagName('entry');
    var out = [];
    for (var i = 0; i < nodes.length && i < 25; i++) {
      var n = nodes[i];
      var title = textOf(n, 'title');
      if (!title || title.length < 18) continue;
      var link = textOf(n, 'link');
      if (!link) {
        var a = n.getElementsByTagName('link')[0];
        if (a && a.getAttribute) link = a.getAttribute('href') || '';
      }
      var when = textOf(n, 'pubDate') || textOf(n, 'published') || textOf(n, 'updated');
      var ts = when ? Math.floor(new Date(when).getTime() / 1000) : Math.floor(Date.now() / 1000);
      if (!ts || isNaN(ts)) ts = Math.floor(Date.now() / 1000);
      var desc = (textOf(n, 'description') || textOf(n, 'summary') || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      out.push(makeItem(title, link, ts, desc, feed));
    }
    return out;
  }

  function parseRss2Json(body, feed) {
    var j = JSON.parse(body);
    if (!j || j.status !== 'ok' || !j.items) return [];
    return j.items.slice(0, 25).map(function (it) {
      var ts = Math.floor(new Date(it.pubDate).getTime() / 1000) || Math.floor(Date.now() / 1000);
      var desc = String(it.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return makeItem(it.title, it.link, ts, desc, feed);
    }).filter(Boolean);
  }

  /* One shape for every item, whichever lane it arrived on. Only the fields
     in storage.quietFields survive into localStorage - no bodies, no images. */
  function makeItem(title, link, ts, desc, feed) {
    title = String(title || '').replace(/\s+/g, ' ').trim();
    if (title.length < 18) return null;
    var blob = title + '. ' + String(desc || '').slice(0, 220);
    if (core.isNoise(blob)) return null;
    var s = core.score(blob);
    return {
      key: core.keyOf(title),
      headline: title,
      url: String(link || '').slice(0, 400),
      ts: ts,
      sentiment: s.sentiment,
      impact: s.impact,
      terms: s.terms,
      industry: core.sectorOf(blob),
      source: feed.name,
      region: feed.region === 'world' ? 'international' : 'indian',
      lane: feed.lane || 'direct',
    };
  }

  function fetchFeed(feed, useProxy) {
    var opts = useProxy ? { proxyOnly: true, timeout: 14000 } : { timeout: 9000 };
    return fetchVia(feed.url, opts).then(function (res) {
      var items = res.json === 'rss2json' ? parseRss2Json(res.body, feed) : parseRSS(res.body, feed);
      items = items.filter(Boolean);
      mark('feed:' + feed.id, items.length > 0, res.via + ' · ' + items.length);
      return items;
    }).catch(function (e) {
      mark('feed:' + feed.id, false, String(e.message || e));
      return [];
    });
  }

  var proxyCursor = 0;
  function fetchFastLane() {
    var jobs = C.directFeeds.map(function (f) { return fetchFeed(f, false); });
    for (var i = 0; i < C.proxiedPerCycle; i++) {
      var f = C.proxiedFeeds[proxyCursor % C.proxiedFeeds.length];
      proxyCursor++;
      jobs.push(fetchFeed(f, true));
    }
    return Promise.all(jobs).then(function (lists) {
      var all = [];
      lists.forEach(function (l) { all = all.concat(l); });
      return all;
    });
  }

  /* ------------------------------------------------------------ news store
     Bounded: deduped by title key, capped at newsMax, anything past the TTL
     is dropped on every merge. That is the whole "no unwanted noise" rule.  */
  var news = [];

  function mergeNews(incoming) {
    var seen = {}, out = [];
    var cutoff = Math.floor(Date.now() / 1000) - C.storage.newsTtlHours * 3600;
    var fresh = 0;

    var known = {};
    news.forEach(function (n) { known[n.key] = true; });

    incoming.concat(news).forEach(function (n) {
      if (!n || !n.key || seen[n.key]) return;
      if (n.ts < cutoff) return;
      seen[n.key] = true;
      if (!known[n.key]) { n.isNew = true; fresh++; } else { n.isNew = false; }
      out.push(n);
    });

    out.sort(function (a, b) { return b.ts - a.ts; });
    news = out.slice(0, C.storage.newsMax);
    persistNews();
    return { total: news.length, fresh: fresh };
  }

  function persistNews() {
    var slim = news.slice(0, 250).map(function (n) {
      var o = {};
      C.storage.quietFields.forEach(function (f) { if (n[f] !== undefined) o[f] = n[f]; });
      return o;
    });
    core.store.set('news', slim, C.storage.newsTtlHours * 3600000);
  }

  function restoreNews() {
    var saved = core.store.get('news', []);
    if (Array.isArray(saved) && saved.length) {
      news = saved.filter(function (n) { return n && n.key && n.headline; });
    }
    return news;
  }

  function getNews() { return news; }

  function adoptBakedNews(payload) {
    if (!payload || !payload.news_items) return { total: news.length, fresh: 0 };
    var mapped = payload.news_items.map(function (n) {
      return {
        key: n.key || core.keyOf(n.headline),
        headline: n.headline,
        url: n.url || '',
        ts: n.ts || Math.floor(new Date(n.timestamp).getTime() / 1000) || Math.floor(Date.now() / 1000),
        sentiment: typeof n.sentiment === 'number' ? n.sentiment : 0,
        impact: n.impact || 'low',
        terms: n.terms || [],
        industry: n.industry || 'general',
        source: n.source || 'feed',
        region: n.region || 'indian',
        lane: 'workflow',
      };
    });
    return mergeNews(mapped);
  }

  /* --------------------------------------------------------- OpenRouter */
  function listFreeModels(key) {
    return fetchText(C.endpoints.openrouterModels, { timeout: 12000 })
      .then(function (b) {
        var j = JSON.parse(b);
        var free = (j.data || []).filter(function (m) {
          var p = m.pricing || {};
          if (String(p.prompt) !== '0' || String(p.completion) !== '0') return false;
          // Keep text-in / text-out chat models; drop image and audio endpoints,
          // which are priced at zero but cannot answer a forecast prompt.
          var a = m.architecture || {};
          var out = a.output_modalities || ['text'];
          var inp = a.input_modalities || ['text'];
          if (out.indexOf('text') === -1 || out.indexOf('audio') !== -1 ||
              out.indexOf('image') !== -1 || inp.indexOf('text') === -1) return false;
          // Classifiers and rerankers are text-in / text-out and priced at zero,
          // so the modality filter alone lets them into the dropdown. They
          // answer a forecast prompt with a verdict like "User Safety: safe".
          return !/guard|safety|moderat|embed|rerank|classif/i.test(m.id);
        }).map(function (m) { return m.id; });
        free.sort(function (a, b) {
          // The auto-router first, then alphabetical.
          if (a === 'openrouter/free') return -1;
          if (b === 'openrouter/free') return 1;
          return a < b ? -1 : 1;
        });
        return free.length ? free : C.fallbackModels.slice();
      })
      .catch(function () { return C.fallbackModels.slice(); });
  }

  function askModel(key, model, system, user) {
    if (!key) return Promise.reject(new Error('no key'));
    var to = withTimeout(25000);
    return fetch(C.endpoints.openrouterChat, {
      method: 'POST',
      signal: to.signal,
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': location.origin,
        'X-Title': 'NIFTY Terminal',
      },
      body: JSON.stringify({
        model: model,
        temperature: 0.2,
        max_tokens: 320,
        /* max_tokens covers reasoning tokens as well as the answer, and the
           free auto-router picks whatever is free at the time. Measured on
           liquid/lfm-2.5-2.6b: reasoning_tokens 320, finish_reason "length",
           content null - the whole budget spent thinking, nothing written, and
           the lane fell back to the local wording without saying why. This
           model does not need to reason; it is rewriting numbers the engine
           already produced. */
        reasoning: { enabled: false },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    }).then(function (r) {
      to.done();
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var msg = j && j.choices && j.choices[0] && j.choices[0].message;
      if (!msg || !msg.content) throw new Error('empty completion');
      /* The free pool the auto-router draws from includes classifiers, not only
         chat models. Routed to nvidia/nemotron-3.5-content-safety the call
         returned a valid 200 whose entire content was "User Safety: safe",
         which would have been printed to the panel as the forecast's
         explanation. Two or three sentences of prose were asked for; anything
         this short is not that, so the local wording stays. */
      if (msg.content.trim().length < 60) throw new Error('unusable completion');
      mark('openrouter', true, model);
      return msg.content;
    }).catch(function (e) {
      to.done();
      mark('openrouter', false, String(e.message || e));
      throw e;
    });
  }

  /* The full daily record, roughly two decades, fetched once and kept for the
     session. The displayed timeframe is often intraday, where "history" is a
     handful of days; matching today's shape against that is nearly worthless.
     The precedent panel needs real years behind it, so it gets its own series
     independent of whatever the chart is currently showing. */
  var longHistory = {};
  function getLongHistory(symbolKey) {
    if (longHistory[symbolKey]) return Promise.resolve(longHistory[symbolKey]);
    var cacheKey = 'longhist:' + symbolKey;
    var cached = core.store.get(cacheKey, null);
    if (cached && cached.length > 500) {
      longHistory[symbolKey] = cached;
      return Promise.resolve(cached);
    }
    var sym = C.symbols[symbolKey];
    if (!sym) return Promise.reject(new Error('unknown symbol'));
    return fetchJSONVia(C.endpoints.yahooChart(sym.yahoo, '1d', 'max'),
                        { proxyOnly: true, skipRss2json: true, timeout: 30000 })
      .then(function (r) {
        var parsed = parseYahoo(r.data);
        if (!parsed.candles.length) throw new Error('no long history');
        longHistory[symbolKey] = parsed.candles;
        // Daily bars barely change; a day of cache is plenty and keeps the
        // fetch off every reload.
        core.store.set(cacheKey, parsed.candles, 86400000);
        mark('longhistory', true, parsed.candles.length + ' daily bars');
        return parsed.candles;
      })
      .catch(function (e) { mark('longhistory', false, String(e.message || e)); throw e; });
  }

  /* ==================================================== market internals

     One request, several lanes. NSE's /api/allIndices carries 139 index rows,
     and among them are three things this page was getting late or not at all:

       breadth            advances and declines for NIFTY 50, which the flow
                          lane votes on and which arrived through the workflow,
                          so it was hours old on an intraday forecast
       India VIX          live, rather than the Yahoo quote which rate-limits
       breadth divergence midcap against large-cap. Measured on one live
                          payload: NIFTY 50 was 26 up / 24 down while NIFTY
                          MIDCAP 100 was 71 up / 28 down. A tape where the
                          broad market is much stronger than the headline index
                          is a different tape, and nothing here could see it.

     Going through the proxy costs a shared, rate-limited hop, so it is one call
     serving all three rather than three calls. Resolves null on any failure -
     the workflow copies stay in place, which is what the page ran on before. */
  /* One place for what counts as a sector row and what counts as a broad
     market row, because two copies of this list is two lists to get out of
     step - and the heatmap and the forecast would then disagree about what
     a sector is. */
  var SECTOR_RX = /^NIFTY (IT|BANK|PSU BANK|PRIVATE BANK|FINANCIAL SERVICES|AUTO|PHARMA|HEALTHCARE|FMCG|METAL|REALTY|ENERGY|OIL & GAS|MEDIA|INFRA|CONSUMER DURABLES|COMMODITIES|MIDCAP 100|SMALLCAP 100|NEXT 50)$/;
  var BROAD_RX = /^NIFTY (MIDCAP 100|SMALLCAP 100|NEXT 50)$/;

  function getMarketInternals() {
    return fetchJSONVia(C.endpoints.nseAllIndices, { proxyOnly: true, skipRss2json: true, timeout: 16000 })
      .then(function (res) {
        var payload = (res && res.data) || {};
        var rows = payload.data || [];
        if (!rows.length) return null;
        var by = {};
        rows.forEach(function (r) { if (r && r.index) by[r.index] = r; });

        function breadthOf(name) {
          var r = by[name];
          if (!r) return null;
          var a = r.advances == null ? null : +r.advances;
          var d = r.declines == null ? null : +r.declines;
          if (a == null || d == null || (a + d) <= 0) return null;
          return { advances: a, declines: d, unchanged: +(r.unchanged || 0),
                   ratio: r3(a / (a + d)) };
        }

        var nifty = breadthOf('NIFTY 50');
        var mid = breadthOf('NIFTY MIDCAP 100');
        var vixRow = by['INDIA VIX'];
        var n50 = by['NIFTY 50'];

        var out = {
          origin: 'browser',
          generated_at: new Date().toISOString(),
          via: res.via,
          source: 'nseindia.com/api/allIndices via ' + res.via,
          breadth: nifty,
          midcapBreadth: mid,
          // Positive: the broad market is carrying more of the tape than the
          // headline index is. Negative: the index is being held up by a few
          // large names, which is the weaker version of the same print.
          breadthDivergence: (nifty && mid) ? r3(mid.ratio - nifty.ratio) : null,
          vix: vixRow && vixRow.last ? +vixRow.last : null,
          vixChangePct: vixRow && vixRow.percentChange != null ? +vixRow.percentChange : null,
          last: n50 && n50.last ? +n50.last : null,
          previousClose: n50 && n50.previousClose ? +n50.previousClose : null,
          pe: n50 && n50.pe ? +n50.pe : null,
          /* The sector board. `allIndices` returns every index NSE
             publishes in one response, so widening this costs nothing and
             it was missing half the board a trader actually watches -
             Financial Services is the heaviest sector in the index and was
             not in the list, nor was PSU Bank, Oil & Gas, Infra, Media or
             Consumer Durables.

             Eight became eighteen, and the broad-market rows (Midcap,
             Smallcap, Next 50) are tagged separately because "midcaps are
             leading" is a different statement from "banks are leading" and
             the panel draws them apart. */
          sectors: rows.filter(function (r) {
            return r && r.index && SECTOR_RX.test(r.index) && r.percentChange != null;
          }).map(function (r) {
            return {
              index: r.index,
              label: String(r.index).replace(/^NIFTY\s+/, ''),
              changePct: +r.percentChange,
              last: r.last == null ? null : +r.last,
              advances: r.advances == null ? null : +r.advances,
              declines: r.declines == null ? null : +r.declines,
              broad: BROAD_RX.test(r.index),
            };
          }).sort(function (a, b) { return b.changePct - a.changePct; }),
        };
        return (out.breadth || out.vix) ? out : null;
      })
      .catch(function () { return null; });
  }

  /* ====================================================== live option chain

     The option chain is the only forward-looking input in the model, and until
     now it reached the page through the workflow - which CLAUDE.md measured at
     roughly one run every two and a half hours. Max pain and the OI walls
     survive that. "Who is writing options today" does not; it is the fastest
     signal the chain carries and it was arriving stale enough to be noise.

     Measured from a real page origin: a direct fetch fails in 126ms ("Failed to
     fetch" - NSE sends Access-Control-Allow-Origin: beta.nseindia.com), and
     r.jina.ai returns the full 206 KB chain in about 1.7 seconds. allorigins
     times out. So the browser can have this live, and does.

     summariseChain() below deliberately mirrors summarise() in
     scripts/fetch_options.py field for field. Two implementations of the same
     arithmetic is exactly the shape of bug this repo keeps finding, so
     scripts/selftest.js runs both over one stored chain and asserts they agree
     rather than trusting that they do. */
  var OPTION_WINDOW_PCT = 6.0;

  function summariseChain(rows, spot) {
    if (!rows || !rows.length || !spot) return null;

    var lo = spot * (1 - OPTION_WINDOW_PCT / 100), hi = spot * (1 + OPTION_WINDOW_PCT / 100);
    var near = rows.filter(function (r) {
      return r && r.strikePrice && r.strikePrice >= lo && r.strikePrice <= hi;
    });
    // Too thin a window says more about the strike ladder than about the book.
    if (near.length < 8) near = rows.filter(function (r) { return r && r.strikePrice; });
    if (!near.length) return null;

    function leg(r, side) { return r[side] || {}; }
    function sum(side, field) {
      return near.reduce(function (t, r) { return t + (leg(r, side)[field] || 0); }, 0);
    }
    var ceOi = sum('CE', 'openInterest'), peOi = sum('PE', 'openInterest');
    var ceChg = sum('CE', 'changeinOpenInterest'), peChg = sum('PE', 'changeinOpenInterest');

    // Max pain: the strike at which writers pay out least, over the same window.
    var bestStrike = null, bestPain = null;
    near.forEach(function (a) {
      var k = a.strikePrice, pain = 0;
      near.forEach(function (b) {
        var kb = b.strikePrice;
        pain += (leg(b, 'CE').openInterest || 0) * Math.max(0, k - kb);
        pain += (leg(b, 'PE').openInterest || 0) * Math.max(0, kb - k);
      });
      if (bestPain === null || pain < bestPain) { bestStrike = k; bestPain = pain; }
    });

    function walls(side, above) {
      return near.filter(function (r) {
        return above ? r.strikePrice > spot : r.strikePrice < spot;
      }).sort(function (a, b) {
        return (leg(b, side).openInterest || 0) - (leg(a, side).openInterest || 0);
      }).slice(0, 3).map(function (r) {
        return {
          strike: r.strikePrice,
          oi: leg(r, side).openInterest || 0,
          chgOi: leg(r, side).changeinOpenInterest || 0,
          distPct: r2((r.strikePrice - spot) / spot * 100),
        };
      });
    }

    var atm = near.reduce(function (best, r) {
      return Math.abs(r.strikePrice - spot) < Math.abs(best.strikePrice - spot) ? r : best;
    }, near[0]);
    var atmCe = leg(atm, 'CE').impliedVolatility || 0, atmPe = leg(atm, 'PE').impliedVolatility || 0;

    function meanIv(pool, side) {
      var vals = pool.map(function (r) { return leg(r, side).impliedVolatility; })
                     .filter(function (v) { return v && v > 0; });
      if (!vals.length) return null;
      return r2(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length);
    }
    var putIv = meanIv(near.filter(function (r) { return r.strikePrice < spot * 0.98; }), 'PE');
    var callIv = meanIv(near.filter(function (r) { return r.strikePrice > spot * 1.02; }), 'CE');

    return {
      strikes: near.length,
      windowPct: OPTION_WINDOW_PCT,
      totalCeOi: ceOi, totalPeOi: peOi,
      pcrOi: ceOi ? r3(peOi / ceOi) : null,
      ceChgOi: ceChg, peChgOi: peChg,
      // Unstable when either side is small or negative, so only when both built.
      pcrChgOi: (ceChg > 0 && peChg > 0) ? r3(peChg / ceChg) : null,
      maxPain: bestStrike,
      maxPainPct: bestStrike ? r3((bestStrike - spot) / spot * 100) : null,
      resistance: walls('CE', true),
      support: walls('PE', false),
      atmStrike: atm.strikePrice,
      atmIv: (atmCe || atmPe) ? r2((atmCe + atmPe) / 2) : null,
      otmPutIv: putIv, otmCallIv: callIv,
      ivSkew: (putIv && callIv) ? r2(putIv - callIv) : null,
    };
  }

  function r2(n) { return Math.round(n * 100) / 100; }
  function r3(n) { return Math.round(n * 1000) / 1000; }

  /* Fetch the chain and summarise it. Resolves null rather than rejecting when
     the proxy is throttled or NSE is shut, because the caller's correct
     response is to keep the workflow copy, not to blank the lane. */
  function getOptionChain(symbol) {
    var sym = symbol || 'NIFTY';
    return fetchJSONVia(C.endpoints.nseOptionInfo(sym), { proxyOnly: true, skipRss2json: true, timeout: 14000 })
      .then(function (infoRes) {
        var info = (infoRes && infoRes.data) || {};
        var expiries = info.expiryDates || [];
        if (!expiries.length) throw new Error('no expiry dates');
        var expiry = expiries[0];
        return fetchJSONVia(C.endpoints.nseOptionChain(sym, expiry),
                            { proxyOnly: true, skipRss2json: true, timeout: 20000 })
          .then(function (chainRes) {
            var payload = (chainRes && chainRes.data) || {};
            var rec = payload.records || {};
            var rows = rec.data || [];
            var spot = rec.underlyingValue;
            var summary = summariseChain(rows, spot);
            if (!summary) throw new Error('chain could not be summarised');
            summary.ok = true;
            summary.symbol = sym;
            summary.spot = spot;
            summary.expiry = expiry;
            summary.expiriesAhead = expiries.slice(0, 4);
            summary.expiryDays = daysToExpiry(expiry);
            summary.chainTimestamp = rec.timestamp || null;
            // The lane keys its staleness check off this, so it must be the
            // moment the browser actually got the data.
            summary.generated_at = new Date().toISOString();
            summary.origin = 'browser';
            summary.via = chainRes.via;
            summary.source = 'nseindia.com/api/option-chain-v3 via ' + chainRes.via;
            return summary;
          });
      })
      .catch(function () { return null; });
  }

  function daysToExpiry(expiry) {
    var m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(expiry || '');
    if (!m) return null;
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var mi = months.indexOf(m[2]);
    if (mi < 0) return null;
    var d = new Date(Date.UTC(+m[3], mi, +m[1], 10, 0, 0));   // 15:30 IST
    return Math.max(0, Math.round((d.getTime() - Date.now()) / 86400000));
  }

  KT.data = {
    fetchText: fetchText, fetchVia: fetchVia, fetchJSONVia: fetchJSONVia, loadBaked: loadBaked,
    getLongHistory: getLongHistory,
    getOptionChain: getOptionChain, summariseChain: summariseChain,
    getMarketInternals: getMarketInternals,
    getCandles: getCandles, getLiveQuote: getLiveQuote, getQuoteFallback: getQuoteFallback,
    fetchFastLane: fetchFastLane, mergeNews: mergeNews, adoptBakedNews: adoptBakedNews,
    restoreNews: restoreNews, getNews: getNews,
    listFreeModels: listFreeModels, askModel: askModel,
    health: health,
  };
})(window.KT);
