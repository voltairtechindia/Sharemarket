NIFTY Terminal — news-driven index forecast
===========================================

Internal Kite-style terminal for NIFTY 50 and SENSEX. Live chart, 24x7 RSS news
intelligence, a real seasonal study, and a forecast that is driven by the news
rather than decorated with it.

Live: https://voltairtechindia.github.io/Sharemarket/

What it does
------------

1. **Live chart** — candles from Yahoo Finance, live price from Moneycontrol's
   public price feed. While the market is open the price is polled on the tick
   interval you choose (1 second by default) and the forming candle is rewritten
   in place. Outside 09:15–15:30 IST the chart holds the last close and the
   status pill says so instead of faking movement.

2. **Four fifths past, one fifth forecast** — the visible window is always four
   parts history to one part projection. The projection is a dashed line with a
   likely-range band that widens with the square root of time, which is how
   uncertainty actually grows.

3. **Reason points** — hover or click any point on the chart and it tells you
   what moved the index in that window, with the actual percentage move and the
   headline behind it. The interval follows the timeframe, as briefed:

   | Timeframe button | Candles | Reason point every |
   |---|---|---|
   | 1H  | 1 minute  | 10 minutes |
   | 1D  | 5 minute  | 1 hour |
   | 1M  | 1 day     | 1 day |
   | 1Y  | 1 day     | 1 week |
   | TILL DATE | 1 week | 1 month |

   A quiet window gets no marker. That is deliberate — a point on every interval
   would be noise, so a marker appears only where the move was meaningful
   against the period's own volatility, or a high-impact headline landed.

4. **Seasonal study** — month-of-year, day-of-week and expiry-week statistics
   computed from ~19 years of real NIFTY closes, not assumed. Shown as a bar per
   calendar month around a zero line, with the current month highlighted.

5. **News intelligence** — headlines are deduplicated, noise-filtered, scored for
   sentiment and impact, and tagged by sector. Only market-relevant content is
   kept; horoscopes, cricket, film, gadget and sponsored content are dropped by
   the filter before anything is stored.

The forecast
------------

Four lanes, each normalised to -1..+1, combined by weight:

| Lane | Weight | Built from |
|---|---|---|
| News flow | 38% | recency- and impact-weighted sentiment, 6-hour half-life |
| Seasonal | 24% | this month's historical average and win rate, plus day-of-week and expiry-week |
| Momentum | 24% | price vs 20- and 50-bar averages, plus RSI |
| Global cue | 14% | international headlines only, 12-hour half-life |

The combined bias is then expressed as a **fraction of a typical move over the
horizon** (realised volatility x sqrt of the number of bars), so the projection
can never run away from what the index actually does. Confidence comes from how
much the four lanes agree, how much news there is to work with, and how strong
the signal is — not from a number someone picked.

This is a general directional study for internal use. It is not a price target
and it is not investment advice.

Data sources — all free, no keys
--------------------------------

| What | Source | How it is reached |
|---|---|---|
| Live index price | Moneycontrol price feed | directly from the browser (sends CORS headers) |
| OHLC candles | Yahoo Finance chart API | via `r.jina.ai` → `allorigins` proxy chain |
| Fast news, every 60s | Moneycontrol + CNBC TV18 RSS | directly from the browser |
| Deep news, every 5 min | 427 feeds | GitHub Actions, server side |
| Seasonality | Yahoo Finance, ~19y of monthly closes | GitHub Actions |
| Forecast wording (optional) | OpenRouter free models | browser, with your own key |

**Why two news lanes.** Most Indian and international publishers — Economic
Times, Livemint, Business Standard, RBI, Reuters, NDTV Profit, Zee Business —
do not send CORS headers, so a browser on a static site cannot read them at all.
Only Moneycontrol and CNBC TV18 can be read directly. So the page reads those
every 60 seconds for freshness, and `.github/workflows/live-data.yml` fetches
the whole feed index server side every 5 minutes, where CORS does not apply.
GitHub's scheduler will not run more often than every 5 minutes.

About the feed count
--------------------

`data/rss_config.json` claimed 1050 feeds. It was placeholder data: 816 of those
URLs pointed at `example.com`, and the rest at hostnames that do not resolve
(`feeds.moneycontrol.com`, `feeds.etmarkets.com`, `feeds.reutersindia.com`).
The headlines in the old `data/news.json` were generated from a template, not
fetched. That file is left in place so nothing that reads it breaks, but it is
no longer used.

