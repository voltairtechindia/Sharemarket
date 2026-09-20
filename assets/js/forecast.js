/* ============================================================================
   Forecast.

   The old engine produced one number for the end of the horizon. This produces
   a path with a time axis, because "where will it be" is a different question
   at 10:30 and at 15:15, and the honest answer to both is a range with a
   probability attached rather than a price.

   Seven lanes feed a directional bias, each normalised to -1..+1:

     news         recency and impact weighted sentiment from the RSS stream
     seasonal     month, weekday and expiry-week effects from ~19 years
     momentum     trend and RSI position against the moving averages
     global       overnight cues: US futures, crude, dollar, rupee, US 10y
     structure    measured moves from triangles, flags, double tops
     levels       how much room there is to the nearest wall on each side
     flow         breadth and FII/DII when the workflow has them

   The average shape of the session is an eighth input but not an eighth lane:
   it enters as a drift term through dayShape(), carries no weight in CONFIG,
   and cannot swing the bias on its own.

   Three things make the band trustworthy rather than decorative:

   1. Volatility is a term structure, not one number. An index is far noisier
      in the first thirty minutes than at lunch, so variance is accumulated
      bucket by bucket across the clock. A flat sigma*sqrt(t) band is too wide
      at noon and far too narrow at the open.

   2. Drift is not linear. News decays, so its push lands early; seasonality is
      a whole-session effect, so it accrues evenly. The path is shaped by that
      rather than by an arbitrary easing curve.

   3. The band is scored against what actually happened. calibrate() walks the
      series and reports how often price really finished inside the 68% band.
      If that number is not near 68, the band is wrong, and the panel says so
      instead of hiding it.
   ========================================================================== */
