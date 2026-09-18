NIFTY Terminal — news-driven index forecast
===========================================

Internal Kite-style terminal for NIFTY 50 and SENSEX. Live chart, 24x7 RSS news
intelligence, a real seasonal study, pattern geometry drawn on the chart, your
own holdings watched for news, and a forecast that is driven by the news rather
than decorated with it — and that publishes its own measured accuracy.

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
   68% and a 95% band, widening along a volatility term structure taken from the
   index's own session profile rather than a flat sqrt(t) curve.

   Beside it, **five checkpoints on a market clock**: where the centre of the
   range sits at 11:53, at 14:38, at tomorrow's open, with the likely range and
   the probability of trading above today's price by then. And below that, the
   panel's own score against history — how often price really did land inside
   the band it drew.

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

6. **Patterns you can check** — triangles, wedges, channels, flags, double tops,
   head and shoulders and cup-and-handle are drawn on the chart as actual lines,
   with the trigger, the measured target and the level that invalidates them.
   Each carries what that pattern really did on this instrument's own history,
   or an admission that the sample is too thin to say.

7. **Your holdings** — add what you bought through your broker and the terminal
   raises an alert when a headline, a corporate filing, a 2.5% move or a 52-week
   extreme touches one of them. Stored in your browser, never uploaded.

8. **Indicators and levels** — a toggleable overlay set (EMA, Bollinger,
   supertrend, VWAP) plus a read-out of RSI, MACD, ADX, ATR, %B, squeeze,
   stochastic and CCI, and the support and resistance price has actually
   respected, scored by how many times it held.

The forecast
------------

Seven lanes, each normalised to -1..+1, combined by weight. Weights are
renormalised at runtime across the lanes that actually reported, so a dead
global feed shifts its weight onto the rest instead of quietly voting neutral.

| Lane | Weight | Built from |
|---|---|---|
| News flow | 24% | recency- and impact-weighted sentiment, 6-hour half-life |
| Momentum | 20% | price vs 20/50 EMA, RSI, MACD histogram, supertrend, scaled by ADX |
| Global cue | 16% | US futures, GIFT Nifty, crude, USD/INR, dollar index, US 10y, gold |
| Chart structure | 13% | measured moves from triangles, flags, double tops, head and shoulders |
| Seasonal | 12% | this month's historical average and win rate, plus day-of-week and expiry-week |
| Room to run | 8% | how far the nearest wall is on each side, in ATR |
| Flows and breadth | 7% | advances vs declines, FII and DII net |

### Where it goes, by the clock

The panel does not give one number for the end of the horizon. It gives a path
on a **market clock** — five checkpoints, each with the centre of the range, the
68% band, and the probability of trading above the current price by that time.

Three things make that more than decoration.

**The clock is session aware.** Stepping forward by one bar width repeatedly put
the 5-minute projection at 16:13 on a market that shuts at 15:30, and put daily
projections on Sundays. The step function now skips the overnight gap and the
weekend. Exchange holidays are *not* modelled — there is no free holiday feed in
the repo, and being one session out a month ahead is a smaller error than being
fourteen hours out this afternoon.

**Volatility is a term structure, not one number.** An index is far noisier in
the first half hour than at lunch, so variance accumulates bucket by bucket
across the clock using this instrument's own session profile. A flat
sigma × sqrt(t) band is too wide at noon and far too narrow at the open. India
VIX blends in as the forward-looking component when it is available.

**Drift is shaped by how each input behaves.** News decays, so its push lands
early. Seasonality is a whole-session effect, so it accrues evenly. A structure
target needs time for the break to happen, so it ramps in late.

### How good is this forecast

The panel scores itself. `calibrate()` rebuilds the model at dozens of past
points on the loaded series and checks what price actually did next. On NIFTY
5-minute data, over 53 replays:

| Measure | Result | Target |
|---|---|---|
| Finished inside the 68% band | 67.9% | 68% |
| Finished inside the 95% band | 94.3% | 95% |
| Direction called right | 57.8% of 45 calls | >50% |
| Error vs assuming no change | 1.3% better | <0% is useless |

Only the technical core is replayed — there is no archive of the RSS stream, so
the news, seasonal, global and flow lanes cannot be scored historically, and the
panel says so rather than quietly including them.

