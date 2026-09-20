# CLAUDE.md — NIFTY Terminal

Static, keyless, India-first market terminal. GitHub Pages serves the repo root;
GitHub Actions fetches everything a browser cannot reach. No backend, no broker
API, no paid feed.

Read `README.md` first for what the product does and why the forecast is built
the way it is. This file is the operational layer: what breaks, how to check it,
and which endpoints have already died.

---

## The one rule that matters here

**A lane that nothing reads is the recurring bug in this repo.** Every audit has
found the same shape: a script writes a file no screen fetches, a config path
points at a file that has never existed, a health indicator keyed to one feed out
of fifteen. Typechecking and a green workflow prove none of it.

Before calling anything done, confirm the round trip:

```bash
# does anything actually read the file you just made a script write?
grep -rn "yourfile.json" assets/ index.html scripts/
```

If the answer is nothing, either wire it or do not write it.

---

## Verify like this, not like that

The page is the system. Run it and read it — do not infer from the source.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m http.server 8080          # then http://localhost:8080
```

**Run `node scripts/selftest.js` first.** (`node --check` is not a substitute —
it passed a file whose test block referenced an out-of-scope variable, because
that is a runtime error, not a syntax one.) No dependencies, no build step - it
loads the real browser modules into a vm context whose global *is* `window` and
asserts 57 invariants, each of which has been a real bug here: band/outcome
alignment, lane liveness, effective sample size, the attribution reconstructing
the drift, the holiday clock, and the variance model degrading rather than
returning NaN. It runs in a few seconds and catches most regressions before the
browser is involved.

The previous set of these lived in a scratch directory and did not survive the
session, which is why they are in the repo now. A check you cannot re-run is not
a check.

Playwright is the fastest honest check (`.venv/bin/pip install playwright &&
.venv/bin/python -m playwright install chromium`). What to assert:

- **Data Lanes panel** — all five should read `live`: Live price, Candles, Fast
  news, Deep news, Model. Any `unavailable` or `idle` is a real failure, not a
  cosmetic one.
- **Console and network** — zero `pageerror`, zero HTTP >= 400. A 403 on a feed
  means that publisher stopped serving browsers, not that the code is wrong.
- **PREV CLOSE** in the stats strip must match NSE's `previousClose` for the
  prior session. It has been silently wrong before.
- The live site is the real target: `https://voltairtechindia.github.io/Sharemarket/`.
  CORS behaves differently from an origin than from localhost — check both.

`data/*.json` in a fresh clone is a snapshot, not live. The page prefers
`raw.githubusercontent.com/.../live-data/data/...`, so a local script run does
**not** change what the page shows unless the remote is unreachable. If you are
testing a fetcher's output, read the JSON directly.

---

## Endpoints that are dead, and what replaced them

Re-verified 18 Sep 2026. Do not "restore" any of these.

| Dead | Symptom | Use instead |
|---|---|---|
| `nseindia.com/api/equity-stockIndices?index=…` | HTTP 404 for every index | `nseindia.com/api/allIndices` — each row carries `advances` / `declines` / `unchanged` already counted |
| `www.moneycontrol.com/rss/*.xml` **from a browser** | HTTP 403, all eight paths | dropped from `directFeeds`; still fine **server side**, so the deep lane keeps them |
| `api.bseindia.com/.../AnnGetData/w` | 200 with the bare JSON string `"No Record Found!"` | nothing — BSE blocks datacentre addresses. The lane records a clean failure and NSE filings carry it |
| `nseindia.com/api/option-chain-indices?symbol=…` | HTTP 404 | `nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=<DD-MMM-YYYY>`, with the expiry from `/api/option-chain-contract-info`. Found by reading the `/api/` paths out of NSE's own `option-chain-v3.js` bundle, not by guessing |
| Yahoo `meta.chartPreviousClose` as prev close | off by as many sessions as the range is long | derive from the daily candle series (`prev_close()` in `fetch_market.py`) |

`priceapi.moneycontrol.com` (live index price) is a **different host** and works
fine from the browser. Do not confuse the two when a Moneycontrol lane fails.

**Two NSE endpoints that are alive and were not being used.** Both re-verified
19 Sep 2026:

- `/api/option-chain-v3` — the only forward-looking input in the model. Feeds
  `fetch_options.py` → `data/options.json` → `optionsLane()`.