(function (KT) {
  'use strict';
  var C = KT.CONFIG, core = KT.core;

  var IMPACT_W = { high: 3, medium: 2, low: 1 };

  /* Normal CDF - Abramowitz and Stegun 7.1.26, plenty for a probability we
     round to whole percent. */
  function ncdf(z) {
    var t = 1 / (1 + 0.2316419 * Math.abs(z));
    var d = 0.3989423 * Math.exp(-z * z / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  function istMinutes(epochSec) {
    var d = core.fmt.ist(epochSec);
    return d.getHours() * 60 + d.getMinutes();
  }
  function istDayKey(epochSec) {
    var d = core.fmt.ist(epochSec);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  /* ------------------------------------------------------- session clock
     A projection has to walk market time, not wall-clock time. Adding one bar
     width repeatedly puts a 5-minute forecast at 16:13 on a market that shut
     at 15:30, and puts a daily forecast on Sunday. Both make the "where will
     it be at X" answer meaningless, which is the one thing the panel exists
     for. So the step function skips the overnight gap and the weekend.

     Exchange holidays used to be unmodelled, on the grounds that there was no
     free holiday feed in the repo. There is one now - NSE serves
     /api/holiday-master?type=trading, twenty cash-market rows a year - and
     scripts/fetch_events.py pulls it into data/events.json, which app.js hands
     to setHolidays() below.

     It matters more than "one session out" suggested. A daily projection that
     walks straight through Diwali puts every date after it one session wrong,
     and the checkpoint table is the part of this panel people read dates off.
     That is the same class of error as reading an outcome from the wrong bar.

     With no holiday list loaded the behaviour is exactly what it was before -
     weekends only - so a failed fetch degrades to the old accuracy instead of
     breaking the clock. */
  var OPEN_MIN = C.market.regular.from, CLOSE_MIN = C.market.regular.to;

  function isWeekend(d) { return C.market.weekdays.indexOf(d.getDay()) === -1; }

  /* The holiday table lives in core, because marketState() needs the same one
     and core is what loads first. Keeping a second copy here would be two
     tables to get out of step, which is the bug shape this repo keeps hitting.
     setHolidays is re-exported below so callers have one obvious entry point. */
  function setHolidays(list) { return core.setHolidays(list); }
  // One predicate for "the exchange is shut", so a caller cannot check one and
  // forget the other.
  function isClosed(d) { return isWeekend(d) || core.isHoliday(d); }

  function nextSessionOpen(epochSec) {
    var d = core.fmt.ist(epochSec);
    var day = epochSec, guard = 0;
    do {
      day += 86400;
      d = core.fmt.ist(day);
      // A corrupt holiday list must not spin forever; ten shut days in a row
      // has never happened and would be a data fault, not a calendar.
      if (++guard > 10) break;
    } while (isClosed(d));
    var mins = d.getHours() * 60 + d.getMinutes();
    return day + (OPEN_MIN - mins) * 60;
  }

  /* How many bars are left between a time and this session's close.

     Every other view projects a fixed bar count, which is the right shape for
     "the next N bars" and the wrong one for "the rest of today": at 09:20 the
     rest of today is 370 minutes and at 15:00 it is 30, and a fixed count
     would either stop short of the close every morning or walk straight
     through it every afternoon. The session view asks the clock instead.

     When the market is shut this returns a whole session, because the thing
     being forecast is the next one, start to finish. */
  function barsToSessionClose(fromSec, barSec) {
    var perBar = Math.max(1, Math.round(barSec / 60));
    var full = Math.round((CLOSE_MIN - OPEN_MIN) / perBar);
    var d = core.fmt.ist(fromSec);
    if (isClosed(d)) return full;
    var m = d.getHours() * 60 + d.getMinutes();
    if (m < OPEN_MIN || m >= CLOSE_MIN) return full;
    return Math.max(1, Math.round((CLOSE_MIN - m) / perBar));
  }

  function advance(epochSec, barSec) {
    if (barSec >= 604800) return epochSec + barSec;
    if (barSec >= 86400) {
      var t = epochSec, g = 0;
      do { t += 86400; } while (isClosed(core.fmt.ist(t)) && ++g <= 10);
      return t;
    }
    var next = epochSec + barSec;
    var nd = core.fmt.ist(next);
    var m = nd.getHours() * 60 + nd.getMinutes();
    if (isClosed(nd) || m > CLOSE_MIN) {
      var over = Math.max(0, (m - CLOSE_MIN) * 60);
      if (isClosed(nd)) over = 0;
      return nextSessionOpen(epochSec) + over;
    }
    if (m < OPEN_MIN) {
      // A bar stamped before the open belongs to this session's first slot.
      return next + (OPEN_MIN - m) * 60;
    }
    return next;
  }

  /* ==================================================== volatility profile
     Per-bar variance bucketed by time of day. Returns a lookup from clock
     minute to a multiplier on the average bar variance, so the band can widen
     at the open and tighten into the lunch lull. Falls back to a flat profile
     when the series is daily or there is too little intraday history. */
  function volProfile(candles, barSec) {
    var flat = { intraday: false, mult: function () { return 1; }, base: 0 };
    if (!candles || candles.length < 60 || barSec >= 86400) return flat;

    var bucketMin = barSec >= 3600 ? 60 : 30;
    var sums = {}, counts = {}, all = [];
    for (var i = 1; i < candles.length; i++) {
      var prev = candles[i - 1].close;
      if (!prev) continue;
      var r = (candles[i].close - prev) / prev * 100;
      if (!isFinite(r)) continue;
      var b = Math.floor(istMinutes(candles[i].time) / bucketMin);
      sums[b] = (sums[b] || 0) + r * r;
      counts[b] = (counts[b] || 0) + 1;
      all.push(r * r);
    }
    if (all.length < 40) return flat;
    var base = all.reduce(function (s, x) { return s + x; }, 0) / all.length;
    if (!base) return flat;

    /* The upper bound used to be 4. Measured on the live NIFTY 5-minute series
       the 09:15-09:29 bucket runs at 13.196x the average bar variance - the
       overnight gap lands in that first bar - so clamping to 4 made the band
       sqrt(13.196/4) = 1.8x too narrow at the open, every session, which is
       the single worst-calibrated moment of the day. The lower bound hit too:
       the 12:30 bucket's true multiplier is 0.257 against a floor of 0.3.

       The clamp exists to stop one freak session defining a bucket, and that
       job is done by the counts[b] < 5 guard above and by the median-style
       trim below. So the bounds widen to what the data actually shows, and a
       bucket that lands outside them is recorded rather than flattened. */
    var mult = {};
    Object.keys(sums).forEach(function (b) {
      if (counts[b] < 5) return;                       // too thin to trust
      mult[b] = core.clamp((sums[b] / counts[b]) / base, 0.15, 20);
    });
    if (Object.keys(mult).length < 3) return flat;

    return {
      intraday: true, bucketMin: bucketMin, base: base, table: mult,
      mult: function (epochSec) {
        var b = Math.floor(istMinutes(epochSec) / bucketMin);
        return mult[b] === undefined ? 1 : mult[b];
      },
    };
  }

  /* ================================================= time-of-day drift
     The average path the session actually walks. Computed as the mean
     cumulative return from the open, by clock minute, across complete
     sessions. This is the part that answers "as per time" directly. */
  function dayShape(candles, barSec) {
    if (!candles || barSec >= 86400 || candles.length < 120) return null;
    var bucketMin = barSec >= 3600 ? 60 : 30;
    var sessions = {}, order = [];
    candles.forEach(function (c) {
      var k = istDayKey(c.time);
      if (!sessions[k]) { sessions[k] = []; order.push(k); }
      sessions[k].push(c);
    });
    var usable = order.filter(function (k) { return sessions[k].length >= 6; });
    if (usable.length < 3) return null;

    var sums = {}, counts = {};
    usable.forEach(function (k) {
      var day = sessions[k], open = day[0].open || day[0].close;
      if (!open) return;
      day.forEach(function (c) {
        var b = Math.floor(istMinutes(c.time) / bucketMin);
        var cum = (c.close - open) / open * 100;
        sums[b] = (sums[b] || 0) + cum;
        counts[b] = (counts[b] || 0) + 1;
      });
    });
    var table = {};
    Object.keys(sums).forEach(function (b) {
      if (counts[b] >= Math.max(3, usable.length * 0.4)) table[b] = sums[b] / counts[b];
    });
    if (Object.keys(table).length < 4) return null;
    return {
      bucketMin: bucketMin, sessions: usable.length, table: table,
      at: function (epochSec) {
        var b = Math.floor(istMinutes(epochSec) / bucketMin);
        return table[b] === undefined ? null : table[b];
      },
    };
  }

  /* ========================================================== the lanes */
  /* ====================================================== news relevance

     The lane used to average sentiment over every headline it held, weighted
     only by recency and a keyword impact tag. Two things were wrong with that,
     both measured on one live 600-item sweep.

     **Syndication counted as corroboration.** keyOf() hashes the exact
     headline, so the same story from thirteen outlets is thirteen keys and
     thirteen votes. Measured: 14% of the pool were near-duplicates, and
     "Trump signs Russia sanctions bill" - high impact, sentiment -3 - appeared
     seven times. Clustering the pool and taking one vote per story moved the
     raw lane by 0.079, which is about a tenth of the bias threshold that
     decides whether a direction is called at all.

     **Relevance was not a dimension.** The same sweep was voting on "SEBI
     Order for Compliance - Completion Order for Recovery Certificate" and on
     "SBI Nifty Bank Index Fund(G)-Direct Plan" with exactly the weight it gave
     a headline naming Reliance. A NIFTY forecast does not care about a
     microcap recovery certificate.

     Relevance is scored in tiers rather than weights. NIFTY 50 is free-float
     market-cap weighted and no free source gives those weights, so a weight
     here would be invented - membership is a fact, and the tier is as far as
     the data honestly goes. See scripts/fetch_constituents.py. */

  var CONSTITUENTS = { byAlias: [], ready: false };

  function setConstituents(payload) {
    CONSTITUENTS = { byAlias: [], ready: false };
    var members = (payload && payload.members) || [];
    members.forEach(function (m) {
      var tier = m.tiers && m.tiers.indexOf('nifty50') !== -1 ? 'nifty50'
               : m.tiers && m.tiers.indexOf('bank') !== -1 ? 'bank' : 'next50';
      (m.aliases || []).forEach(function (a) {
        if (!a || a.length < 4) return;
        CONSTITUENTS.byAlias.push({ alias: ' ' + a.toLowerCase() + ' ', tier: tier, symbol: m.symbol });
      });
    });
    // Longest alias first, so "Tata Consultancy Services" wins over "Tata".
    CONSTITUENTS.byAlias.sort(function (a, b) { return b.alias.length - a.alias.length; });
    CONSTITUENTS.ready = CONSTITUENTS.byAlias.length > 0;
    newsCacheClear();                           // relevance changed, re-cluster
    return CONSTITUENTS.byAlias.length;
  }

  /* Terms that move the whole index regardless of which company is named.
     These are the macro drivers - policy, rates, the currency, oil, and the
     foreign flows that set the tone for an Indian session. */
  var MACRO_RX = new RegExp([
    '\\brbi\\b', 'repo rate', 'monetary policy', '\\bmpc\\b', '\\bcrr\\b',
    'inflation', '\\bcpi\\b', '\\bwpi\\b', '\\bgdp\\b', 'fiscal deficit',
    '\\bbudget\\b', 'rupee', '\\busd/?inr\\b', 'crude', 'brent',
    '\\bfed\\b', '\\bfomc\\b', 'federal reserve', 'tariff', 'trade deal',
    '\\bfii\\b', '\\bdii\\b', 'foreign investors', '\\bsebi\\b.*\\bmarket\\b',
    '\\bnifty\\b', '\\bsensex\\b', '\\bbank nifty\\b', 'indian markets?',
  ].join('|'), 'i');

  /* Paperwork. The existing procedural filter in core.score catches some of
     this; these are the shapes it missed in the measured sweep, and they were
     arriving tagged medium impact. */
  var PAPERWORK_RX = new RegExp([
    'recovery certificate', 'know your customer', '\\bkyc\\b',
    'compliance certificate', 'order for compliance',
    'index fund', 'direct plan', '\\bnav\\b', 'mutual fund scheme',
    'board meeting intimation', 'trading window', 'disclosure under regulation',
    'newspaper publication', 'postal ballot', 'record date',
  ].join('|'), 'i');

  /* How much a headline bears on where the index goes in the next few hours. */
  function relevanceOf(n) {
    var text = String(n.headline || '') + ' ' + String(n.summary || '');
    var low = ' ' + text.toLowerCase().replace(/[^a-z0-9&]+/g, ' ') + ' ';

    if (PAPERWORK_RX.test(text)) return { w: 0.15, why: 'paperwork' };
    if (MACRO_RX.test(text)) return { w: 1.0, why: 'macro' };

    if (CONSTITUENTS.ready) {
      for (var i = 0; i < CONSTITUENTS.byAlias.length; i++) {
        var c = CONSTITUENTS.byAlias[i];
        if (low.indexOf(c.alias) !== -1) {
          return c.tier === 'next50'
            ? { w: 0.5, why: 'NIFTY Next 50: ' + c.symbol, symbol: c.symbol }
            : { w: 1.0, why: 'index constituent: ' + c.symbol, symbol: c.symbol };
        }
      }
    }
    // A listed company that is not in the index. Its own business, not NIFTY's.
    return { w: 0.25, why: 'single stock, outside the index' };
  }

  /* --------------------------------------------------------- clustering */
  var NEWS_STOP = (' the a an of in on at to for and or is are was were with from by as its it ' +
                   'this that will has have be been says said after over into up down new ').split(' ');
  var STOPSET = {};
  NEWS_STOP.forEach(function (w) { if (w) STOPSET[w] = 1; });

  function tokensOf(text) {
    var out = {}, n = 0;
    String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).forEach(function (w) {
      if (w.length > 2 && !STOPSET[w] && !out[w]) { out[w] = 1; n++; }
    });
    return { set: out, size: n };
  }
  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    var inter = 0;
    for (var k in a.set) if (b.set[k]) inter++;
    return inter / (a.size + b.size - inter);
  }

  /* Clustering is O(n^2) over a few hundred headlines and newsLane runs twice
     per build, which runs on every one-second tick. So the result is cached
     against a cheap signature of the pool - anything that changes the pool
     changes the signature and forces a rebuild.

     Several slots, not one. build() calls this twice with different pools -
     everything, then the international subset - and a single slot meant each
     call evicted the other's entry, so both recomputed on every tick. Measured:
     0.25ms when called alone against 116ms per pair when alternating, which
     was most of a 140ms build. Four slots is more than the two live callers
     need and still bounded. */
  var NEWS_CACHE_SLOTS = 4;
  var newsCache = { keys: [], byKey: {} };

  function newsCacheGet(sig) {
    return Object.prototype.hasOwnProperty.call(newsCache.byKey, sig) ? newsCache.byKey[sig] : null;
  }
  function newsCachePut(sig, value) {
    if (!Object.prototype.hasOwnProperty.call(newsCache.byKey, sig)) newsCache.keys.push(sig);
    newsCache.byKey[sig] = value;
    while (newsCache.keys.length > NEWS_CACHE_SLOTS) {
      delete newsCache.byKey[newsCache.keys.shift()];
    }
  }
  function newsCacheClear() { newsCache = { keys: [], byKey: {} }; }

  function clusterStories(items) {
    /* The signature has to depend on the contents, not just the shape. It was
       length plus the first and last timestamp, and two different pools of the
       same size spanning the same instants collided - a split tape was handed
       a unanimous tape's clusters and scored +1.0 instead of ~0. Caught by
       selftest, not by the page, which is the whole argument for the suite.

       djb2 over each item's dedupe key and sentiment: O(n) over short strings,
       and it changes whenever any member or any reading changes. */
    var h = 5381;
    for (var q = 0; q < items.length; q++) {
      var kq = (items[q].key || '') + '|' + (items[q].sentiment || 0);
      for (var c2 = 0; c2 < kq.length; c2++) h = ((h << 5) + h + kq.charCodeAt(c2)) | 0;
    }
    var sig = items.length + ':' + (h >>> 0).toString(36) + ':' + (CONSTITUENTS.ready ? 1 : 0);
    var hit = newsCacheGet(sig);
    if (hit) return hit;

    var prepped = items.map(function (n) {
      return { item: n, tok: tokensOf(n.headline), used: false };
    });
    var clusters = [];
    for (var i = 0; i < prepped.length; i++) {
      if (prepped[i].used) continue;
      prepped[i].used = true;
      var group = [prepped[i].item];
      for (var j = i + 1; j < prepped.length; j++) {
        if (prepped[j].used) continue;
        // Only the same story if it broke around the same time.
        if (Math.abs(prepped[i].item.ts - prepped[j].item.ts) > 21600) continue;
        /* Token overlap alone merges opposites. "RBI holds repo rate" and "RBI
           cuts repo rate" share three tokens of five - Jaccard 0.6, over the
           threshold - and merging them would fold two contradictory readings
           into one and then keep whichever happened to score harder. Same
           words is not the same story when the verdicts disagree, so opposed
           sentiment blocks the merge. */
        var si = prepped[i].item.sentiment || 0, sj = prepped[j].item.sentiment || 0;
        if (si * sj < 0) continue;
        if (jaccard(prepped[i].tok, prepped[j].tok) >= 0.5) {
          prepped[j].used = true;
          group.push(prepped[j].item);
        }
      }
      clusters.push(group);
    }

    /* Everything that does not depend on the clock is resolved here, once.
       relevanceOf() scans 319 aliases, and doing that for 516 clusters on
       every one-second tick measured 29ms a call - twice per build, for a
       result that cannot change until the pool does. Only the time decay is
       left for newsLane to apply. */
    var summarised = clusters.map(function (group) {
      var lead = group[0];
      for (var g = 1; g < group.length; g++) {
        if (Math.abs(group[g].sentiment || 0) > Math.abs(lead.sentiment || 0)) lead = group[g];
      }
      var sources = {}, distinct = 0;
      group.forEach(function (x) { if (x.source && !sources[x.source]) { sources[x.source] = 1; distinct++; } });
      return {
        lead: lead,
        size: group.length,
        rel: relevanceOf(lead),
        // Corroboration is worth something, but not its multiple. Five outlets
        // carrying one story is better evidence than one; it is nothing like
        // five separate events. So it enters as a log, capped.
        corroboration: 1 + Math.min(0.45, 0.15 * Math.log(Math.max(1, distinct))),
        distinct: distinct,
      };
    });

    newsCachePut(sig, summarised);
    return summarised;
  }

  function newsLane(items, opts) {
    opts = opts || {};
    var now = Date.now() / 1000, halfLife = opts.halfLifeSec || 21600;
    var region = opts.region || null;

    var pool = (items || []).filter(function (n) {
      if (!n || !n.ts) return false;
      if (region && n.region !== region) return false;
      return (now - n.ts) <= 172800;
    });
    if (!pool.length) return { score: 0, n: 0, high: 0, top: null, raw: 0, hasData: false };

    var clusters = clusterStories(pool);

    var num = 0, den = 0, counted = 0, high = 0, top = null, topW = 0;
    var duplicates = 0, suppressed = 0, macro = 0, named = 0;
    var votes = [], recent = 0;

    clusters.forEach(function (c) {
      // One vote per story. The loudest telling of it carries the cluster,
      // because a wire summary and a full write-up of the same event should
      // not average each other out.
      var lead = c.lead, rel = c.rel;
      duplicates += c.size - 1;
      if (rel.why === 'paperwork') suppressed++;
      if (rel.why === 'macro') macro++;
      if (rel.symbol) named++;

      var age = Math.max(0, now - lead.ts);
      var decay = Math.pow(0.5, age / halfLife);
      var w = IMPACT_W[lead.impact] * decay * rel.w * c.corroboration;
      if (w <= 0.01) return;

      num += (lead.sentiment || 0) * w;
      den += w;
      counted++;
      if (lead.impact === 'high' && rel.w >= 0.5) high++;

      // Kept so the spread and the consensus can be measured after the loop.
      // Only stories that actually expressed a view count toward agreement -
      // a neutral wire item is not a vote for "no change", it is silence.
      if (lead.sentiment) votes.push({ s: lead.sentiment, w: w });
      if (age <= 3600 && rel.w >= 0.5) recent++;

      var strength = Math.abs(lead.sentiment || 0) * w;
      if (strength > topW) { topW = strength; top = lead; }
    });

    if (!den) return { score: 0, n: 0, high: 0, top: null, raw: 0, hasData: false };
    var raw = num / den;

    /* How much the stories agree, and how far apart they are.

       A weighted mean is easy to drag. Measured on one live sweep, 63 relevant
       stories carried a mean of -0.857 and a spread of 1.62 - the tilt was real
       (22 positive against 41 negative) but a handful of -4 headlines were
       doing a lot of the work. Those are different situations and the mean
       alone cannot tell them apart.

       Consensus is the share of opinionated stories agreeing with the sign of
       the mean: 0.5 is a coin, 1.0 is unanimous. A mean with no consensus
       behind it is being set by outliers, so the score is shrunk toward zero
       rather than trusted at face value. At full disagreement it keeps half its
       size; at unanimity it keeps all of it. Half rather than none because a
       split tape genuinely is mildly informative - it is just not worth a full
       vote. */
    var consensus = null, dispersion = null, shrink = 1;
    if (votes.length >= 3) {
      var sign = raw >= 0 ? 1 : -1;
      var agree = 0, wsum = 0, mean = 0;
      votes.forEach(function (v) { wsum += v.w; mean += v.s * v.w; });
      mean = wsum ? mean / wsum : 0;
      var varSum = 0;
      votes.forEach(function (v) {
        if ((v.s > 0 ? 1 : -1) === sign) agree++;
        varSum += v.w * (v.s - mean) * (v.s - mean);
      });
      consensus = Math.round(agree / votes.length * 1000) / 1000;
      dispersion = wsum ? Math.round(Math.sqrt(varSum / wsum) * 1000) / 1000 : null;
      shrink = 0.5 + 0.5 * core.clamp(2 * consensus - 1, 0, 1);
    }

    /* Stories an hour, against the trailing rate over the window. A burst is
       not a direction - it is a warning that the tape is being repriced - so it
       is reported and shown, and deliberately does not vote. Acting on it would
       need a measured relationship this repo does not have yet. */
    var hours = Math.max(1, (opts.halfLifeSec || 21600) / 3600);
    var velocity = counted ? Math.round(recent / (counted / hours) * 100) / 100 : null;

    return {
      score: core.clamp(raw / 2.5, -1, 1) * shrink, raw: raw,
      scoreBeforeShrink: core.clamp(raw / 2.5, -1, 1),
      n: counted, high: high, top: top, hasData: true,
      stories: clusters.length, items: pool.length, duplicates: duplicates,
      suppressed: suppressed, macro: macro, named: named,
      consensus: consensus, dispersion: dispersion, shrink: Math.round(shrink * 1000) / 1000,
      opinionated: votes.length, recentHighRelevance: recent, velocity: velocity,
      relevanceReady: CONSTITUENTS.ready,
    };
  }

  function lastThursday(year, monthIdx) {
    var last = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
    for (var d = last; d >= 1; d--) if (new Date(Date.UTC(year, monthIdx, d)).getUTCDay() === 4) return d;
    return last;
  }

  function seasonalLane(seasonality, whenIst) {
    if (!seasonality || !seasonality.months) return { score: 0, note: 'no seasonal data', month: null, hasData: false };
    var d = whenIst || core.fmt.ist();
    var month = seasonality.months.filter(function (m) { return m.m === d.getMonth() + 1; })[0];
    if (!month || !month.n) return { score: 0, note: 'no seasonal data', month: null, hasData: false };
    var byReturn = core.clamp(month.avg / 3, -1, 1);
    var byWin = core.clamp((month.win - 50) / 20, -1, 1);
    var s = byReturn * 0.6 + byWin * 0.4;
    var parts = [month.name + ' averages ' + core.fmt.pct(month.avg) + ' over ' + month.n +
                 ' years (' + month.win.toFixed(0) + '% positive)'];
    var dow = (seasonality.days_of_week || []).filter(function (x) { return x.d === (d.getDay() + 6) % 7; })[0];
    if (dow) { s += core.clamp(dow.avg / 0.12, -1, 1) * 0.12; parts.push(dow.name + ' averages ' + core.fmt.pct(dow.avg, 3)); }
    var ew = seasonality.expiry_week;
    if (ew && ew.n && Math.abs(d.getDate() - lastThursday(d.getFullYear(), d.getMonth())) <= 3) {
      s += core.clamp((ew.avg - ew.other_avg) / 0.1, -1, 1) * 0.1;
      parts.push('expiry week (avg ' + core.fmt.pct(ew.avg, 3) + ' vs ' + core.fmt.pct(ew.other_avg, 3) + ')');
    }
    return { score: core.clamp(s, -1, 1), note: parts.join(', '), month: month, hasData: true };
  }

  function momentumLane(snap, candles) {
    if (!snap) return { score: 0, note: 'not enough history', hasData: false };
    var price = snap.price, bits = [];
    var s = 0, w = 0;
    if (snap.ema20) { s += core.clamp((price - snap.ema20) / snap.ema20 * 100 / 1.2, -1, 1) * 0.28; w += 0.28;
                      bits.push('price ' + (price >= snap.ema20 ? 'above' : 'below') + ' 20 EMA'); }
    if (snap.ema50) { s += core.clamp((price - snap.ema50) / snap.ema50 * 100 / 2.5, -1, 1) * 0.18; w += 0.18; }
    if (snap.rsi != null) { s += core.clamp((snap.rsi - 50) / 25, -1, 1) * 0.22; w += 0.22;
                            bits.push('RSI ' + snap.rsi.toFixed(0)); }
    if (snap.macdHist != null && snap.atr) { s += core.clamp(snap.macdHist / (snap.atr * 0.5), -1, 1) * 0.16; w += 0.16;
                            bits.push('MACD ' + (snap.macdHist >= 0 ? 'above' : 'below') + ' signal'); }
    if (snap.supertrendDir) { s += snap.supertrendDir * 0.16; w += 0.16;
                            bits.push('supertrend ' + (snap.supertrendDir > 0 ? 'long' : 'short')); }
    // ADX does not pick a side; it says how much to believe the side already
    // chosen. A trendless tape gets its momentum vote cut.
    var conviction = snap.adx == null ? 0.75 : core.clamp(snap.adx / 30, 0.35, 1.25);
    if (snap.adx != null) bits.push('ADX ' + snap.adx.toFixed(0));
    return { score: core.clamp((w ? s / w : 0) * conviction, -1, 1), note: bits.join(', '), adx: snap.adx, hasData: w > 0 };
  }

  /* Global cues, read from data/global.json when the workflow has produced it.
     Each instrument votes with a sign that reflects how it maps onto Indian
     equities: crude up and dollar up are headwinds, US futures up is a
     tailwind. Falls back to international news sentiment when absent. */
  /* The heaviest row in this table used to be `sgx_nifty`, at 0.24, labelled
     "GIFT / SGX Nifty". `fetch_global.py` fetched it from Yahoo symbol
     `^NSEI` - which is NIFTY spot. So a quarter of the global lane was NIFTY
     voting on NIFTY, and the open prediction built on top of it would have
     read its own answer back as evidence and called the gap zero every single
     day. Removed 20 Sep 2026 rather than reweighted: there is no keyless GIFT
     Nifty quote, and a row that is not what its label says is worse than a
     missing row.

     Nikkei, Hang Seng and the CBOE VIX were already being fetched and were
     read by nothing. They are the cues that actually trade while India is
     shut, which is precisely the window an opening gap is made in, so they
     go in here and carry the weight that came free. */
  var GLOBAL_MAP = {
    us_futures: { w: 0.24, sign: 1, label: 'US futures' },
    nasdaq_fut: { w: 0.10, sign: 1, label: 'Nasdaq futures' },
    nikkei:     { w: 0.10, sign: 1, label: 'Nikkei' },
    hangseng:   { w: 0.08, sign: 1, label: 'Hang Seng' },
    crude: { w: 0.14, sign: -1, label: 'Crude' },
    usdinr: { w: 0.14, sign: -1, label: 'USD/INR' },
    dxy: { w: 0.10, sign: -1, label: 'Dollar index' },
    us10y: { w: 0.06, sign: -1, label: 'US 10y' },
    gold: { w: 0.06, sign: -1, label: 'Gold' },
    cboe_vix: { w: 0.06, sign: -1, label: 'CBOE VIX' },
  };

  function globalLane(cues, newsGlobal) {
    if (!cues || !cues.items) {
      return { score: newsGlobal ? newsGlobal.score : 0,
               note: newsGlobal && newsGlobal.n ? (newsGlobal.n + ' international headlines') : 'no global data',
               parts: [], hasData: !!(newsGlobal && newsGlobal.n) };
    }
    var s = 0, w = 0, parts = [];
    Object.keys(GLOBAL_MAP).forEach(function (k) {
      var row = cues.items[k];
      if (!row || row.changePct == null) return;
      var m = GLOBAL_MAP[k];
      // A 1% move in a cue is a full-strength vote from that cue.
      var v = core.clamp(row.changePct / 1.0, -1.5, 1.5) * m.sign;
      s += v * m.w; w += m.w;
      parts.push({ label: m.label, changePct: row.changePct, contribution: Math.round(v * m.w * 1000) / 1000 });
    });
    if (!w) return { score: newsGlobal ? newsGlobal.score : 0, note: 'no global data', parts: [], hasData: !!(newsGlobal && newsGlobal.n) };
    var blended = core.clamp(s / w, -1, 1);
    // Overnight prices are hard evidence; global headlines are colour. Weight
    // accordingly rather than averaging them as equals.
    if (newsGlobal && newsGlobal.n > 4) blended = blended * 0.78 + newsGlobal.score * 0.22;
    parts.sort(function (a, b) { return Math.abs(b.contribution) - Math.abs(a.contribution); });
    var lead = parts[0];
    return {
      score: blended, parts: parts, hasData: true,
      note: lead ? (lead.label + ' ' + core.fmt.pct(lead.changePct) +
                    (parts[1] ? ', ' + parts[1].label + ' ' + core.fmt.pct(parts[1].changePct) : '')) : 'global cues flat',
    };
  }

  /* ==================================================== the model's read

     The only lane on this page whose working cannot be re-derived from its
     inputs. Every other lane is arithmetic a reader can check line by line;
     this one is a language model's opinion, and it is admitted on exactly the
     same terms as the rest - a number between -1 and +1, a weight, and a row
     in the ledger that scores it against what actually happened.

     What it is not allowed to do is anywhere near as important as what it is.
     It cannot write a price, a band, a probability or a weight. It votes, the
     vote is clamped, the vote is renormalised against the lanes that reported,
     and if it is wrong often enough the learner will quietly turn it down.

     Two things make the difference between a real lane and a flattering one:

       It never sees the engine's verdict. The prompt in app.js hands it the
       raw evidence - price, headlines, cues, positioning, momentum readings -
       and not the blended bias. Show a model the answer and it will agree with
       it, and the lane then reads as independent confirmation while adding
       nothing. That is the same failure as `sgx_nifty` feeding NIFTY back into
       the global lane, one level up and much harder to spot.

       It goes dark rather than stale. A vote older than MODEL_MAX_AGE_MS is
       not a current read of anything - the headlines have turned over - so the
       lane drops out and its weight goes to the lanes that did report. That is
       the same rule optionsLane() applies to a four-hour-old chain, and for
       the same reason. */
  var MODEL_MAX_AGE_MS = 20 * 60 * 1000;

  function modelLane(vote, nowMs) {
    if (!vote || vote.score == null || !isFinite(vote.score)) {
      return { score: 0, note: 'no model read yet', hasData: false };
    }
    var age = (nowMs || Date.now()) - (vote.at || 0);
    if (age > MODEL_MAX_AGE_MS) {
      return { score: 0, hasData: false,
               note: 'last read ' + Math.round(age / 60000) + ' min old, dropped' };
    }
    var score = core.clamp(vote.score, -1, 1);
    var mins = Math.round(age / 60000);
    return {
      score: score, hasData: true,
      model: vote.model || null,
      why: vote.why || '',
      note: (vote.why ? String(vote.why).slice(0, 110) : 'no reason given') +
            ' (' + (mins < 1 ? 'just now' : mins + ' min ago') + ')',
    };
  }

  /* ==================================================== the opening gap

     Every other lane in this file answers "which way from here". This one
     answers a different question that the page could not answer at all until
     now: what price does the next session START at.

     It is a separate question because a gap is not drift. NIFTY does not walk
     from Friday's close to Monday's open one bar at a time; it is shut while
     the rest of the world trades, and it reprices in one jump at 09:15 to
     whatever happened in between. Modelling that as drift spread over the
     first few bars is the wrong shape and will read wrong on the chart every
     single morning.

     The betas below are judgements, not fits - stated plainly because the rest
     of this file states its measurements plainly and these are not measurements.
     They are the conventional ordering: US futures lead, Asia trades inside
     India's own morning and so carries real information about the open, the
     rupee matters more than crude, and volatility is a damper rather than a
     direction. `KT.learn` moves them from the settled record once there are
     opens to learn from, and until then `fitted` is false and the UI says so.

     What is NOT in here, deliberately: NIFTY's own last change. That was the
     bug in `sgx_nifty` - see GLOBAL_MAP above - and it is the one input that
     would make this lane look brilliant while predicting nothing.

     One more thing these numbers have to account for, which the first draft of
     them did not: the four equity rows are not four independent opinions. S&P
     futures, Nasdaq futures, the Nikkei and the Hang Seng mostly move
     together, so betas chosen as if each were the only cue sum to far more
     than the response actually is. Measured against the live cue file on 20
     Sep 2026 - a night with Nasdaq futures up 3.3% - the first draft produced
     a gap of exactly 1.5%, which is to say it hit the clamp and stopped being
     a model. The equity block now totals 0.52 rather than 1.05, so a 1% US
     night reads as roughly half a percent on the open, and the clamp goes back
     to being what it is for: one feed printing nonsense. */
  var OPEN_BETA = {
    us_futures: 0.22,
    nasdaq_fut: 0.12,
    nikkei:     0.12,
    hangseng:   0.06,
    usdinr:    -0.30,
    dxy:       -0.08,
    crude:     -0.04,
    us10y:     -0.04,
    cboe_vix:  -0.02,
  };
  /* A gap is bounded by what gaps actually are. NIFTY opening more than 1.5%
     away from its close is a handful of days a decade - budget, an election
     result, a global shock - and on those days no cross-asset regression was
     going to call it either. Clipping here keeps one bad print in one feed
     from drawing a projection off the top of the chart. */
  var MAX_GAP_PCT = 1.5;

  function openLane(cues, newsOvernight, lastClose, betas) {
    var B = betas || OPEN_BETA;
    var out = { gapPct: 0, price: lastClose, parts: [], hasData: false,
                note: 'no overnight cues', fitted: !!(betas && betas.fitted) };
    if (!lastClose) return out;

    var gap = 0, seen = 0, parts = [];
    if (cues && cues.items) {
      Object.keys(B).forEach(function (k) {
        if (k === 'fitted') return;
        var row = cues.items[k];
        if (!row || row.changePct == null || !isFinite(row.changePct)) return;
        /* One cue cannot carry the whole gap. A 9% crude print - which the
           feed has produced - would otherwise be worth -0.45% on its own, and
           a single bad tick in one instrument would move the opening call
           further than any real morning does. */
        var move = core.clamp(row.changePct, -4, 4);
        var add = move * B[k];
        gap += add;
        seen++;
        parts.push({ key: k, label: (GLOBAL_MAP[k] && GLOBAL_MAP[k].label) || k,
                     changePct: row.changePct, contributionPct: r3(add) });
      });
    }
    if (!seen) return out;

    /* Overnight headlines, scaled to a tenth of a percent at full strength.
       Small on purpose: a sentiment score is an opinion about text, and the
       futures are a price somebody paid. When they disagree the price wins. */
    if (newsOvernight && newsOvernight.n > 3) {
      var newsAdd = core.clamp(newsOvernight.score, -1, 1) * 0.10;
      gap += newsAdd;
      parts.push({ key: 'news', label: 'Overnight headlines',
                   changePct: null, contributionPct: r3(newsAdd) });
    }

    gap = core.clamp(gap, -MAX_GAP_PCT, MAX_GAP_PCT);
    parts.sort(function (a, b) { return Math.abs(b.contributionPct) - Math.abs(a.contributionPct); });

    var lead = parts[0];
    return {
      gapPct: r3(gap),
      price: r2(lastClose * (1 + gap / 100)),
      parts: parts, cues: seen, hasData: true, fitted: !!(betas && betas.fitted),
      note: lead ? (lead.label + ' ' + core.fmt.pct(lead.changePct != null ? lead.changePct : lead.contributionPct))
                 : 'cues flat',
    };
  }

  /* Room to run. Price pinned under a wall it has failed at four times is not
     the same setup as price in clear air, whatever the momentum says. */
  function levelsLane(lv, price, atr) {
    if (!lv || !price) return { score: 0, note: 'no levels', hasData: false };
    var up = lv.nearestResistance, dn = lv.nearestSupport;
    if (!up && !dn) return { score: 0, note: 'no level nearby', hasData: false };
    var a = atr || price * 0.004;
    var dUp = up ? (up.level - price) / a : 8;
    var dDn = dn ? (price - dn.level) / a : 8;
    // More headroom than floor-room leans up, and vice versa.
    var s = core.clamp((dUp - dDn) / 6, -1, 1);
    // With only one side found, the comparison is against a guess. Halve the
    // vote rather than letting an absent level read as a maximum signal.
    if (!up || !dn) s *= 0.5;
    var note = [];
    if (up) note.push('resistance ' + core.fmt.price(up.level) + ' (' + up.touches + ' touches, ' + core.fmt.pct(up.distPct, 1) + ')');
    if (dn) note.push('support ' + core.fmt.price(dn.level) + ' (' + dn.touches + ' touches, ' + core.fmt.pct(dn.distPct, 1) + ')');
    return { score: s, note: note.join(', '), up: up, down: dn, atrToUp: dUp, atrToDown: dDn, hasData: true };
  }

  function flowLane(flows) {
    if (!flows) return { score: 0, note: 'no flow data', hasData: false };
    var s = 0, w = 0, bits = [];
    if (flows.breadth && (flows.breadth.advances + flows.breadth.declines) > 0) {
      var b = flows.breadth, tot = b.advances + b.declines;
      s += core.clamp((b.advances - b.declines) / tot / 0.5, -1, 1) * 0.5; w += 0.5;
      bits.push(b.advances + ' advancing vs ' + b.declines + ' declining' +
                (flows.breadthOrigin === 'browser' ? ' (live)' : ''));
    }

    /* Midcap breadth against large-cap breadth. An index carried by a handful
       of heavyweights while the broad market sags is a different tape from one
       where everything is participating, and the headline advance/decline
       count cannot tell them apart. Measured on one live payload: NIFTY 50 at
       26 up / 24 down against NIFTY MIDCAP 100 at 71 up / 28 down.

       Weighted lightly. It is a genuine read on risk appetite and it is also
       the newest thing in this lane, with no measured record behind it. */
    if (flows.breadthDivergence != null) {
      s += core.clamp(flows.breadthDivergence / 0.25, -1, 1) * 0.15; w += 0.15;
      bits.push('midcap breadth ' +
                (flows.breadthDivergence > 0 ? 'stronger' : 'weaker') + ' than large-cap by ' +
                Math.abs(Math.round(flows.breadthDivergence * 100)) + 'pts');
    }
    if (flows.fii && flows.fii.netCr != null) {
      s += core.clamp(flows.fii.netCr / 3000, -1, 1) * 0.3; w += 0.3;
      bits.push('FII net ' + core.fmt.signed(flows.fii.netCr, 0) + ' cr');
    }
    if (flows.dii && flows.dii.netCr != null) {
      s += core.clamp(flows.dii.netCr / 3000, -1, 1) * 0.2; w += 0.2;
      bits.push('DII net ' + core.fmt.signed(flows.dii.netCr, 0) + ' cr');
    }
    if (!w) return { score: 0, note: 'no flow data', hasData: false };
    return { score: core.clamp(s / w, -1, 1), note: bits.join(', '), hasData: true };
  }

  /* ============================================================= options

     The only forward-looking lane in the model. Everything else reads prices
     that have already printed or headlines that have already been published;
     this reads what money is positioned for next.

     Three signals, weighted by how much a 6.5-hour horizon can actually use:

     Change in open interest, put against call. Who is writing today. Puts
     written into a tape that is holding is support being sold; calls written
     into one that has stalled is a ceiling being built. Read on a log scale
     because the ratio is multiplicative - 2.5 and 0.4 are the same distance
     from neutral, and a linear read would not treat them that way.

     Standing open interest, put against call. The same idea over the whole
     book rather than today's flow. Slower, so weaker over this horizon, but it
     does not flip on one large trade.

     Max pain. Price does drift toward the strike where writers pay out least,
     but the pull is weak and concentrated in the last day or two, so it is
     scaled by how close expiry is rather than applied flat. A week out it
     contributes essentially nothing, which is the honest weight for it.

     The direction convention here - heavy put-side activity reads bullish - is
     the standard intraday reading for an index, and it is a convention rather
     than something this repo has measured. The ledger is what will eventually
     say whether it earns its weight. Until then the lane carries a deliberately
     modest 0.10 and the panel says the weight is a guess. */
  function optionsLane(opt, price, nowMs) {
    if (!opt || !opt.ok || !price) {
      return { score: 0, note: 'no option chain', hasData: false };
    }

    /* Staleness is the real constraint. NSE answers with
       Access-Control-Allow-Origin: beta.nseindia.com, so the browser cannot
       fetch this and it arrives through the workflow - which CLAUDE.md measured
       at roughly one run every two and a half hours, not the five minutes the
       cron asks for. Max pain and the OI walls tolerate that; today's
       change-in-OI does not. Past four hours the lane drops out rather than
       voting on positioning that has since moved. */
    var stamp = Date.parse(opt.generated_at || '');
    var ageMin = isFinite(stamp) ? ((nowMs || Date.now()) - stamp) / 60000 : null;
    if (ageMin != null && ageMin > 240) {
      return { score: 0, hasData: false, ageMin: Math.round(ageMin),
               note: 'option chain is ' + Math.round(ageMin / 60) + 'h old, too stale to vote' };
    }

    var s = 0, w = 0, bits = [];

    if (opt.pcrChgOi != null && opt.pcrChgOi > 0) {
      // log base 2.5: a ratio of 2.5 or 0.4 is a full-strength vote.
      var v1 = core.clamp(Math.log(opt.pcrChgOi) / Math.log(2.5), -1, 1);
      s += v1 * 0.45; w += 0.45;
      bits.push('puts outwritten calls ' + opt.pcrChgOi + ':1 today');
    }

    if (opt.pcrOi != null && opt.pcrOi > 0) {
      var v2 = core.clamp((opt.pcrOi - 1) / 0.35, -1, 1);
      s += v2 * 0.20; w += 0.20;
      bits.push('standing PCR ' + opt.pcrOi);
    }

    if (opt.maxPainPct != null && opt.expiryDays != null) {
      // Full weight on expiry day, nothing a week out.
      var prox = core.clamp(1 - opt.expiryDays / 7, 0, 1);
      var v3 = core.clamp(opt.maxPainPct / 0.5, -1, 1) * prox;
      s += v3 * 0.20; w += 0.20;
      if (prox > 0.2) {
        bits.push('max pain ' + core.fmt.price(opt.maxPain) + ' (' +
                  core.fmt.pct(opt.maxPainPct) + ', ' + opt.expiryDays + 'd to expiry)');
      }
    }

    /* Room to the nearest positioning wall, up against down. Same shape as
       levelsLane, but these walls are where options are stacked rather than
       where price happened to turn - and the two often disagree, which is
       itself worth seeing. */
    var up = (opt.resistance || [])[0], dn = (opt.support || [])[0];
    if (up && dn && up.distPct != null && dn.distPct != null) {
      var room = core.clamp((up.distPct + dn.distPct) / 1.5, -1, 1);
      s += room * 0.15; w += 0.15;
      bits.push('OI wall ' + core.fmt.price(up.strike) + ' above, ' +
                core.fmt.price(dn.strike) + ' below');
    }

    if (!w) return { score: 0, note: 'option chain carried no usable signal', hasData: false };

    /* "Live" and "from this morning" are different claims and the panel must
       not blur them. A browser-fetched chain is seconds old; the workflow copy
       can be hours old, and the age is printed either way once it matters. */
    var note = bits.join(', ');
    if (opt.origin === 'browser' && (ageMin == null || ageMin < 10)) {
      note += ' (live)';
    } else if (ageMin != null && ageMin > 10) {
      note += ' (as of ' + (ageMin >= 90 ? Math.round(ageMin / 60) + 'h' : Math.round(ageMin) + ' min') + ' ago)';
    }
    return {
      score: core.clamp(s / w, -1, 1), note: note, hasData: true,
      ageMin: ageMin == null ? null : Math.round(ageMin),
      pcrOi: opt.pcrOi, pcrChgOi: opt.pcrChgOi,
      maxPain: opt.maxPain, maxPainPct: opt.maxPainPct,
      ivSkew: opt.ivSkew, atmIv: opt.atmIv,
      origin: opt.origin || 'workflow',
      resistance: up || null, support: dn || null,
    };
  }

  /* ====================================================== the band, once

     build() and calibrate() used to draw this twice, and they drifted: the
     chart showed a band built from a GARCH term structure, the intraday
     volatility profile and a calibrated multiplier, while the accuracy panel
     scored a flat stdev(rets)*sqrt(t) band with a fixed 1.15 on it. The panel
     was therefore reporting the coverage of a model nobody could see, and the
     number it printed said nothing about the band on screen.

     One function now, called by both. The only thing a caller varies is where
     the drift comes from - which is the part that genuinely differs, because
     the news, global and flow lanes cannot be replayed historically. The
     variance, the profile, the multiplier and the level tempering are shared
     by construction and cannot diverge again. */
  function bandPath(cfg) {
    var path = [], upper = [], lower = [], upper2 = [], lower2 = [], detail = [];
    var cumVar = 0, t = cfg.lastCandle.time;
    var useProfile = cfg.vp && cfg.vp.intraday;
    for (var k = 1; k <= cfg.bars; k++) {
      t = advance(t, cfg.barSec);
      var frac = k / cfg.bars;

      // accumulated variance with the intraday profile applied bar by bar
      var barVar = (cfg.varPath ? cfg.varPath[k - 1] : Math.pow(cfg.sigmaBlend, 2));
      var profileMult = useProfile ? cfg.vp.mult(t) : 1;
      cumVar += barVar * profileMult;
      var sd = Math.sqrt(cumVar);

      /* The drift callback may return a plain number or, when the caller wants
         the projection explained rather than merely drawn, an object carrying
         the same total plus the pieces it was built from. Keeping the
         decomposition here rather than recomputing it elsewhere is the same
         rule bandPath itself exists for: two places computing the drift is two
         places that can disagree about it. */
      var out = cfg.drift(k, frac, t);
      var rawPct = typeof out === 'number' ? out : out.total;
      var parts = typeof out === 'number' ? null : out.parts;

      var driftPct = core.clamp(rawPct, -cfg.capPct, cfg.capPct);
      /* The gap is added outside the per-bar cap and is not scaled by k. It is
         a level shift that has already happened by the time the first
         projected bar prints - the market reopens at a different price - so
         capping it with `maxDriftPctPerBar`, which exists to stop a *drift*
         running away over many bars, would be capping the wrong quantity with
         the wrong number. It is bounded by MAX_GAP_PCT where it is produced. */
      var gapPct = cfg.gapPct || 0;
      // The price every probability on this path is measured against.
      var refP = cfg.lastClose * (1 + gapPct / 100);
      // A wall does not stop price, it slows it. Beyond a level with a real
      // record, the remaining drift is halved rather than cut off, which keeps
      // the path continuous and still reflects the resistance.
      var untempered = cfg.lastClose * (1 + (gapPct + driftPct) / 100);
      var mid = temper(untempered, cfg.lastClose, cfg.lv);

      var band1 = cfg.lastClose * sd / 100 * cfg.z68;
      var band2 = cfg.lastClose * sd / 100 * cfg.z95;
      path.push({ time: t, value: r2(mid) });
      upper.push({ time: t, value: r2(mid + band1) });
      lower.push({ time: t, value: r2(mid - band1) });
      upper2.push({ time: t, value: r2(mid + band2) });
      lower2.push({ time: t, value: r2(mid - band2) });

      if (parts) {
        detail.push({
          time: t, bar: k, frac: frac,
          parts: parts,
          rawPct: r3(rawPct),
          gapPct: r3(gapPct),
          // What the cap and the level tempering took off, separately, because
          // "the model wanted more but a wall was in the way" is a different
          // statement from "the model wanted more but the cap said no".
          cappedPct: r3(driftPct - rawPct),
          temperPct: r3((mid - untempered) / cfg.lastClose * 100),
          driftPct: r3((mid - cfg.lastClose) / cfg.lastClose * 100),
          sdPct: r3(sd),
          profileMult: Math.round(profileMult * 100) / 100,
          /* Probability of finishing above the price the projection starts
             from: the last close intraday, and the PREDICTED OPEN once a gap
             is in play.

             Measured against the last close it was arithmetically right and
             useless. With a 0.92% gap called, "above yesterday's close at
             15:30" is 99% by lunchtime and says nothing, because the gap
             already answered it - the chart printed 100% on every checkpoint
             the first time this ran. What is still uncertain is whether the
             session holds its open, so that is what this measures.

             Clamped to 1-99 either way. A page that prints a certainty has
             stopped describing a forecast. */
          pUp: sd > 0
            ? core.clamp(Math.round(ncdf((mid - refP) / (cfg.lastClose * sd / 100)) * 100), 1, 99)
            : 50,
        });
      }
    }
    return { path: path, upper: upper, lower: lower, upper2: upper2, lower2: lower2,
             detail: detail };
  }

  /* Everything the band needs that is not the drift: the profile, the fitted
     variance model, its forward path and its calibrated multipliers. Built the
     same way for a live forecast and for a replay, from whatever history it is
     handed - so a replay cannot accidentally see the future through a profile
     fitted on the whole series. */
  /* One slot, because build() is the only caller that repeats. The page polls
     once a second while the market is open and every one of those ticks used
     to refit the whole variance model - measured at 462ms on a 600-bar window,
     which is half a second of blocked main thread per second of market. The
     fit only changes when a new bar closes, so that is exactly what the key
     is. calibrate() walks distinct histories and misses on purpose. */
  var volCache = { key: null, value: null };

  function volContext(hist, barSec, bars, vix, opts) {
    opts = opts || {};
    var lastBar = hist.length ? hist[hist.length - 1] : null;
    var cacheKey = lastBar ? [barSec, bars, hist.length, lastBar.time, lastBar.close,
                              vix || 0, opts.conformal ? opts.conformal.z68 : 0].join(':') : null;
    if (cacheKey && volCache.key === cacheKey) return volCache.value;
    /* Fitting on every bar ever loaded is not more accurate, only slower, and
       on a 1651-bar series it measured 1292ms against 16ms on 300 - the
       optimiser needs far more iterations to satisfy a longer likelihood, so
       the cost is worse than linear. A GARCH's memory is short by construction
       (persistence 0.988 on this series has a half-life of about 57 bars), so
       history beyond a few hundred bars contributes almost nothing to the
       current variance and a great deal to the wait. */
    var MAX_FIT_BARS = opts.maxFitBars || 600;
    if (hist.length > MAX_FIT_BARS) hist = hist.slice(hist.length - MAX_FIT_BARS);
    var vp = volProfile(hist, barSec);
    var rets = [];
    for (var i = Math.max(1, hist.length - 120); i < hist.length; i++) {
      var pv = hist[i - 1].close;
      if (pv) rets.push((hist[i].close - pv) / pv);
    }
    var sigmaBar = stdev(rets) * 100;

    var volModel = null;
    try {
      if (KT.vol) volModel = KT.vol.model(hist, { profile: vp.intraday ? vp.mult : null, minBars: 80 });
    } catch (e) { volModel = null; }
    if (volModel && !(volModel.sigma2 && volModel.sigma2.length)) volModel = null;
    if (volModel) {
      var fitted = Math.sqrt(volModel.sigma2[volModel.sigma2.length - 1]);
      if (fitted > 0 && isFinite(fitted)) sigmaBar = fitted;
    }
    if (!(sigmaBar > 0)) sigmaBar = 0.25;

    var vixBar = null;
    if (vix && vix > 3) {
      var barsPerYear = 365.25 * 24 * 3600 / barSec;
      if (barSec < 86400) barsPerYear = 252 * (6.25 * 3600 / barSec);
      vixBar = vix / Math.sqrt(barsPerYear);
    }
    var vixWeight = volModel && volModel.kind !== 'ewma' ? 0.25 : 0.4;
    var sigmaBlend = vixBar ? (sigmaBar * (1 - vixWeight) + vixBar * vixWeight) : sigmaBar;

    var varPath = null;
    if (volModel) {
      try {
        var fwd = KT.vol.forecastPath(volModel, bars,
          volModel.rv[volModel.rv.length - 1], volModel.rets[volModel.rets.length - 1]);
        if (fwd && fwd.length === bars && fwd[0] > 0) {
          var k0 = Math.pow(sigmaBlend, 2) / fwd[0];
          varPath = fwd.map(function (v) { return v * k0; });
        }
      } catch (e) { varPath = null; }
    }

    var z68 = C.forecast.coneVolMultiplier, z95 = C.forecast.coneVolMultiplier * 1.96;
    var zBasis = 'fixed multiplier (no fitted model)';
    if (volModel && volModel.z68 && volModel.z68.z > 0) {
      z68 = volModel.z68.z;
      z95 = volModel.z95 && volModel.z95.z > 0 ? volModel.z95.z : z68 * 1.96;
      zBasis = volModel.z68.basis + ', ' + volModel.z68.n + ' one-bar residuals';
    }

    /* The multiplier above is calibrated on ONE-BAR standardised residuals,
       and the band it is used for spans seventy-five. Those are different
       distributions: a horizon error accumulates drift error and model error
       on top of the variance, so the one-bar quantile is systematically too
       small. Replayed properly the first version of this covered 45% against
       a nominal 68% - Kupiec p=0.034, a real failure, not noise.

       So the horizon multiplier is calibrated at the horizon, by split
       conformal prediction: score every past replay by |actual - forecast|
       divided by the band's own sigma, and take the quantile of those scores.
       That is distribution-free and needs no assumption about the shape of
       the horizon error at all. calibrate() produces it; this uses it as soon
       as it exists, and falls back to the one-bar number before then while
       saying which it used. */
    if (opts.conformal && opts.conformal.z68 > 0) {
      z68 = opts.conformal.z68;
      z95 = opts.conformal.z95 > 0 ? opts.conformal.z95 : z68 * 1.96;
      zBasis = 'split conformal at the ' + bars + '-bar horizon, ' +
               opts.conformal.n + ' replays';
    }
    var out = {
      vp: vp, volModel: volModel, sigmaBar: sigmaBar, sigmaBlend: sigmaBlend,
      vixBar: vixBar, varPath: varPath, z68: z68, z95: z95, zBasis: zBasis,
      rets: rets,
    };
    if (cacheKey) { volCache.key = cacheKey; volCache.value = out; }
    return out;
  }

  /* ============================================================ the build */
  function build(ctx) {
    var candles = ctx.candles || [], items = ctx.news || [], tfKey = ctx.timeframe;
    var tf = C.timeframes[tfKey];
    if (!candles.length || !tf) return null;

    var lastCandle = candles[candles.length - 1];
    var lastClose = lastCandle.close;
    if (ctx.livePrice && lastClose && Math.abs(ctx.livePrice - lastClose) / lastClose < 0.025) {
      lastClose = ctx.livePrice;
      lastCandle.close = ctx.livePrice;
      lastCandle.high = Math.max(lastCandle.high, ctx.livePrice);
      lastCandle.low = Math.min(lastCandle.low, ctx.livePrice);
    }

    var snap = ctx.indicators || KT.ind.snapshot(candles);
    var lv = ctx.levels || null;
    var structs = ctx.structures || [];
    var atr = (snap && snap.atr) || lastClose * 0.004;

    var nAll = newsLane(items);
    var nGlobal = newsLane(items, { region: 'international', halfLifeSec: 43200 });
    var seasonal = seasonalLane(ctx.seasonality);
    var mom = momentumLane(snap, candles);
    var glob = globalLane(ctx.global, nGlobal);
    var struct = KT.structures.impliedBias(structs, lastClose, ctx.structureStats);
    var lvl = levelsLane(lv, lastClose, atr);
    var flow = flowLane(ctx.flows);
    var opts = optionsLane(ctx.options, lastClose, Date.now());
    var mdl = modelLane(ctx.modelVote, Date.now());

    /* ------------------------------------------------------ opening gap
       Only meaningful while India is shut. Intraday there is no gap left to
       call - the market has already opened, the reprice is in the candles,
       and adding it again would double-count the morning for the rest of the
       day. `gapApplies` is therefore the market clock, not a setting. */
    var mState = core.marketState ? core.marketState() : null;
    var gapApplies = tf.barSec < 86400 && !!(mState && mState.state !== 'live');
    var nOvernight = gapApplies ? newsLane(items, { halfLifeSec: 43200 }) : null;
    var open = openLane(ctx.global, nOvernight, lastClose,
                        (KT.learn && KT.learn.openBetas && KT.learn.openBetas()) || null);
    var gapPct = gapApplies && open.hasData ? open.gapPct : 0;
    // Shared by the band, the checkpoints and the narrative, for the reason
    // bandPath() itself exists: one number, computed once.
    var refPrice = lastClose * (1 + gapPct / 100);

    var shape = dayShape(candles, tf.barSec);

    /* Weights come from the learner when it has settled rows to learn from,
       and from CONFIG when it does not. One line, one source, and the object
       carries `fitted` so the page can say which it is showing rather than
       leaving a reader to assume the numbers were measured. */
    var W = (KT.learn && KT.learn.weights && KT.learn.weights()) || C.forecast.weights;
    var lanes = [
      { id: 'news', label: 'News flow', score: nAll.score, weight: W.news, hasData: nAll.hasData,
        note: nAll.n ? (nAll.n + ' scored headlines, ' + nAll.high + ' high impact') : 'no headlines yet' },
      { id: 'seasonal', label: 'Seasonal', score: seasonal.score, weight: W.seasonal, note: seasonal.note, hasData: seasonal.hasData },
      { id: 'momentum', label: 'Momentum', score: mom.score, weight: W.momentum, note: mom.note, hasData: mom.hasData },
      { id: 'global', label: 'Global cue', score: glob.score, weight: W.global, note: glob.note, hasData: glob.hasData },
      { id: 'structure', label: 'Chart structure', score: struct.score, weight: W.structure, hasData: struct.hasData,
        note: struct.note || 'no structure in play' },
      { id: 'levels', label: 'Room to run', score: lvl.score, weight: W.levels, note: lvl.note, hasData: lvl.hasData },
      { id: 'flow', label: 'Flows and breadth', score: flow.score, weight: W.flow, note: flow.note, hasData: flow.hasData },
      { id: 'options', label: 'Options positioning', score: opts.score, weight: W.options, note: opts.note, hasData: opts.hasData },
      { id: 'model', label: 'Model read', score: mdl.score, weight: W.model, note: mdl.note, hasData: mdl.hasData },
    ];

    /* Lanes with no data must not drag the bias toward zero. Renormalise over
       the lanes that actually reported. hasData means the lane received input,
       not that it formed an opinion - a lane that read forty headlines and
       concluded neutral is live and belongs in the denominator.

       This was a regex over each lane's own English note until 18 Sep 2026, so
       rewording a note silently changed the bias. It also read the news lane as
       live when it was dark, because the fallback string "no headlines yet"
       contains "headlines" and matched the pattern meant to detect the opposite.
       The heaviest lane in CONFIG (0.24) therefore voted a hard zero whenever
       the RSS sweep came back empty, instead of dropping out. */
    var live = lanes.filter(function (l) { return l.hasData; });
    var wsum = live.reduce(function (s, l) { return s + l.weight; }, 0) || 1;
    var bias = core.clamp(live.reduce(function (s, l) { return s + l.score * l.weight; }, 0) / wsum, -1, 1);
    lanes.forEach(function (l) { l.contribution = Math.round(l.score * l.weight / wsum * 1000) / 1000; });

    /* ---------------------------------------------------- regime -------- */
    var rets = [];
    for (var i = Math.max(1, candles.length - 120); i < candles.length; i++) {
      var pv = candles[i - 1].close;
      if (pv) rets.push((candles[i].close - pv) / pv);
    }
    var ac1 = autocorr(rets, 1);
    // Negative lag-1 autocorrelation means the tape is fading its own moves,
    // so a drift projection should be trimmed. Positive means it follows on.
    var persistence = core.clamp(1 + ac1 * 1.6, 0.45, 1.5);


    var bars = Math.max(6, Math.round(tf.visibleBars * tf.forecastRatio));
    if (tf.maxForecastBars) bars = Math.min(bars, tf.maxForecastBars);
    // The session view runs to the bell, not to a bar count. Applied after the
    // cap above on purpose: maxForecastBars exists to stop a long view
    // projecting years, and a horizon that ends at 15:30 today is not the
    // thing it is guarding against.
    if (tf.sessionForecast) bars = barsToSessionClose(lastCandle.time, tf.barSec);

    /* ---------------------------------------------------- volatility -----
       The intraday profile, the fitted model, the VIX blend, the forward
       variance and the calibrated multipliers all come from one place that
       calibrate() also calls. That is the point: the band scored in the
       accuracy panel is now the band drawn on the chart, by construction
       rather than by two pieces of code agreeing to stay in step. */
    var vc = volContext(candles, tf.barSec, bars, ctx.vix, { conformal: ctx.conformal || null });
    var vp = vc.vp, volModel = vc.volModel;
    var sigmaBar = vc.sigmaBar, sigmaBlend = vc.sigmaBlend, vixBar = vc.vixBar;
    var varPath = vc.varPath, z68 = vc.z68, z95 = vc.z95, zBasis = vc.zBasis;

    /* ---------------------------------------------------- drift shape ----
       News pushes early and fades; seasonality accrues evenly; structure
       pulls toward its measured target late, once the break has had time to
       happen. Splitting them means the path bends the way the inputs actually
       behave instead of following one arbitrary curve. */
    var newsPart = (nAll.score * W.news + glob.score * W.global) / wsum;
    /* The model is in the even group, not the news group. It is handed the
       headlines but it is also handed positioning, momentum and the cues, so
       what it produces is a read of the whole picture rather than a reaction
       to a headline - and a read of the whole picture applies across the
       session rather than decaying out of it in the first hour. */
    var evenPart = (seasonal.score * W.seasonal + mom.score * W.momentum +
                    lvl.score * W.levels + flow.score * W.flow +
                    opts.score * W.options + mdl.score * W.model) / wsum;
    var structPart = (struct.score * W.structure) / wsum;

    var horizonSigma = sigmaBlend * Math.sqrt(bars);
    var scale = horizonSigma * 1.1 * persistence;
    var capPct = C.forecast.maxDriftPctPerBar * bars;

    /* Adaptive conformal inference over what the ledger has actually settled.
       Inert until there are rows, and it says so rather than pretending. */
    var aciState = null;
    try {
      if (KT.vol && KT.ledger && KT.ledger.missRecord) {
        aciState = KT.vol.aci(0.68, KT.ledger.missRecord(ctx.symbol, tfKey, 68));
        if (aciState && aciState.active) {
          // Widen or tighten to the coverage the record says is honest.
          var zTarget = KT.vol.tquantile((1 + aciState.coverageAdapted) / 2, volModel ? volModel.df : 6);
          var zNominal = KT.vol.tquantile(0.84, volModel ? volModel.df : 6);
          if (zNominal > 0) { z68 *= zTarget / zNominal; z95 *= zTarget / zNominal; }
        }
      }
    } catch (e) { aciState = null; }

    var checkpoints = [];
    var newsHalfBars = Math.max(2, bars * 0.35);

    var drawn = bandPath({
      lastCandle: lastCandle, lastClose: lastClose, bars: bars, barSec: tf.barSec,
      sigmaBlend: sigmaBlend, varPath: varPath, vp: vp, z68: z68, z95: z95,
      lv: lv, capPct: capPct, gapPct: gapPct,
      drift: function (k, frac, t) {
        var newsDecay = 1 - Math.pow(0.5, k / newsHalfBars);   // front-loaded
        var structRamp = Math.pow(frac, 1.4);                  // back-loaded
        var newsAt = newsPart * newsDecay * scale;
        var evenAt = evenPart * frac * scale;
        var structAt = structPart * structRamp * scale;
        // The clock's own average path, where there is enough history for it.
        // Four sessions of shape is an anecdote and twenty is a pattern, so the
        // contribution is scaled by how many sessions went into it rather than
        // trusted flat.
        var shapeAt = 0;
        if (shape) {
          var sv = shape.at(t), s0 = shape.at(lastCandle.time);
          if (sv !== null && s0 !== null) {
            shapeAt = (sv - s0) * 0.35 * core.clamp(shape.sessions / 15, 0.15, 1);
          }
        }
        return {
          total: newsAt + evenAt + structAt + shapeAt,
          /* The three timing groups and the clock term, plus how far each
             timing curve has travelled by this bar. That second part is what
             makes the hover worth reading: the same lane mix produces a
             different push at 10:30 and at 15:15, and nothing on the page
             showed that before. */
          parts: {
            news: newsAt, even: evenAt, struct: structAt, shape: shapeAt,
            newsDecay: newsDecay, evenRamp: frac, structRamp: structRamp,
          },
        };
      },
    });
    var path = drawn.path, upper = drawn.upper, lower = drawn.lower,
        upper2 = drawn.upper2, lower2 = drawn.lower2;

    /* ------------------------------------------------- per-bar attribution
       Why the line is where it is, at every bar, not just at the end.

       Each lane belongs to one timing group, and the group's curve says how
       much of that lane's push has landed by bar k: news decays so it arrives
       early, the even group accrues linearly, a structure target ramps in late
       because the break needs time to happen. So a lane's contribution at bar
       k is its share of the bias times its group's curve at k, and those sum
       exactly to the drift the band was drawn with.

       Computed once here rather than in the chart, because the chart drawing
       its own version of this is how build() and calibrate() drifted apart. */
    var GROUP_OF = { news: 'news', global: 'news', structure: 'struct',
                     seasonal: 'even', momentum: 'even', levels: 'even', flow: 'even',
                     options: 'even', model: 'even' };
    var attribution = drawn.detail.map(function (d) {
      var curve = { news: d.parts.newsDecay, even: d.parts.evenRamp,
                    struct: d.parts.structRamp, shape: 1 };
      var laneParts = lanes.filter(function (l) { return l.hasData; }).map(function (l) {
        var g = GROUP_OF[l.id] || 'even';
        return { id: l.id, label: l.label, group: g,
                 pct: r3(l.contribution * curve[g] * scale),
                 note: l.note, arrived: Math.round(curve[g] * 100) };
      }).filter(function (l) { return Math.abs(l.pct) >= 0.0005; })
        .sort(function (a, b) { return Math.abs(b.pct) - Math.abs(a.pct); });

      return {
        time: d.time, bar: d.bar,
        label: timeLabel(d.time, tf.barSec),
        driftPct: d.driftPct, rawPct: d.rawPct,
        cappedPct: d.cappedPct, temperPct: d.temperPct,
        sdPct: d.sdPct, profileMult: d.profileMult, pUp: d.pUp,
        shapePct: r3(d.parts.shape),
        lanes: laneParts,
      };
    });

    /* ------------------------------------------------- historical analogue
       A drift formula draws a smooth line because it is a smooth formula. Here
       we ask the series itself: when did the chart last look like it looks now,
       and what happened next? The average of those real forward paths carries
       the texture that a formula cannot, so the projection gains genuine ups
       and downs rather than a clean curve.

       The model keeps the direction and the magnitude. The analogue only lends
       its wiggle, and only in proportion to how well it actually matches - a
       weak match barely moves the line. */
    var analog = null;
    try {
      if (KT.analogs && candles.length > bars * 3) {
        analog = KT.analogs.find(candles, {
          window: Math.max(10, Math.round(bars * 0.6)),
          horizon: bars,
          k: 8,
        });
        if (analog && analog.ok && analog.quality > 5) {
          var shaped = KT.analogs.shape(path, analog, lastClose, 0.55);
          // The bands travel with the path, otherwise the cone detaches from
          // the line it is supposed to be describing.
          for (var sIdx = 0; sIdx < shaped.length; sIdx++) {
            var delta = shaped[sIdx].value - path[sIdx].value;
            upper[sIdx].value = r2(upper[sIdx].value + delta);
            lower[sIdx].value = r2(lower[sIdx].value + delta);
            upper2[sIdx].value = r2(upper2[sIdx].value + delta);
            lower2[sIdx].value = r2(lower2[sIdx].value + delta);
          }
          /* The attribution was built from the pre-analogue drift, so without
             this the hover card names a centre the chart does not draw.
             Measured on the live series: up to 18.3 points, 0.079%. That is
             the same two-places-compute-the-same-thing failure bandPath()
             exists to prevent, reintroduced one layer up.

             The lane parts still describe the drift the model asked for - the
             analogue does not change any lane's view - so the shift is
             recorded as its own contributor rather than smeared across them.
             That is also the more useful reading: the analogue is a real input
             and the card should name it. */
          for (var aIdx = 0; aIdx < attribution.length && aIdx < shaped.length; aIdx++) {
            var a = attribution[aIdx];
            var shiftPct = (shaped[aIdx].value - path[aIdx].value) / lastClose * 100;
            a.analogPct = r3(shiftPct);
            a.driftPct = r3((shaped[aIdx].value - lastClose) / lastClose * 100);
            a.pUp = a.sdPct > 0
              ? core.clamp(Math.round(ncdf((shaped[aIdx].value - refPrice) / (lastClose * a.sdPct / 100)) * 100), 1, 99)
              : 50;
          }
          path = shaped;
        }
      }
    } catch (e) {
      analog = null;
    }

    /* -------------------------------------------- component projections
       The blended path above answers "where does everything, together, point".
       It does not answer the two questions actually worth asking separately:
       what does the news alone imply, and what does the chart's own history
       alone imply. When those two disagree, that disagreement is the signal -
       a bullish tape into bearish headlines is a different situation from both
       pointing the same way, and one line cannot show it.

       Same machinery, same volatility, same level tempering. Only the drift
       source changes, so the three are directly comparable. */
    function component(parts) {
      var out = [], tc = lastCandle.time, cv = 0;
      for (var j = 1; j <= bars; j++) {
        tc = advance(tc, tf.barSec);
        var fr = j / bars;
        cv += (varPath ? varPath[j - 1] : Math.pow(sigmaBlend, 2)) * (vp.intraday ? vp.mult(tc) : 1);
        var nd = 1 - Math.pow(0.5, j / newsHalfBars);
        var sr = Math.pow(fr, 1.4);
        var d = ((parts.news || 0) * nd + (parts.even || 0) * fr + (parts.struct || 0) * sr) * scale;
        d = core.clamp(d, -capPct, capPct);
        // Same gap as the blended path. The opening reprice is not a lane's
        // opinion - it happens to all three lines equally - so leaving it out
        // here would make the news and pattern lines start from a price the
        // market will not open at, and the fan between them would read as
        // disagreement that is really just a missing gap.
        out.push({ time: tc, value: r2(temper(lastClose * (1 + (gapPct + d) / 100), lastClose, lv)) });
      }
      return out;
    }

    // News and the global cue: what the flow of information implies on its own.
    var newsOnly = (nAll.score * W.news + glob.score * W.global) / wsum;
    // Chart structure, momentum and room to the next level: what the price
    // record implies on its own, with no headline input at all.
    var patternOnly = (struct.score * W.structure + mom.score * W.momentum +
                       lvl.score * W.levels) / wsum;

    var pathNews = component({ news: newsOnly });
    var pathPattern = component({ struct: (struct.score * W.structure) / wsum,
                                  even: (mom.score * W.momentum + lvl.score * W.levels) / wsum });

    var endNews = pathNews.length ? pathNews[pathNews.length - 1].value : lastClose;
    var endPat = pathPattern.length ? pathPattern[pathPattern.length - 1].value : lastClose;
    var agreeSign = (endNews - lastClose) * (endPat - lastClose);
    var componentSummary = {
      news: {
        bias: r2(newsOnly), end: endNews,
        changePct: r2((endNews - lastClose) / lastClose * 100),
        note: nAll.n ? nAll.n + ' scored headlines, ' + nAll.high + ' high impact'
                     : 'no headlines scored yet',
      },
      pattern: {
        bias: r2(patternOnly), end: endPat,
        changePct: r2((endPat - lastClose) / lastClose * 100),
        note: [struct.note, mom.note].filter(Boolean).join('; ') || 'no structure read',
      },
      // The honest headline: do the two stories agree, and by how much do they
      // differ at the end of the horizon.
      agree: agreeSign > 0 ? 'agree' : (agreeSign < 0 ? 'conflict' : 'flat'),
      gapPct: r2(Math.abs(endNews - endPat) / lastClose * 100),
    };

    /* ------------------------------------------------------ checkpoints
       The answer to "where will it be at X". Five points across the horizon,
       each with the expected level, the 68% range and the probability of
       finishing above the current price. */
    var marks = pickCheckpoints(bars);
    marks.forEach(function (k2) {
      var idx = k2 - 1;
      if (idx < 0 || idx >= path.length) return;
      var mid = path[idx].value, band = mid - lower[idx].value;
      var sd = band / z68;
      var z = sd > 0 ? (mid - refPrice) / sd : 0;
      checkpoints.push({
        time: path[idx].time,
        label: timeLabel(path[idx].time, tf.barSec),
        value: mid,
        low: lower[idx].value, high: upper[idx].value,
        low95: lower2[idx].value, high95: upper2[idx].value,
        changePct: r2((mid - lastClose) / lastClose * 100),
        // Same 1-99 clamp as bandPath: a checkpoint that says 100% is not a
        // forecast, and these are the numbers printed on the chart.
        pUp: core.clamp(Math.round(ncdf(z) * 100), 1, 99),
        /* What that probability is above. Carried on the row so the chart,
           the table and the narrative cannot each assume a different one -
           which they would, the moment a gap made them differ. */
        pUpFrom: refPrice,
        bars: k2,
      });
    });

    /* ------------------------------------------------------- confidence */
    var scores = live.map(function (l) { return l.score; });
    var agreement = core.clamp(1 - stdevOf(scores) / 0.9, 0, 1);
    var coverage = core.clamp(nAll.n / 40, 0.25, 1);
    var strength = core.clamp(Math.abs(bias) / 0.5, 0.2, 1);
    var trendiness = snap && snap.adx != null ? core.clamp(snap.adx / 35, 0.3, 1) : 0.6;
    var confidence = Math.round(
      C.forecast.minConfidence + (C.forecast.maxConfidence - C.forecast.minConfidence) *
      (agreement * 0.38 + coverage * 0.16 + strength * 0.26 + trendiness * 0.20)
    );

    var endMid = path.length ? path[path.length - 1].value : lastClose;
    var direction = bias > 0.08 ? 'BULLISH' : bias < -0.08 ? 'BEARISH' : 'RANGE-BOUND';

    return {
      timeframe: tfKey,
      horizonLabel: horizonLabel(tf, bars),
      bias: Math.round(bias * 1000) / 1000,
      direction: direction,
      confidence: core.clamp(confidence, C.forecast.minConfidence, C.forecast.maxConfidence),
      lastClose: r2(lastClose),
      target: endMid,
      targetPct: r2((endMid - lastClose) / lastClose * 100),
      rangeLow: lower.length ? lower[lower.length - 1].value : lastClose,
      rangeHigh: upper.length ? upper[upper.length - 1].value : lastClose,
      forecastBars: bars,
      volPerBar: Math.round(sigmaBlend * 1000) / 1000,
      volRealised: Math.round(sigmaBar * 1000) / 1000,
      volImplied: vixBar ? Math.round(vixBar * 1000) / 1000 : null,
      /* What produced the band, so the panel can show its working rather than
         asserting a width. Null volModel means vol.js could not fit and the
         old realised-vol path ran - which is a fact worth displaying, not
         hiding behind a number that looks the same either way. */
      volModel: volModel ? {
        kind: volModel.kind,
        omega: r2(volModel.omega * 10000) / 10000,
        alpha: Math.round(volModel.alpha * 1000) / 1000,
        beta: Math.round(volModel.beta * 1000) / 1000,
        gamma: Math.round((volModel.gamma || 0) * 1000) / 1000,
        df: Math.round(volModel.df * 10) / 10,
        persistence: Math.round((volModel.effectivePersistence != null ? volModel.effectivePersistence : volModel.persistence) * 1000) / 1000,
        qlike: Math.round(volModel.qlike * 10000) / 10000,
        deseasonalised: !!volModel.deseasonalised,
        rangeBars: volModel.used ? volModel.used.range : null,
        fallbackBars: volModel.used ? volModel.used.fallback : null,
        candidates: volModel.candidates || null,
        reason: volModel.reason || null,
      } : null,
      z68: Math.round(z68 * 1000) / 1000,
      z95: Math.round(z95 * 1000) / 1000,
      zBasis: zBasis,
      aci: aciState,
      persistence: Math.round(persistence * 100) / 100,
      autocorr: Math.round(ac1 * 1000) / 1000,
      intradayProfile: vp.intraday,
      dayShapeSessions: shape ? shape.sessions : 0,
      lanes: lanes,
      attribution: attribution,
      path: path, upper: upper, lower: lower, upper2: upper2, lower2: lower2,
      pathNews: pathNews, pathPattern: pathPattern, components: componentSummary,
      analog: analog,
      checkpoints: checkpoints,
      topNews: nAll.top,
      /* The lane's own working, so the news panel can report what it did with
         the stream instead of recomputing it and drifting from the model. */
      newsDetail: {
        hasData: nAll.hasData, items: nAll.items || 0, stories: nAll.stories || 0,
        duplicates: nAll.duplicates || 0, suppressed: nAll.suppressed || 0,
        macro: nAll.macro || 0, named: nAll.named || 0,
        consensus: nAll.consensus == null ? null : nAll.consensus,
        dispersion: nAll.dispersion == null ? null : nAll.dispersion,
        shrink: nAll.shrink == null ? 1 : nAll.shrink,
        opinionated: nAll.opinionated || 0, velocity: nAll.velocity,
        relevanceReady: !!nAll.relevanceReady,
      },
      seasonMonth: seasonal.month,
      rsi: snap ? snap.rsi : null,
      structure: struct.target || null,
      globalParts: glob.parts || [],
      options: opts.hasData ? opts : null,
      /* The opening call. `applies` is what the UI must read before printing
         a number: intraday the gap is behind us and this object is a stale
         description of a reprice that already happened, so showing it then
         would be an answer to a question the clock has closed. */
      modelRead: mdl.hasData ? { score: r3(mdl.score), why: mdl.why, model: mdl.model } : null,
      open: {
        applies: gapApplies,
        hasData: open.hasData,
        price: open.hasData ? open.price : null,
        gapPct: open.hasData ? open.gapPct : null,
        gapPoints: open.hasData ? r2(open.price - lastClose) : null,
        at: path.length ? path[0].time : null,
        parts: open.parts || [],
        cues: open.cues || 0,
        fitted: !!open.fitted,
        note: open.note,
        prevClose: lastClose,
      },
      narrative: narrate(direction, lanes, nAll, checkpoints, lastClose),
      generatedAt: Date.now(),
    };
  }

  function temper(mid, from, lv) {
    if (!lv) return mid;
    var wall = mid > from ? lv.nearestResistance : lv.nearestSupport;
    if (!wall || wall.touches < 2) return mid;
    var beyond = mid > from ? mid - wall.level : wall.level - mid;
    if (beyond <= 0) return mid;
    var damp = core.clamp(1 - wall.touches * 0.12, 0.3, 0.7);
    return mid > from ? wall.level + beyond * damp : wall.level - beyond * damp;
  }

  /* The close at or immediately before a time.

     calibrate() used to read its outcome from candles[at + bars], on the
     assumption that advancing the clock by `bars` bar-widths lands on the bar
     `bars` indices later. It does not. A NIFTY session holds 75 five-minute
     bars but spans 74 intervals, so on the 1D view the band ended at 15:30 on
     the day it was drawn while index at+75 was the *next* day's 09:15 open.
     Measured over the loaded series, 19 of 20 replay endpoints disagreed, by a
     median of 213 bars.

     That mattered more than an off-by-one usually does, because the gap being
     skipped over is the overnight one - the 09:15 bucket runs at 13.2x the
     average bar variance. Coverage was being scored against a price one
     overnight jump beyond where the band actually ended, which made the band
     look far too narrow and would have had the conformal step widening it to
     cover an error the model never made.

     The band's time axis is what the chart draws and what horizonLabel
     describes, so the time axis is authoritative and the outcome is read at
     the time the band ends. */
  function closeAtTime(candles, t) {
    if (!candles || !candles.length || candles[0].time > t) return null;
    var lo = 0, hi = candles.length - 1, best = null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (candles[mid].time <= t) { best = candles[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best ? best.close : null;
  }

  function pickCheckpoints(bars) {
    var want = [Math.round(bars * 0.15), Math.round(bars * 0.3), Math.round(bars * 0.5),
                Math.round(bars * 0.75), bars];
    var seen = {}, out = [];
    want.forEach(function (k) { k = Math.max(1, k); if (!seen[k]) { seen[k] = 1; out.push(k); } });
    return out;
  }

  function timeLabel(epochSec, barSec) {
    var d = core.fmt.ist(epochSec);
    var hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (barSec < 86400) {
      var today = core.fmt.ist();
      var sameDay = d.getDate() === today.getDate() && d.getMonth() === today.getMonth();
      return sameDay ? hhmm : core.fmt.dayShort(epochSec) + ' ' + hhmm;
    }
    if (barSec < 604800) return core.fmt.dayShort(epochSec);
    return core.fmt.stamp(epochSec, barSec);
  }

  function horizonLabel(tf, bars) {
    // Counted in market time, so a 32-bar daily projection reads as 32 trading
    // sessions rather than the calendar month those sessions happen to span.
    // barSec is the measured spacing, not the declared one, so a series the
    // provider quietly downgraded is still described correctly.
    if (tf.barSec >= 2419200) {                       // monthly bars
      return bars < 18 ? bars + ' months' : Math.round(bars / 12 * 10) / 10 + ' years';
    }
    if (tf.barSec >= 604800) {                        // weekly bars
      return bars < 9 ? bars + ' weeks' : Math.round(bars / 4.3) + ' months';
    }
    if (tf.barSec >= 86400) {
      return bars < 45 ? bars + ' trading days' : Math.round(bars / 21) + ' months';
    }
    var mins = bars * tf.barSec / 60;
    if (mins < 75) return Math.round(mins) + ' minutes';
    var sessionMins = CLOSE_MIN - OPEN_MIN;
    if (mins <= sessionMins) return (Math.round(mins / 30) / 2) + ' hours';
    return Math.round(mins / sessionMins * 10) / 10 + ' sessions';
  }

  function narrate(direction, lanes, news, checkpoints, price) {
    var ranked = lanes.slice().filter(function (l) { return Math.abs(l.contribution) > 0.001; })
      .sort(function (a, b) { return Math.abs(b.contribution) - Math.abs(a.contribution); });
    var lead = ranked[0], second = ranked[1];
    var verb = direction === 'BULLISH' ? 'leans up' : direction === 'BEARISH' ? 'leans down' : 'has no clear lean';
    var s = 'The balance ' + verb + '. ';
    if (lead) {
      s += 'Strongest input is ' + lead.label.toLowerCase() + ' (' + lead.note + ')';
      if (second) {
        var agrees = (second.score > 0) === (lead.score > 0);
        s += (agrees ? ', supported by ' : ', pulled against by ') + second.label.toLowerCase() +
             ' (' + second.note + ')';
      }
      s += '. ';
    }
    var lastCp = checkpoints[checkpoints.length - 1];
    if (lastCp) {
      s += 'By ' + lastCp.label + ' the centre of the range is ' + core.fmt.price(lastCp.value) +
           ' (' + core.fmt.pct(lastCp.changePct) + '), with about a ' + lastCp.pUp +
           '% chance of finishing above ' +
           core.fmt.price(lastCp.pUpFrom != null ? lastCp.pUpFrom : price) +
           (lastCp.pUpFrom != null && Math.abs(lastCp.pUpFrom - price) / price > 0.0002
             ? ' (the predicted open)' : '') + '. ';
    }
    if (news.top) s += 'Loudest headline: "' + news.top.headline.slice(0, 110) + '" (' + news.top.source + ').';
    return s;
  }

  /* ========================================================= calibration

     Walk the series, rebuild the band from data available at that bar, and
     check whether the future actually landed inside it.

     Two things were wrong with the version this replaces, and both flattered
     the model.

     First, it scored a band nobody could see. It built a flat
     stdev(rets)*sqrt(t) cone with a fixed 1.15 multiplier, while the chart drew
     a band shaped by the intraday volatility profile, a fitted variance model
     and a calibrated multiplier. The coverage number therefore described a
     model that does not exist. It now calls volContext() and bandPath() - the
     same two functions build() calls - so the thing scored is the thing drawn.

     Second, it counted the same evidence several times. The step was a third
     of the horizon, so consecutive replays shared two thirds of their window
     and their outcomes were strongly correlated. Measured on the 1D timeframe
     that turned about 15 independent observations into a reported 45, and the
     confidence interval that follows from 45 is roughly half as wide as the
     truth. Windows are now non-overlapping by default, and the overlapping
     count is reported alongside so the difference is visible rather than
     silently absorbed.

     Only the lanes that exist historically are used. There is no archive of
     the RSS stream, so news, global and flow cannot be replayed - together
     that is 47% of the model's weight, and the result is labelled as the
     technical core rather than the full model. Reporting a number that peeked
     at today's news would defeat the point. */
  function calibrate(candles, tfKey, opts, onDone) {
    opts = opts || {};
    var tf = C.timeframes[tfKey];
    if (!candles || candles.length < 200 || !tf) return null;
    var bars = Math.max(6, Math.round(tf.visibleBars * tf.forecastRatio));
    if (tf.maxForecastBars) bars = Math.min(bars, tf.maxForecastBars);

    /* Overlapping windows for the estimate, deflated sample size for the
       interval. This is the fix for the thing that made every number on this
       panel meaningless.

       Non-overlapping windows gave an honest n but only about twenty of them,
       and twenty is not enough: shifting the replay grid by five bars on the
       same series moved the direction rate from 33.3% to 92.3% and the
       conformal band multiplier from 0.738 to 1.642. The panel was reporting
       where the grid happened to start.

       Overlapping windows do not bias the estimate - every window is a valid
       replay - they only make it look more precise than it is. So all of them
       feed the point estimates and the conformal quantile, and every interval
       and significance test is computed on the effective sample size instead:

           nEff = nWindows * step / bars

       which is how many genuinely independent horizons the evidence covers.
       The panel shows both, because a reader who sees only the large number
       will over-read it, and a reader who sees only the small one will think
       the estimate is noisier than it is. */
    var step = opts.step || Math.max(1, Math.round(bars / 5));
    var warm = Math.max(150, bars * 2);
    if (candles.length < warm + bars + 1) return null;

    var W = C.forecast.weights;
    var capPct = C.forecast.maxDriftPctPerBar * bars;

    var in68 = 0, in95 = 0, n = 0, dirRight = 0, dirCalls = 0, scores = [];
    var absErr = 0, naiveErr = 0, crpsSum = 0, crpsN = 0;
    var missRecord = [], fits = 0, budgetMs = 0, laneUsed = {};
    var windowIdx = 0, lastVc = null, VOL_REFIT_EVERY = opts.volRefitEvery || 5;
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    /* The loop still steps by index because that is how the history is
       walked, but a window is only usable if its *time* endpoint is loaded.
       The margin is generous: one session of daily bars spans fewer indices
       than bar-widths, never more. */
    function runWindow(at) {
      var hist = candles.slice(0, at + 1);
      var last = hist[hist.length - 1];
      var price = last.close;
      if (!(price > 0)) return;

      var snap = KT.ind.snapshot(hist);
      if (!snap) return;

      /* Everything below is built from hist only. A profile or a variance model
         fitted on the whole series would be reading the future through the back
         door, and would be the single easiest way to make this number look
         good while meaning nothing. */
      /* The variance fit is almost all of the cost here - measured at 216ms a
         window against about 2ms for everything else - and conditional
         volatility does not turn over in fifteen bars. Refitting every fifth
         window keeps the five-fold increase in sample size roughly free. The
         reused model is still re-anchored to each window's own last bar
         through forecastPath(), so what carries over is the shape of the
         variance process, not a stale level. */
      var vc;
      if (windowIdx % VOL_REFIT_EVERY === 0 || !lastVc) {
        vc = volContext(hist, tf.barSec, bars, null,
          { conformal: opts.conformal || null, maxFitBars: opts.maxFitBars || 300 });
        fits++;
        lastVc = vc;
      } else {
        vc = lastVc;
      }
      windowIdx++;

      var ac = autocorr(vc.rets, 1);
      var persistence = core.clamp(1 + ac * 1.6, 0.45, 1.5);
      var shape = dayShape(hist, tf.barSec);

      var lv = KT.levels.build(hist);
      var mom = momentumLane(snap, hist);
      var lvl = levelsLane(lv, price, snap.atr);
      var seasonal = seasonalLane(opts.seasonality, core.fmt.ist(last.time));
      var structs = [];
      try { structs = KT.structures.detect(hist) || []; } catch (e) { structs = []; }
      var struct = KT.structures.impliedBias(structs, price, opts.structureStats);

      var liveW = 0;
      if (mom.hasData) { liveW += W.momentum; laneUsed.momentum = 1; }
      if (lvl.hasData) { liveW += W.levels; laneUsed.levels = 1; }
      if (struct.hasData) { liveW += W.structure; laneUsed.structure = 1; }
      if (seasonal.hasData) { liveW += W.seasonal; laneUsed.seasonal = 1; }
      if (!liveW) return;

      var evenPart = ((mom.hasData ? mom.score * W.momentum : 0) +
                      (lvl.hasData ? lvl.score * W.levels : 0) +
                      (seasonal.hasData ? seasonal.score * W.seasonal : 0)) / liveW;
      var structPart = (struct.hasData ? struct.score * W.structure : 0) / liveW;
      var bias = core.clamp(evenPart + structPart, -1, 1);

      var scale = vc.sigmaBlend * Math.sqrt(bars) * 1.1 * persistence;

      var drawn = bandPath({
        lastCandle: last, lastClose: price, bars: bars, barSec: tf.barSec,
        sigmaBlend: vc.sigmaBlend, varPath: vc.varPath, vp: vc.vp,
        z68: vc.z68, z95: vc.z95, lv: lv, capPct: capPct,
        drift: function (k, frac, t) {
          var d = (evenPart * frac + structPart * Math.pow(frac, 1.4)) * scale;
          if (shape) {
            var sv = shape.at(t), s0 = shape.at(last.time);
            if (sv !== null && s0 !== null) {
              d += (sv - s0) * 0.35 * core.clamp(shape.sessions / 15, 0.15, 1);
            }
          }
          return d;
        },
      });

      var idx = drawn.path.length - 1;
      var mid = drawn.path[idx].value;
      var lo68 = drawn.lower[idx].value, hi68 = drawn.upper[idx].value;
      var lo95 = drawn.lower2[idx].value, hi95 = drawn.upper2[idx].value;
      /* Read the outcome at the time the band ends, not at an index offset.
         See closeAtTime(). A replay whose endpoint falls past the last loaded
         candle is dropped rather than scored against the nearest thing to
         hand. */
      var endTime = drawn.path[idx].time;
      if (endTime > candles[candles.length - 1].time) return;
      var actual = closeAtTime(candles, endTime);
      if (!(actual > 0)) return;

      var inside68 = actual >= lo68 && actual <= hi68;
      if (inside68) in68++;
      if (actual >= lo95 && actual <= hi95) in95++;
      missRecord.push(inside68 ? 0 : 1);

      absErr += Math.abs(actual - mid) / price * 100;
      naiveErr += Math.abs(actual - price) / price * 100;

      /* Split-conformal nonconformity score: how many band-sigmas away the
         outcome actually landed. The quantile of these is the multiplier that
         would have given exactly the coverage asked for. */
      var sdBand = (mid - lo68) / (vc.z68 || 1);
      if (sdBand > 0) scores.push(Math.abs(actual - mid) / sdBand);

      // CRPS scores the whole band, which a hit rate cannot: it rewards a
      // sharp forecast that was right and refuses to reward a wide one that
      // merely failed to be wrong.
      if (KT.vol && KT.vol.crpsGaussian) {
        var sdPrice = (mid - lo68) / (vc.z68 || 1);
        var sc = KT.vol.crpsGaussian(actual, mid, sdPrice);
        if (sc != null && isFinite(sc)) { crpsSum += sc / price * 100; crpsN++; }
      }

      if (Math.abs(bias) > 0.08) {
        dirCalls++;
        if ((actual > price) === (bias > 0)) dirRight++;
      }
      n++;
    }

    /* Straight through when no callback is given - that is the path the tests
       take and it keeps the function easy to reason about. With a callback,
       the same windows run in slices with a yield between them.

       The yield is not a nicety. Ninety-six windows measured just under five
       seconds, all of it inside one macrotask, and the page polls the live
       price every second: without slicing, the chart stops repainting and the
       price stops ticking for five seconds every time this runs. */

    /* Everything after the walk, as a closure over the counters above, so the
       straight-through driver and the sliced one cannot produce two different
       summaries. Same reason bandPath() exists. */
    function finish() {
    budgetMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;

    if (n < 8) return null;

    /* How many independent horizons this evidence really covers. Every
       interval below is computed on this, not on n. */
    var nEff = Math.max(1, Math.round(n * step / bars));
    var effHits68 = Math.round(in68 / n * nEff);
    var effHits95 = Math.round(in95 / n * nEff);

    var k68 = KT.vol ? KT.vol.kupiec(effHits68, nEff, 0.68) : null;
    var k95 = KT.vol ? KT.vol.kupiec(effHits95, nEff, 0.95) : null;

    /* Conformal quantile with the finite-sample correction: the k-th smallest
       score where k = ceil((n+1) * coverage). When k exceeds n the sample
       cannot certify that coverage at all, and the honest answer is null
       rather than the largest score pretending to be a 95% quantile. */
    function conformalQ(coverage) {
      if (!scores.length) return null;
      var s = scores.slice().sort(function (a, b) { return a - b; });
      var k = Math.ceil((s.length + 1) * coverage);
      return k > s.length ? null : s[k - 1];
    }
    var cz68 = conformalQ(0.68), cz95 = conformalQ(0.95);

    /* Wilson interval on the direction rate. The point estimate on its own has
       been the most over-read number on this panel: 57.8% of 45 reads like an
       edge and its interval runs from 43.3% to 71.0%, which contains a coin. */
    var dirCallsEff = Math.max(1, Math.round(dirCalls * step / bars));
    var dirCi = null;
    if (dirCallsEff >= 5) {
      var ph = dirRight / dirCalls, z = 1.96, den = 1 + z * z / dirCallsEff;
      var centre = ph + z * z / (2 * dirCallsEff);
      var margin = z * Math.sqrt(ph * (1 - ph) / dirCallsEff + z * z / (4 * dirCallsEff * dirCallsEff));
      dirCi = [Math.round((centre - margin) / den * 1000) / 10,
               Math.round((centre + margin) / den * 1000) / 10];
    }

    return {
      /* n is how many replays ran; nEff is how many independent horizons they
         cover. Every interval on this object uses nEff. Showing only n would
         overstate the evidence by exactly the factor the windows overlap. */
      n: n, nEff: nEff, bars: bars, step: step,
      overlapFraction: Math.round((1 - step / bars) * 100),
      directionCallsEff: dirCallsEff,
      coverage68: Math.round(in68 / n * 1000) / 10,
      coverage95: Math.round(in95 / n * 1000) / 10,
      kupiec68: k68, kupiec95: k95,
      mae: Math.round(absErr / n * 1000) / 1000,
      naiveMae: Math.round(naiveErr / n * 1000) / 1000,
      // Below 1 the model beats "tomorrow equals today", which is a much
      // harder benchmark than it sounds on a near random walk.
      skill: Math.round(absErr / (naiveErr || 1) * 1000) / 1000,
      crps: crpsN ? Math.round(crpsSum / crpsN * 1000) / 1000 : null,
      directionCalls: dirCalls,
      directionRight: dirRight,
      directionRate: dirCalls ? Math.round(dirRight / dirCalls * 1000) / 10 : null,
      directionCi: dirCi,
      /* The direction rate is only worth acting on if its interval clears the
         break-even after costs, not merely 50%. This says whether it clears
         50% at all, which is the weaker of the two tests and still usually
         fails at these sample sizes. */
      directionSignificant: !!(dirCi && dirCi[0] > 50),
      /* The conformal quantile is the one number that genuinely benefits from
         every window: it is a quantile, not a rate, so overlap costs it
         precision but not validity, and averaging over five times as many
         windows is what stops the band width swinging by a factor of two on a
         five-bar shift of the grid. */
      conformalWindows: scores.length,
      missRecord: missRecord,
      /* Feed this straight back into the next build(): it is the multiplier
         that would have delivered the coverage the band claims. */
      conformal: (cz68 > 0) ? {
        z68: Math.round(cz68 * 1000) / 1000,
        z95: cz95 > 0 ? Math.round(cz95 * 1000) / 1000 : null,
        n: n,
        certifies95: cz95 != null,
      } : null,
      fits: fits, elapsedMs: Math.round(budgetMs),
      volModel: null,
      /* Name the lanes that actually voted, not the ones that could have.
         seasonality and the pattern hit-rate table are only passed in when the
         caller supplies them, and describing a lane as scored when it sat out
         is the same class of error as the regex that used to decide liveness. */
      lanesUsed: Object.keys(laneUsed),
      basis: (function () {
        var used = Object.keys(laneUsed);
        var usedW = used.reduce(function (t, k) { return t + (W[k] || 0); }, 0);
        var missing = ['news', 'momentum', 'global', 'structure', 'seasonal', 'levels', 'flow']
          .filter(function (k) { return !laneUsed[k]; });
        return 'replayed with ' + (used.join(', ') || 'no lanes') + ' - ' +
               Math.round(usedW * 100) + '% of the model weight. ' +
               'Unscored here: ' + missing.join(', ') + '. ' +
               'News, global and flow cannot be replayed at all because no archive of the feed ' +
               'exists yet; the rest sit out when the caller does not supply their inputs. ' +
               'Pattern hit rates and seasonal averages are deliberately not passed in, because ' +
               'both are computed over the whole series and would let the replay see its own future';
      })(),
    };
    }

    var at = warm;
    if (typeof onDone !== 'function') {
      for (; at + bars < candles.length; at += step) runWindow(at);
      return finish();
    }
    var SLICE = opts.slice || 6;
    (function chunk() {
      var budget = SLICE;
      while (budget-- > 0 && at + bars < candles.length) { runWindow(at); at += step; }
      if (at + bars < candles.length) { setTimeout(chunk, 0); return; }
      onDone(finish());
    })();
    return null;
  }
  /* ------------------------------------------------------------- helpers */
  function r2(n) { return Math.round(n * 100) / 100; }
  function r3(n) { return Math.round(n * 1000) / 1000; }
  function stdev(a) {
    if (!a || a.length < 2) return 0;
    var m = a.reduce(function (s, x) { return s + x; }, 0) / a.length;
    return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / a.length);
  }
  function stdevOf(a) { return stdev(a); }
  function autocorr(a, lag) {
    if (!a || a.length < lag + 8) return 0;
    var m = a.reduce(function (s, x) { return s + x; }, 0) / a.length;
    var num = 0, den = 0;
    for (var i = 0; i < a.length; i++) {
      den += (a[i] - m) * (a[i] - m);
      if (i >= lag) num += (a[i] - m) * (a[i - lag] - m);
    }
    return den ? num / den : 0;
  }

  KT.forecast = {
    build: build, calibrate: calibrate,
    newsLane: newsLane, seasonalLane: seasonalLane, momentumLane: momentumLane,
    globalLane: globalLane, levelsLane: levelsLane, flowLane: flowLane,
    optionsLane: optionsLane, openLane: openLane, openBetaDefaults: OPEN_BETA,
    modelLane: modelLane, MODEL_MAX_AGE_MS: MODEL_MAX_AGE_MS,
    barsToSessionClose: barsToSessionClose,
    volProfile: volProfile, dayShape: dayShape, ncdf: ncdf,
    bandPath: bandPath, volContext: volContext, advance: advance,
    setHolidays: setHolidays, isClosed: isClosed,
    setConstituents: setConstituents, relevanceOf: relevanceOf, clusterStories: clusterStories,
  };
})(window.KT);
