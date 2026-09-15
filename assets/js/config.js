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
  timeframes: {
    '1H':  { label: 'Hourly',    interval: '1m',  range: '5d',  reasonBucket: 600,    reasonLabel: 'every 10 minutes', visibleBars: 240, forecastRatio: 0.25, barSec: 60 },
    '1D':  { label: 'Daily',     interval: '5m',  range: '1mo', reasonBucket: 3600,   reasonLabel: 'every 1 hour',     visibleBars: 300, forecastRatio: 0.25, barSec: 300 },
    '1M':  { label: 'Monthly',   interval: '1d',  range: '6mo', reasonBucket: 86400,  reasonLabel: 'every 1 day',      visibleBars: 130, forecastRatio: 0.25, barSec: 86400 },
    '1Y':  { label: 'Yearly',    interval: '1d',  range: '2y',  reasonBucket: 604800, reasonLabel: 'every 1 week',     visibleBars: 260, forecastRatio: 0.25, barSec: 86400 },
    'ALL': { label: 'Till date', interval: '1wk', range: 'max', reasonBucket: 2592000,reasonLabel: 'every 1 month',    visibleBars: 520, forecastRatio: 0.25, barSec: 604800 },
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
    bakedMs: 120000,     // re-read the GitHub Actions output
    maxBackoffMs: 60000,
  },

  /* ---------------------------------------------------------------- sources
     Verified from the live GitHub Pages origin: these send CORS headers, so the
     browser can read them with no proxy at all. Everything else in the feed
     universe is fetched server side by .github/workflows/live-data.yml.      */
  directFeeds: [
    { id: 'mc_top',      name: 'Moneycontrol top',      url: 'https://www.moneycontrol.com/rss/MCtopnews.xml',                     region: 'india' },
    { id: 'mc_markets',  name: 'Moneycontrol markets',  url: 'https://www.moneycontrol.com/rss/marketreports.xml',                 region: 'india' },
    { id: 'mc_business', name: 'Moneycontrol business', url: 'https://www.moneycontrol.com/rss/business.xml',                      region: 'india' },
    { id: 'mc_economy',  name: 'Moneycontrol economy',  url: 'https://www.moneycontrol.com/rss/economy.xml',                       region: 'india' },
    { id: 'mc_results',  name: 'Moneycontrol results',  url: 'https://www.moneycontrol.com/rss/results.xml',                       region: 'india' },
    { id: 'cnbc_market', name: 'CNBC TV18 markets',     url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml',         region: 'india' },
    { id: 'cnbc_economy',name: 'CNBC TV18 economy',     url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/economy.xml',        region: 'india' },
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

  /* Local JSON produced by the scheduled workflow. Same origin, so no CORS. */
  baked: {
    news:        'data/news.json',
    rollup:      'data/news_rollup.json',
    seasonality: 'data/seasonality.json',
    quote:       'data/quote.json',
    health:      'data/feed_health.json',
    filings:     'data/filings.json',
    social:      'data/social.json',
    index:       'data/feeds_index.json',
    lexicon:     'config/lexicon.json',
    auth:        'config/auth.json',
    candles:     (sym, tf) => `data/candles_${sym}_${tf}.json`,
  },

  /* ------------------------------------------------------------- forecasting
     Weights sum to 1. They decide how much each lane moves the needle.       */
  forecast: {
    weights: { news: 0.38, seasonal: 0.24, momentum: 0.24, global: 0.14 },
    maxDriftPctPerBar: 0.06,   // cap so the projection never runs away
    coneVolMultiplier: 1.15,   // widen the likely-range band a touch
    minConfidence: 35,
    maxConfidence: 88,
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