- `/api/holiday-master?type=trading` — twenty cash-market rows a year. This
  removes the limitation `advance()` used to document: a daily projection that
  walked through Diwali put every later date one session wrong.

Both answer with `Access-Control-Allow-Origin: beta.nseindia.com`, so a
**direct** browser fetch fails — measured, "Failed to fetch" in 126 ms. But the
proxy chain already in `config.js` carries them: `r.jina.ai` returns the full
206 KB option chain from a real page origin in about 1.7 seconds. `allorigins`
times out on it, and GDELT is blocked through every route.

So both are browser lanes now, with the workflow copy as the fallback:

- `data.getOptionChain()` — live chain, polled every 3 minutes while the market
  is open. `optionsLane()` prints `(live)` or the age, and drops itself past
  four hours either way.
- `data.getMarketInternals()` — one `allIndices` call serving three things that
  were all late or missing: NIFTY 50 breadth, India VIX, and midcap-against-
  large-cap breadth divergence. One hop rather than three, because the proxy is
  shared and rate-limits.

A browser result only replaces the workflow copy when it actually parses, so a
throttled proxy leaves the older-but-real number in place instead of blanking
the lane. The Data Lanes panel shows `live` or `workflow` accordingly — a
fallback is not an outage and must not read as one.

**`fetchJSONVia` resolves `{ data, via }`, not the payload.** Reading
`res.expiryDates` instead of `res.data.expiryDates` fails silently: the promise
resolves, the field is `undefined`, and the lane quietly falls back to the
workflow copy with no error anywhere. That cost a debugging cycle here.

NSE in general: hand out the homepage cookie first (`session()` in
`fetch_flows.py`), send a `Referer`, and expect waves of blocking by IP. Every
lane is optional by design — a missing lane drops out of the forecast's weighting
rather than voting zero.

---

## The workflow is not a five-minute cron

`live-data.yml` asks for `*/5 * * * *`. Measured starts over 17–18 Sep 2026:
07:53, 12:53, 17:23, 20:26, 22:59, 01:12 UTC. **About one run every 2.5 hours.**
GitHub deprioritises schedules on low-activity repos and drops the skipped
firings rather than queueing them. Each run also takes 7–9 minutes, longer than
the interval it requests.

Consequences to keep in mind:

- At 11:00 IST on a trading day the `live-data` branch was serving 06:46 IST data.
- Breadth, FII/DII, filings and the deep news index are **as old as the last run**.
  Live price, candles and the fast news sweep are browser-side and stay current.
- Do not "fix" this by changing the cron. The same throttle applies. Read the
  timestamps in the Data Lanes panel.

Data force-pushes to the orphan `live-data` branch (Pages never builds it);
`snapshot.yml` copies it back to `main` four times a day as the offline fallback.
That is why `main` shows a stream of `data: offline snapshot …` commits.

---

## OpenRouter

Optional. Without a key the forecast is complete — the model only rewrites the
already-computed explanation into English and is told never to change a number.

Local key: `assets/local-config.js` (gitignored, template at
`assets/local-config.example.js`). Live site: Settings → paste once, stored in
that browser's localStorage. **Never commit a key; the repo and the Pages site
are public.**

Two traps, both hit in production:

1. **`max_tokens` covers reasoning tokens.** Routed to a reasoning-heavy free
   model, all 320 went to reasoning: `content: null`, `finish_reason: "length"`,
   lane silently idle. `reasoning: { enabled: false }` is in the request body now.
   Keep it.
2. **The free pool contains classifiers.** `openrouter/free` once routed to
   `nvidia/nemotron-3.5-content-safety:free`, which answered `"User Safety: safe"`
   with a valid 200. Guarded two ways: completions under 60 characters are
   rejected, and the Settings dropdown filters out ids matching
   `guard|safety|moderat|embed|rerank|classif`.

`openrouter/free` stays the default on purpose — free model ids turn over
constantly and the auto-router survives that. With reasoning off it was usable
6/6 in testing; named models were *less* reliable (upstream 429s).

---

## Load order is a dependency order

`config` → `core` → `indicators` → `levels` → `candles` → `patterns` →
`structures` → `vol` →
`forecast` → `ledger` → `learn` → `engine` → `chart` → `app`. The script tags in
`index.html` are commented with this. Reordering them breaks the page silently.