Those numbers are shown whether or not they flatter the model. On the yearly
view the same test scores *worse* than assuming no change, and the panel reports
that too. A forecast panel that only displays its wins is a marketing page.

### Patterns, drawn rather than claimed

`structures.js` finds triangles, wedges, channels, flags, double tops, head and
shoulders and cup-and-handle, and returns the **geometry** — so the chart draws
the shape, its neckline, its trigger and its measured target. A label you cannot
check is decoration; a line sitting on the highs is something you can disagree
with.

The gates matter more than the detectors, because geometry will find a head and
shoulders in pure noise if you let it:

- a trendline needs three separate swing pivots, since a line through two points
  always fits perfectly and proves nothing;
- the structure's height must be a real share of its window's range, so a wiggle
  is not promoted to a formation;
- peaks that are meant to match must match inside half an ATR;
- every tolerance is in ATR, so one rule set covers a 1-minute candle and a
  weekly one.

It was tuned against random-walk input until it stopped inventing structures
there. Some still survive — random walks really do produce double tops, and
that is the point of the next paragraph.

`outcomes()` measures every pattern against **this instrument's own history**:
how often the trigger was hit, and how often the target came before the stop.
Under eight resolved cases it says the sample is too thin instead of quoting a
rate. So the honest answer to "if this pattern shows, will it surely go" is
visible on the panel: usually no, and here is the measured number.

This is a general directional study for internal use. It is not a price target
and it is not investment advice.

Your holdings
-------------

Type in what you bought through your broker and the terminal watches the news
for those names: matched headlines, corporate filings, moves above 2.5%, and
52-week extremes all raise an alert.

Matching is word-boundary aware and case-sensitive for short tickers, so `IOC`
does not match "cho**ice**" and `TCS` does not match "B**TCS**". `data/universe.json`
maps every NSE ticker to its company name and generated aliases, which is what
lets a wire saying "Reliance Industries" reach a line you typed as `RELIANCE`.

**Holdings never leave your browser.** They are in `localStorage`, are never
uploaded, never written to the repository and never sent to any model — the same
rule the trade journal follows. This repo is public; a public repo is no place
for a position book. Export and import are there so you can move them yourself.

Data sources — all free, no keys
--------------------------------

| What | Source | How it is reached |
|---|---|---|
| Live index price | Moneycontrol price feed | directly from the browser (sends CORS headers) |
| OHLC candles | Yahoo Finance chart API | via `r.jina.ai` → `allorigins` proxy chain |
| Fast news, every 60s | 13 CORS-clean feeds | directly from the browser |
| Deep news, per workflow run | 448 feeds | GitHub Actions, server side |
| Global cues | Yahoo, Stooq fallback | GitHub Actions |
| Breadth | NSE `allIndices`, widest index that answered | GitHub Actions |
| FII and DII | NSE, Moneycontrol fallback | GitHub Actions |
| Stock quotes | NSE index endpoint, Yahoo fallback | GitHub Actions |
| Ticker → company names | NSE equity master | GitHub Actions |
| Seasonality | Yahoo Finance, ~19y of monthly closes | GitHub Actions |
| Charting library | vendored in `assets/vendor/` | same origin, CDN as fallback |
| Forecast wording (optional) | OpenRouter free models | browser, with your own key |

**Why two news lanes.** Most Indian and international publishers — Economic
Times, Livemint, Business Standard, RBI, Reuters, NDTV Profit, Zee Business — do
not send CORS headers, so a browser on a static site cannot read them at all.
Thirteen feeds can be read directly, each re-verified 200-with-items from the
deployed origin: CNBC TV18 (5), CNBC US (3), MarketWatch (3) and Yahoo Finance.
The page sweeps those every 60 seconds; the workflow fetches the whole index
server side, where CORS does not apply.

Moneycontrol's eight RSS paths used to be the bulk of that list. `www.moneycontrol.com`
now answers **403 to a browser** on every one of them — measured from the live
origin, all eight, every sweep — so the fast lane was reporting "unavailable"
while eight of its fifteen feeds failed silently. They are removed from
`directFeeds` rather than left in to fail. They still work **server side**, where
no `Origin` header is sent, so the deep lane keeps them and loses nothing. The
price feed on `priceapi.moneycontrol.com` is a different host and is unaffected.

### Why the data used to look stale, and what fixed it

