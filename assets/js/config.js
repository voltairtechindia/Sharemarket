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
    maxBackoffMs: 60000,
  },

  /* ---------------------------------------------------------------- sources
     Every entry re-verified from the live GitHub Pages origin: these answer
     with CORS headers, so the browser reads them with no proxy and no workflow
     in the way. That is what makes a genuine 60 second lane possible - about
     800 items per sweep. Anything not on this list either refused CORS or
     returned 503 when tested, and belongs to the server-side workflow.       */
  directFeeds: [
    { id: 'mc_top',        name: 'Moneycontrol top',       url: 'https://www.moneycontrol.com/rss/MCtopnews.xml',                   region: 'india' },
    { id: 'mc_latest',     name: 'Moneycontrol latest',    url: 'https://www.moneycontrol.com/rss/latestnews.xml',                  region: 'india' },
    { id: 'mc_markets',    name: 'Moneycontrol markets',   url: 'https://www.moneycontrol.com/rss/marketreports.xml',               region: 'india' },
    { id: 'mc_business',   name: 'Moneycontrol business',  url: 'https://www.moneycontrol.com/rss/business.xml',                    region: 'india' },
    { id: 'mc_economy',    name: 'Moneycontrol economy',   url: 'https://www.moneycontrol.com/rss/economy.xml',                     region: 'india' },
    { id: 'mc_results',    name: 'Moneycontrol results',   url: 'https://www.moneycontrol.com/rss/results.xml',                     region: 'india' },
    { id: 'mc_buzz',       name: 'Moneycontrol buzzing',   url: 'https://www.moneycontrol.com/rss/buzzingstocks.xml',               region: 'india' },
    { id: 'mc_ipo',        name: 'Moneycontrol IPO',       url: 'https://www.moneycontrol.com/rss/iponews.xml',                     region: 'india' },
    { id: 'cnbc_market',   name: 'CNBC TV18 markets',      url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml',       region: 'india' },
    { id: 'cnbc_economy',  name: 'CNBC TV18 economy',      url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/economy.xml',      region: 'india' },
    { id: 'cnbc_business', name: 'CNBC TV18 business',     url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/business.xml',     region: 'india' },
    { id: 'cnbc_world',    name: 'CNBC TV18 world',        url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/world.xml',        region: 'international' },
    { id: 'yahoo_finance', name: 'Yahoo Finance',          url: 'https://finance.yahoo.com/news/rssindex',                          region: 'international' },
    { id: 'cnbc_us',       name: 'CNBC US markets',        url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258', region: 'international' },
    { id: 'marketwatch',   name: 'MarketWatch top',        url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',       region: 'international' },
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
    openrouterModels: 'https://openrouter.ai/api/v1/models',
    openrouterChat: 'https://openrouter.ai/api/v1/chat/completions',
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
    social:      'data/social.json',
    index:       'data/feeds_index.json',
    global:      'data/global.json',
    flows:       'data/flows.json',
    accuracy:    'data/accuracy.json',
    stocks:      'data/stocks.json',
    universe:    'data/universe.json',
    lexicon:     'config/lexicon.json',
    auth:        'config/auth.json',
    candles:     (sym, tf) => `data/candles_${sym}_${tf}.json`,
  },

  /* Files that must never be read from the stale same-origin copy when the
     remote lane is alive - these are the ones that change every minute. */
  liveFiles: ['data/news.json', 'data/quote.json', 'data/global.json', 'data/flows.json',
              'data/news_rollup.json', 'data/filings.json', 'data/stocks.json'],

  /* ------------------------------------------------------------- forecasting
     Weights sum to 1. They decide how much each lane moves the needle.       */
  forecast: {
    /* Seven lanes. Weights are renormalised at runtime over the lanes that
       actually reported, so a missing global feed shifts weight to the rest
       instead of quietly dragging the bias toward zero. */
    weights: {
      news: 0.24,       // the loudest short-horizon input, and the fastest to decay
      momentum: 0.20,   // trend, RSI, MACD, supertrend, scaled by ADX
      global: 0.16,     // overnight futures, crude, dollar, rupee, US 10y
      structure: 0.13,  // measured moves from triangles, flags, double tops
      seasonal: 0.12,   // month, weekday and expiry-week effects
      levels: 0.08,     // how much room there is before the next wall
      flow: 0.07,       // breadth, FII and DII when the workflow has them
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