`forecast.js` owns the model (eight lanes, clock-aware path, bands,
`calibrate()`). `engine.js` is only reason points — the forecast moved out of it.
`vol.js` owns the variance model and every statistic that judges the band.
`ledger.js` owns the forward record.

Three invariants that were each a real bug, found by measuring rather than by
reading:

- **`build()` and `calibrate()` must draw the band through `bandPath()` and
  `volContext()`.** They used to build it twice and drifted, so the accuracy
  panel scored a model the chart never showed.
- **A replay reads its outcome by time, not by index.** `candles[at + bars]` is
  not the bar the band ends on: a session holds 75 five-minute bars across 74
  intervals, so index arithmetic lands a whole overnight gap late. Measured, 19
  of 20 endpoints disagreed. Use `closeAtTime()`.
- **Every interval and p-value in `calibrate()` uses `nEff`, never `n`.**
  Windows overlap on purpose — that is what makes the estimate stable — but
  scoring them as independent made the panel swing by tens of points when the
  replay grid moved five bars.

A fourth, in `core.js`: **the holiday table lives in core, not in
`forecast.js`.** Two things need it — the projection clock, so a daily forecast
does not step onto a closed session, and `marketState()`, which without it
reported **LIVE on Diwali**. Core loads first, so core owns it and `forecast.js`
delegates. Two tables would be two tables to get out of step.

A fifth, in `forecast.js`: **the band must not be widened for a scheduled
event.** India VIX is an implied number and already prices scheduled risk, and
it is already blended into `sigmaBlend`. Adding an event multiplier on top
double-counts it, which is the same mistake as fitting a GARCH on unadjusted
intraday returns. `data/events.json` is therefore shown in the hover card and
deliberately does **not** vote.

A sixth, in every fetcher: **a failed run must not clobber the last good
file.** The workflow seeds `data/` from the live branch before anything runs,
precisely so a lane that fails keeps its previous value — a fetcher that
unconditionally writes its failure payload defeats that, and one network blip
then publishes `ok: false` to everybody. `common.carry_forward()` is the shared
form of what `fetch_flows.py` has always done by hand.

Its `keep_stamp` argument matters: anything whose consumer judges staleness
from `generated_at` must keep the original. `optionsLane()` drops itself past
four hours, and restamping a carried copy to now would silence that guard and
let the model vote on another session's positioning. Refreshing the stamp is a
lie about when the data was true.

A seventh, in `app.js`: **nothing in boot's `Promise.all` may be a network call
with a long timeout, and every handler it names must be declared.** Both have
bitten. Putting the two live proxy fetches in the barrier made the chart queue
behind 14–20 second hops. Worse, a handler was referenced there and never
declared — the reference threw *synchronously while the array was being built*,
so the whole chain rejected, the page sat on "Loading NIFTY candles…" forever,
and **nothing appeared in the console**. `selftest.js` now checks both
statically, because no numeric test would ever see it.

An eighth, in `forecast.js`: **the news cluster cache needs more than one
slot.** `build()` calls `newsLane()` twice with different pools — everything,
then the international subset — so a single slot meant each call evicted the
other and both re-clustered on every one-second tick. Measured: 0.25ms called
alone against **116ms per alternating pair**, which was most of a 140ms build.
Four slots, and `selftest.js` asserts both the pair cost and the whole build
fitting inside the tick.

A ninth, in `data.js` and `fetch_options.py`: **the option chain is summarised
twice, once in each language, and `selftest.js` proves they agree.** The browser
needs the maths in JS to go live; the workflow needs it in Python for the
fallback and the archive. Two implementations of one piece of arithmetic is
precisely this repo's recurring bug, so `references/fixtures/option-chain-nifty.json`
holds a real reduced chain and the suite asserts both produce the same PCR, max
pain, walls and IV — and that `optionsLane()` scores them identically. Tolerance
is 0.011 on rounded ratios only, because Python's `round()` is banker's rounding
and JS `Math.round` is half-up.

A tenth, in `forecast.js`: **anything derived from the band must be rebuilt
after the analogue shifts it.** `KT.analogs.shape()` bends `path` *after*
`attribution` is computed from it, so the hover card named a centre the chart
did not draw — measured at 18.3 points, 0.079%. The analogue is recorded as its
own contributor now rather than smeared across the lanes, because it changes no
lane's view. Same two-places-compute-the-same-thing failure `bandPath()` exists
to prevent, one layer up.