The page was reading its data from the branch GitHub Pages builds from. **Pages
rebuilds the site on every push to that branch and throttles those builds to
roughly ten an hour.** A five-minute data cycle is twelve an hour before you
count code changes, so the refreshes queued and the page you loaded was always
several cycles behind the commit that produced it. Pushing more often made it
worse, not better.

Data now force-pushes to a separate **`live-data` branch that Pages never
builds**, and the page reads it from `raw.githubusercontent.com`, which serves
with CORS headers within seconds of the push. Verified from the live origin
before the change was made.

That branch is rewritten as a single orphan commit each time. Fourteen hundred
commits a day of churned JSON would otherwise turn a small repo into a very
large one inside a month.

`.github/workflows/snapshot.yml` copies the data back onto the published branch
four times a day, purely as the offline fallback — so a fresh clone opens with
something in it, and the page still works if `raw.githubusercontent` is
unreachable.

### The five-minute cron is not a five-minute cron

`live-data.yml` asks for `*/5 * * * *`. Measured start times over 18 Sep 2026
and the day before: **01:12, 22:59, 20:26, 17:23, 12:53, 07:53 UTC** — roughly
one run every two and a half hours, not twelve an hour. GitHub deprioritises
scheduled workflows on repos with little push activity and drops the queued
firings; it does not queue them up and catch up later. On top of that each run
takes 7 to 9 minutes, which is longer than the interval it is asking for.

The visible consequence: at 11:00 IST on a trading day the `live-data` branch
was carrying data generated at 06:46 IST, four and a quarter hours stale, with
no server-side run at all during the morning session.

Nothing in this repo can fix that — it is GitHub's scheduler, and the free tier
is what it is. What keeps the page usable anyway is that the lanes which change
minute to minute do not depend on it: live price, candles and the fast news
sweep all run in the browser. Breadth, FII/DII, filings and the deep news index
are as old as the last run, and the Data Lanes panel shows when each one
landed. Treat the workflow as a several-times-a-day job, because that is what
it is, and read the timestamps rather than the cron expression.

Each run also does four extra news sweeps a minute apart, publishing each as it
lands. News is the only lane that changes minute to minute, so it is the only
one repeated — which buys four fresh minutes out of every 150, not the
continuous coverage the cron line implies.

About the feed count
--------------------

`data/rss_config.json` claimed 1050 feeds. It was placeholder data: 816 of those
URLs pointed at `example.com`, and the rest at hostnames that do not resolve
(`feeds.moneycontrol.com`, `feeds.etmarkets.com`, `feeds.reutersindia.com`).
The headlines in the old `data/news.json` were generated from a template, not
fetched. `rss_config.json` was kept around for a while in case something still
read it; a grep over `assets/`, `index.html` and `scripts/` found nothing did,
so 175 KB of `example.com` URLs is now deleted rather than carried.

`data/feeds_index.json` replaces it with **448 feeds that are all real and all
free**: 83 publisher and regulator RSS URLs, and 365 Google News RSS search
feeds covering the NIFTY 50 constituents, the next tier of liquid names, every
sector index, Indian policy and macro topics, and the global themes that move
Indian equities. The UI reports the number that actually answered on the last
run, not a number typed into the page.

To grow it, add a line to the `news:` list in **`config/feeds.yml`** and re-run
`scripts/feeds_build.py`. That file used to be decorative — `feeds_build.py`
ignored it and used a hardcoded list — which is now fixed: the YAML is merged on
top of the baseline and deduplicated by URL. Google News queries and the
company/sector expansions still live in `feeds_build.py`, where each query is a
real feed, so adding coverage there is also a one-line change.

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

**Reasoning is turned off in the request.** The default model is
`openrouter/free`, an auto-router across whatever is free at that moment, and
`max_tokens` covers reasoning tokens as well as the answer. Routed to
`liquid/lfm-2.5-2.6b:free` the call came back with `reasoning_tokens: 320`,
`finish_reason: "length"` and `content: null` — the entire 320-token budget
spent thinking, nothing written, the lane reporting "idle" with no explanation.
`reasoning: { enabled: false }` in the body fixes it deterministically; this
model is rewriting numbers that already exist, so it has nothing to reason
about.

If the key you were using has ever been committed or shared, rotate it at
https://openrouter.ai/keys.

