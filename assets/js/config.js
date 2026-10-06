/* ============================================================================
   Configuration. Everything that might need changing lives here.

   No API key is stored in this file on purpose - the repo and the GitHub Pages
   site are public. The OpenRouter key is entered once in Settings and kept in
   this browser's localStorage. For your own machine you can drop an untracked
   assets/local-config.js (see assets/local-config.example.js) that sets
   window.KT_LOCAL = { openrouterKey: "sk-or-v1-..." } - .gitignore keeps it out
   of the repo.
   ========================================================================== */
window.KT = window.KT || {};

KT.CONFIG = {
  /* ------------------------------------------------------------ instruments */
  symbols: {
    NIFTY: {
      key: 'NIFTY', label: 'NIFTY 50', exchange: 'NSE index',
      yahoo: '^NSEI', mcId: 'in;NSX', primary: true,
    },
    SENSEX: {
      key: 'SENSEX', label: 'SENSEX', exchange: 'BSE index',
      yahoo: '^BSESN', mcId: 'in;SEN', primary: false,
    },
    /* BANK NIFTY carries about a third of the index's weight and is the
       second thing anybody looks at after NIFTY itself. Quote-only, like
       INDIA VIX: no mcId, so it takes the Yahoo fallback path, and no
       candle series is fetched for it - it is a number on the board, not a
       chart the forecast runs on. */
    BANKNIFTY: {
      key: 'BANKNIFTY', label: 'BANK NIFTY', exchange: 'NSE index',
      yahoo: '^NSEBANK', mcId: null, primary: false,
    },
    INDIAVIX: {
      key: 'INDIAVIX', label: 'INDIA VIX', exchange: 'NSE volatility',
      yahoo: '^INDIAVIX', mcId: null, primary: false, inverse: true,
    },
  },
  defaultSymbol: 'NIFTY',

  /* -------------------------------------------------------------- timeframes
     reasonBucket is the interval at which a "why did it move" point is placed,
     exactly as briefed: 10 minutes on the hourly view, 1 hour on the daily
     view, 1 day on the monthly view.                                         */
  /* maxForecastBars caps the projection independently of the 4:1 framing. The
     ratio is what the chart looks like; this is how far ahead the model is
     willing to claim anything. Without it the "till date" view projected 130
     weekly bars - two and a half years - and produced a band from 25,000 to
     1,16,000, which is arithmetically correct and completely useless. The
     chart still shows four parts history to one part forecast; there is just
     less of both on the long views. */
  timeframes: {
    /* The session view, added 20 Sep 2026. One bar a minute, and the
       projection runs to 15:30 rather than to a fixed bar count - which is
       what `sessionForecast` means and why it is not just another row with a
       smaller barSec. Every other view answers "the next N bars"; this one
       answers "the rest of today", and those stop being the same question the
       moment the clock is past 14:00.

       histPerForecast is 1.5 rather than the usual 4. The 4:1 framing is right
       when the forecast is a fifth of the picture; with 375 projected minutes
       it would demand 1500 bars of history and squeeze the session being
       forecast into a sliver of the chart - the opposite of what this view is
       for. */
    '1S':  { label: 'Session',   interval: '1m',  range: '5d',  reasonBucket: 900,    reasonLabel: 'every 15 minutes', visibleBars: 375, forecastRatio: 0.25, barSec: 60, sessionForecast: true, histPerForecast: 1.5, bakedAs: '1H' },
    '1H':  { label: 'Hourly',    interval: '1m',  range: '5d',  reasonBucket: 600,    reasonLabel: 'every 10 minutes', visibleBars: 240, forecastRatio: 0.25, barSec: 60 },
    '1D':  { label: 'Daily',     interval: '5m',  range: '1mo', reasonBucket: 3600,   reasonLabel: 'every 1 hour',     visibleBars: 300, forecastRatio: 0.25, barSec: 300 },
    '1M':  { label: 'Monthly',   interval: '1d',  range: '6mo', reasonBucket: 86400,  reasonLabel: 'every 1 day',      visibleBars: 130, forecastRatio: 0.25, barSec: 86400, maxForecastBars: 30 },
    '1Y':  { label: 'Yearly',    interval: '1d',  range: '2y',  reasonBucket: 604800, reasonLabel: 'every 1 week',     visibleBars: 260, forecastRatio: 0.25, barSec: 86400, maxForecastBars: 45 },
    /* Yahoo silently downgrades interval=1wk to monthly bars when range=max,
       so this row used to claim weekly candles while holding monthly ones -
       which put every "till date" forecast date four times too close. It now
       asks for what it actually gets, and barSec is re-derived from the data
       at load time anyway (see core.deriveBarSec) so a future change upstream
       cannot reintroduce the same silent error. */
    'ALL': { label: 'Till date', interval: '1mo', range: 'max', reasonBucket: 2592000,reasonLabel: 'every 1 month',    visibleBars: 520, forecastRatio: 0.25, barSec: 2592000, maxForecastBars: 12 },
  },
  defaultTimeframe: '1D',

  /* ----------------------------------------------------------- market hours
     NSE cash: pre-open 09:00-09:15 IST, regular 09:15-15:30 IST, Mon-Fri.    */
  market: {
    tzOffsetMin: 330,
    preOpen:  { from: 9 * 60,      to: 9 * 60 + 15 },
    regular:  { from: 9 * 60 + 15, to: 15 * 60 + 30 },
    weekdays: [1, 2, 3, 4, 5],
  },

  /* --------------------------------------------------------------- polling */
  poll: {
    tickMs: 1000,        // chart repaint / live price poll while market is open
    tickMsClosed: 30000, // gentle heartbeat when the market is shut
    newsMs: 60000,       // fast lane RSS
    bakedMs: 60000,      // re-read the workflow output (raw.githubusercontent, no Pages build)
    /* The live option chain, browser-side through the proxy. Three minutes
       rather than the one-second tick: NSE itself only restamps the chain every
       minute or so, the payload is 206 KB, and r.jina.ai rate-limits with a 429
       when leaned on. A failed or throttled fetch falls back to the workflow
       copy, which is what the lane used to run on exclusively. */
    optionsMs: 180000,
    /* Breadth, VIX and the midcap divergence, one call. Five minutes: breadth
       does not turn over faster than that in a way a 6.5-hour forecast can use,
       and it shares a rate-limited proxy hop with the option chain above. */
    internalsMs: 300000,
    maxBackoffMs: 60000,
  },

  /* ---------------------------------------------------------------- sources
     Every entry re-verified from the live GitHub Pages origin: these answer
     with CORS headers, so the browser reads them with no proxy and no workflow
     in the way. That is what makes a genuine 60 second lane possible - about
     800 items per sweep. Anything not on this list either refused CORS or
     returned 503 when tested, and belongs to the server-side workflow.       */
  directFeeds: [
    /* Moneycontrol's eight RSS paths used to head this list. www.moneycontrol.com
       now answers 403 to a browser on any of them - re-measured from the
       deployed origin, all eight, every time - so they are gone rather than
       left in to fail the lane on every sweep. The price feed on
       priceapi.moneycontrol.com is a different host and still works.
       Everything below was verified 200 with items from the live origin. */
    { id: 'cnbc_market',   name: 'CNBC TV18 markets',      url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml',           region: 'india' },
    { id: 'cnbc_economy',  name: 'CNBC TV18 economy',      url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/economy.xml',          region: 'india' },
    { id: 'cnbc_business', name: 'CNBC TV18 business',     url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/business.xml',         region: 'india' },
    { id: 'cnbc_pf',       name: 'CNBC TV18 personal fin', url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/personal-finance.xml', region: 'india' },
    { id: 'cnbc_startup',  name: 'CNBC TV18 startup',      url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/startup.xml',          region: 'india' },
    { id: 'cnbc_world',    name: 'CNBC TV18 world',        url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/world.xml',            region: 'international' },
    { id: 'yahoo_finance', name: 'Yahoo Finance',          url: 'https://finance.yahoo.com/news/rssindex',                              region: 'international' },
    { id: 'cnbc_us',       name: 'CNBC US markets',        url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258', region: 'international' },
    { id: 'cnbc_us_world', name: 'CNBC US world markets',  url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839135', region: 'international' },
    { id: 'cnbc_us_fin',   name: 'CNBC US finance',        url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', region: 'international' },
    { id: 'marketwatch',   name: 'MarketWatch top',        url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',           region: 'international' },
    { id: 'mw_realtime',   name: 'MarketWatch realtime',   url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines',    region: 'international' },
    { id: 'mw_pulse',      name: 'MarketWatch pulse',      url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',          region: 'international' },
  ],

  /* Feeds a browser cannot reach directly are NOT attempted here.
     Measured from the live origin: r.jina.ai rate limits (429) and strips RSS
     to plain text so no <item> survives, allorigins was refusing connections,
     and rss2json returned an error. The lane cost a request per cycle and
     returned nothing, so breadth is left to the server-side workflow, which
     has no CORS wall and had 177 of 183 polled feeds alive on its last run.
     The proxy chain below is still used for Yahoo candles, where it works. */
  proxiedFeeds: [],
  proxiedPerCycle: 0,

  /* Proxy chain, tried in order. Verified reachable from the Pages origin;
     r.jina.ai returns the upstream body untouched with x-return-format:text. */
  proxies: [
    { id: 'jina',       build: (u) => 'https://r.jina.ai/' + u, headers: { 'x-return-format': 'text' } },
    { id: 'allorigins', build: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
    { id: 'rss2json',   build: (u) => 'https://api.rss2json.com/v1/api.json?count=25&rss_url=' + encodeURIComponent(u), json: 'rss2json' },
  ],

  endpoints: {
    yahooChart: (sym, iv, rg) =>
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${rg}`,
    mcPrice: (id) =>
      `https://priceapi.moneycontrol.com/pricefeed/notapplicable/inidicesindia/${encodeURIComponent(id)}`,
    /* The option chain, live from the browser.

       NSE answers with Access-Control-Allow-Origin: beta.nseindia.com, so a
       direct fetch from this origin fails - measured, "Failed to fetch" in
       126ms. But r.jina.ai passes the body through untouched, and measured from
       a real page origin it returns the full 206 KB chain in about 1.7 seconds.
       allorigins times out on it.

       That matters more than a new feed would: the chain was already the only
       forward-looking input in the model, and going through the workflow made
       it about two and a half hours old by the time anyone read it. The fastest
       signal it carries - who is writing options today - is worthless at that
       age and genuinely useful live. */
    /* 139 index rows in one payload: NIFTY 50 breadth, live India VIX, and
       midcap-against-large-cap breadth. One proxy hop serving three lanes,
       because the hop is shared and rate-limited. */
    nseAllIndices: 'https://www.nseindia.com/api/allIndices',
    nseOptionInfo: (sym) =>
      `https://www.nseindia.com/api/option-chain-contract-info?symbol=${encodeURIComponent(sym)}`,
    nseOptionChain: (sym, expiry) =>
      `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=${encodeURIComponent(sym)}` +
      `&expiry=${encodeURIComponent(expiry)}`,
    openrouterModels: 'https://openrouter.ai/api/v1/models',
    openrouterChat: 'https://openrouter.ai/api/v1/chat/completions',

    /* TradingView's public screener. Measured 6 Oct 2026 from the deployed
       origin: a plain POST with Content-Type text/plain (a "simple" request,
       so no preflight) answers 200 in 230-430 ms with CORS headers, no key,
       no login. CLAUDE.md recorded it as unverifiable from a datacentre; from
       a real browser it works, which is the only place this page runs.

       What it carries that nothing else here does, in one request:
         - every NIFTY 50 member with price, change, technical rating,
           fundamentals and the analyst consensus target (FactSet-sourced)
         - GIFT Nifty (NSEIX:NIFTY1!), streaming - the only keyless quote of
           it this repo has found
         - the overnight cues live, rather than as old as the last workflow run
       NSE symbols arrive 15 minutes delayed (update_mode says so on every
       row, and the page prints it); CME futures 10 minutes. */
    tvScan: (market) => 'https://scanner.tradingview.com/' + market + '/scan',

    /* NSE endpoints that answer through the r.jina.ai hop already in the
       proxy chain. Each was read from the deployed origin on 6 Oct 2026
       before any code was written against it, as CLAUDE.md asks:
         snapshot-capital-market-largedeal   bulk, block and short deals (52 KB)
         event-calendar                      board meetings / results, ~5 weeks
         live-analysis-oi-spurts-underlyings change in F&O open interest
         fiidiiTradeReact                    FII / DII cash, same evening
         corporate-sast-reg29                takeover-code disclosures
         corporates-pit-gg                   insider-trading filings (PIT);
                                             `corporates-pit` now returns empty
         fao_participant_oi_DDMMYYYY.csv     who is long and short index futures */
    nseLargeDeals: 'https://www.nseindia.com/api/snapshot-capital-market-largedeal',
    nseEventCalendar: 'https://www.nseindia.com/api/event-calendar?index=equities',
    nseOiSpurts: 'https://www.nseindia.com/api/live-analysis-oi-spurts-underlyings',
    nseFiiDii: 'https://www.nseindia.com/api/fiidiiTradeReact',
    nseInsider: 'https://www.nseindia.com/api/corporates-pit-gg?index=equities',
    nseSast: (from, to) => 'https://www.nseindia.com/api/corporate-sast-reg29?index=equities&from_date=' +
                           from + '&to_date=' + to,
    nseParticipantOi: (ddmmyyyy) =>
      'https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_' + ddmmyyyy + '.csv',
  },

  /* The overnight cues, live from TradingView. Keys match data/global.json so
     the global lane and the opening-gap model read either source unchanged.
     Where one symbol is not carried by the screener the next is tried - the
     list is an order of preference, not a set.

     gift_nifty is shown and is deliberately NOT a model input. It is a
     near-month future, so its distance from NIFTY's close is the overnight
     move plus a futures premium of a few tenths of a percent that decays to
     zero at expiry. Feeding it to the gap model without measuring that
     premium would be the sgx_nifty bug again in a subtler shape - see
     CLAUDE.md. */
  tvGlobal: [
    { key: 'gift_nifty', tv: ['NSEIX:NIFTY1!'],              label: 'GIFT Nifty' },
    { key: 'us_futures', tv: ['CME_MINI:ES1!'],              label: 'S&P 500 futures' },
    { key: 'nasdaq_fut', tv: ['CME_MINI:NQ1!'],              label: 'Nasdaq futures' },
    { key: 'dow_fut',    tv: ['CBOT_MINI:YM1!'],             label: 'Dow futures' },
    { key: 'nikkei',     tv: ['TVC:NI225'],                  label: 'Nikkei 225' },
    { key: 'hangseng',   tv: ['TVC:HSI'],                    label: 'Hang Seng' },
    // TVC:UKOIL is not carried by the screener (measured 6 Oct 2026); ICE
    // Brent is, which is the same benchmark the workflow reads as BZ=F.
    { key: 'crude',      tv: ['ICEEUR:BRN1!', 'NYMEX:BZ1!', 'NYMEX:CL1!'], label: 'Brent crude' },
    { key: 'usdinr',     tv: ['FX_IDC:USDINR'],              label: 'USD/INR' },
    { key: 'dxy',        tv: ['TVC:DXY'],                    label: 'Dollar index' },
    { key: 'us10y',      tv: ['TVC:US10Y'],                  label: 'US 10y yield' },
    { key: 'gold',       tv: ['TVC:GOLD'],                   label: 'Gold' },
    { key: 'cboe_vix',   tv: ['TVC:VIX'],                    label: 'CBOE VIX' },
    { key: 'ftse',       tv: ['TVC:UKX'],                    label: 'FTSE 100' },
  ],

  /* ------------------------------------------------------- prediction trail
     The line the model drew N bars ago, kept on the chart after its time has
     come, so a reader can see how close it landed. `bars` is the lead: the
     trail point at 11:00 on a one-hour lead is what the forecast made at
     10:00 said 11:00 would be. Leads are in bars of the timeframe's own
     candles, so "1 hour" on the 5-minute view is twelve. */
  trail: {
    leads: {
      '1S':  [{ bars: 5, label: '5 min' },  { bars: 15, label: '15 min' }, { bars: 60, label: '1 hour' }],
      '1H':  [{ bars: 5, label: '5 min' },  { bars: 10, label: '10 min' }, { bars: 30, label: '30 min' }],
      '1D':  [{ bars: 3, label: '15 min' }, { bars: 12, label: '1 hour' }, { bars: 36, label: '3 hours' }],
      '1M':  [{ bars: 1, label: '1 day' },  { bars: 5, label: '1 week' }],
      '1Y':  [{ bars: 5, label: '1 week' }, { bars: 21, label: '1 month' }],
      'ALL': [{ bars: 1, label: '1 month' }, { bars: 3, label: '3 months' }],
    },
    /* Fifteen minutes on the intraday views by default: it is the lead at
       which the line is meant to be read against the candles beside it.
       The longer leads are one click away and are scored the same way. */
    defaultLead: { '1S': 15, '1H': 10, '1D': 3, '1M': 1, '1Y': 5, 'ALL': 1 },
    // History a replayed point needs behind it: EMA50, ADX and the level
    // clustering are all meaningless on fewer bars than this.
    warmBars: 60,
    // Forward points kept per symbol, timeframe and lead.
    liveMax: 1500,
  },

  /* ------------------------------------------------------------ data lanes
     The workflow writes its output to a branch the site is NOT built from, and
     the page reads it straight off raw.githubusercontent.com, which answers
     with CORS headers and serves a commit within seconds.

     This is the fix for the freshness problem. Data committed to the Pages
     branch has to wait for a Pages build, and Pages throttles builds to a
     handful an hour, so a 1 minute data cycle on the published branch is not
     possible no matter how often the workflow runs. On a side branch the same
     commit is readable immediately and the site is never rebuilt for it.

     If the remote read fails - offline, rate limited, branch missing - the
     same-origin copy under data/ is used instead, which is always a valid if
     older snapshot.                                                          */
  remote: {
    enabled: true,
    base: 'https://raw.githubusercontent.com/voltairtechindia/Sharemarket/live-data/',
    timeoutMs: 7000,
  },

  baked: {
    news:        'data/news.json',
    rollup:      'data/news_rollup.json',
    seasonality: 'data/seasonality.json',
    quote:       'data/quote.json',
    health:      'data/feed_health.json',
    filings:     'data/filings.json',
    index:       'data/feeds_index.json',
    global:      'data/global.json',
    flows:       'data/flows.json',
    options:     'data/options.json',
    events:      'data/events.json',
    constituents:'data/constituents.json',
    stocks:      'data/stocks.json',
    universe:    'data/universe.json',
    ipo:         'data/ipo.json',
    lexicon:     'config/lexicon.json',
    auth:        'config/auth.json',
    /* The session view asks Yahoo for exactly what the hourly view asks for -
       1m bars over 5d - so it reads the hourly view's workflow file rather
       than making the workflow write a second identical one. Writing the
       duplicate would be two files to keep in step for no extra information,
       which is this repo's recurring bug in its cheapest form. */
    candles:     (sym, tf) => `data/candles_${sym}_${(KT.CONFIG.timeframes[tf] && KT.CONFIG.timeframes[tf].bakedAs) || tf}.json`,
  },

  /* Files that must never be read from the stale same-origin copy when the
     remote lane is alive - these are the ones that change every minute. */
  liveFiles: ['data/news.json', 'data/quote.json', 'data/global.json', 'data/flows.json',
              'data/news_rollup.json', 'data/filings.json', 'data/stocks.json'],

  /* ------------------------------------------------------------- forecasting
     Weights sum to 1. They decide how much each lane moves the needle.       */
  forecast: {
    /* Weights are renormalised at runtime over the lanes that actually
       reported, so a missing feed shifts weight to the rest instead of quietly
       dragging the bias toward zero.

       Eight lanes. Every weight here is a judgement, not a measurement - none
       of them has been fitted, because until the ledger has settled rows there
       is nothing to fit against. When options joined, the seven existing
       weights were scaled by 0.9 rather than re-argued, so their relative
       order is unchanged and the new lane paid for itself out of all of them
       equally. That is the least opinionated way to make room. */
    weights: {
      news: 0.1987,     // the loudest short-horizon input, and the fastest to decay
      momentum: 0.1656, // trend, RSI, MACD, supertrend, scaled by ADX
      global: 0.1325,   // overnight futures, Asia, crude, dollar, rupee, US 10y
      structure: 0.1076,// measured moves from triangles, flags, double tops
      seasonal: 0.0994, // month, weekday and expiry-week effects
      levels: 0.0662,   // how much room there is before the next wall
      flow: 0.0580,     // breadth, FII and DII when the workflow has them
      /* The only forward-looking lane: PCR on today's open interest, the OI
         walls and max pain. Deliberately modest - the direction convention it
         uses is standard practice rather than something measured here, and it
         arrives through the workflow so it is hours old by construction. */
      options: 0.0920,
      /* The language model's own read, added 20 Sep 2026. It is a lane and
         nothing more: a number between -1 and +1, weighted, renormalised and
         scored in the ledger exactly like the other eight. It cannot write a
         price, a band or a probability.

         0.08 is below an equal share. Nine lanes at par would be 0.111 each,
         and the model gets less than that on purpose: it is the only lane
         whose reasoning cannot be re-derived from its inputs - every other one
         is arithmetic somebody can check line by line - so it has to earn more
         before it is listened to more. Only two lanes sit below it, flows at
         0.058 and room-to-run at 0.066, and both are there because their data
         is thin rather than because their working is unverifiable. The learner
         can raise the model's weight, and will only do so off settled calls.

         The eight existing weights were scaled by 0.92 to make room rather
         than re-argued, so their relative order is unchanged and the new lane
         paid for itself out of all of them equally. Same move as when options
         joined at 0.9; it is the least opinionated way to make room. */
      model: 0.0800,
    },
    maxDriftPctPerBar: 0.06,   // cap so the projection never runs away
    coneVolMultiplier: 1.15,   // widen the likely-range band a touch
    minConfidence: 35,
    maxConfidence: 88,
    calibrateEveryMs: 900000,  // re-score the band against history every 15 min
  },

  /* ------------------------------------------------------------- holdings
     What you bought through your broker. Entered by hand, kept in this
     browser, never uploaded and never written to the repo - the same rule the
     trade journal follows. Quotes for them come from Yahoo through the proxy
     chain, and alerts are matched against the same news stream the index uses. */
  holdings: {
    maxSymbols: 60,
    quoteRefreshMs: 60000,
    alertTtlHours: 36,
    maxAlerts: 120,
    /* An alert fires when a holding moves more than this in a session, or when
       a headline that names it scores at least this hard. */
    movePctAlert: 2.5,
    newsSentimentAlert: 1.5,
    suffix: '.NS',           // NSE on Yahoo; BSE is .BO
  },

  /* ---------------------------------------------------------------- storage
     Bounded on purpose: the brief says no unwanted noise or data is stored.  */
  storage: {
    prefix: 'kt:',
    newsMax: 400,        // headlines kept, newest first
    newsTtlHours: 48,
    candleTtlMin: 10,
    quietFields: ['headline', 'source', 'ts', 'url', 'sentiment', 'impact', 'industry', 'region', 'key'],
  },

  /* The settings dropdown is filled from OpenRouter's live model list, filtered
     to entries that cost zero for both prompt and completion. This array is only
     the fallback for when that endpoint cannot be reached - free model IDs turn
     over often, so never rely on a hardcoded one.

     'openrouter/free' is an auto-router across whatever is free at the time,
     which is why it is the default: it keeps working when individual model IDs
     are retired. */
  fallbackModels: [
    'openrouter/free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3.5-lightning:free',
    'thinkingmachines/inkling-small:free',
    'liquid/lfm-2.5-2.6b:free',
  ],
  defaultModel: 'openrouter/free',
};