`data/feeds_index.json` replaces it with **427 feeds that are all real and all
free**: 62 publisher and regulator RSS URLs, and 365 Google News RSS search
feeds covering the NIFTY 50 constituents, the next tier of liquid names, every
sector index, Indian policy and macro topics, and the global themes that move
Indian equities. The UI reports the number that actually answered on the last
run, not a number typed into the page.

To grow it, edit the lists in `scripts/feeds_build.py` and re-run it. Each
Google News query is a real feed, so adding coverage is a one-line change.

Your OpenRouter key
-------------------

This repository and the GitHub Pages site are **public**, so no key is committed.

- On the live site: open Settings and paste your key once. It is stored in that
  browser's localStorage and is sent only to OpenRouter.
- On your own machine: copy `assets/local-config.example.js` to
  `assets/local-config.js` and put your key in it. That path is in `.gitignore`,
  so it stays local. The browser logs one harmless 404 for it on the public site,
  where the file does not exist.

The key is optional. Without it the forecast still runs — direction, range and
confidence all come from the local rule engine. The model only rewrites the
explanation into plain English, and it is explicitly told never to change the
numbers the engine produced.

If the key you were using has ever been committed or shared, rotate it at
https://openrouter.ai/keys.

Layout
------

```
index.html                     the terminal
assets/style.css               Kite-style theme, light and dark
assets/js/config.js            every tunable: symbols, timeframes, feeds, weights
assets/js/core.js              formatting, IST clock, bounded storage, sentiment scorer
assets/js/data.js              fetch lanes, RSS parsing, news store, OpenRouter
assets/js/engine.js            seasonal study, forecast, reason points
assets/js/chart.js             candles, projection, cone, markers, framing
assets/js/app.js               boot, polling loops, all rendering
assets/local-config.example.js template for your local key

config/feeds.yml               original curated feed list (kept)
config/lexicon.json            sentiment and noise words, shared by browser and worker
config/watchlist.yml           Yahoo symbols (kept)

scripts/feeds_build.py         builds data/feeds_index.json
scripts/fetch_news.py          fetches every feed, filters, scores, writes news JSON
scripts/fetch_market.py        OHLC per timeframe, quote snapshot, seasonality
scripts/…                      original helpers, unchanged

.github/workflows/live-data.yml   runs the two workers every 5 minutes and commits
```

Storage is bounded on purpose
-----------------------------

The brief asked for no unwanted noise or data. In the browser: at most 400
headlines, nothing older than 48 hours, deduplicated by normalised title, and
only the fields needed to render and score — no article bodies, no images, no
tracking. Roughly 40 KB of localStorage. "Clear cached news" in Settings empties
it. On the server: at most 600 headlines with a 72-hour TTL and a 220-character
summary cap.

Running locally
---------------

```bash
pip install -r requirements.txt
python scripts/feeds_build.py      # writes data/feeds_index.json
python scripts/fetch_market.py     # candles, quote, seasonality
python scripts/fetch_news.py       # news, rollup, feed health
python -m http.server 8080         # then open http://localhost:8080
```

Open `index.html` over `http://`, not `file://` — the browser blocks fetches of
the local `data/*.json` files from a `file://` page.

Deploying
---------

Push to `main`. GitHub Pages serves the repo root. The workflow needs
**Settings → Actions → General → Workflow permissions → Read and write**, or its
commit step will fail.

Notes and limits
----------------

- One-second updates are as live as a free public endpoint allows. The price
  comes from Moneycontrol's feed; there is no exchange-grade tick stream behind
  a free static site. The request interval backs off automatically on errors.
- Yahoo and the CORS proxies are free services with no uptime promise. Candles
  fall back from Yahoo to the last cached copy to the file the workflow wrote,
  so the chart keeps drawing when a lane is down. The Data Lanes panel shows
  which lane is live.
- FNO fields (open interest, PCR, max pain) are not shown. The old page carried
  those as simulated numbers; they are not available from a free keyless source,
  and a made-up number is worse than no number. Connect a broker API if you need
  them for real.
- Internal use only.