An eleventh, in `forecast.js`: **the news cluster cache key must depend on
contents, not shape.** It was length plus first and last timestamp, and two
pools of the same size spanning the same instants collided — a split tape was
handed a unanimous tape's clusters and scored +1.0 instead of ~0. It is a djb2
fold over each item's key and sentiment now. Caught by `selftest.js`, not by
the page.

A twelfth, in `vol.js`: **deseasonalise before fitting.** `volProfile()` already
models the intraday cycle and re-applies it bar by bar, so a GARCH fitted on raw
5-minute returns spends its ARCH coefficient describing the clock. Measured,
persistence fell 0.741 → 0.509 and QLIKE improved 13% once the profile was
divided out first.

---

## The opening call, the session view, and the locked record

Added 20 Sep 2026. Three features, one question: what price does the next
session start at, what does it do minute by minute, and was the line we drew
this morning right.

**`openLane()` in `forecast.js` is not a ninth lane.** Every other lane answers
"which way from here" and votes into one blended bias. This one answers "what
price does it open at", which is a different question with a different shape: a
gap is a level shift that has already happened by the first projected bar, not
a drift spread over the first few. It is added outside `maxDriftPctPerBar` for
that reason - that cap exists to stop a drift running away over many bars and
capping a gap with it is capping the wrong quantity with the wrong number - and
bounded separately by `MAX_GAP_PCT` (1.5%). It applies only while the market is
shut; intraday `gapApplies` is false, because the reprice is in the candles and
adding it again would double-count the morning for the rest of the day.

**`sgx_nifty` was NIFTY.** The heaviest row in `GLOBAL_MAP`, at 0.24, labelled
"GIFT / SGX Nifty", was fetched from Yahoo symbol `^NSEI` - NIFTY spot. A
quarter of the global lane was the index voting on itself, and an opening-gap
model built on it would have read its own answer back as evidence and called
the gap zero every morning. Removed, not reweighted: there is no keyless GIFT
Nifty quote, and a row that is not what its label says is worse than a missing
row. `selftest.js` greps for the symbol so it cannot come back quietly. Nikkei,
Hang Seng and the CBOE VIX were already being fetched and read by nothing; they
trade while India is shut, which is the window a gap is made in, so they took
the weight.

**The betas are judgements and the equity ones are correlated.** S&P futures,
Nasdaq futures, the Nikkei and the Hang Seng mostly move together, so betas
chosen as if each were the only cue sum to far more than the actual response.
The first draft totalled 1.05 across the equity block and produced exactly
1.5% on the live cue file - it hit the clamp and stopped being a model. The
block totals 0.52 now. When the clamp is the answer, the betas are wrong, not
the clamp.

**`'1S'` projects to the bell, not to a bar count.** Every other timeframe
projects `visibleBars * forecastRatio`. At 09:20 the rest of today is 370
minutes and at 15:00 it is 30, so a fixed count either stops short of the close
every morning or walks through it every afternoon. `sessionForecast` makes
`build()` ask `barsToSessionClose()` instead, applied *after* `maxForecastBars`
because that cap guards against projecting years, not against a horizon that
ends at 15:30 today. `histPerForecast: 1.5` overrides the 4:1 framing: at 4:1,
375 projected minutes would demand 1500 bars of history and squeeze the session
being forecast into a sliver.

It reads `candles_NIFTY_1H.json` via `bakedAs`, because it asks Yahoo for
exactly what the hourly view asks for. A second identical file would be two
files to keep in step for no extra information.

**375 bars costs 46ms warm and 833ms cold.** Conflating those hid the real
number: almost all of the cold figure is the variance fit, which `volContext`
caches on the last bar. Boot pays cold once; the tick pays warm 25,000 times a
session. `selftest.js` asserts both, separately.

**Probabilities are measured against the predicted open, not the last close.**
With a 0.92% gap in the path, "will it be above yesterday's close at 15:30" is
99% by lunchtime - arithmetically right and useless, because the gap already
answered it. Every checkpoint printed 99-100% the first time this ran. The live
uncertainty is whether the session holds its open, so `refPrice` is what `pUp`
is measured from and `pUpFrom` is carried on the row so the chart, the table
and the narrative cannot each assume a different one. Clamped to 1-99
regardless: a page that prints a certainty has stopped describing a forecast.