Layout
------

```
index.html                     the terminal
assets/style.css               Kite-style theme, light and dark
assets/vendor/                 lightweight-charts, vendored so a CDN outage cannot blank the chart

assets/js/config.js            every tunable: symbols, timeframes, feeds, weights, holdings
assets/js/core.js              formatting, IST clock, bounded storage, sentiment scorer
assets/js/indicators.js        RSI, MACD, ADX, ATR, Bollinger, Keltner, supertrend, squeeze,
                               stochastic, CCI, Williams %R, OBV, MFI, VWAP, Ichimoku, divergence
assets/js/levels.js            clustered support and resistance, pivots, Fibonacci,
                               volume profile, unfilled gaps, round numbers
assets/js/patterns.js          candlestick patterns and their measured hit rates
assets/js/structures.js        chart patterns with drawable geometry, targets and outcomes
assets/js/journal.js           your trades, browser only
assets/js/portfolio.js         your holdings, news matching and alerts, browser only
assets/js/data.js              fetch lanes, RSS parsing, news store, OpenRouter
assets/js/forecast.js          the model: seven lanes, clock-aware path, bands, calibration
assets/js/engine.js            reason points (the forecast moved to forecast.js)
assets/js/chart.js             candles, projection, bands, pattern geometry, overlays, markers
assets/js/app.js               boot, polling loops, all rendering
assets/local-config.example.js template for your local key

config/feeds.yml               hand-editable feed list, merged into the index
config/lexicon.json            sentiment and noise words, shared by browser and worker
config/watchlist.yml           Yahoo symbols

scripts/feeds_build.py         builds data/feeds_index.json from feeds.yml + baseline
scripts/fetch_news.py          fetches every feed, filters, scores, writes news JSON
scripts/fetch_market.py        OHLC per timeframe, quote snapshot, seasonality
scripts/fetch_global.py        overnight cues: futures, crude, dollar, rupee, yields
scripts/fetch_flows.py         breadth, FII and DII
scripts/fetch_stocks.py        per-stock quotes for the holdings panel
scripts/build_universe.py      NSE ticker to company name and aliases
scripts/fetch_filings.py       BSE and NSE corporate announcements
scripts/serve.py               dev server: static files plus the fetch loops
scripts/publish_live.sh        force-pushes data/ to the live-data branch

.github/workflows/live-data.yml   asks for every 5 min; GitHub gives ~every 2.5 h
.github/workflows/snapshot.yml    copies live data back to the published branch 4x a day
```

### What was removed, and why

These were all live in the tree and exercised by nothing, which is the failure
mode this project keeps having: a lane that is built, committed, and never read.

| Removed | Why |
|---|---|
| `realtime_loop.py` | hardcoded `C:\hrv\...` path, `import random`, wrote the fabricated numbers below |
| `history.html` | linked from nowhere; fell back to typed-in prose like "next resistance at 23500-23600" when its data file was missing, which it always was |
| `data/live_impact.json` | read by `history.html`, written by nothing since `realtime_loop.py` stopped running |
| `scripts/predict.py`, `scripts/validate.py`, `data/predictions.json` | a whole forecast-scoring subsystem, in no workflow, read by no screen; `forecast.js` `calibrate()` replaced it |
| `scripts/fetch_social.py`, `data/social.json` | `fetch_filings.py` superseded the fetcher; the `social:` path was declared in `config.js` and never fetched |
| `scripts/demo_data.py` | generated fake market data, in a repo whose whole argument is that it does not do that |
| `data/rss_config.json` | 175 KB of `example.com` URLs, already documented as dead |
| `accuracy: 'data/accuracy.json'` in `config.js` | the file has never existed in this repo |

### Load order is a dependency order

`config` and `core` first because everything reads them, then `indicators` →
`levels` → `structures` → `forecast` → `engine` → `chart` → `app`. Shuffling
those script tags breaks the page, so they are commented in `index.html`.


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
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/feeds_build.py    # writes data/feeds_index.json
.venv/bin/python scripts/fetch_market.py   # candles, quote, seasonality
.venv/bin/python scripts/fetch_news.py     # news, rollup, feed health
.venv/bin/python scripts/fetch_flows.py    # breadth, FII/DII
.venv/bin/python -m http.server 8080       # then open http://localhost:8080
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
