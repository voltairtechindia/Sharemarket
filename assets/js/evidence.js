/* ============================================================================
   The evidence count.

   One number on the page, and a breakdown behind it: how many individual
   observations the forecast on screen was actually built from.

   The number exists because "our AI analyses thousands of datapoints" is the
   emptiest sentence in this industry, and the only thing that makes it not
   empty is being willing to itemise it. So this counts, names and sources
   every group, and the panel prints the list.

   What counts as one datapoint, and what does not:

     counts    a value that was read from a source and fed into a calculation.
               One bar's open is one. One headline's sentiment score is one.
               One strike's call open interest is one. One EMA value at one
               bar is one - it is computed, but it is computed FROM data and
               is read BY the momentum lane, so it is a link in the chain.

     does not  work. Eighty-six candlestick detectors tested against 1,651
               bars is 142,000 test calls, and counting those would quadruple
               the headline overnight while adding no information - most of
               them are a function returning false. Only the hits count.

     does not  anything fetched and not read. A feed that returned 200 and
               whose items were dropped as irrelevant is counted once as a
               feed polled, not once per item it wasted.

     does not  the same value twice. The candle series is counted once, under
               price bars, not again under every indicator derived from it.

   Where a group's source is unavailable the group reports zero and says so.
   A count that quietly keeps yesterday's number for a dead feed is the exact
   failure the Data Lanes panel exists to prevent, one level up.
   ========================================================================== */