**The band lines are gone from the chart and still in the model.** Four dotted
lines occupied most of the picture. `upper`, `lower`, `upper2`, `lower2` are
still computed, still in the hover card, still what `calibrate()` scores and
what the ledger settles against - drawn is not the same question as computed,
and deleting them to tidy the chart would have silently gutted the accuracy
panel. `selftest.js` asserts both halves.

**A lock that can be rewritten is not a lock.** `ledger.lock()` freezes at most
two calls per session - `advance` (the day-before call) and `open` (recomputed
in the 09:00-09:15 pre-open window) - and `write()` refuses rather than
overwrites. It refuses silently, because it happens on most of the 25,000 ticks
in a session and is not news. Locks are scoped by timeframe as well as session:
a 5-minute path and a 1-minute path are different claims about the same day.

`stageNow()` read the wall clock only, and was wrong in the exact case the
feature was built for: on a Sunday afternoon the minute count is past 09:15, so
it returned null and refused to freeze Monday's call - on the one evening a
person is most likely to be asking. The same hole swallowed every weekday
evening after 15:30. If the session in the forecast is not today's, nothing
about it has traded yet whatever the time is.

`scoreLock()` joins predicted to actual **by time, never by index** - the same
rule `closeAtTime()` exists for. A missing bar shifts every later comparison by
one otherwise, silently, for the rest of the day.

**`learn.js` moves two numbers and no others.** The eight lane weights and one
scalar gain on the opening betas. Three guardrails, each a way this goes wrong:
`MIN_SAMPLE` (20) because a lane right 4 of 5 times has said nothing - Wilson
runs 38% to 99%; `MAX_STEP` (8% of its own weight) because a single bad Tuesday
must not rewrite the model; `FLOOR` (0.02) because a lane driven to zero stops
being scored and can never earn its way back. Steps are sized by how far a
lane's interval clears a coin, not by its point estimate - the point estimate
steps hardest exactly where the sample is thinnest.

The opening betas are scaled by **one** learned gain, not fitted individually.
Nine betas on the handful of mornings this will have by Christmas would produce
nine confident numbers and no information.

**The LLM cannot write a weight.** It reads the record and writes the English
post-mortem, and may `propose()` a change that sits until a human `accept()`s
it. A proposal outside `MAX_STEP` is *dropped, not clamped* - honouring 8% of a
request to quadruple a lane would hide that the model misunderstood the task.
The free pool contains classifiers (see OpenRouter above); a router that once
answered "User Safety: safe" to a forecast prompt must not be one keystroke
from the model's parameters.

**`data/predictions.json` is a lane nothing reads.** Fabricated rows with NIFTY
ranges around 23,250 and notes like "Self-taught from previous predictions". It
predates the ledger, is read by no screen and no script, and is exactly what the
rule at the top of this file is about. The real forward record is `fcLedger` and
`fcLocks` in localStorage. Delete the file or wire it; do not leave it.

---

## The chart, the patterns, the count, and the model's vote

Added 20 Sep 2026, second pass.

**Series creation order is the only z-index there is.** Lightweight Charts
paints series in the order they were added, so `lockSeries`, `actualSeries` and
`fcSeries` are created *before* `candleSeries` and the candles land on top of
them. Moving the candle block back above those three would silently undo it -
no error, no visual clue beyond the chart looking busier. The three lines run
through `soften()` at 0.45-0.6 alpha for the same reason: the brief is candles
first, guides underneath.

The News-only and Pattern-only projections are gone from the chart. They are
still computed and still on the forecast panel as "News says" / "Pattern says";
four coloured lines fanning out of one point read as four forecasts rather than
one forecast and its components.

**The hover card is four lines and stays off the time axis.** It carried the
per-lane bars, the likely range and a three-clause footnote - all of which are
on the panel to the right, permanently and with more room - so it was repeating
the panel on top of the one thing only the chart has. Position now asks
`chart.timeScale().height()` for the axis height rather than guessing, because
that height changes with the font and with `secondsVisible`. The `why` overlay
flag switches the whole card off.

**86 detectors across 64 families, in `candles.js`.** The table moved out of
`patterns.js`; the scan and the measured record stayed. That split is the point:
a detector is added by adding a row, and it is then scored whether its author
wanted it scored or not. A pattern that cannot be added without a record cannot
be added as decoration.

Two rules the table enforces and `selftest.js` checks. Every threshold is in
ATR, so multiplying every price by ten flips no verdict - asserted across all 86.
And trend context is mandatory where the textbook requires it: a hammer and a
hanging man are the *same candle*, and a detector that ignores what came before
is detecting a shape and guessing which one it is.

