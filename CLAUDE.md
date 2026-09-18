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
| Yahoo `meta.chartPreviousClose` as prev close | off by as many sessions as the range is long | derive from the daily candle series (`prev_close()` in `fetch_market.py`) |

`priceapi.moneycontrol.com` (live index price) is a **different host** and works
fine from the browser. Do not confuse the two when a Moneycontrol lane fails.

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

`config` → `core` → `indicators` → `levels` → `structures` → `vol` →
`forecast` → `ledger` → `engine` → `chart` → `app`. The script tags in
`index.html` are commented with this. Reordering them breaks the page silently.

`forecast.js` owns the model (seven lanes, clock-aware path, bands,
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

A fourth, in `vol.js`: **deseasonalise before fitting.** `volProfile()` already
models the intraday cycle and re-applies it bar by bar, so a GARCH fitted on raw
5-minute returns spends its ARCH coefficient describing the clock. Measured,
persistence fell 0.741 → 0.509 and QLIKE improved 13% once the profile was
divided out first.

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