(function (KT) {
  'use strict';

  /* Indicator series computed per bar and read by a lane. Counted explicitly
     rather than inferred, so adding an indicator to indicators.js does not
     silently inflate the headline - somebody has to put it here, and that is
     the point at which they have to decide whether a lane actually reads it. */
  var PER_BAR_SERIES = [
    'ema20', 'ema50', 'ema200', 'rsi', 'macd', 'macdSignal', 'macdHist',
    'atr', 'adx', 'plusDI', 'minusDI', 'supertrend',
    'bbUpper', 'bbMid', 'bbLower', 'stochK', 'stochD', 'cci', 'williamsR',
    'obv', 'mfi', 'vwap',
  ];

  function n(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v) : 0; }

  function count(ctx) {
    ctx = ctx || {};
    var g = [];

    /* ------------------------------------------------------------ price --- */
    var bars = (ctx.candles && ctx.candles.length) || 0;
    g.push({ id: 'ohlc', label: 'Price values', n: bars * 4,
             note: bars ? bars.toLocaleString('en-IN') + ' bars, open/high/low/close each' : 'no candles loaded',
             source: 'Yahoo chart, or the workflow snapshot' });

    g.push({ id: 'indicators', label: 'Indicator readings', n: bars * PER_BAR_SERIES.length,
             note: PER_BAR_SERIES.length + ' series across every bar',
             source: 'computed here from the bars above' });

    /* ---------------------------------------------------------- patterns --- */
    var hits = (ctx.patterns && ctx.patterns.found && ctx.patterns.found.length) || 0;
    var detectors = (KT.candles && KT.candles.SET && KT.candles.SET.length) || 0;
    g.push({ id: 'patterns', label: 'Pattern hits', n: hits,
             note: detectors + ' detectors across ' + ((KT.candles && KT.candles.families) || 0) +
                   ' named families; only hits are counted, not the tests that found nothing',
             source: 'candles.js, scored against this series’ own history' });

    var structures = (ctx.structures && ctx.structures.length) || 0;
    g.push({ id: 'structures', label: 'Chart structures', n: structures,
             note: structures ? 'triangles, wedges, channels, double tops, head and shoulders, cup and handle'
                              : 'none currently in play',
             source: 'structures.js' });

    /* ------------------------------------------------------------ levels --- */
    var lv = ctx.levels, touches = 0, zones = 0;
    if (lv && lv.zones) {
      zones = lv.zones.length;
      lv.zones.forEach(function (z) { touches += n(z.touches); });
    }
    g.push({ id: 'levels', label: 'Level touches', n: touches,
             note: zones + ' price zones, counted by the times price actually respected each one',
             source: 'levels.js' });

    /* -------------------------------------------------------------- news --- */
    var nd = ctx.forecast && ctx.forecast.newsDetail;
    var items = (nd && nd.items) || (ctx.news && ctx.news.length) || 0;
    var feeds = n(ctx.feeds);
    /* Each scored headline carries a sentiment and an impact grade, and both
       are read by the lane, so a headline is two observations rather than one.
       Counting it as one would undercount exactly as badly as counting the
       whole article would overcount. */
    g.push({ id: 'news', label: 'Headline scores', n: items * 2,
             note: items ? items.toLocaleString('en-IN') + ' headlines, sentiment and impact each' +
                           (nd && nd.stories ? ', clustered into ' + nd.stories + ' distinct stories' : '')
                         : 'the news sweep has not returned yet',
             source: feeds ? feeds + ' RSS feeds, polled from the browser and the workflow'
                           : 'RSS, browser and workflow' });

    g.push({ id: 'feeds', label: 'Feeds polled', n: feeds,
             note: feeds ? 'each one checked and its liveness recorded' : 'feed index not loaded',
             source: 'config/feeds.yml' });

    /* Company-name matching is what turns a microcap filing into a NIFTY
       story. The universe is read on every headline, so it is evidence in
       use rather than a table sitting there. */
    var universe = n(ctx.universe);
    var members = n(ctx.constituents);
    g.push({ id: 'universe', label: 'Company names matched against', n: universe,
             note: members ? universe.toLocaleString('en-IN') + ' listed symbols, of which ' + members +
                             ' are index constituents with weights'
                           : 'symbol universe',
             source: 'NSE equity list' });

    /* ----------------------------------------------------------- options --- */
    var opt = ctx.options, strikes = n(opt && opt.strikes);
    /* Per strike: call OI, put OI, call change in OI, put change in OI, call
       IV, put IV. Six numbers, all six read by optionsLane(). */
    g.push({ id: 'options', label: 'Option chain values', n: strikes * 6,
             note: strikes ? strikes + ' strikes around the money, both sides, open interest, change and IV'
                           : 'the chain has not been reached this session',
             source: 'NSE option-chain-v3' });

    /* ------------------------------------------------------------- macro --- */
    var cues = (ctx.global && ctx.global.items) ? Object.keys(ctx.global.items).length : 0;
    g.push({ id: 'global', label: 'Overnight cue readings', n: cues * 2,
             note: cues ? cues + ' instruments, price and change each' : 'global cues not loaded',
             source: 'Yahoo and Stooq' });

    var flows = 0;
    if (ctx.flows) {
      ['fii', 'dii', 'advances', 'declines', 'unchanged'].forEach(function (k) {
        if (ctx.flows[k] != null) flows++;
      });
    }
    g.push({ id: 'flows', label: 'Flow and breadth readings', n: flows,
             note: flows ? 'FII and DII net, advances, declines, unchanged' : 'not available this run',
             source: 'NSE allIndices and the FII/DII report' });

    var filings = n(ctx.filings);
    g.push({ id: 'filings', label: 'Corporate filings read', n: filings,
             note: filings ? 'announcements matched against the symbol universe' : 'none in the window',
             source: 'NSE corporate announcements' });

    var events = n(ctx.events);
    g.push({ id: 'events', label: 'Scheduled releases', n: events,
             note: events ? 'shown on the hover card; deliberately not voted on, VIX already prices them'
                          : 'calendar not loaded',
             source: 'economic calendar' });

    var seasons = n(ctx.seasonality);
    g.push({ id: 'seasonal', label: 'Seasonal observations', n: seasons,
             note: seasons ? 'month, weekday and expiry-week records from this index’ own history'
                           : 'seasonality not loaded',
             source: 'computed from the long daily series' });

    /* ------------------------------------------------------- the record --- */
    var replays = n(ctx.calibration && ctx.calibration.n);
    g.push({ id: 'replays', label: 'Backtest replays', n: replays,
             note: replays ? 'the model rebuilt at past bars and scored against what followed'
                           : 'the first calibration has not finished yet',
             source: 'forecast.calibrate()' });

    var lockedMinutes = 0, lockRows = 0;
    if (KT.ledger && KT.ledger.locks) {
      try {
        KT.ledger.locks(ctx.symbol, 60).forEach(function (r) {
          lockRows++;
          lockedMinutes += (r.path && r.path.length) || 0;
        });
      } catch (e) { lockedMinutes = 0; }
    }
    g.push({ id: 'locked', label: 'Frozen forecast minutes', n: lockedMinutes,
             note: lockRows ? lockRows + ' locked calls, each minute scored against what printed'
                            : 'nothing frozen yet',
             source: 'the forward record in this browser' });

    var settled = 0;
    if (KT.ledger && KT.ledger.all) {
      try { settled = KT.ledger.all().length; } catch (e) { settled = 0; }
    }
    g.push({ id: 'ledger', label: 'Forecast rows written down', n: settled,
             note: settled ? 'each with its lanes, its band and its outcome' : 'none yet',
             source: 'the forward record in this browser' });

    var total = 0;
    g.forEach(function (x) { x.n = n(x.n); total += x.n; });
    g.sort(function (a, b) { return b.n - a.n; });

    return {
      total: total,
      groups: g,
      live: g.filter(function (x) { return x.n > 0; }).length,
      dark: g.filter(function (x) { return x.n === 0; }).length,
    };
  }

  KT.evidence = { count: count, PER_BAR_SERIES: PER_BAR_SERIES };
})(window.KT);