Several of these fire a handful of times a decade - concealing baby swallow,
ladder bottom, three stars in the south, kicking. They read n=0 and that is the
right answer, not a reason to loosen the rule until something matches.

**The scan is cached because of what the numbers are.** 86 detectors across
1,651 bars is 142,000 test calls, measured at 44ms, and `recompute()` runs on
the one-second tick. A closed bar's shape cannot change, so the full scan runs
once per closed bar and every tick after that rescans the last 16 bars -
comfortably past the deepest detector window. Measured 44ms cold, 0.65ms warm.
The cache key is length plus the last bar's **time**, never its close: keying on
the close invalidates every tick and caches nothing. `selftest.js` asserts the
cached result equals the scan it caches, because a cache that returns something
different is a silent wrong answer rather than a slow one.

**`evidence.js` counts observations, not work.** One value read from a source
and fed into a calculation is one. The 142,000 pattern tests are not - counting
a test that returned false would quadruple the headline and add nothing. A feed
that returned 200 and whose items were all dropped counts once as a feed polled,
not once per wasted item. Live on the current series it totals about 45,000
across 17 groups, and the panel itemises every one with its source.

Each field in `evidenceContext()` reads the shape `app.js` actually holds, not
one that looked plausible - `S.filings` is a summary with a `count`, the symbol
universe lives in `portfolio.js`, the feed total arrives on the news payload. A
count reading an absent field reports zero forever and nobody notices, which is
the failure this panel exists to argue against.

**The model is a lane, and it never sees the answer.** OpenRouter votes on
direction: one number in [-1, 1], weighted at 0.08, renormalised, recorded in
the ledger and scorable by `learn.js` like the other eight. It cannot write a
price, a band, a probability or a weight.

The prompt in `maybeAskModelVote()` contains no `f.direction`, `f.bias`,
`f.confidence` or `f.range*` - only the evidence. Show a model the answer and it
agrees with the answer; the lane then reads as independent confirmation and is
in fact a mirror. That is the `sgx_nifty` failure one level up and much harder
to spot, because a mirror and a good analyst produce the same number on the days
it does not matter. `selftest.js` greps the function for those fields.

0.08 is below an equal share (nine lanes at par is 0.111) because the model is
the only lane whose reasoning cannot be re-derived from its inputs. A vote older
than twenty minutes goes dark rather than stale, same rule `optionsLane()`
applies to a four-hour-old chain.

`parseVote()` rejects rather than coerces. A classifier verdict, prose with no
JSON, a missing score, a one-word reason: none becomes a vote. A score of 5 is
**dropped, not clamped to 1** - a model answering 5 has misread the question,
and quietly turning that into a maximum bullish vote would hide that it did.
Those cases are unit-tested by lifting `parseVote` out of `app.js`, because
`openrouter.ai` is not reachable from CI and the guard is the only thing between
a free-tier router and 8% of the forecast.

---

## The audit, and what it found

20 Sep 2026, third pass. The brief was "quality check everything and make sure
all the information which is required is shown". Everything below is what that
found, not what was planned.

**Seven files were written for nobody.** `data/predictions.json`,
`data/live_impact.json`, `data/social.json`, `data/rss_config.json`,
`data/market.json`, `config/keywords.yml`, `config/watchlist.yml`. Nothing in
`assets/`, `index.html` or any script read any of them. `predictions.json` was
worse than dead - fabricated rows with NIFTY ranges around 23,250 and notes
reading "Self-taught from previous predictions", sitting in a public repo
looking like a track record. All seven are `git rm`-ed, so they are recoverable
from history and gone from the tree, and `fetch_market.py` no longer writes
`market.json` "for backward compatibility with the old page" - there is no old
page. `selftest.js` asserts each one stays gone.

**`internals.sectors` was computed on every poll and drawn nowhere.** The same
`allIndices` response the breadth numbers come from carries every sector index
NSE publishes. The page filtered it, sorted it, and threw it away. Sector
performance is the first thing an Indian trader reads after the index level,
and it was one render function away the whole time.

The filter was also too narrow - eight indices, and `NIFTY FINANCIAL SERVICES`,
the heaviest sector in the index, was not among them. Eighteen now, with the
broad-market rows (Midcap 100, Smallcap 100, Next 50) tagged `broad` so the
board can draw them apart: "midcaps are leading" is a different statement from
"banks are leading". `SECTOR_RX` is declared once, because two copies of that
list is two lists to get out of step.

**FII/DII was fetched since the repo existed and never displayed.** It is the
number every business channel closes the day on. It is now on the board in
crore, with the report date, because it is a T+1 report - during Monday's
session the newest figure available is Friday's, and a panel that printed it
without the date would read as today's flows and be a day wrong every day.

**The movers panel was impossible, for a reason worth writing down.**
`fetch_stocks.py` built its wanted list from `universe.json` in file order,
which is alphabetical, and the Yahoo batch lane takes the first 400. So a run
covered 20MICRONS through roughly the letter C and priced almost none of the
NIFTY 50. Index members go to the front of the queue now. Until a workflow run
lands, the panel says how many of the 50 it has rather than ranking five names
out of two.

**Indian money scale, in `core.fmt`.** `crore`, `croreSigned`, `rupees`,
`count`. Rupee amounts here are read in crore and lakh - "FII bought 599.54" is
not a sentence anybody says, "FII bought Rs 600 Cr" is. Input is in crore
because that is the unit every Indian source publishes flows in, NSE's own
FII/DII report included, and it steps up to lakh crore past a hundred thousand.

**The chart says what it is showing.** `renderChartRead()` writes four clauses
under the chart in the order a person would say them out loud: what you are
looking at, what it has done, what moved it, what happens next and on whose
say-so. Every number in it is already on the page - it makes no new claim. The
bar size is in words ("5 minute bars") because "5m" means nothing to somebody
who has not used a terminal, and the whole point is that it reads without
training. Everything is escaped: the loudest headline comes from an RSS feed,
which is somebody else's input arriving in this page, and building a sentence
out of it with `innerHTML` is how a feed title containing a tag becomes markup.

**Bank Nifty and India VIX are on the board and are not chartable.** No candle
series is fetched for them - `quote_only` in `fetch_market.py` skips five
timeframes per run that nothing would open. They are marked `is-quote` in the
markup and the ticker click handler refuses to switch to them, because doing so
left the page on "Loading" forever with no error anywhere.

**Two test classes were added because of bugs this session made.**

`MARKUP — every id the code writes to exists`. `core.text()` on a missing id
does nothing at all, so a renamed or mistyped panel simply never appears and
nothing is raised. 231 ids used, 270 declared, checked statically.

`renderX() is called from recompute()`. All four new render calls were inserted
next to the *first* `renderEvidence();` in the file - which is inside the
evidence button's click handler, not inside `recompute()`. The four panels
rendered only if you clicked "Break it down", and shipped blank otherwise. No
console error, no exception, four empty boxes. The browser check caught it;
this makes it a test rather than something somebody has to remember to look at.

**One source found and deliberately not used.** TradingView's public scanner
(`POST scanner.tradingview.com/india/scan`) returns technical ratings,
performance and fundamentals for roughly 700 NSE stocks in one request with no
login - it is what `Suraj2553/india-stock-dashboard` runs on. It is blocked
from both this session's networks, so it could not be verified, and this repo's
rule is to measure rather than assume. The test to run from a machine that can
reach it: POST with `{"filter":[{"left":"type","operation":"equal","right":"stock"}],"markets":["india"],"columns":["name","close","change","sector","Recommend.All"],"range":[0,5]}`
and check for `Access-Control-Allow-Origin` - if it is there, the browser can
have a 700-stock screener with no workflow in the way.

---

## Style

Match the surrounding code. This codebase is ES5-flavoured browser JS with no
build step and no framework — `var`, `function`, no modules. Python is stdlib
plus `requests` / `feedparser` / `PyYAML`, nothing else.

Comments here explain **why**, usually with the measurement that forced the
decision ("measured from the live origin", "53 replays", "0.80% against a real
0.16%"). Keep that habit — a comment that just restates the line is noise, and a
number in a comment is checkable later.

The project's stated position is that a made-up number is worse than no number.
Honour it: if a source cannot be reached, say so in the UI rather than filling
the gap. `scripts/demo_data.py` and `realtime_loop.py` were deleted for breaking
this rule.

---

## Git

`main` only, no feature branches. Commit when asked. Never commit
`assets/local-config.js` or `.venv/` — both are in `.gitignore`.
